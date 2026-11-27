import { Router, type Request } from 'express';
import { requireAuth } from '../auth/middleware';
import { bugReportLimiter } from '../auth/rateLimits';
import { db } from '../db/knex';
import type { GameService } from '../games/service';
import { asyncHandler } from '../http/asyncHandler';
import { ApiError } from '../http/errors';
import { requestTraceId } from '../http/trace';
import { logger } from '../logger';
import { activeMembershipFor, isRoomId } from '../rooms/queries';

// Limits from the POST /bug-reports request schema in docs/api/openapi-spec.md, plus caps on the
// free-form context strings so a report cannot carry an arbitrarily large row.
export const DESCRIPTION_MAX = 2000;
const URL_MAX = 2048;
const PAGE_MAX = 64;
const USER_AGENT_MAX = 512;
const SEVERITIES = ['low', 'medium', 'high'] as const;
type Severity = (typeof SEVERITIES)[number];

type FieldErrors = Record<string, string>;

/** `bug_reports.context` (docs/architecture/data-model.md, Data Dictionary — bug_reports). */
interface StoredContext {
  url: string;
  page: string | null;
  round_number: number | null;
  trick_number: number | null;
  /** The reporter's own game.toPlayerView(userId), built on the server. Never other players' hands. */
  game_state_summary: unknown;
  user_agent: string | null;
  client_timestamp: string;
}

interface ParsedReport {
  description: string;
  severity: Severity | null;
  url: string;
  page: string | null;
  roomId: string | null;
  gameId: string | null;
  roundNumber: number | null;
  trickNumber: number | null;
  userAgent: string | null;
  clientTimestamp: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function optionalString(ctx: Record<string, unknown>, key: string, max: number, errors: FieldErrors): string | null {
  const v = ctx[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) {
    errors[`context.${key}`] = `Must be a string of at most ${max} characters.`;
    return null;
  }
  return v;
}

function optionalUuid(ctx: Record<string, unknown>, key: string, errors: FieldErrors): string | null {
  const v = ctx[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !isRoomId(v)) {
    errors[`context.${key}`] = 'Must be a UUID or null.';
    return null;
  }
  return v.toLowerCase();
}

function optionalCount(ctx: Record<string, unknown>, key: string, errors: FieldErrors): number | null {
  const v = ctx[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) {
    errors[`context.${key}`] = 'Must be a non-negative integer or null.';
    return null;
  }
  return v;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates the body against the request schema. Unknown fields are ignored, including the
 * client's `gameStateSummary`: the server builds that itself from the live game, so a report can
 * never store a hand the reporter did not hold.
 */
function parseReport(body: unknown): ParsedReport {
  const b = isObject(body) ? body : {};
  const errors: FieldErrors = {};

  const rawDescription = b.description;
  const description = typeof rawDescription === 'string' ? rawDescription.trim() : '';
  if (description.length === 0 || description.length > DESCRIPTION_MAX) {
    errors.description = `Describe the problem in 1–${DESCRIPTION_MAX} characters.`;
  }

  let severity: Severity | null = null;
  if (b.severity !== undefined && b.severity !== null) {
    if (typeof b.severity === 'string' && (SEVERITIES as readonly string[]).includes(b.severity)) {
      severity = b.severity as Severity;
    } else {
      errors.severity = `Must be one of ${SEVERITIES.join(', ')}.`;
    }
  }

  const ctx = isObject(b.context) ? b.context : null;
  if (!ctx) {
    errors.context = 'Required.';
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request body.', { fields: errors });
  }

  const url = typeof ctx.url === 'string' ? ctx.url : '';
  if (url.length === 0 || url.length > URL_MAX || !isHttpUrl(url)) {
    errors['context.url'] = 'Required: the http(s) URL of the page.';
  }
  const clientTimestamp = typeof ctx.clientTimestamp === 'string' ? ctx.clientTimestamp : '';
  if (clientTimestamp.length === 0 || clientTimestamp.length > 64 || Number.isNaN(Date.parse(clientTimestamp))) {
    errors['context.clientTimestamp'] = 'Required: an ISO 8601 date-time.';
  }

  const parsed: ParsedReport = {
    description,
    severity,
    url,
    page: optionalString(ctx, 'page', PAGE_MAX, errors),
    roomId: optionalUuid(ctx, 'roomId', errors),
    gameId: optionalUuid(ctx, 'gameId', errors),
    roundNumber: optionalCount(ctx, 'roundNumber', errors),
    trickNumber: optionalCount(ctx, 'trickNumber', errors),
    userAgent: optionalString(ctx, 'userAgent', USER_AGENT_MAX, errors),
    clientTimestamp,
  };
  if (Object.keys(errors).length > 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request body.', { fields: errors });
  }
  return parsed;
}

/** A client-supplied id is stored only if the row exists (the columns are foreign keys). */
async function existingId(table: 'rooms' | 'games', id: string | null): Promise<string | null> {
  if (!id) return null;
  const row = await db(table).where({ id }).first('id');
  return row ? (row.id as string) : null;
}

/**
 * Where the reporter is, as the server sees it. The room comes from their active membership and
 * the game from the room's live game; the client's ids are a fallback (for example, a report sent
 * just after leaving). The snapshot is their own player view, or null for spectators and anyone
 * not seated in a live game.
 */
async function reporterLocation(games: GameService, userId: string, report: ParsedReport) {
  const membership = await activeMembershipFor(userId);
  if (membership) {
    const roomId = membership.roomId;
    const liveGameId = games.gameIdFor(roomId);
    const gameId =
      liveGameId ??
      ((await db('games').where({ room_id: roomId }).orderBy('started_at', 'desc').first('id'))?.id as string | undefined) ??
      null;
    return { roomId, gameId, view: games.playerView(roomId, userId) };
  }
  const [roomId, gameId] = await Promise.all([existingId('rooms', report.roomId), existingId('games', report.gameId)]);
  return { roomId, gameId, view: null };
}

function userAgentOf(req: Request, report: ParsedReport): string | null {
  const header = req.get('user-agent');
  return (header ? header.slice(0, USER_AGENT_MAX) : null) ?? report.userAgent;
}

export function createBugReportsRouter(games: GameService): Router {
  const router = Router();

  // POST /bug-reports (docs/api/openapi-spec.md). Requires a session: the report is tied to the
  // user and to their session's traceId, which correlates it with the server logs
  // (docs/operations/observability-alerting.md, "Correlating a bug report with server logs").
  router.post(
    '/',
    requireAuth,
    bugReportLimiter,
    asyncHandler(async (req, res) => {
      const report = parseReport(req.body);
      const userId = req.user!.id;
      const traceId = requestTraceId(req);
      const { roomId, gameId, view } = await reporterLocation(games, userId, report);

      const context: StoredContext = {
        url: report.url,
        page: report.page,
        round_number: view ? view.currentRound : report.roundNumber,
        trick_number: view ? view.currentTrick : report.trickNumber,
        game_state_summary: view,
        user_agent: userAgentOf(req, report),
        client_timestamp: report.clientTimestamp,
      };

      const [row] = await db('bug_reports')
        .insert({
          user_id: userId,
          room_id: roomId,
          game_id: gameId,
          trace_id: traceId,
          description: report.description,
          severity: report.severity,
          context: JSON.stringify(context),
        })
        .returning(['id', 'created_at']);

      logger.info(
        { traceId, userId, roomId, gameId, reportId: row.id, severity: report.severity, page: report.page },
        'bug report submitted',
      );
      // TODO(metrics, remaining-work prompt 10): increment bug_reports_total{severity} once the
      // prom-client registry exists.

      res.status(201).json({ reportId: row.id, message: 'Your report has been submitted. Thank you.' });
    }),
  );

  return router;
}
