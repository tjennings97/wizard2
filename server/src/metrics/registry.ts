import fs from 'fs';
import path from 'path';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Every Prometheus metric the app exposes on GET /api/v1/metrics. The names, types and labels are
 * the Metrics Registry in docs/operations/observability-alerting.md; the update points are listed
 * there too ("Metric update points"). This module has no dependencies on the layers it measures:
 * they import it, and the gauges read their current value from a source registered at startup.
 */

/** RAILWAY_GIT_COMMIT_SHA (7 chars) in production, else the server package version. */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (sha) return sha.slice(0, 7);
  if (env.npm_package_version) return env.npm_package_version;
  try {
    // src/metrics and dist/metrics are both two levels below server/package.json.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const registry = new Registry();
registry.setDefaultLabels({ env: config.nodeEnv, version: appVersion() });
collectDefaultMetrics({ register: registry });

// --- current-value sources --------------------------------------------------------------------

/**
 * The gauges are read when Prometheus scrapes rather than counted up and down, so they cannot
 * drift (a missed decrement, or rooms left open by the previous process). Each source is set by
 * the layer that owns the state (see server.ts and db/knex.ts).
 */
export type GaugeSource = () => number | Promise<number>;
export type GaugeName = 'wsConnections' | 'playersConnected' | 'gamesActive' | 'roomsActive' | 'dbPoolSize';
const sources: Partial<Record<GaugeName, GaugeSource>> = {};

export function setGaugeSource(name: GaugeName, source: GaugeSource): void {
  sources[name] = source;
}

function sourcedGauge(name: string, help: string, source: GaugeName) {
  return new Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      const read = sources[source];
      if (!read) return;
      try {
        this.set(await read());
      } catch (err) {
        // Keep the last value: a failed read (say the database is down) must not fail the scrape.
        logger.warn({ err, event: 'metrics.collect_failed', metric: name }, 'metric source failed');
      }
    },
  });
}

// --- infrastructure ---------------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by route pattern.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests, by route pattern.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const wsConnectionsActive = sourcedGauge('ws_connections_active', 'Current Socket.io connections.', 'wsConnections');

export const wsReconnectionsTotal = new Counter({
  name: 'ws_reconnections_total',
  help: 'Players whose seat was held after a disconnect, by outcome: success (back in the window) or timeout.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// --- game -------------------------------------------------------------------------------------

export const roomsActive = sourcedGauge('rooms_active', 'Rooms in the open or in_progress state.', 'roomsActive');
export const gamesActive = sourcedGauge('games_active', 'Games in progress in this process.', 'gamesActive');

export const gamesStartedTotal = new Counter({
  name: 'games_started_total',
  help: 'Games started since process start.',
  registers: [registry],
});

export const gamesCompletedTotal = new Counter({
  name: 'games_completed_total',
  help: 'Games ended since process start, by status.',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const playersConnected = sourcedGauge(
  'players_connected',
  'Users with at least one authenticated socket connection.',
  'playersConnected',
);

export const bugReportsTotal = new Counter({
  name: 'bug_reports_total',
  help: 'Bug reports submitted, by severity (none when the reporter gave none).',
  labelNames: ['severity'] as const,
  registers: [registry],
});

// --- database ---------------------------------------------------------------------------------

export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Time the app waited for each database query, in seconds.',
  labelNames: ['operation', 'table'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const dbQueriesTotal = new Counter({
  name: 'db_queries_total',
  help: 'Database queries, by operation, table and status.',
  labelNames: ['operation', 'table', 'status'] as const,
  registers: [registry],
});

export const dbPoolSize = sourcedGauge('db_pool_size', 'Connections in the Knex pool (in use plus free).', 'dbPoolSize');

export const dbPayloadBytes = new Histogram({
  name: 'db_payload_bytes',
  help: 'Estimated bytes written per insert or update on games and game_events.',
  labelNames: ['operation', 'table'] as const,
  buckets: [256, 1024, 4096, 16384, 65536, 262144, 1048576],
  registers: [registry],
});

// --- security (docs/architecture/security.md, "Security events") -------------------------------

export const authLoginFailuresTotal = new Counter({
  name: 'auth_login_failures_total',
  help: 'Failed logins, by reason: unknown_user or bad_password.',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const rateLimitHitsTotal = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Requests refused by a rate limiter, by endpoint.',
  labelNames: ['endpoint'] as const,
  registers: [registry],
});

export const passwordResetAttemptsTotal = new Counter({
  name: 'auth_password_reset_attempts_total',
  help: 'POST /auth/reset-password attempts that reached the credential check, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
