import type { Knex } from 'knex';
import { dbPayloadBytes, dbQueriesTotal, dbQueryDuration, setGaugeSource } from './registry';

type Operation = 'select' | 'insert' | 'update' | 'delete';

/** The schema's tables (the `table` label is bounded to these; anything else is `other`). */
const TABLES = new Set([
  'users',
  'sessions',
  'invites',
  'rooms',
  'room_members',
  'games',
  'rounds',
  'round_players',
  'game_results',
  'game_events',
  'bug_reports',
]);
/** High-volume JSONB writes whose size is worth watching (db_payload_bytes). */
const PAYLOAD_TABLES = new Set(['games', 'game_events']);

const METHOD_OPERATIONS: Record<string, Operation> = {
  select: 'select',
  first: 'select',
  pluck: 'select',
  insert: 'insert',
  update: 'update',
  counter: 'update',
  del: 'delete',
};

/** What Knex passes with its query events. */
interface QueryData {
  __knexQueryUid?: string;
  method?: string;
  sql?: string;
  bindings?: readonly unknown[];
}

/**
 * select / insert / update / delete, or null for statements outside those four (transaction
 * control such as BEGIN and COMMIT, DDL from migrations), which are not recorded.
 */
export function operationOf(q: QueryData): Operation | null {
  const byMethod = q.method ? METHOD_OPERATIONS[q.method] : undefined;
  if (byMethod) return byMethod;
  // Raw queries: the leading keyword.
  const keyword = /^\s*\(?\s*([a-z]+)/i.exec(q.sql ?? '')?.[1]?.toLowerCase();
  return keyword === 'select' || keyword === 'insert' || keyword === 'update' || keyword === 'delete' ? keyword : null;
}

/** The first table the statement names, if it is one of the schema's; otherwise `other`. */
export function tableOf(sql: string | undefined): string {
  const name = /\b(?:from|into|update|join)\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql ?? '')?.[1]?.toLowerCase();
  return name && TABLES.has(name) ? name : 'other';
}

/**
 * The instrumentation wrapper for every query the app runs (docs/operations/observability-alerting.md,
 * Database metrics): db_queries_total and db_query_duration_seconds on each completion,
 * db_payload_bytes on inserts and updates to games and game_events, and db_pool_size on scrape.
 *
 * It listens to Knex's query events on the root instance, which also receives the queries run
 * inside transactions, so no call site has to opt in.
 */
export function instrumentKnex(db: Knex): void {
  const pending = new Map<string, { start: bigint; operation: Operation; table: string }>();

  db.on('query', (q: QueryData) => {
    const operation = operationOf(q);
    if (!operation || !q.__knexQueryUid) return;
    const table = tableOf(q.sql);
    pending.set(q.__knexQueryUid, { start: process.hrtime.bigint(), operation, table });
    if ((operation === 'insert' || operation === 'update') && PAYLOAD_TABLES.has(table)) {
      dbPayloadBytes.observe({ operation, table }, Buffer.byteLength(JSON.stringify(q.bindings ?? [])));
    }
  });

  const done = (q: QueryData | undefined, status: 'success' | 'error') => {
    const uid = q?.__knexQueryUid;
    const started = uid ? pending.get(uid) : undefined;
    if (!uid || !started) return;
    pending.delete(uid);
    const { operation, table } = started;
    dbQueriesTotal.inc({ operation, table, status });
    dbQueryDuration.observe({ operation, table }, Number(process.hrtime.bigint() - started.start) / 1e9);
  };
  db.on('query-response', (_response: unknown, q: QueryData) => done(q, 'success'));
  db.on('query-error', (_err: unknown, q: QueryData) => done(q, 'error'));

  setGaugeSource('dbPoolSize', () => {
    const pool = (db.client as { pool?: { numUsed(): number; numFree(): number } }).pool;
    return pool ? pool.numUsed() + pool.numFree() : 0;
  });
}
