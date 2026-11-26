import type { CookieOptions, Response } from 'express';
import type { Knex } from 'knex';
import { config } from '../config';
import { db } from '../db/knex';
import { generateSessionToken, sha256 } from './credentials';
import { emitSessionsInvalidated, type InvalidationReason } from './sessionEvents';
import {
  ENDED_SESSION_RETENTION_MS,
  isInReauthWindow,
  SESSION_IDLE_TTL_MS,
  SESSION_MAX_LIFETIME_MS,
  sessionCapAt,
  slidExpiry,
} from './sessionPolicy';
import { toPublicUser, type PublicUser, type UserRow } from './users';

export const SESSION_COOKIE = 'wizard_session';

const baseCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: config.isProduction,
  sameSite: 'strict',
  path: '/',
  signed: true,
};

export interface IssuedSession {
  token: string;
  /** The new session's trace_id, for log correlation. */
  traceId: string;
  /** Hard-cap time. The cookie lives this long; the database decides validity before then. */
  cookieExpiresAt: Date;
}

export interface AuthSession {
  id: string;
  traceId: string;
  createdAt: Date;
  expiresAt: Date;
  /** Hard cap (created_at + 30 days). */
  capAt: Date;
  /** Within 24h of the cap: the user must log in again before entering a room or game. */
  inReauthWindow: boolean;
}

export type AuthResult =
  | { ok: true; user: PublicUser; session: AuthSession }
  /** userId and traceId are set when the session row exists, for logging the rejection. */
  | { ok: false; code: 'UNAUTHORIZED' | 'SESSION_INVALIDATED'; userId?: string; traceId?: string };

interface SessionJoinRow extends UserRow {
  session_id: string;
  trace_id: string;
  session_created_at: Date;
  expires_at: Date;
  invalidated_at: Date | null;
}

/**
 * Invalidates every still-active session for the user, deletes their sessions that ended
 * more than a day ago, then creates a new one. Must run inside a transaction that holds a lock
 * on the user's row, so two concurrent logins cannot both leave an active session behind.
 * `reason` is what the ended sessions' sockets are told (a login displaces them by default).
 */
export async function rotateSession(
  trx: Knex.Transaction,
  userId: string,
  reason: InvalidationReason = 'displaced',
): Promise<IssuedSession> {
  await invalidateUserSessions(trx, userId, reason);
  await pruneEndedSessions(trx, userId);
  const token = generateSessionToken();
  const now = Date.now();
  const [inserted]: { trace_id: string }[] = await trx('sessions')
    .insert({
      user_id: userId,
      token_hash: sha256(token),
      created_at: new Date(now),
      expires_at: new Date(now + SESSION_IDLE_TTL_MS),
    })
    .returning('trace_id');
  return { token, traceId: inserted.trace_id, cookieExpiresAt: new Date(now + SESSION_MAX_LIFETIME_MS) };
}

/**
 * Ends every still-active session for the user. Sockets on those sessions are told
 * (SESSION_INVALIDATED) once `trx` commits; see sessionEvents.ts.
 */
export async function invalidateUserSessions(
  trx: Knex | Knex.Transaction,
  userId: string,
  reason: InvalidationReason,
): Promise<void> {
  const rows: { id: string }[] = await trx('sessions')
    .where({ user_id: userId })
    .whereNull('invalidated_at')
    .update({ invalidated_at: trx.fn.now() })
    .returning('id');
  emitSessionsInvalidated(trx, rows.map((r) => r.id), reason);
}

/** Ends one session (logout). Its sockets are told as for invalidateUserSessions. */
export async function invalidateSession(conn: Knex | Knex.Transaction, sessionId: string): Promise<void> {
  const rows: { id: string }[] = await conn('sessions')
    .where({ id: sessionId })
    .whereNull('invalidated_at')
    .update({ invalidated_at: conn.fn.now() })
    .returning('id');
  emitSessionsInvalidated(conn, rows.map((r) => r.id), 'logout');
}

/** Deletes the user's sessions that were invalidated or expired over ENDED_SESSION_RETENTION_MS ago. */
async function pruneEndedSessions(trx: Knex.Transaction, userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - ENDED_SESSION_RETENTION_MS);
  await trx('sessions')
    .where({ user_id: userId })
    .andWhere((q) => q.where('invalidated_at', '<', cutoff).orWhere('expires_at', '<', cutoff))
    .delete();
}

/**
 * Validates a raw session token and, unless `slide: false`, slides its expiry forward. Shared by
 * the HTTP middleware and (once built) the Socket.io layer, which must call it on connect and on
 * game actions so that a player who is only using the socket keeps their session alive.
 *
 * Callers that may still reject the request after validating (REAUTH_REQUIRED,
 * CREDENTIAL_CHANGE_REQUIRED) pass `slide: false` and call slideSession once it is allowed,
 * so blocked requests do not keep the session alive.
 */
export async function authenticateToken(
  token: string,
  { slide = true }: { slide?: boolean } = {},
): Promise<AuthResult> {
  const row: SessionJoinRow | undefined = await db('sessions as s')
    .join('users as u', 'u.id', 's.user_id')
    .where('s.token_hash', sha256(token))
    .first(
      'u.*',
      's.id as session_id',
      's.trace_id',
      's.created_at as session_created_at',
      's.expires_at',
      's.invalidated_at',
    );

  if (!row) return { ok: false, code: 'UNAUTHORIZED' };
  // Logout clears the cookie, so a client still holding an invalidated token has almost
  // always been displaced by a newer login (or a password reset).
  const ids = { userId: row.id, traceId: row.trace_id };
  if (row.invalidated_at) return { ok: false, code: 'SESSION_INVALIDATED', ...ids };

  const now = Date.now();
  const createdAt = new Date(row.session_created_at);
  const expiresAt = new Date(row.expires_at);
  if (expiresAt.getTime() <= now) return { ok: false, code: 'UNAUTHORIZED', ...ids };

  const session: AuthSession = {
    id: row.session_id,
    traceId: row.trace_id,
    createdAt,
    expiresAt,
    capAt: sessionCapAt(createdAt),
    inReauthWindow: isInReauthWindow(createdAt, now),
  };
  return { ok: true, user: toPublicUser(row), session: slide ? await slideSession(session, now) : session };
}

/** Moves a validated session's expiry forward for activity. Returns the session as updated. */
export async function slideSession(session: AuthSession, now: number = Date.now()): Promise<AuthSession> {
  const slidTo = slidExpiry(session.createdAt, session.expiresAt, now);
  if (!slidTo) return session;
  // Guarded on invalidated_at so a concurrent logout/login is never undone.
  await db('sessions')
    .where({ id: session.id })
    .whereNull('invalidated_at')
    .update({ expires_at: slidTo });
  return { ...session, expiresAt: slidTo };
}

/** True if the session has been invalidated (displaced, reset or logged out). */
export async function isSessionInvalidated(sessionId: string): Promise<boolean> {
  return !!(await db('sessions').where({ id: sessionId }).whereNotNull('invalidated_at').first('id'));
}

/** True if the user is an active (not departed) player in a game that is still in progress. */
export async function isInActiveGame(userId: string): Promise<boolean> {
  const row = await db('room_members as rm')
    .join('games as g', 'g.room_id', 'rm.room_id')
    .where({ 'rm.user_id': userId, 'rm.role': 'player', 'g.status': 'in_progress' })
    .whereNull('rm.left_at')
    .first(db.raw('1'));
  return !!row;
}

export function setSessionCookie(res: Response, session: IssuedSession): void {
  res.cookie(SESSION_COOKIE, session.token, { ...baseCookieOptions, expires: session.cookieExpiresAt });
}

export function clearSessionCookie(res: Response): void {
  // Omit `signed`, otherwise Express writes a signature for the empty value.
  const { signed: _signed, ...options } = baseCookieOptions;
  res.clearCookie(SESSION_COOKIE, options);
}
