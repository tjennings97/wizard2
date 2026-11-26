import { AsyncLocalStorage } from 'async_hooks';

/** Fields every log line written while handling one request carries (see logger.ts mixin). */
export interface LogContext {
  traceId: string;
  userId: string;
}

/**
 * Set by authenticate() for the rest of an authenticated request, so code below the routes
 * (the room service, for one) logs the session's traceId and userId without passing them down.
 */
export const logContext = new AsyncLocalStorage<LogContext>();
