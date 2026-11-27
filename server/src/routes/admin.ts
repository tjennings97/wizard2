import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { db } from '../db/knex';
import { asyncHandler } from '../http/asyncHandler';
import { ApiError } from '../http/errors';
import { logger } from '../logger';
import {
  generateInviteCode,
  generateTemporarySecret,
  hashSecret,
  normalizeInviteCode,
  sha256,
} from '../auth/credentials';
import { requireAuth } from '../auth/middleware';
import { invalidateUserSessions } from '../auth/sessions';
import { toPublicUser, type PublicUser, type UserRow } from '../auth/users';

/**
 * Admin panel routes (docs/api/openapi-spec.md, Admin Endpoints): invites, user roles and
 * credential resets. Every route requires an authenticated admin. requireAuth reads the role
 * from the database on each request, so a demotion takes effect on the very next request.
 */

export const INVITE_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const;
type InviteStatus = (typeof INVITE_STATUSES)[number];
const ROLES = ['player', 'admin'] as const;
type Role = (typeof ROLES)[number];

export const INVITE_TTL_DAYS = 7;
const LABEL_MAX = 128;
const USERS_PAGE_DEFAULT = 50;
const USERS_PAGE_MAX = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InviteRow {
  id: string;
  label: string | null;
  status: InviteStatus;
  created_at: Date;
  expires_at: Date;
  redeemed_at: Date | null;
  redeemed_by: string | null;
  redeemed_by_username: string | null;
}

/** The `Invite` schema. The code itself is never stored, so it is never listed. */
function toInviteDto(row: InviteRow) {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    redeemedAt: row.redeemed_at ? new Date(row.redeemed_at).toISOString() : null,
    redeemedBy: row.redeemed_by,
    redeemedByUsername: row.redeemed_by_username,
  };
}

const validationError = (fields: Record<string, string>) =>
  new ApiError(400, 'VALIDATION_ERROR', `Invalid request: ${Object.keys(fields).join(', ')}.`, { fields });

const inviteNotFound = () => new ApiError(404, 'NOT_FOUND', 'Invite not found.');
const userNotFound = () => new ApiError(404, 'NOT_FOUND', 'User not found.');
const notAdmin = () => new ApiError(403, 'FORBIDDEN', 'Admin role required.');

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A user row in the admin list: the `User` fields minus `avatarSvg`, which the admin table never
 * shows and which would make a 200-user page needlessly large.
 */
type AdminUserDto = Omit<PublicUser, 'avatarSvg'>;
function toAdminUserDto(row: UserRow): AdminUserDto {
  const { avatarSvg: _avatarSvg, ...rest } = toPublicUser(row);
  return rest;
}

/**
 * Inside a transaction: locks the acting admin's row and the target's (in id order, so two
 * requests cannot deadlock) and re-checks the actor's role. The requireAdmin check ran before
 * the request did its work, and the actor may have been demoted since: two admins demoting each
 * other at once must not both succeed, and a demoted admin's in-flight reset must not land.
 * Throws 403 if the actor is no longer an admin, 404 if the target does not exist.
 */
async function lockActorAndTarget(trx: Knex.Transaction, actorId: string, targetId: string): Promise<void> {
  const locked: Pick<UserRow, 'id' | 'role'>[] = await trx('users')
    .whereIn('id', [actorId, targetId])
    .orderBy('id')
    .forUpdate()
    .select('id', 'role');
  if (locked.find((u) => u.id === actorId)?.role !== 'admin') throw notAdmin();
  if (!locked.some((u) => u.id === targetId)) throw userNotFound();
}

/** Stack after requireAuth. req.user.role comes from the database, never from the cookie. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  next(req.user?.role === 'admin' ? undefined : notAdmin());
}

/** Pending invites past their expiry become `expired` (PRD: expired invites are marked automatically). */
async function markExpiredInvites(): Promise<void> {
  await db('invites').where({ status: 'pending' }).andWhere('expires_at', '<=', db.fn.now()).update({ status: 'expired' });
}

function inviteQuery() {
  return db('invites as i')
    .leftJoin('users as u', 'u.id', 'i.redeemed_by')
    .select('i.id', 'i.label', 'i.status', 'i.created_at', 'i.expires_at', 'i.redeemed_at', 'i.redeemed_by', 'u.username as redeemed_by_username');
}

/** A query-string integer, or undefined if absent. Adds a field error when malformed or out of range. */
function queryInt(raw: unknown, field: string, min: number, max: number, fields: Record<string, string>): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fields[field] = `Must be an integer from ${min} to ${max}.`;
    return undefined;
  }
  return n;
}

/** Responses that carry a one-time secret must not be cached anywhere. */
function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

export function createAdminRouter(): Router {
  const router = Router();
  // On each route rather than router.use, so an unknown /admin path is a plain 404 like any
  // other unknown route, not a 401 or 403.
  const admin = [requireAuth, requireAdmin];

  // GET /admin/invites?status=
  router.get(
    '/invites',
    ...admin,
    asyncHandler(async (req, res) => {
      const status = req.query.status;
      if (status !== undefined && !(INVITE_STATUSES as readonly unknown[]).includes(status)) {
        throw validationError({ status: `Must be one of: ${INVITE_STATUSES.join(', ')}.` });
      }
      await markExpiredInvites();
      const q = inviteQuery().orderBy('i.created_at', 'desc').orderBy('i.id');
      if (status !== undefined) q.where('i.status', status as InviteStatus);
      const rows: InviteRow[] = await q;
      res.status(200).json(rows.map(toInviteDto));
    }),
  );

  // POST /admin/invites { label? }
  router.post(
    '/invites',
    ...admin,
    asyncHandler(async (req, res) => {
      const body = req.body === undefined ? {} : asObject(req.body);
      if (!body) throw validationError({ body: 'Must be a JSON object.' });
      let label: string | null = null;
      if (body.label !== undefined && body.label !== null) {
        if (typeof body.label !== 'string' || body.label.trim().length > LABEL_MAX) {
          throw validationError({ label: `Must be a string of at most ${LABEL_MAX} characters.` });
        }
        label = body.label.trim() || null;
      }

      const code = generateInviteCode();
      const [{ id }]: { id: string }[] = await db('invites')
        .insert({
          code_hash: sha256(normalizeInviteCode(code)),
          label,
          created_by: req.user!.id,
          expires_at: db.raw(`now() + interval '${INVITE_TTL_DAYS} days'`),
        })
        .returning('id');
      const row: InviteRow = await inviteQuery().where('i.id', id).first();

      logger.info({ userId: req.user!.id, inviteId: id }, 'admin created invite');
      noStore(res);
      res.status(201).json({ invite: toInviteDto(row), code });
    }),
  );

  // DELETE /admin/invites/{inviteId}: revoke a pending invite.
  router.delete(
    '/invites/:inviteId',
    ...admin,
    asyncHandler(async (req, res) => {
      const { inviteId } = req.params;
      if (!UUID_PATTERN.test(inviteId)) throw inviteNotFound();
      const revoked = await db('invites')
        .where({ id: inviteId, status: 'pending' })
        .andWhere('expires_at', '>', db.fn.now())
        .update({ status: 'revoked' })
        .returning('id');
      if (revoked.length === 0) {
        await markExpiredInvites();
        const exists = await db('invites').where({ id: inviteId }).first('id');
        if (!exists) throw inviteNotFound();
        throw new ApiError(400, 'INVITE_NOT_REVOCABLE', 'Only pending invites can be revoked.');
      }
      logger.info({ userId: req.user!.id, inviteId }, 'admin revoked invite');
      res.status(204).end();
    }),
  );

  // GET /admin/users?role=&page=&limit=
  router.get(
    '/users',
    ...admin,
    asyncHandler(async (req, res) => {
      const fields: Record<string, string> = {};
      const role = req.query.role;
      if (role !== undefined && !(ROLES as readonly unknown[]).includes(role)) {
        fields.role = `Must be one of: ${ROLES.join(', ')}.`;
      }
      const page = queryInt(req.query.page, 'page', 1, Number.MAX_SAFE_INTEGER, fields) ?? 1;
      const limit = queryInt(req.query.limit, 'limit', 1, USERS_PAGE_MAX, fields) ?? USERS_PAGE_DEFAULT;
      if (Object.keys(fields).length > 0) throw validationError(fields);

      const base = () => {
        const q = db('users');
        if (role !== undefined) q.where({ role: role as Role });
        return q;
      };
      const [{ count }] = await base().count<{ count: string }[]>({ count: '*' });
      const rows: UserRow[] = await base()
        .select('*')
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .offset((page - 1) * limit);
      res.status(200).json({ data: rows.map(toAdminUserDto), total: Number(count), page, limit });
    }),
  );

  // PATCH /admin/users/{userId}/role { role }
  router.patch(
    '/users/:userId/role',
    ...admin,
    asyncHandler(async (req, res) => {
      const userId = req.params.userId.toLowerCase();
      if (!UUID_PATTERN.test(userId)) throw userNotFound();
      const role = asObject(req.body)?.role;
      if (!(ROLES as readonly unknown[]).includes(role)) {
        throw validationError({ role: `Must be one of: ${ROLES.join(', ')}.` });
      }
      const actorId = req.user!.id;
      // Lockout prevention (PRD, Admin): another admin must remove an admin's role.
      if (userId === actorId && role === 'player') {
        throw new ApiError(400, 'SELF_DEMOTION_FORBIDDEN', 'You cannot remove your own admin role.');
      }

      const updated = await db.transaction(async (trx) => {
        await lockActorAndTarget(trx, actorId, userId);
        const [row]: UserRow[] = await trx('users').where({ id: userId }).update({ role }).returning('*');
        return row;
      });

      logger.info({ userId: actorId, targetUserId: updated.id, role }, 'admin changed user role');
      res.status(200).json(toPublicUser(updated));
    }),
  );

  // POST /admin/users/{userId}/reset-credentials
  router.post(
    '/users/:userId/reset-credentials',
    ...admin,
    asyncHandler(async (req, res) => {
      const userId = req.params.userId.toLowerCase();
      if (!UUID_PATTERN.test(userId)) throw userNotFound();
      const actorId = req.user!.id;
      // An admin changes their own credentials from the profile page. A self-reset would end the
      // very session making the request (and any game it is playing) for no benefit.
      if (userId === actorId) {
        throw new ApiError(400, 'SELF_RESET_FORBIDDEN', 'Change your own credentials from your profile.');
      }
      if (!(await db('users').where({ id: userId }).first('id'))) throw userNotFound();

      const temporaryPassword = generateTemporarySecret();
      const temporaryPassphrase = generateTemporarySecret();
      // Hash outside the transaction so the user row lock is not held across bcrypt.
      const [passwordHash, recoveryHash] = await Promise.all([hashSecret(temporaryPassword), hashSecret(temporaryPassphrase)]);

      await db.transaction(async (trx) => {
        await lockActorAndTarget(trx, actorId, userId);
        // Both secrets must be chosen again before the flag clears (auth-follow-ups §4a/§4b).
        await trx('users').where({ id: userId }).update({
          password_hash: passwordHash,
          recovery_hash: recoveryHash,
          requires_credential_change: true,
          password_changed_at: null,
          recovery_changed_at: null,
        });
        await invalidateUserSessions(trx, userId, 'admin_reset');
      });

      logger.info({ userId: actorId, targetUserId: userId }, 'admin reset user credentials');
      noStore(res);
      res.status(200).json({
        temporaryPassword,
        temporaryPassphrase,
        note: "The user's credentials are marked temporary. They will be prompted to change their password and recovery passphrase on next login.",
      });
    }),
  );

  return router;
}
