# Wizard — Grafana Cloud Onboarding

Step-by-step setup of Grafana Cloud for the production Wizard app: connecting metrics and logs, building the dashboards, and creating the alerts. Everything here is done by hand in the Grafana Cloud, Railway and terminal UIs. Nothing in the repo configures Grafana.

The **Observability and Alerting Guide** (`docs/operations/observability-alerting.md`) defines what the app emits and why each alert exists. This document is the how-to. If the two disagree about a metric, label or threshold, the guide wins; fix this document.

Grafana's UI changes from time to time. If a menu path below doesn't match what you see, use the search bar at the top of Grafana (for example "Metrics Endpoint" or "Synthetic Monitoring").

## Before you start

You need:

- Access to the Railway project (`wizard-app` service, environment variables).
- The production domain, written as `<domain>` below (for example `wizard.example.com`).
- A terminal with `curl` and `openssl`.
- An email address for alert notifications.

Allow about 1–2 hours for the whole thing. Steps 1–3 must happen in order; after that, any order works.

| Step | What | Result |
| --- | --- | --- |
| 1 | Create the stack | A Grafana Cloud instance |
| 2 | Set the scrape token | `/api/v1/metrics` answers with the token |
| 3 | Scrape metrics | Prometheus series in Grafana |
| 4 | Forward logs | Log lines in Loki |
| 5 | Uptime check | `/health` probed every minute |
| 6 | Dashboards | Three dashboards |
| 7 | Contact point and alerts | Email on incidents |
| 8 | Verify end to end | You've seen one alert fire and resolve |

## Step 1 — Create the stack

1. Sign up at grafana.com and choose the **Free** plan.
2. Create a stack. Pick the region closest to Railway's region for the app (lower latency on scrapes; it doesn't affect players).
3. Open the stack (`https://<stack>.grafana.net`). This is where every later step happens unless it says Railway.

The free tier covers this project: 10,000 metric series, 50 GB of logs a month with 14-day retention, and enough synthetic-monitoring checks for one uptime check. The app's estimated usage is well under each limit (see "Volume estimate" in the guide).

## Step 2 — Set the scrape token

The metrics endpoint only answers requests carrying `Authorization: Bearer <PROMETHEUS_TOKEN>`.

1. Generate a token:

   ```bash
   openssl rand -hex 32
   ```

2. In Railway, open `wizard-app` → **Variables**, and set `PROMETHEUS_TOKEN` to that value. Railway redeploys the service.
3. Once it's deployed, check both cases:

   ```bash
   # Without the token: expect HTTP 401 and {"code":"UNAUTHORIZED",...}
   curl -i https://<domain>/api/v1/metrics

   # With the token: expect HTTP 200 and Prometheus text
   curl -s -H "Authorization: Bearer <token>" https://<domain>/api/v1/metrics | head -20
   ```

   The second command should print lines such as `# TYPE http_requests_total counter`, and the series should carry `env="production"` and a 7-character `version` (the deployed commit).

Keep the token in a password manager. You'll paste it into Grafana in step 3.

## Step 3 — Scrape the metrics

1. In Grafana, go to **Connections → Add new connection**, search for **Metrics Endpoint**, and open it.
2. Create a scrape job:
   - **Name:** `wizard-production`
   - **Scrape job URL:** `https://<domain>/api/v1/metrics`
   - **Authentication:** Bearer token, with the token from step 2
   - **Scrape interval:** 30 seconds if offered. If the shortest interval offered is longer (say 1 minute), choose it. The queries below use windows of 5 minutes or more, which still work at 1-minute scrapes.
3. Click **Test connection**. A failure here is almost always one of three things: a wrong token (401), the wrong path (404 — the path is `/api/v1/metrics`, not `/metrics`), or the deploy from step 2 not having finished.
4. Save, wait a couple of minutes, then go to **Explore**, choose the Prometheus data source (named like `grafanacloud-<stack>-prom`), and run:

   ```promql
   http_requests_total{env="production"}
   ```

   You should see series per `route`. If nothing appears after 5 minutes, open the scrape job again and check its status or error message.

## Step 4 — Forward the logs

The app writes JSON lines to stdout and Railway captures them. Getting them into Grafana Cloud Loki needs a forwarder.

1. In Grafana, go to **Connections → Add new connection** and search for **Railway**. If an integration exists, follow its instructions; it gives you the Loki push URL and credentials.
2. If there's no integration, create the credentials yourself:
   - In the Grafana Cloud portal (grafana.com → your stack → **Loki → Details**), copy the **URL** and the **User** (a number).
   - Under **Access Policies**, create a policy with the `logs:write` scope and a token for it.
   - In Railway, set up log forwarding to the Loki push API (`<loki-url>/loki/api/v1/push`) with basic auth: the user number and the token. Check Railway's docs for whether log drains are available on your plan. If they aren't, the fallback is a small forwarder service in the same project (for example Grafana Alloy) reading the service's logs. That's a larger job; decide before starting it.
3. Whatever does the forwarding, it must attach two stream labels to every line: `app="wizard"` and `env="production"`. Every saved query and alert below filters on them. Don't promote `traceId`, `userId`, `roomId` or `gameId` to labels: they have too many values. Leave them in the JSON and filter with `| json`.
4. Check in **Explore**, choosing the Loki data source:

   ```logql
   {app="wizard", env="production"} | json
   ```

   Lines should show `timestamp`, `level`, `traceId`, `userId`, `roomId`, `gameId`, `event` and `message`. Then load any page of the app and run:

   ```logql
   {app="wizard", env="production"} | json | event = "http.request"
   ```

   You should see one `request completed` line per API call.

## Step 5 — Uptime check

1. Go to **Testing & synthetics → Synthetics** (Synthetic Monitoring). The first time, click **Initialize** (or similar) to set it up.
2. Add a check of type **HTTP**:
   - **Job name:** `wizard-health`
   - **Target:** `https://<domain>/health`
   - **Probe locations:** two or three (one probe failing on its own shouldn't page you)
   - **Frequency:** 1 minute
   - **Validation:** status code 200; optionally, body contains `"status":"ok"`
3. Save. The check's dashboard shows uptime and latency within a few minutes.

The alert for this check is created in step 7.

## Step 6 — Dashboards

Create three dashboards: **Wizard — Infrastructure**, **Wizard — Database**, **Wizard — Game activity**. For each one:

1. **Dashboards → New → New dashboard**, then **Settings → Variables** and add both variables below.
2. Add each panel from the tables below: **Add → Visualization**, choose the Prometheus data source, paste the query, set the visualization and unit, and give it the title from the table.
3. Save. Copy the variables once into the first dashboard, then use **Save as** for the others so the variables carry over.

### Variables (every dashboard)

| Name | Type | Settings |
| --- | --- | --- |
| `env` | Custom | Values: `production`. Default: `production`. |
| `version` | Query | Data source: Prometheus. Query: `label_values(http_requests_total{env="$env"}, version)`. Enable **Include All option**, with custom all value `.*`. Default: All. |

Queries use `version=~"$version"` (regex match), so **All** matches every version and picking one narrows the panel to a single deploy.

### Infrastructure dashboard

| Panel | Query | Visualization | Unit |
| --- | --- | --- | --- |
| Request rate by route | `sum by (route) (rate(http_requests_total{env="$env", version=~"$version"}[5m]))` | Time series | requests/sec |
| 5xx error rate | `100 * sum(rate(http_requests_total{env="$env", version=~"$version", status_code=~"5.."}[5m])) / sum(rate(http_requests_total{env="$env", version=~"$version"}[5m]))` | Time series, threshold line at 1 | percent (0–100) |
| 4xx rate by route | `sum by (route, status_code) (rate(http_requests_total{env="$env", version=~"$version", status_code=~"4.."}[5m]))` | Time series | requests/sec |
| p95 latency by route | `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{env="$env", version=~"$version"}[5m])))` | Time series, threshold line at 0.3 | seconds |
| Active WebSocket connections | `sum(ws_connections_active{env="$env"})` | Stat | none |
| Reconnection success rate | `100 * sum(rate(ws_reconnections_total{env="$env", outcome="success"}[10m])) / sum(rate(ws_reconnections_total{env="$env"}[10m]))` | Time series | percent (0–100) |
| Event loop lag (p99) | `max(nodejs_eventloop_lag_p99_seconds{env="$env"})` | Time series | seconds |
| Heap used | `sum(nodejs_heap_size_used_bytes{env="$env"})` | Time series | bytes |
| CPU | `rate(process_cpu_seconds_total{env="$env"}[5m])` | Time series | percent (0.0–1.0) |

Notes:

- Unmatched API paths are labelled `route="unmatched"`. A rising `unmatched` 4xx rate is usually an old client or a scanner.
- Route labels are patterns with no trailing slash, for example `POST /api/v1/rooms` and `GET /api/v1/rooms/:roomId`.
- `status_code="aborted"` marks requests the client gave up on before the response was sent. A burst of them alongside high latency usually means requests were hanging (often the database).
- The reconnection success rate shows "No data" when nobody has reconnected in the window. That's normal.

### Database dashboard

| Panel | Query | Visualization | Unit |
| --- | --- | --- | --- |
| Query rate by operation | `sum by (operation) (rate(db_queries_total{env="$env", version=~"$version"}[5m]))` | Time series | queries/sec |
| Query error rate | `100 * sum(rate(db_queries_total{env="$env", version=~"$version", status="error"}[5m])) / sum(rate(db_queries_total{env="$env", version=~"$version"}[5m]))` | Time series | percent (0–100) |
| p95 query time by operation | `histogram_quantile(0.95, sum by (le, operation) (rate(db_query_duration_seconds_bucket{env="$env", version=~"$version"}[5m])))` | Time series | seconds |
| p95 query time by table | `histogram_quantile(0.95, sum by (le, table) (rate(db_query_duration_seconds_bucket{env="$env", version=~"$version"}[5m])))` | Time series | seconds |
| Pool size | `sum(db_pool_size{env="$env"})` | Stat (max 10, the pool's limit) | none |
| p95 write size | `histogram_quantile(0.95, sum by (le, table) (rate(db_payload_bytes_bucket{env="$env", version=~"$version"}[5m])))` | Time series | bytes |

`table="other"` covers raw statements and anything outside the schema tables. Transaction control (`BEGIN`, `COMMIT`) isn't recorded.

### Game activity dashboard

| Panel | Query | Visualization | Unit |
| --- | --- | --- | --- |
| Active games | `sum(games_active{env="$env"})` | Stat | none |
| Active rooms | `sum(rooms_active{env="$env"})` | Stat | none |
| Players connected | `sum(players_connected{env="$env"})` | Stat | none |
| Games started (per hour) | `sum(increase(games_started_total{env="$env"}[1h]))` | Time series (bars) | none |
| Games ended by status (per hour) | `sum by (status) (increase(games_completed_total{env="$env"}[1h]))` | Time series (bars, stacked) | none |
| Reconnection outcomes (per hour) | `sum by (outcome) (increase(ws_reconnections_total{env="$env"}[1h]))` | Bar chart | none |
| Bug reports by severity (per day) | `sum by (severity) (increase(bug_reports_total{env="$env"}[1d]))` | Bar chart | none |
| Failed logins (per hour) | `sum by (reason) (increase(auth_login_failures_total{env="$env"}[1h]))` | Time series | none |
| Rate-limited requests (per hour) | `sum by (endpoint) (increase(rate_limit_hits_total{env="$env"}[1h]))` | Time series | none |
| Password reset attempts (per hour) | `sum by (outcome) (increase(auth_password_reset_attempts_total{env="$env"}[1h]))` | Time series | none |

Counters reset to zero on every deploy or restart. `rate()` and `increase()` handle that; don't graph raw counter values. `bug_reports_total` uses `severity="none"` for reports filed without a severity.

### Logs panel (optional)

On any dashboard, add a panel with the **Logs** visualization and the Loki data source:

```logql
{app="wizard", env="$env"} | json | level = "error"
```

## Step 7 — Contact point and alerts

### Contact point and policy

1. **Alerting → Contact points → Add contact point.** Name it `wizard-oncall`, choose **Email**, and enter your address. Click **Test** and confirm the email arrives (check spam).
2. **Alerting → Notification policies.** Edit the default policy so its contact point is `wizard-oncall`. That routes every alert to you without per-rule routing.
3. Optional: set **Group wait** to 30s and **Repeat interval** to 4h, so a long incident doesn't send an email every hour.

### Creating each rule

For each rule below: **Alerting → Alert rules → New alert rule**, then:

1. **Query:** choose the data source, paste the query, and set the time range to the last 10 minutes.
2. **Expression:** keep the default Reduce (Last) → Threshold, and set the threshold given.
3. **Folder:** `Wizard`. **Evaluation group:** `wizard-1m`, evaluated every 1 minute (create both the first time).
4. **Pending period:** as given. The condition must hold this long before the alert fires.
5. **Labels:** `severity=sev1` or `severity=sev2`.
6. **Configure no data and error handling:** set **No data** to **Normal** (OK) for every rule except the uptime check. Most of these queries legitimately return nothing when the app is quiet.
7. **Summary:** the summary given, which is what the email shows.

### Rules

**1. Service unavailable — Sev 1**

- Data source: Prometheus (synthetic monitoring writes its results there).
- Query:

  ```promql
  sum(probe_success{job="wizard-health"}) / count(probe_success{job="wizard-health"})
  ```

- Threshold: below 0.5 (most probes failing).
- Pending period: 2m.
- No data: **Alerting**. No results means the check itself stopped.
- Summary: `/health is failing from most probe locations.`

The synthetic monitoring UI can also create this alert for you from the check's **Alerting** section. Either way is fine; just don't create both.

**2. High HTTP error rate — Sev 1**

```promql
100 * sum(rate(http_requests_total{env="production", status_code=~"5.."}[10m]))
  / sum(rate(http_requests_total{env="production"}[10m]))
```

- Threshold: above 1. Pending period: 10m.
- Summary: `More than 1% of API requests are failing with 5xx.`

**3. WebSocket reconnection timeouts — Sev 1**

```promql
100 * sum(rate(ws_reconnections_total{env="production", outcome="timeout"}[10m]))
  / sum(rate(ws_reconnections_total{env="production"}[10m]))
```

- Threshold: above 20. Pending period: 10m.
- Summary: `More than 20% of disconnected players are not getting back in time.`

With very few players, one timeout out of two disconnects is already 50%. If this fires on single events, add a minimum-volume condition: in the same rule, add query B `sum(increase(ws_reconnections_total{env="production"}[10m]))`, and make the condition "A > 20 and B >= 5" with a Math expression `$A > 20 && $B >= 5`.

**4. API latency degradation — Sev 2**

```promql
max(histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{env="production", route!~"/health|/api/v1/health|/api/v1/metrics|unmatched"}[5m]))))
```

- Threshold: above 0.3. Pending period: 10m.
- Summary: `p95 latency on at least one API route is over 300 ms.`

The outer `max` turns per-route series into one value, so one alert fires rather than one per route. To see which route it is, open the "p95 latency by route" panel.

**5. Application error volume — Sev 2**

- Data source: Loki.
- Query:

  ```logql
  sum(rate({app="wizard", env="production"} | json | level = "error" [10m]))
  ```

- Threshold: above 0.1 (about 6 error lines a minute). Pending period: 10m.
- Summary: `Error-level log lines are above 0.1 per second.`

**6. Login failure spike — Sev 2**

```promql
sum(increase(auth_login_failures_total{env="production"}[10m]))
```

- Threshold: above 30. Pending period: 0s (fire right away; the 10-minute window is in the query).
- Summary: `More than 30 failed logins in 10 minutes.`

**7. Rate-limit hits — Sev 2**

```promql
sum(increase(rate_limit_hits_total{env="production"}[10m]))
```

- Threshold: above 5. Pending period: 0s.
- Summary: `More than 5 requests refused by rate limiters in 10 minutes.`

### Silencing during deploys

Each push to `master` redeploys the app, and the restart can trip rules 1 and 3. Before a deploy you're watching: **Alerting → Silences → New silence**, matcher `severity=sev1`, duration 10 minutes.

## Step 8 — Verify end to end

1. **Metrics and logs:** log in to the app, open a room, and close it. Within a minute or two, the Infrastructure dashboard shows the requests, and Loki shows the `http.request` lines with your `traceId`.
2. **Trace correlation:** submit a bug report from the app. In the admin panel, copy its trace ID, then run in Explore (Loki):

   ```logql
   {app="wizard", env="production"} | json | traceId = "<trace id>"
   ```

   You should see your session's requests, including `bug report submitted`.
3. **An alert:** trigger rule 6 safely. In the rule, temporarily set the threshold to 0, run a failed login against the app, and wait for the email. Then set the threshold back to 30 and confirm the "resolved" email arrives.
4. **Uptime:** the synthetic check shows 100% for the last hour.

## Saved queries for investigation

Save these in Explore (**Add to query library**, or keep them in a dashboard of Logs panels). The runbook in the Observability and Alerting Guide refers to several of them.

| Purpose | Query (Loki) |
| --- | --- |
| Everything from one session (bug report correlation) | `{app="wizard", env="production"} \| json \| traceId = "<trace id>"` |
| Errors, newest first | `{app="wizard", env="production"} \| json \| level = "error"` |
| Errors grouped by message | `sum by (message) (count_over_time({app="wizard", env="production"} \| json \| level = "error" [1h]))` |
| Slow requests | `{app="wizard", env="production"} \| json \| event = "http.request" \| durationMs > 300` |
| 5xx responses | `{app="wizard", env="production"} \| json \| event = "http.request" \| statusCode >= 500` |
| Failed logins by IP | `sum by (ip, reason) (count_over_time({app="wizard", env="production"} \| json \| event = "auth.login_failed" [1h]))` |
| Rate-limited requests | `{app="wizard", env="production"} \| json \| event =~ "auth.rate_limited\|rate_limited"` |
| One game from start to end | `{app="wizard", env="production"} \| json \| gameId = "<game id>"` |
| Reconnection timeouts | `{app="wizard", env="production"} \| json \| event = "game.reconnect_timeout"` |
| Startup and shutdown | `{app="wizard", env="production"} \| json \| message =~ "server listening\|shutting down\|startup cleanup done"` |

The `\|` in this table is a plain `|` when you paste it into Grafana.

Many older log lines don't have an `event` name yet (`event` is null), so search those by `message`.

## Maintenance

- **Rotating the scrape token:** set a new `PROMETHEUS_TOKEN` in Railway, wait for the deploy, then update the token in the `wizard-production` scrape job straight away. Scrapes fail with 401 in between, which leaves a short gap in the graphs.
- **Weekly check (about 5 minutes):** scan the Infrastructure dashboard for slow upward drifts that didn't trigger an alert; check "Games ended by status" for a rise in `incomplete`; check bug reports by severity; confirm Railway's Postgres backups ran.
- **Usage:** **Administration → Cost management → Usage** (or the grafana.com portal) shows active series and log volume against the free-tier limits.
- **k6 performance metrics:** set up once `ci-perf.yml` exists. The secrets and the dashboard import (ID 19665) are in "k6 Performance Test Metrics" in the Observability and Alerting Guide.
