import { EventEmitter } from 'events';
import type { Knex } from 'knex';

/**
 * In-process notification seam for ended sessions. The auth code emits here; the socket layer
 * subscribes and disconnects every socket using an ended session. Auth never imports socket code.
 *
 * Single-instance only: a second server instance would need a shared channel (for example,
 * Postgres LISTEN/NOTIFY or the Redis adapter) to hear about another instance's logins.
 */

/** Why the sessions ended. Sent to the displaced sockets so the client can say what happened. */
export type InvalidationReason = 'displaced' | 'logout' | 'password_reset';

interface SessionEventMap {
  /** Session ids that were just invalidated, and why. */
  invalidated: [sessionIds: string[], reason: InvalidationReason];
}

class SessionEvents extends EventEmitter<SessionEventMap> {}

export const sessionEvents = new SessionEvents();

/** The outermost transaction: a nested one (savepoint) is only durable once its root commits. */
function rootTransaction(trx: Knex.Transaction): Knex.Transaction {
  let root = trx;
  while (root.parentTransaction) root = root.parentTransaction;
  return root;
}

/**
 * Emits `invalidated` once the change is durable: after `conn`'s outermost transaction commits
 * if it is a transaction (never, if it rolls back), straight away otherwise.
 */
export function emitSessionsInvalidated(
  conn: Knex | Knex.Transaction,
  sessionIds: string[],
  reason: InvalidationReason,
): void {
  if (sessionIds.length === 0) return;
  const emit = () => {
    sessionEvents.emit('invalidated', sessionIds, reason);
  };
  if (conn.isTransaction) {
    const trx = conn as Knex.Transaction;
    // A savepoint can be released and its parent still roll back, so wait for the root. If the
    // savepoint itself rolls back, its writes are gone even when the root commits.
    Promise.all([trx.executionPromise, rootTransaction(trx).executionPromise]).then(emit, () => {});
  } else {
    emit();
  }
}
