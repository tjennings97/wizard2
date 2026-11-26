import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sendError } from '../http/errors';
import { logContext } from '../logContext';
import {
  authenticateToken,
  clearSessionCookie,
  isInActiveGame,
  SESSION_COOKIE,
  slideSession,
  type AuthSession,
} from './sessions';
import type { PublicUser } from './users';

export type { AuthSession };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth. Read from the database on every request, never from the cookie. */
      user?: PublicUser;
      authSession?: AuthSession;
    }
  }
}

const MESSAGES = {
  UNAUTHORIZED: 'Session is invalid or expired.',
  SESSION_INVALIDATED: 'Session was ended by a newer login.',
  REAUTH_REQUIRED: 'Your session is about to expire. Please log in again.',
  CREDENTIAL_CHANGE_REQUIRED: 'You must change your password before continuing.',
} as const;

function reauthRequired(res: Response): void {
  // The session is still valid (an in-progress game may rely on it), so the cookie is left in
  // place; logging in again replaces it.
  sendError(res, 401, { code: 'REAUTH_REQUIRED', message: MESSAGES.REAUTH_REQUIRED });
}

interface AuthOptions {
  /**
   * Skip the re-auth window check. Only for routes that must always work while the session
   * is valid, such as logout.
   */
  allowInReauthWindow?: boolean;
  /**
   * Allow users whose credentials were reset by an admin (requires_credential_change) to use
   * this route. Only for the routes needed to complete the change: GET /users/me,
   * PATCH /users/me, and POST /auth/logout. Every other route returns 403
   * CREDENTIAL_CHANGE_REQUIRED until the change is made.
   */
  allowDuringCredentialChange?: boolean;
}

/**
 * Reads the signed HTTP-only session cookie, hashes the token, and looks the session up.
 * Attaches req.user and req.authSession, or responds 401 if the session is missing, expired, or
 * invalidated. The session's expiry slides forward only for requests that pass every check.
 *
 * In the last 24h before the session's 30-day cap, responds 401 REAUTH_REQUIRED unless the
 * user is an active player in a game in progress, who may finish it (games are capped at 3h).
 *
 * While the user's requires_credential_change flag is set, responds 403
 * CREDENTIAL_CHANGE_REQUIRED unless the route opts in with allowDuringCredentialChange.
 */
export function authenticate(options: AuthOptions = {}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // signedCookies holds `false` when the signature does not match (tampered cookie).
    const token: unknown = req.signedCookies?.[SESSION_COOKIE];
    try {
      const result =
        typeof token === 'string' && token.length > 0
          ? await authenticateToken(token, { slide: false })
          : ({ ok: false, code: 'UNAUTHORIZED' } as const);

      if (!result.ok) {
        clearSessionCookie(res);
        sendError(res, 401, { code: result.code, message: MESSAGES[result.code] });
        return;
      }

      if (
        result.session.inReauthWindow &&
        !options.allowInReauthWindow &&
        !(await isInActiveGame(result.user.id))
      ) {
        reauthRequired(res);
        return;
      }

      if (result.user.requiresCredentialChange && !options.allowDuringCredentialChange) {
        sendError(res, 403, {
          code: 'CREDENTIAL_CHANGE_REQUIRED',
          message: MESSAGES.CREDENTIAL_CHANGE_REQUIRED,
        });
        return;
      }

      req.user = result.user;
      req.authSession = await slideSession(result.session);
      // Everything the request does from here logs with the session's traceId.
      logContext.run({ traceId: req.authSession.traceId, userId: req.user.id }, next);
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth = authenticate();

/**
 * Stack after requireAuth on routes that commit the user to a new game: creating a room,
 * joining a room, and starting a game. Requires more than 24h left before the session's
 * 30-day cap, even for a user who is currently mid-game, so no game can outlast the session.
 */
export function requireSessionRunway(req: Request, res: Response, next: NextFunction): void {
  if (!req.authSession) {
    next(new Error('requireSessionRunway must run after requireAuth'));
    return;
  }
  if (req.authSession.inReauthWindow) {
    reauthRequired(res);
    return;
  }
  next();
}
