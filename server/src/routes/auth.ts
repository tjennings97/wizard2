import { Router } from 'express';
import { asyncHandler } from '../http/asyncHandler';
import { db } from '../db/knex';
import { logger } from '../logger';
import { ApiError } from '../http/errors';
import { requestTraceId } from '../http/trace';
import { burnVerifyTime, hashSecret, normalizeInviteCode, sha256, verifySecret } from '../auth/credentials';
import { authenticate } from '../auth/middleware';
import { loginLimiter, registerLimiter, resetPasswordLimiter } from '../auth/rateLimits';
import {
  clearSessionCookie,
  invalidateSession,
  invalidateUserSessions,
  rotateSession,
  setSessionCookie,
} from '../auth/sessions';
import { toPublicUser, type UserRow } from '../auth/users';
import { BodyValidator } from '../auth/validation';

export const authRouter = Router();

const PG_UNIQUE_VIOLATION = '23505';

// One message for every invite failure, so responses do not reveal whether a code exists,
// expired, or was already used (docs/architecture/security.md, invite-code enumeration).
const inviteInvalid = () =>
  new ApiError(422, 'INVITE_INVALID', 'Invite code is invalid, expired, or has already been used.');
const invalidCredentials = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
const invalidRecovery = () =>
  new ApiError(401, 'INVALID_RECOVERY', 'Username or recovery passphrase is incorrect.');

interface InviteRow {
  id: string;
  status: string;
  expires_at: Date;
  redeemed_at: Date | null;
}

function isRedeemable(invite: InviteRow | undefined): invite is InviteRow {
  return (
    !!invite &&
    invite.status === 'pending' &&
    invite.redeemed_at === null &&
    new Date(invite.expires_at).getTime() > Date.now()
  );
}

/**
 * Usernames are stored lowercase (USERNAME_PATTERN), so match the login and reset lookups the
 * same way. Mobile keyboards often auto-capitalize the first letter.
 */
const normalizeUsername = (username: string): string => username.trim().toLowerCase();

// POST /auth/register
authRouter.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const v = new BodyValidator(req.body);
    const inviteCode = v.presentString('inviteCode');
    const username = v.username();
    const displayName = v.displayName();
    const password = v.newSecret('password');
    const recoveryPassphrase = v.newSecret('recoveryPassphrase');
    const avatarConfig = v.avatarConfig();
    v.done();
    if (recoveryPassphrase === password) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request body: recoveryPassphrase.', {
        fields: { recoveryPassphrase: 'Must be different from your password.' },
      });
    }

    // Codes from the admin panel are hashed in normalized form (case, spaces and dashes ignored).
    // Invites seeded before that rule were hashed exactly as written, so match those too.
    const codeHashes = [...new Set([sha256(normalizeInviteCode(inviteCode)), sha256(inviteCode)])];

    // Cheap pre-check so a bad code does not cost two bcrypt hashes. Re-checked under lock below.
    const preInvite: InviteRow | undefined = await db('invites').whereIn('code_hash', codeHashes).first();
    if (!isRedeemable(preInvite)) throw inviteInvalid();

    // Hash outside the transaction so the invite row lock is not held across ~0.5s of bcrypt.
    const [passwordHash, recoveryHash] = await Promise.all([
      hashSecret(password),
      hashSecret(recoveryPassphrase),
    ]);

    const { user, session } = await db.transaction(async (trx) => {
      // Lock the invite so two concurrent registrations cannot both redeem it.
      const invite: InviteRow | undefined = await trx('invites')
        .whereIn('code_hash', codeHashes)
        .forUpdate()
        .first();
      if (!isRedeemable(invite)) throw inviteInvalid();

      let userRow: UserRow;
      try {
        [userRow] = await trx('users')
          .insert({
            username,
            display_name: displayName,
            password_hash: passwordHash,
            recovery_hash: recoveryHash,
            avatar_config: avatarConfig,
          })
          .returning('*');
      } catch (err) {
        if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          throw new ApiError(409, 'USERNAME_TAKEN', 'That username is already in use.');
        }
        throw err;
      }

      await trx('invites').where({ id: invite.id }).update({
        status: 'accepted',
        redeemed_at: trx.fn.now(),
        redeemed_by: userRow.id,
      });

      return { user: userRow, session: await rotateSession(trx, userRow.id) };
    });

    logger.info({ userId: user.id, traceId: session.traceId }, 'user registered');
    setSessionCookie(res, session);
    res.status(201).json(toPublicUser(user));
  }),
);

// POST /auth/login
authRouter.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const v = new BodyValidator(req.body);
    const username = normalizeUsername(v.presentString('username'));
    const password = v.presentString('password');
    v.done();

    const found: UserRow | undefined = await db('users').where({ username }).first();
    if (!found) {
      await burnVerifyTime(password);
      throw invalidCredentials();
    }
    if (!(await verifySecret(password, found.password_hash))) throw invalidCredentials();

    const { user, session } = await db.transaction(async (trx) => {
      // Lock the user row: serialises concurrent logins so exactly one session stays active.
      const locked: UserRow = await trx('users').where({ id: found.id }).forUpdate().first();
      return { user: locked, session: await rotateSession(trx, locked.id) };
    });

    logger.info({ userId: user.id, traceId: session.traceId }, 'user logged in');
    setSessionCookie(res, session);
    // The User body always carries requiresCredentialChange; when true the client must route
    // to the forced change-password flow before anything else.
    res.status(200).json(toPublicUser(user));
  }),
);

// POST /auth/logout
authRouter.post(
  '/logout',
  // Logout must always work while the session is valid, including in the re-auth window.
  authenticate({ allowInReauthWindow: true, allowDuringCredentialChange: true }),
  asyncHandler(async (req, res) => {
    await invalidateSession(db, req.authSession!.id);

    logger.info({ userId: req.user!.id, traceId: req.authSession!.traceId }, 'user logged out');
    clearSessionCookie(res);
    res.status(204).end();
  }),
);

// POST /auth/reset-password
authRouter.post(
  '/reset-password',
  resetPasswordLimiter,
  asyncHandler(async (req, res) => {
    const v = new BodyValidator(req.body);
    const username = normalizeUsername(v.presentString('username'));
    const recoveryPassphrase = v.presentString('recoveryPassphrase');
    const newPassword = v.newSecret('newPassword');
    v.done();

    // Unknown username and wrong passphrase get the same response (and the same bcrypt cost),
    // so this endpoint cannot be used to discover which usernames exist.
    const user: UserRow | undefined = await db('users').where({ username }).first();
    if (!user) {
      await burnVerifyTime(recoveryPassphrase);
      logger.info({ ip: req.ip, traceId: requestTraceId(req), outcome: 'unknown_user' }, 'password reset attempt');
      throw invalidRecovery();
    }
    if (!(await verifySecret(recoveryPassphrase, user.recovery_hash))) {
      logger.warn(
        { ip: req.ip, userId: user.id, traceId: requestTraceId(req), outcome: 'bad_passphrase' },
        'password reset attempt',
      );
      throw invalidRecovery();
    }

    const passwordHash = await hashSecret(newPassword);
    await db.transaction(async (trx) => {
      await trx('users').where({ id: user.id }).update({ password_hash: passwordHash, password_changed_at: trx.fn.now() });
      // A reset ends every existing session (docs/architecture/security.md, reset flow).
      await invalidateUserSessions(trx, user.id, 'password_reset');
    });

    logger.info(
      { ip: req.ip, userId: user.id, traceId: requestTraceId(req), outcome: 'success' },
      'password reset attempt',
    );
    clearSessionCookie(res);
    res.status(204).end();
  }),
);
