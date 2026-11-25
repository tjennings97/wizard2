import { EventEmitter } from 'events';
import type { Knex } from 'knex';

/**
 * In-process notification seam for ended sessions. The auth code emits here; the socket layer
 * subscribes and disconnects every socket using an ended session. Auth never imports socket code.
 *
 * Single-instance only: a second server instance would need a shared channel (for example,
 * Postgres LISTEN/NOTIFY or the Redis adapter) to hear about another instance's logins.
 */
interface SessionEventMap {
  /** Session ids that were just invalidated (newer login, password reset, logout). */
  invalidated: [sessionIds: string[]];
}

class SessionEvents extends EventEmitter<SessionEventMap> {}

export const sessionEvents = new SessionEvents();

/**
 * Emits `invalidated` once the change is durable: after `conn` commits if it is a transaction
 * (never, if it rolls back), straight away otherwise.
 */
export function emitSessionsInvalidated(conn: Knex | Knex.Transaction, sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  const emit = () => {
    sessionEvents.emit('invalidated', sessionIds);
  };
  if (conn.isTransaction) {
    (conn as Knex.Transaction).executionPromise.then(emit, () => {});
  } else {
    emit();
  }
}
