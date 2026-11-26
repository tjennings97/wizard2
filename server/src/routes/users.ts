import { Router } from 'express';
import { db } from '../db/knex';
import { asyncHandler } from '../http/asyncHandler';
import { ApiError } from '../http/errors';
import { logger } from '../logger';
import { hashSecret, verifySecret } from '../auth/credentials';
import { authenticate } from '../auth/middleware';
import { currentPasswordLimiter } from '../auth/rateLimits';
import { rotateSession, setSessionCookie } from '../auth/sessions';
import { toPublicUser, type UserRow } from '../auth/users';
import { BodyValidator } from '../auth/validation';

export const usersRouter = Router();

// GET /users/me, PATCH /users/me and POST /auth/logout are the only routes a user flagged for a
// forced credential change may use (docs/architecture/security.md, CLAUDE.md "Forced credential
// change"). Do not opt any other route in.
const meAuth = authenticate({ allowDuringCredentialChange: true });

// GET /users/me: the client calls this when the app loads to restore the session, so this is
// where a returning user in the re-auth window gets 401 REAUTH_REQUIRED. It stays available
// while a credential change is required, so the client can read requiresCredentialChange.
usersRouter.get('/me', meAuth, (req, res) => {
  res.status(200).json(req.user);
});

// 401 but not a session code, so the client does not treat it as being signed out.
const wrongCurrentPassword = () => new ApiError(401, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect.');

const PATCHABLE = ['displayName', 'password', 'recoveryPassphrase'] as const;

/** True once the user has chosen both secrets themselves since the last admin reset. */
const bothSecretsChanged = (row: Pick<UserRow, 'password_changed_at' | 'recovery_changed_at'>): boolean =>
  row.password_changed_at !== null && row.recovery_changed_at !== null;

// PATCH /users/me: display name, password and recovery passphrase (docs/api/openapi-spec.md).
// Changing either secret requires currentPassword, rotates the session (every other device is
// signed out; this one gets a new cookie), and may clear requires_credential_change.
usersRouter.patch(
  '/me',
  meAuth,
  currentPasswordLimiter,
  asyncHandler(async (req, res) => {
    const body: Record<string, unknown> =
      req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const has = (field: string) => field in body;

    // Avatar changes arrive with the avatar system (auth-follow-ups §8 decides whether
    // avatarSvg is accepted at all). Refuse rather than silently ignore them.
    for (const field of ['avatarConfig', 'avatarSvg']) {
      if (has(field)) {
        throw new ApiError(400, 'VALIDATION_ERROR', `Invalid request body: ${field}.`, {
          fields: { [field]: 'Avatar changes are not supported yet.' },
        });
      }
    }
    if (!PATCHABLE.some(has)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to update.', {
        fields: { body: `Send at least one of ${PATCHABLE.join(', ')}.` },
      });
    }

    const v = new BodyValidator(body);
    const displayName = has('displayName') ? v.displayName() : undefined;
    const password = has('password') ? v.newSecret('password') : undefined;
    const recoveryPassphrase = has('recoveryPassphrase') ? v.newSecret('recoveryPassphrase') : undefined;
    const changingSecret = password !== undefined || recoveryPassphrase !== undefined;
    const currentPassword = changingSecret ? v.presentString('currentPassword') : undefined;
    v.done();

    const userId = req.user!.id;
    const traceId = req.authSession!.traceId;

    let passwordHash: string | undefined;
    let recoveryHash: string | undefined;
    let verifiedHash: string | undefined;
    if (changingSecret) {
      const found: UserRow = await db('users').where({ id: userId }).first();
      if (!(await verifySecret(currentPassword!, found.password_hash))) {
        logger.warn({ userId, traceId }, 'profile secret change: wrong current password');
        throw wrongCurrentPassword();
      }
      verifiedHash = found.password_hash;
      // A forced change must replace the temporary credentials the admin knows, and a normal
      // change that keeps the old value is a no-op that would still sign out other devices.
      const same: Record<string, string> = {};
      if (password !== undefined && password === currentPassword) same.password = 'Must differ from your current password.';
      if (recoveryPassphrase !== undefined && (await verifySecret(recoveryPassphrase, found.recovery_hash))) {
        same.recoveryPassphrase = 'Must differ from your current recovery passphrase.';
      }
      if (Object.keys(same).length > 0) {
        throw new ApiError(400, 'VALIDATION_ERROR', `Invalid request body: ${Object.keys(same).join(', ')}.`, {
          fields: same,
        });
      }
      // Hash outside the transaction so the user row lock is not held across bcrypt.
      [passwordHash, recoveryHash] = await Promise.all([
        password !== undefined ? hashSecret(password) : undefined,
        recoveryPassphrase !== undefined ? hashSecret(recoveryPassphrase) : undefined,
      ]);
    }

    const { user, session } = await db.transaction(async (trx) => {
      // Lock the user row: serialises with logins and other changes (rotateSession requires it).
      const locked: UserRow = await trx('users').where({ id: userId }).forUpdate().first();
      // currentPassword was checked before the lock. If the password changed in between (another
      // device, or a reset), it was checked against a hash that is no longer current.
      if (verifiedHash !== undefined && locked.password_hash !== verifiedHash) throw wrongCurrentPassword();

      const now = trx.fn.now();
      const update: Record<string, unknown> = {};
      if (displayName !== undefined) update.display_name = displayName;
      if (passwordHash !== undefined) Object.assign(update, { password_hash: passwordHash, password_changed_at: now });
      if (recoveryHash !== undefined) Object.assign(update, { recovery_hash: recoveryHash, recovery_changed_at: now });

      const [updated]: UserRow[] = await trx('users').where({ id: userId }).update(update).returning('*');
      let row = updated;
      if (row.requires_credential_change && bothSecretsChanged(row)) {
        [row] = await trx('users')
          .where({ id: userId })
          .update({ requires_credential_change: false })
          .returning('*');
      }
      return { user: row, session: changingSecret ? await rotateSession(trx, userId, 'credential_change') : null };
    });

    if (session) {
      setSessionCookie(res, session);
      logger.info(
        {
          userId,
          traceId: session.traceId,
          password: password !== undefined,
          recoveryPassphrase: recoveryPassphrase !== undefined,
          requiresCredentialChange: user.requires_credential_change,
        },
        'profile secrets changed',
      );
    } else {
      logger.info({ userId, traceId }, 'profile updated');
    }
    res.status(200).json(toPublicUser(user));
  }),
);
