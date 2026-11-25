/**
 * Session lifetime rules, kept free of I/O so they can be unit-tested.
 * See the sessions table in docs/architecture/data-model.md.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Sliding idle timeout: a session expires 24 hours after its last authenticated activity. */
export const SESSION_IDLE_TTL_MS = 24 * HOUR_MS;
/** Hard cap: no session outlives 30 days from login, however active. Also the cookie lifetime. */
export const SESSION_MAX_LIFETIME_MS = 30 * 24 * HOUR_MS;
/** Only write a new expires_at when it would move by at least this much (limits DB writes). */
export const EXTEND_MIN_STEP_MS = HOUR_MS;
/**
 * In the last 24 hours before the hard cap, a user must log in again before doing anything
 * except finishing a game already in progress. Games are capped at 3 hours, so a game started
 * with more than 24 hours of session left always ends before the session does.
 */
export const REAUTH_WINDOW_MS = 24 * HOUR_MS;
/**
 * Ended (invalidated or expired) session rows are deleted at the user's next login once they
 * have been ended this long. Keeping them for a day lets a displaced device still get
 * SESSION_INVALIDATED ("signed in elsewhere") rather than a generic UNAUTHORIZED.
 */
export const ENDED_SESSION_RETENTION_MS = 24 * HOUR_MS;

export function sessionCapAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_MAX_LIFETIME_MS);
}

/** True once the session is within REAUTH_WINDOW_MS of its hard cap. */
export function isInReauthWindow(createdAt: Date, now: number = Date.now()): boolean {
  return sessionCapAt(createdAt).getTime() - now <= REAUTH_WINDOW_MS;
}

/**
 * The expires_at a session should move to on activity, or null if it should stay put
 * (the move would be under EXTEND_MIN_STEP_MS). Never past the hard cap.
 */
export function slidExpiry(createdAt: Date, expiresAt: Date, now: number = Date.now()): Date | null {
  const target = Math.min(now + SESSION_IDLE_TTL_MS, sessionCapAt(createdAt).getTime());
  return target - expiresAt.getTime() >= EXTEND_MIN_STEP_MS ? new Date(target) : null;
}
