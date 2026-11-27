# Wizard — Observability and Alerting Guide

Oct 23, 2026 · @TJ

## Overview

This guide defines the observability and alerting strategy for the Wizard card game. It covers structured logging, Prometheus metrics, Grafana Cloud dashboards, alert definitions and thresholds, k6 performance test metric ingestion, and log retention constraints. It is written for both developer reference (how to implement and configure each component) and operational use (how to read dashboards, interpret alerts, and respond to incidents).

All observability components are grounded in the architecture decisions in the System Architecture Document and the infrastructure decisions in the Deployment and Infrastructure Plan. This guide does not restate those decisions — it operationalizes them.

**Observability stack summary:**

- **Structured logging:** pino emitting JSON to stdout, captured by Railway and forwarded to Grafana Cloud Loki
- **Metrics:** prom-client exposing a `/metrics` endpoint, scraped by Grafana Cloud every 30 seconds
- **Dashboards:** Grafana Cloud, a production dashboard plus k6 performance trends
- **Alerting:** Grafana Cloud alerting rules, notifications delivered via email
- **Performance test metrics:** k6 pushing results to Grafana Cloud via Prometheus remote write during CI runs
- **Trace correlation:** a `traceId` UUID generated per session, propagated through all logs and bug reports, and stored on bug report records as the correlation key between user reports and server logs

## Observability Architecture

The diagram below shows how the observability components connect at runtime.

```
┌─────────────────────────────────────────────────────────┐
│                   Railway (production)                  │
│                                                         │
│  Express app                                            │
│  ├── pino → stdout → Railway log capture                │
│  └── prom-client → GET /metrics (bearer token required) │
└─────────────────────────────────────────────────────────┘
         │ log stream (forwarded)       │ scraped every 30s
         ▼                              ▼
  Grafana Cloud Loki           Grafana Cloud Prometheus
         │                              │
         └──────────┬───────────────────┘
                    ▼
            Grafana Dashboards
                    │
              Alert rules
                    │
               Email alerts

┌─────────────────────────────────────────────────────────┐
│              GitHub Actions (ci-perf.yml)               │
│  k6 run -o experimental-prometheus-rw                   │
│      → Grafana Cloud Prometheus remote write endpoint   │
└─────────────────────────────────────────────────────────┘
```

**Key design points:**

- The Express app is the only component that emits observability data. The game engine and persistence layers are instrumented at the socket and API layers above them — the engine itself has no logging or metrics calls.
- Only production sends metrics and logs to Grafana Cloud. Every metric series and log stream still carries an `env` label (`production`), so another environment could be added later without changing queries.
- The `/metrics` endpoint is protected by a bearer token stored as a Railway environment variable (`PROMETHEUS_BEARER_TOKEN`). Grafana Cloud is configured with this token as a scrape header. The endpoint is publicly accessible over HTTPS (Grafana Cloud's scraper reaches it from outside Railway), but is protected from unauthorised access by the bearer token requirement.
- The `traceId` for a session is generated at login and stored on the session record. It is attached to `req.user` by session middleware and to `socket.data` on socket connect. All log calls in the API and socket layers include it automatically. It is also written to the `bug_reports` table when a bug report is submitted.

## Structured Logging

### Implementation

All server-side logging uses pino, configured to emit newline-delimited JSON to stdout. Railway captures stdout automatically and makes it available in its log viewer. Logs are also forwarded to Grafana Cloud Loki (see [Log Retention and Forwarding](#log-retention-and-forwarding)).

pino is initialised once in a shared `logger.ts` module and imported wherever logging is needed. Pretty-printing is disabled in production to keep output compact and machine-readable. In development, `pino-pretty` may be used locally for readability but must not be active in the production build.

### Log entry structure

Every log entry must include the following fields:

| Field | Type | Description |
| --- | --- | --- |
| `timestamp` | ISO 8601 string | Server time of the log event |
| `level` | string | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `traceId` | UUID string | Correlation ID for the session; present on all authenticated calls |
| `userId` | string \| null | Authenticated user ID; null for unauthenticated requests |
| `roomId` | string \| null | Current room ID if the event is room-scoped; null otherwise |
| `gameId` | string \| null | Current game ID if the event is game-scoped; null otherwise |
| `event` | string | A short machine-readable event name (e.g. `game.card_played`, `auth.login_failed`) |
| `message` | string | Human-readable description of the event |

Additional fields may be added per event type (e.g. `cardPlayed`, `round`, `errorCode`) and are included in the same flat JSON object.

### Log levels

| Level | Usage |
| --- | --- |
| `info` | Normal application events: logins, room opens, game starts, game completions, bug report submissions |
| `warn` | Recoverable unexpected conditions: reconnection timeouts, invalid socket events, auth failures |
| `error` | Unhandled exceptions, database errors, failed game state persists |
| `fatal` | Startup failures (missing config, failed DB connection); process exits after logging |
| `debug` | Verbose per-event detail for local development; disabled in production |
| `trace` | Reserved for deep diagnostic use; never enabled in production |

Production runs at `info` level. The log level is set via the `LOG_LEVEL` environment variable and defaults to `info` if unset.

### What to log

**Always log at `info`:**

- Successful login and logout (include `userId`, `traceId`)
- Room opened, player joined, player left, host transferred
- Game started, round started, game completed (include `gameId`, player count, round count)
- Bug report submitted (include `traceId`, `severity`)
- Server startup with environment name and config summary (never log secret values)

**Always log at `warn`:**

- Reconnection timer expired (player treated as quit)
- Socket event received from an unauthenticated or unrecognised connection
- Game action rejected (out-of-turn, illegal card, invalid bid)
- Invite code redemption failed

**Always log at `error`:**

- Any unhandled exception in a route handler or socket event handler
- Database write failure for game state checkpoint or event log entry
- Failed to emit a socket event after multiple retries

**Always log at `info` for socket events:**

- Player joined or left a Socket.io room (include `userId`, `roomId`)
- Player disconnected — 30-second reconnection timer started (include `userId`, `gameId`)
- Player reconnected successfully within the window (include `userId`, `gameId`, elapsed time)
- Reconnection timer expired — player treated as quit (include `userId`, `gameId`)
- `session_error` (`SESSION_INVALIDATED`) sent to a displaced socket (a new login from another device)

**Always log at `info` for database operations:**

- Successful game state checkpoint written after each round (include `gameId`, `roundNumber`)
- Game result and event log entries persisted on game completion (include `gameId`)
- Bug report written to the database (include `traceId`, `severity`)

**Always log at `warn` or `error` for database operations:**

- Query timeout or connection error: `warn` on first occurrence, `error` if the operation cannot be retried successfully
- Game state checkpoint write failure: `error` — this risks losing round state on a server restart
- Event log write failure: `error` — this is append-only audit data and any gap should be visible

**Never log:**

- Passwords, recovery passphrases, or session tokens (even hashed)
- Full card hands outside of `debug` level
- Any field from the `bug_reports.context` JSONB that may contain user-entered text in a format that could include credentials

### Viewing logs

**Railway dashboard:** Logs are viewable in the Railway project dashboard under the `wizard-app` service. The dashboard search supports plain-text filtering. On the Hobby plan, the dashboard view window is 7 days.

**Grafana Cloud Loki (via Explore):** Once log forwarding is configured (see [Log Retention and Forwarding](#log-retention-and-forwarding)), logs are queryable in Grafana Cloud using LogQL. Navigate to **Explore → Loki** and filter by labels. Example queries:

```logql
# All error-level logs in production
{env="production", app="wizard"} | json | level = "error"

# All events for a specific trace ID (correlate with a bug report)
{env="production", app="wizard"} | json | traceId = "<uuid>"

# Game completions in the last 24 hours
{env="production", app="wizard"} | json | event = "game.completed"
```

## Metrics Registry

All metrics are registered using `prom-client` and exposed on `GET /metrics`. The endpoint requires a `Bearer <PROMETHEUS_BEARER_TOKEN>` header. Requests without a valid token receive a 401. Grafana Cloud is configured to pass this token as a scrape header.

Every metric series includes two global labels applied via prom-client's default labels mechanism — they do not need to be specified per metric:

- `env` — set from the `NODE_ENV` environment variable (`production` in the deployed app)
- `version` — set from the application version string (e.g. the value of `npm_package_version`, or `RAILWAY_GIT_COMMIT_SHA` truncated to 7 characters). This label allows dashboard queries to be scoped to a specific deployed version and makes it straightforward to correlate a metric change with a particular release.

### Infrastructure metrics

The following metrics are collected automatically by prom-client's default collectors (CPU, memory, event loop lag, GC) in addition to the custom metrics below.

| Metric name | Type | Labels | Description |
| --- | --- | --- | --- |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code`, `env` | HTTP request duration in seconds, bucketed. Covers all `/api/v1/` routes. |
| `http_requests_total` | Counter | `method`, `route`, `status_code`, `env` | Total HTTP request count. Used to compute error rate and throughput. |
| `ws_connections_active` | Gauge | `env` | Current number of active Socket.io connections. |
| `ws_reconnections_total` | Counter | `outcome`, `env` | Total WebSocket reconnection attempts. `outcome` label values: `success`, `timeout`. |

### Game metrics

| Metric name | Type | Labels | Description |
| --- | --- | --- | --- |
| `rooms_active` | Gauge | `env` | Current number of rooms in Open or In Progress state. |
| `games_active` | Gauge | `env` | Current number of games in the In Progress state. |
| `games_started_total` | Counter | `env` | Total games started since process start. |
| `games_completed_total` | Counter | `status`, `env` | Total games ended. `status` label values: `complete`, `incomplete`. |
| `players_connected` | Gauge | `env` | Current number of authenticated players with an active socket connection. |
| `bug_reports_total` | Counter | `severity`, `env` | Total bug reports submitted. `severity` label values: `low`, `medium`, `high`. |

### Database metrics

| Metric name | Type | Labels | Description |
| --- | --- | --- | --- |
| `db_query_duration_seconds` | Histogram | `operation`, `table`, `env`, `version` | Duration of each database query in seconds. Covers all Knex query builder calls in the persistence layer. |
| `db_queries_total` | Counter | `operation`, `table`, `status`, `env`, `version` | Total query count. `operation` values: `select`, `insert`, `update`, `delete`. `status` values: `success`, `error`. |
| `db_pool_size` | Gauge | `env`, `version` | Current number of connections in the Knex connection pool. |
| `db_payload_bytes` | Histogram | `operation`, `table`, `env`, `version` | Size in bytes of data written per query. Measured on `insert` and `update` operations for high-volume tables (`game_events`, `games`) only. |

All database metrics are emitted by the Express application, not by Postgres itself. The instrumentation wrapper around Knex measures client-side latency — the time the app spends waiting for a query response — which includes both Postgres execution time and the network round-trip between the app and database services within Railway. At this scale and deployment topology these will be close, but the figures should be read as "time the app was blocked waiting for the DB" rather than internal Postgres query execution time. The `operation` and `table` labels are set in the wrapper; because no raw SQL exists outside the persistence layer, all database calls pass through it, keeping instrumentation centralised.

**Note on cardinality:** the `table` label is bounded to the fixed schema table set (`users`, `sessions`, `rooms`, `room_members`, `games`, `rounds`, `round_players`, `game_results`, `game_events`, `invites`, `bug_reports`) and `operation` has four values. Combined with the two global labels, total series count remains well within Grafana Cloud's free tier limit of 10,000 series.

### Metric update points

Metrics must be updated at the following points in the application:

- `http_request_duration_seconds` and `http_requests_total`: updated by Express middleware on every response, using the route pattern (e.g. `/api/v1/rooms/:id`), not the raw URL, to avoid high-cardinality label values.
- `ws_connections_active`: incremented on socket connect, decremented on socket disconnect.
- `ws_reconnections_total`: incremented in the reconnection handler — `outcome=success` when the 30-second timer is cleared by a reconnecting socket, `outcome=timeout` when the timer expires.
- `rooms_active`: incremented when a room is created, decremented when a room transitions to Closed.
- `games_active`: incremented when a game starts, decremented when a game ends (complete or incomplete).
- `games_started_total`: incremented when a game starts.
- `games_completed_total`: incremented when a game ends, with the appropriate `status` label.
- `players_connected`: incremented on authenticated socket connect, decremented on socket disconnect.
- `bug_reports_total`: incremented in the `POST /api/v1/bug-reports` route handler after a successful write.
- `db_query_duration_seconds` and `db_queries_total`: updated by a thin instrumentation wrapper around all Knex query calls in the persistence layer. The wrapper records operation type, table name, and outcome (`success` or `error`) on every query completion, before the result is returned to the caller.
- `db_pool_size`: sampled on a 10-second interval using `knex.client.pool.numUsed()` and `knex.client.pool.numFree()`. Per-query updates are avoided to reduce noise.
- `db_payload_bytes`: updated in the instrumentation wrapper for `insert` and `update` calls on `game_events` and `games` tables only. Byte size is estimated using `Buffer.byteLength(JSON.stringify(data))` before the query executes.

### Health endpoint

`GET /health` (no authentication required) returns `{ status: "ok" }` with HTTP 200 when the application is healthy. It returns HTTP 500 if a liveness check fails. This endpoint is used by Railway for health checks and is also polled by the Grafana Cloud synthetic monitoring uptime check (see [Alerting](#alerting)).

## Dashboards

All dashboards are hosted in Grafana Cloud. Dashboards cover production. Panels keep an `env` template variable so another environment could be added later.

### Environment variable setup

In the Grafana dashboard settings, add a template variable:

- **Name:** `env`
- **Type:** Custom
- **Values:** `production`
- **Default:** `production`

All panel queries include `env="$env"` as a label selector.

Add a second template variable for version:

- **Name:** `version`
- **Type:** Query
- **Data source:** Prometheus
- **Query:** `label_values(http_requests_total{env="$env"}, version)`
- **Default:** All

This allows any panel to be filtered to a specific deployed version by adding `version="$version"` to its label selectors. Use it when investigating whether a regression was introduced by a specific deploy.

### Infrastructure health dashboard

This dashboard covers the runtime health of the Express application and WebSocket layer.

| Panel | Query (PromQL) | Visualisation |
| --- | --- | --- |
| HTTP request rate | `sum(rate(http_requests_total{env="$env"}[5m])) by (route)` | Time series |
| HTTP error rate (%) | `sum(rate(http_requests_total{env="$env", status_code=~"5.."}[5m])) / sum(rate(http_requests_total{env="$env"}[5m])) * 100` | Time series with 1% threshold line |
| API p95 latency | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{env="$env"}[5m])) by (le, route))` | Time series |
| Active WebSocket connections | `ws_connections_active{env="$env"}` | Stat (current value) |
| WebSocket reconnection success rate (%) | `sum(rate(ws_reconnections_total{env="$env", outcome="success"}[10m])) / sum(rate(ws_reconnections_total{env="$env"}[10m])) * 100` | Time series |
| HTTP 4xx rate | `sum(rate(http_requests_total{env="$env", status_code=~"4.."}[5m])) by (route)` | Time series |

### Database health dashboard

This panel group can be added to the infrastructure dashboard or maintained as a separate dashboard tab.

| Panel | Query (PromQL) | Visualisation |
| --- | --- | --- |
| DB query rate by operation | `sum(rate(db_queries_total{env="$env", version="$version"}[5m])) by (operation)` | Time series |
| DB query error rate (%) | `sum(rate(db_queries_total{env="$env", version="$version", status="error"}[5m])) / sum(rate(db_queries_total{env="$env", version="$version"}[5m])) * 100` | Time series |
| DB p95 query duration by operation | `histogram_quantile(0.95, sum(rate(db_query_duration_seconds_bucket{env="$env", version="$version"}[5m])) by (le, operation))` | Time series |
| DB p95 query duration by table | `histogram_quantile(0.95, sum(rate(db_query_duration_seconds_bucket{env="$env", version="$version"}[5m])) by (le, table))` | Time series |
| DB connection pool size | `db_pool_size{env="$env", version="$version"}` | Stat (current value) |
| DB write payload size (p95, bytes) | `histogram_quantile(0.95, sum(rate(db_payload_bytes_bucket{env="$env", version="$version"}[5m])) by (le, table))` | Time series |

### Game activity dashboard

This dashboard covers game lifecycle and player activity.

| Panel | Query (PromQL) | Visualisation |
| --- | --- | --- |
| Active games | `games_active{env="$env"}` | Stat (current value) |
| Active rooms | `rooms_active{env="$env"}` | Stat (current value) |
| Players connected | `players_connected{env="$env"}` | Stat (current value) |
| Games started (rate) | `rate(games_started_total{env="$env"}[1h])` | Time series |
| Games completed by status | `sum(rate(games_completed_total{env="$env"}[1h])) by (status)` | Time series |
| Reconnection outcomes | `sum(rate(ws_reconnections_total{env="$env"}[10m])) by (outcome)` | Bar chart |
| Bug reports by severity | `sum(rate(bug_reports_total{env="$env"}[1h])) by (severity)` | Bar chart |

### Log exploration (Loki)

Loki is available as a separate data source in Grafana Cloud Explore. It is not embedded in the dashboard panels above but is used for ad-hoc investigation. See the LogQL examples in [Structured Logging](#structured-logging).

To add a Loki logs panel to any dashboard, use the Logs visualisation type with a LogQL query such as:

```logql
{env="$env", app="wizard"} | json | level = "error"
```

### k6 performance test dashboard

See [k6 Performance Test Metrics](#k6-performance-test-metrics) for setup. Once k6 data is flowing into Grafana Cloud, import the official k6 Prometheus dashboard (Grafana dashboard ID **19665**) from the Grafana dashboard library. This dashboard visualises k6's built-in metrics (virtual users, request rate, response time percentiles, error rate) for each test run. Filter by the `testid` tag to isolate individual CI runs.

## Alerting

Alerts are defined in Grafana Cloud's alerting system using PromQL rules. All alerts deliver notifications to a single email contact point. Alert rules are scoped to `env="production"`.

### Contact point

Configure one contact point in Grafana Cloud Alerting:

- **Type:** Email
- **Name:** `wizard-oncall`
- **Address:** `[RECIPIENT EMAIL ADDRESS]`

All alert rules reference the `wizard-oncall` contact point via a notification policy.

### Severity definitions

| Severity | Meaning | Expected response |
| --- | --- | --- |
| **Sev 1** | Service is down or critically degraded; players are affected now | Immediate investigation; consider rollback if cause is a recent deploy |
| **Sev 2** | Elevated error rate or degraded performance; service is operational but impaired | Investigate within the hour; no immediate rollback required |

### Alert rules

#### Sev 1 — Service unavailable (health check failure)

- **Condition:** `GET /health` returns a non-200 response for 2 consecutive scrape intervals (approximately 1 minute)
- **PromQL:** Grafana Cloud synthetic monitoring uptime check on `https://<production-domain>/health`; alert when uptime check status is DOWN
- **Implementation note:** Configure a Grafana Cloud synthetic monitoring HTTP check against `/health`. Set check interval to 1 minute. Alert when the check fails for 2 consecutive periods.
- **Rationale:** A health check failure indicates the application process is down or unresponsive. This is categorically different from an elevated error rate — it means no requests are being served at all. The 2-consecutive-period window avoids alerting on transient Railway restarts during a normal deploy.

#### Sev 1 — Sustained high HTTP error rate

- **Condition:** The proportion of 5xx HTTP responses exceeds 1% of total requests consistently for 10 minutes
- **PromQL:**

```promql
(
  sum(rate(http_requests_total{env="production", status_code=~"5.."}[10m]))
  /
  sum(rate(http_requests_total{env="production"}[10m]))
) * 100 > 1
```

- **For:** 10 minutes
- **Rationale:** Transient errors are expected at low rates. A sustained rate above 1% over 10 minutes indicates a systematic failure in the API layer, a broken game action handler, or a database connectivity problem.

#### Sev 1 — WebSocket error spike

- **Condition:** The WebSocket reconnection timeout rate exceeds 20% of total reconnection attempts over a 10-minute window
- **PromQL:**

```promql
(
  sum(rate(ws_reconnections_total{env="production", outcome="timeout"}[10m]))
  /
  sum(rate(ws_reconnections_total{env="production"}[10m]))
) * 100 > 20
```

- **For:** 10 minutes
- **Rationale:** A high reconnection timeout rate means players are being dropped from games rather than successfully reconnecting. This directly disrupts active gameplay. A 20% threshold allows for natural churn (mobile network drops, page refreshes) while catching systematic connectivity failures.

#### Sev 2 — API latency degradation

- **Condition:** The p95 response time for any non-game API route exceeds 300ms consistently for 10 minutes
- **PromQL:**

```promql
histogram_quantile(
  0.95,
  sum(rate(http_request_duration_seconds_bucket{env="production"}[5m])) by (le, route)
) > 0.3
```

- **For:** 10 minutes
- **Rationale:** The PRD specifies a p95 response time target of under 300ms for non-game endpoints. Sustained breach of this threshold indicates resource pressure (database slowness, event loop saturation) before it escalates to an error rate spike.

#### Sev 2 — Application error volume spike

- **Condition:** The rate of `error`-level log events in Loki exceeds a sustained threshold. This alert is defined as a Grafana Cloud Loki alert rule.
- **LogQL:**

```logql
sum(rate({env="production", app="wizard"} | json | level="error" [10m])) > 0.1
```

- **Threshold:** More than 0.1 error-level log lines per second (approximately 6 per minute) sustained over 10 minutes
- **Rationale:** This alert catches application-layer errors (unhandled exceptions, failed DB writes) that may not surface immediately as 5xx HTTP responses — for example, errors in socket event handlers or background tasks.

### Alert summary table

| Alert | Severity | Trigger condition | Window |
| --- | --- | --- | --- |
| Service unavailable | Sev 1 | `/health` check DOWN for 2 consecutive checks | \~1 minute |
| High HTTP error rate | Sev 1 | 5xx rate > 1% of all requests | 10 minutes |
| WebSocket timeout spike | Sev 1 | Reconnection timeout rate > 20% | 10 minutes |
| API latency degradation | Sev 2 | p95 latency > 300ms on any route | 10 minutes |
| Application error volume | Sev 2 | Error log rate > 0.1/s | 10 minutes |

### Alert suppression during deploys

Railway redeploys the app automatically on push to `main`. A redeploy causes a brief process restart during which the health check will fail and WebSocket connections will be disrupted. To avoid spurious Sev 1 alerts during planned deploys, manually silence the health check and WebSocket alerts in Grafana Cloud for a 5-minute window around each production deploy. This can be done via Grafana's silence feature in the Alerting section.

## k6 Performance Test Metrics

k6 performance tests run on a schedule in CI against the app and a throwaway Postgres started in the CI job (see the Deployment and Infrastructure Plan, `ci-perf.yml`). Rather than storing results only as CI artifacts, k6 is configured to push metrics directly to Grafana Cloud via the Prometheus remote write protocol. This means performance test results are visible in the same Grafana Cloud instance as runtime metrics, queryable in PromQL, and displayable on a dedicated dashboard.

### How it works

k6 uses its `experimental-prometheus-rw` output flag to send time-series data to Grafana Cloud's remote write endpoint during the test run. All k6 metric series have a `k6_` prefix and are labelled with a `testid` tag (set per CI run) to allow individual runs to be isolated in queries.

Grafana Cloud's free tier includes 10,000 Prometheus series. k6 generates a modest number of series per run (one series per metric per scenario), well within this limit at the current test scale.

### Required Grafana Cloud credentials

In the Grafana Cloud portal (grafana.com → Cloud Portal → Prometheus → Details):

1. Copy the **Remote Write Endpoint URL**
2. Copy the **Username / Instance ID**
3. Create an **Access Policy Token** with the `metrics:write` scope

These three values are stored as GitHub Actions secrets:

| Secret name | Value |
| --- | --- |
| `GRAFANA_REMOTE_WRITE_URL` | Remote write endpoint URL |
| `GRAFANA_REMOTE_WRITE_USERNAME` | Prometheus instance username / ID |
| `GRAFANA_REMOTE_WRITE_PASSWORD` | Access Policy Token |

### CI workflow configuration (`ci-perf.yml`)

The k6 run step in the GitHub Actions workflow passes the remote write credentials as environment variables:

```yaml
- name: Run k6 performance tests
  env:
    K6_PROMETHEUS_RW_SERVER_URL: ${{ secrets.GRAFANA_REMOTE_WRITE_URL }}
    K6_PROMETHEUS_RW_USERNAME: ${{ secrets.GRAFANA_REMOTE_WRITE_USERNAME }}
    K6_PROMETHEUS_RW_PASSWORD: ${{ secrets.GRAFANA_REMOTE_WRITE_PASSWORD }}
    K6_PROMETHEUS_RW_TREND_STATS: "p(50),p(95),p(99),max"
  run: |
    k6 run -o experimental-prometheus-rw \
      --tag testid=ci-${{ github.run_id }} \
      tests/performance/load.js
```

The `K6_PROMETHEUS_RW_TREND_STATS` option converts k6 trend metrics (which use a native histogram format by default) into explicit percentile series (`k6_*_p50`, `k6_*_p95`, `k6_*_p99`, `k6_*_max`) that are straightforward to query in PromQL and display in Grafana panels.

The `testid` tag is set to `ci-<github.run_id>` so each CI run is uniquely identifiable in Grafana queries.

### Dashboard

Import the official k6 Prometheus dashboard from the Grafana dashboard library:

- Dashboard ID: **19665** (`k6 Prometheus` by Grafana k6)
- In Grafana Cloud: **Dashboards → New → Import → enter ID 19665 → Load → select the Prometheus data source → Import**

This dashboard displays virtual users, request rate, response time percentiles, and error rate for each test run. Use the `testid` variable in the dashboard to filter to a specific CI run.

### Key k6 metrics in Grafana

| k6 metric | Prometheus series (with `K6_PROMETHEUS_RW_TREND_STATS`) | Description |
| --- | --- | --- |
| `http_req_duration` | `k6_http_req_duration_p95`, `k6_http_req_duration_p99` | API response time percentiles |
| `http_req_failed` | `k6_http_req_failed` | HTTP error rate during the test |
| `ws_connecting` | `k6_ws_connecting_p95` | WebSocket connection time |
| `ws_msgs_received` | `k6_ws_msgs_received` | WebSocket messages received |
| `vus` | `k6_vus` | Active virtual users over time |
| `iterations` | `k6_iterations` | Test iterations completed |

### NFR thresholds

The k6 test scripts define pass/fail thresholds matching the PRD non-functional requirements. These thresholds are enforced in CI — a threshold breach fails the `ci-perf.yml` workflow and must be resolved or explicitly overridden before the next release. The Grafana dashboard visualises trends across runs to show whether performance is improving or regressing over time.

## Log Retention and Forwarding

### Constraint summary

The target log retention window is 90 days. Neither Railway's Hobby plan dashboard nor Grafana Cloud's free Loki tier reaches this target. The following table documents the constraint at each layer and the decision taken.

| Layer | Platform | Queryable window | Decision |
| --- | --- | --- | --- |
| Railway log dashboard | Railway Hobby plan | 7 days | Accepted as a real-time debug tool only; not the primary log store |
| Raw log storage | Railway (all plans) | 90 days stored; not queryable beyond the dashboard window | Not actionable without plan upgrade |
| Forwarded logs | Grafana Cloud Loki (free tier) | **14 days** | **Selected as the primary queryable log store** |
| Forwarded logs | Grafana Cloud Loki (paid) | 30 days | Deferred; see decision note below |
| Forwarded logs | Grafana Cloud Loki (enterprise) | Custom (90+ days by arrangement) | Out of scope for this version |

**Decision:** Forward logs from Railway to Grafana Cloud Loki on the free tier, giving 14 days of queryable logs. The 90-day target cannot be met within the current budget ($10–20/month). This constraint is accepted for the initial launch. The decision of whether to upgrade to Grafana Cloud's paid Loki tier (30 days) will be revisited once the application is in production and actual log volume is known.

### Log forwarding setup

Railway does not natively push logs to external services, but it supports log drains — a configured endpoint that receives a stream of stdout log lines. Grafana Cloud Loki exposes a push endpoint compatible with Railway's log drain format.

**Steps to configure log forwarding:**

1. In Grafana Cloud, navigate to **Connections → Add new connection → Logs → Railway**. Follow the Railway log drain integration guide to obtain the Loki push URL and credentials.
2. Alternatively, configure a custom log drain in Railway: in the project settings, add a log drain pointing to the Grafana Cloud Loki push API endpoint with a basic auth header using a Grafana Cloud Access Policy Token with the `logs:write` scope.
3. Add stream labels to every forwarded log line to enable filtering in Grafana: at minimum `app="wizard"` and `env="production"`.
4. Verify the drain is working by checking **Explore → Loki** in Grafana Cloud for recent log entries.

**Note on label carriage:** pino logs are structured JSON. Grafana's Loki pipeline can parse JSON log lines and extract fields as labels or indexed fields. The `env` label should be set at the drain/stream level (not per log line) to avoid high-cardinality label issues. The `traceId`, `userId`, `roomId`, and `gameId` fields are best left as structured log fields (not labels) and queried via `| json` filters in LogQL.

### Volume estimate

Estimating log volume helps verify whether the Grafana Cloud free tier's 50 GB monthly ingestion limit is relevant at this scale.

The figures below are indicative estimates, not measurements. They are based on the target scale stated in the PRD (3–20 concurrent games, up to 100 connected users) and on general assumptions about structured JSON log line sizes and per-game event frequency. They have not been validated against a running instance. They should be treated as a pre-launch sanity check only and revisited once the application is generating real traffic.

- Average log line size: \~300 bytes (structured JSON with standard fields)
- Estimated log rate in active play: \~10 lines/second across all active games
- Per day: 10 lines/s × 86,400 s × 300 bytes ≈ **260 MB/day**
- Per month: ≈ **7.8 GB/month**

This is well within Railway's 500 lines/second rate limit and well within Grafana Cloud's 50 GB/month free ingestion allowance. No log sampling or rate reduction is required at this scale.

**Note:** Railway's rate limit of 500 log lines per second applies per replica. At the estimated 10 lines/second this is not a concern, but if `debug`-level logging is accidentally enabled in production, the rate could spike significantly. The `LOG_LEVEL` environment variable must be set to `info` in production.

### Retention decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-10-23 | Accept 14-day queryable window via Grafana Cloud Loki free tier | 90-day target unachievable within $10–20/month budget; revisit once production log volume is known |
| TBD | Upgrade to Grafana Cloud Loki paid tier (30 days) or accept 14-day limit permanently | To be decided after first 30 days of production operation |

## Operational Runbook

This section defines the initial investigation steps for each alert and for common operational tasks. It is not a comprehensive incident response policy — it is a starting point for a solo operator or small team.

### Responding to a Sev 1 alert

**General approach for any Sev 1:**

1. Check whether the alert coincides with a recent production deploy. If yes, initiate a rollback via the Railway dashboard (Deployments → locate last known-good deploy → Redeploy). Confirm smoke tests pass after rollback.
2. If no recent deploy, check the Railway `wizard-app` service logs in the Railway dashboard for `fatal` or `error` level entries in the minutes preceding the alert.
3. Open Grafana Cloud → Explore → Loki and run: `{env="production", app="wizard"} | json | level = "error"` filtered to the alert time window.
4. Check the Railway service status in the Railway dashboard for memory or CPU anomalies.

---

**Alert: Service unavailable (health check failure)**

- Verify: open `https://<production-domain>/health` in a browser. If it returns anything other than `{ status: "ok" }`, the app process is down or unreachable.
- Check Railway dashboard → `wizard-app` → Deployments for a failed or crashed deploy.
- Check logs for `fatal` level entries around the time of failure, particularly startup validation errors (missing environment variables, failed DB connection).
- If the process is crashed and not recovering, trigger a manual redeploy in Railway.
- If the database is unreachable, check the `wizard-db` Postgres service in Railway for its own health status.

---

**Alert: Sustained high HTTP error rate**

- In Grafana, drill into `http_requests_total` broken down by `route` and `status_code` to identify which endpoint is returning 5xx responses.
- Check Loki for `error`-level log entries on that route: `{env="production", app="wizard"} | json | level = "error"`.
- Common causes: database query failure (check Postgres connectivity), unhandled exception in a route handler (check the `event` field on the log entry), a bad deploy (consider rollback).

---

**Alert: WebSocket timeout spike**

- A spike in reconnection timeouts means players are failing to reconnect within the 30-second window.
- Check whether the timeout spike correlates with a deploy (brief disconnection is expected during restart — see alert suppression in [Alerting](#alerting)).
- If not deploy-related, check `ws_connections_active` in Grafana for a sudden drop. A drop to near zero suggests the Node.js process was briefly unresponsive or restarted.
- Check the event loop lag metric (from prom-client's default collectors) for signs of CPU saturation blocking the event loop.

### Responding to a Sev 2 alert

**Alert: API latency degradation**

- Identify the affected route from the `http_request_duration_seconds` histogram broken down by `route`.
- Check Postgres: high query latency is a common cause. Railway's Postgres service page shows connection count and basic health. A sudden increase in query time may indicate a missing index on a hot query, or a long-running transaction locking rows.
- Check Node.js memory usage (from prom-client default collectors). A growing heap may indicate a memory leak that is triggering GC pauses.

---

**Alert: Application error volume spike**

- Open Grafana Cloud → Explore → Loki, query: `{env="production", app="wizard"} | json | level = "error"` for the alert window.
- Group by the `event` field to find which event type is generating the most errors.
- If errors are concentrated in socket event handlers, check for a game state corruption scenario (a player action arriving in an unexpected state).
- If errors are concentrated in persistence layer calls, check database connectivity and disk space on the Railway Postgres volume.

### Correlating a bug report with server logs

When a user submits a bug report:

1. Find the report in the admin panel's Bug reports section (or in the `bug_reports` table, by its `created_at` timestamp or `user_id`). Each report is also logged at INFO as `bug report submitted`, with `traceId`, `userId`, `roomId`, `gameId`, `reportId` and `severity`.
2. Copy its trace ID (the Copy button in the panel, or the `trace_id` column).
3. In Grafana Cloud → Explore → Loki, run: `{env="production", app="wizard"} | json | traceId = "<trace_id>"`
4. This returns all log entries from that user's session, in chronological order, giving the full server-side view of what happened up to and during the bug.

### Checking production health manually

At any time, a quick health check can be performed:

```bash
# Health endpoint
curl https://<production-domain>/health
# Expected: {"status":"ok"} with HTTP 200

# Metrics endpoint (requires bearer token)
curl -H "Authorization: Bearer <PROMETHEUS_BEARER_TOKEN>" \
  https://<production-domain>/metrics
# Expected: Prometheus text format output
```

### Routine checks

There is no formal on-call rotation for this personal project. However, the following checks are recommended on an informal weekly basis:

- Review the Infrastructure Health dashboard in Grafana for any sustained error rate or latency trends that did not trigger an alert (e.g. a slow upward drift in p95 latency).
- Review `games_completed_total` with `status="incomplete"` for an unexpected increase in incomplete games, which may indicate a player drop or reconnection problem.
- Review `bug_reports_total` for any increase in report volume, particularly at `severity=high`.
- Verify that Railway's automated Postgres backups ran successfully (Railway dashboard → `wizard-db` → Backups tab).
