import { parse as parseCookies } from 'cookie';
import { signedCookie } from 'cookie-parser';
import { config } from '../config';
import { authenticateToken, isInActiveGame, SESSION_COOKIE, slideSession, type AuthSession } from '../auth/sessions';
import type { InvalidationReason } from '../auth/sessionEvents';
import type { PublicUser } from '../auth/users';

export type SocketAuthFailure = 'UNAUTHORIZED' | 'SESSION_INVALIDATED' | 'REAUTH_REQUIRED' | 'CREDENTIAL_CHANGE_REQUIRED';

export type SocketAuthResult =
  | { ok: true; user: PublicUser; session: AuthSession }
  /** userId and traceId are set when the session was found, for logging the rejection. */
  | { ok: false; code: SocketAuthFailure; userId?: string; traceId?: string; reason?: InvalidationReason };

export const SESSION_ERROR_MESSAGES: Record<SocketAuthFailure, string> = {
  UNAUTHORIZED: 'Session is invalid or expired.',
  SESSION_INVALIDATED: 'Session has ended.',
  REAUTH_REQUIRED: 'Your session is about to expire. Please log in again.',
  CREDENTIAL_CHANGE_REQUIRED: 'You must change your password before continuing.',
};

/** session_error message for a socket whose session another request just ended. */
export const INVALIDATION_MESSAGES: Record<InvalidationReason, string> = {
  displaced: 'Session was ended by a newer login.',
  logout: 'Session was ended by a logout.',
  password_reset: 'Session was ended by a password reset.',
  credential_change: 'Session was ended by a password or recovery passphrase change.',
  admin_reset: 'Session was ended by an admin credential reset.',
};

/** The raw session token from a handshake Cookie header, or null if absent or the signature is wrong. */
export function sessionTokenFromCookieHeader(header: string | undefined): string | null {
  if (!header) return null;
  const raw = parseCookies(header)[SESSION_COOKIE];
  if (!raw) return null;
  // Signed cookies are "s:<value>.<signature>"; signedCookie returns false on a bad signature
  // and the input unchanged when it is not signed, which we also reject.
  if (!raw.startsWith('s:')) return null;
  const token = signedCookie(raw, config.sessionSecret);
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * The socket equivalent of the REST `authenticate()` middleware, run on connect:
 * the same session lookup, the same re-auth window rule (allowed only for a player returning to
 * a game in progress), and the credential-change lock. Slides the session only on success.
 */
export async function authenticateSocket(cookieHeader: string | undefined): Promise<SocketAuthResult> {
  const token = sessionTokenFromCookieHeader(cookieHeader);
  if (!token) return { ok: false, code: 'UNAUTHORIZED' };

  const result = await authenticateToken(token, { slide: false });
  if (!result.ok) return result;

  const ids = { userId: result.user.id, traceId: result.session.traceId };
  if (result.session.inReauthWindow && !(await isInActiveGame(result.user.id))) {
    return { ok: false, code: 'REAUTH_REQUIRED', ...ids };
  }
  if (result.user.requiresCredentialChange) return { ok: false, code: 'CREDENTIAL_CHANGE_REQUIRED', ...ids };

  return { ok: true, user: result.user, session: await slideSession(result.session) };
}

/**
 * Re-validates a connected socket's session on a game action, sliding its expiry. Returns null if
 * the session is still the one the socket connected with and valid, else the session_error code.
 * The re-auth window does not apply: the user is playing a game in progress.
 */
export async function recheckSocketSession(cookieHeader: string | undefined, sessionId: string): Promise<SocketAuthFailure | null> {
  const token = sessionTokenFromCookieHeader(cookieHeader);
  if (!token) return 'UNAUTHORIZED';
  const result = await authenticateToken(token);
  if (!result.ok) return result.code;
  return result.session.id === sessionId ? null : 'SESSION_INVALIDATED';
}
