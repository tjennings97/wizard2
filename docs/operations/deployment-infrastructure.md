# Wizard — Deployment and Infrastructure Plan

Oct 22, 2026 · @TJ

This plan governs how the Wizard card game is built, tested, and shipped to production on Railway.

## Overview

This document defines how the Wizard card game is built, verified, and shipped. It covers the Railway project structure, the environment model (local dev and production), the GitHub Actions CI pipeline, test automation execution gates, rollback procedure, secret management, database backup strategy, and the production smoke test account.

Related documents: PRD (requirements and NFRs), System Architecture Document (component design), and Test Plan (test suites and pass criteria). Where this document references those specs it does not restate them — it defines the operational steps that implement them.

## Environments

Two environments are defined, matching the Test Plan. There is no staging environment: Railway's deploy history and rollback UI cover recovery from a bad deploy, and pre-release tests run in CI (see CI — GitHub Actions).

| Environment | Purpose | Railway environment name | Auto-deploy branch |
| --- | --- | --- | --- |
| Dev | Day-to-day development and local testing | `development` | None (local only; not hosted) |
| Prod | Live application | `production` | `main` |

**Dev** runs locally. Developers use a `.env` file (never committed to source control) and a local Postgres instance. No Railway service is provisioned for dev.

**Prod** is the live environment. It deploys automatically when changes are pushed to `main`. A change reaches `main` only through a pull request whose CI checks pass (see Deploy Pipeline).

## Railway Project Setup

One Railway project contains the production environment, which provisions two services: the Express application and a managed Postgres database.

| Service | Type | Notes |
| --- | --- | --- |
| `wizard-app` | Web service | Serves React build, REST API, and WebSocket traffic on a single port behind TLS |
| `wizard-db` | Postgres | Managed by Railway; reachable only from within the Railway project's private network |

**Custom domain.** A custom domain is attached to the `wizard-app` service in the production environment. SSL is provisioned automatically via Let's Encrypt.

**Environment variables.** All configuration is stored as Railway environment variables, scoped per environment. Variables are never committed to source control. The application validates all required variables on startup and fails loudly if any are missing. Variable categories:

- Database URL
- Session secret
- Socket.io config
- Prometheus bearer token
- `NODE_ENV` / environment name (`development` / `production`)
- `APP_ORIGIN`: the public origin the app is served from, for example `https://wizard.example.com` (scheme and host, no path or trailing slash). It is required when `NODE_ENV=production`: the server refuses to start without it. Use the custom domain once attached; until then, the Railway-generated domain (`https://<name>.up.railway.app`). Update it if the domain changes.
- `TRUST_PROXY_HOPS` (optional): proxy hops to trust for the client IP. It defaults to `1` in production, which matches Railway's single edge proxy.

**Private networking.** The Postgres service is not exposed to the public internet. The application connects via Railway's internal hostname.

## Deploy Pipeline

Deployment is triggered by Git branch pushes. Railway autodeploy handles the actual deploy; GitHub Actions (see CI section) runs the test gate before a pull request may merge.

**Branch strategy.**

| Branch | Deploys to | Who merges |
| --- | --- | --- |
| `main` | Production | Merge from feature branches only after all PR checks pass |
| Feature branches | Nowhere (CI only) | Developer opens PR targeting `main` |

**Merge gate.** Defined in the Test Plan and enforced by the CI pipeline: all unit, integration, API, WebSocket, and E2E tests must pass on the PR, run against the app and a throwaway Postgres started in the CI job, before merge to `main` is permitted.

**Performance.** k6 tests run on a schedule rather than on each PR. A threshold breach must be resolved or explicitly overridden before the next release.

**Rollback.** See Rollback section.

## CI — GitHub Actions

GitHub Actions is the CI platform. No Railway-specific CI is required; Railway handles autodeploy from branch pushes independently. GitHub Actions runs test suites and enforces the merge gate on pull requests.

**Workflows.**

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci-pr.yml` | PR opened or updated targeting `main` | Runs unit, integration, API, WebSocket, and E2E tests against the app and a throwaway Postgres started in the CI job. PR is blocked from merge if any test fails. |
| `ci-perf.yml` | Scheduled | Runs k6 performance tests against the app and a throwaway Postgres started in the CI job. Results are stored as CI artifacts and pushed to Grafana Cloud. |
| `ci-smoke.yml` | Post-deploy to prod | Runs production smoke tests against the live environment using the `smoke_test` account. |

**`npm audit`.** Dependency audit runs as part of `ci-pr.yml`. Known vulnerabilities in direct dependencies block merge.

**`ci-pr.yml` steps.** One job on `ubuntu-latest` with a `postgres:16` service container (database `wizard_test`). It triggers on pull requests to `main` and also to `master`, the repository's current default branch.

1. `npm ci`
2. `npm audit` (dev dependencies included)
3. `npm run typecheck`
4. `npm run build` (client and server)
5. `npm test -w server` (Jest unit tests)
6. `npm run test:integration -w server` (Jest integration and Socket.io tests; they create and migrate their own `wizard_jest` database)
7. `npm run migrate:latest -w server` against `wizard_test`
8. Start the server with `NODE_ENV=test TRUST_PROXY_HOPS=1 PORT=3100` and poll `/health` for up to 60 seconds
9. `pip install -r tests/api/requirements.txt`, then `pytest tests/api` with `API_BASE_URL=http://127.0.0.1:3100/api/v1` and `DATABASE_URL` pointing at `wizard_test`
10. Print the server log, whether or not the earlier steps passed

`SESSION_SECRET` and `PROMETHEUS_TOKEN` are fixed throwaway values set in the workflow, not secrets. Playwright E2E tests are not part of the job yet; add a step when the suite exists.

**Secrets.** The `RAILWAY_TOKEN` and any other CI-required secrets are stored as GitHub Actions secrets, not in the repository.

## Test Automation Execution

Test suites, environments, tools, and pass criteria are defined in the Test Plan. This section defines when and how each suite is executed in the pipeline.

| Suite | Tool | Runs in | Triggered by | Pass criteria |
| --- | --- | --- | --- | --- |
| Unit | Jest | Dev (local) + CI | PR to `main` | All tests green |
| API | pytest + requests | Dev (local) + CI | PR to `main` | All tests green |
| WebSocket | socket.io-client (Node.js) | Dev (local) + CI | PR to `main` | All tests green |
| E2E | Playwright | Dev (local) + CI | PR to `main` | All tests green |
| Performance | k6 | CI | Scheduled | All NFR thresholds met (per Test Plan) |
| Smoke | Playwright | Prod | Post-deploy to `main` | All 8 smoke tests pass |

**Test data.** Each test run provisions its own data and cleans up after itself, as defined in the Test Plan. No shared state between runs.

**Failure behaviour.**

- A failure in `ci-pr.yml` blocks merge. The developer must fix and push again.
- A performance test failure must be resolved or explicitly overridden before the next release.
- A smoke test failure after a prod deploy pages the on-call engineer and blocks the next release until resolved.

**Performance test results.** k6 captures p50, p95, and p99 latency per scenario. Results are stored as CI artifacts and pushed to Grafana Cloud, where a dashboard visualises trends across runs. If the PRD NFR section is updated, the k6 load profiles must be updated to match before the next performance run.

## Rollback

Railway retains a deploy history for each environment. A previous deployment can be reactivated from the Railway dashboard without requiring a code change or a new Git push.

**Procedure.**

1. Identify the bad deploy via smoke test failure or monitoring alert.
2. Open the Railway dashboard → select the `production` environment → Deployments.
3. Locate the last known-good deployment and select **Redeploy**.
4. Confirm the smoke tests pass against the restored deployment.
5. Open a post-mortem issue in the repository to track root cause and fix.

**Database migrations.** If the bad deploy included a database migration, a code rollback alone may not be sufficient. Migration rollback procedure is a decision deferred to the development phase when the migration strategy (e.g. forward-only vs reversible) is established. This is noted as an open decision below.

## Secret Management

All secrets and configuration are stored as environment variables. No secret is ever committed to source control.

**Runtime secrets (Railway).** Set for the production environment in the Railway dashboard.

| Variable category | Examples |
| --- | --- |
| Database | `DATABASE_URL` |
| Session | Session secret |
| Real-time | Socket.io config |
| Observability | Prometheus bearer token |
| App config | `NODE_ENV`, environment name, `APP_ORIGIN`, `TRUST_PROXY_HOPS` (optional) |

**Local development.** Developers use a `.env` file at the project root. A `.env.example` file with placeholder values is committed to source control. The `.env` file itself is listed in `.gitignore`.

**CI secrets.** The `RAILWAY_TOKEN` and any other secrets needed by GitHub Actions workflows are stored as GitHub Actions repository secrets.

**Startup validation.** The application validates all required environment variables on startup and fails loudly with a descriptive error if any are missing. This prevents silent misconfiguration in any environment.

## Database Backups

The project runs on Railway's **Hobby plan** ($5/month). Railway provides automated volume backups on all paid plans, including Hobby. The Postgres database is stored on a Railway volume and backed up using Railway's built-in backup scheduler.

**Backup principles.** Regardless of plan, the backup strategy must satisfy the following:

- Production data must be backed up automatically with no manual intervention required.
- A minimum of one backup must be retained and restorable without Railway support involvement.
- The backup must be sufficient to recover from accidental data deletion or a failed migration.

**Manual export.** As a secondary safety measure, `pg_dump` can be used to export the production database manually at any time. This is not a substitute for automated backups but provides an additional recovery option, particularly before major migrations.

**Backup configuration.** The following schedules are enabled on the production Postgres volume via the Railway dashboard (Backups tab):

- **Daily** — every 24 hours, retained for 6 days
- **Weekly** — every 7 days, retained for 27 days

Both schedules run concurrently. Manual backups may be triggered at any time, capped at 50% of the volume's total size. Backup storage is billed incrementally at the same rate as volume storage ($0.15/GB/month).

**Restoration.** To restore a backup: open the Railway dashboard → select the `production` environment → locate the Postgres service → Backups tab → select the backup by date stamp → click Restore. Railway stages the change for review before applying it. Restoration replaces the current volume; the previous volume remains unmounted in the project. Once confirmed, click Deploy.

**Volume storage limit.** The Hobby plan includes up to 5 GB of volume storage. If the database grows beyond this, the volume must be resized (which requires upgrading to the Pro plan for self-serve resizing up to 1 TB).

**Note on point-in-time recovery.** Railway offers point-in-time recovery as a separate feature. Its availability on the Hobby plan should be verified in the Railway dashboard on first setup.

## Smoke Test Account

A dedicated account exists in the production environment for smoke test execution. It is a standard registered user account.

| Property | Value |
| --- | --- |
| Username | `smoke_test` |
| Role | Standard registered user |
| Environment | Production only |

**Purpose.** The account is used exclusively by the `ci-smoke.yml` workflow to execute the post-deploy smoke test suite. It performs only read-only or non-destructive actions as defined in the Test Plan.

**Provisioning.** The `smoke_test` account must be created manually in the production environment before the first production deployment. Its credentials are stored as GitHub Actions secrets and injected into the smoke test workflow at runtime. The account must never be used for any purpose other than automated smoke tests.

## Observability

Observability requirements are defined in the PRD. This section describes how they are operational in the deployed environments.

**Structured logging.** All server-side logs are emitted as structured JSON using `pino`. Logs are written to stdout and captured by Railway's log aggregation. Each entry includes: timestamp, level, trace/correlation ID, user ID (if authenticated), room ID and game ID (if applicable), and message.

**Metrics.** The Express app exposes a `GET /metrics` endpoint via `prom-client`. The endpoint requires a bearer token (stored as an environment variable). Grafana Cloud (free tier) scrapes this endpoint over HTTPS.

**Dashboards.** Grafana Cloud hosts the production dashboards and a dashboard of k6 performance test trends across runs.

**Health endpoint.** The server exposes `GET /health` (no authentication required) returning `{ status: "ok" }` with HTTP 200. This endpoint is used by Railway for health checks and can be used by external uptime monitors.

**Trace IDs.** A correlation ID is attached to every request and propagated through logs. It is the correlation key between stored bug reports and server logs.

**Availability.** Best-effort for a personal project. Railway SLA applies. No formal uptime SLA is defined for this version.

## Open Decisions

| # | Decision | Blocking | Notes |
| --- | --- | --- | --- |
| OD-2 | Database migration strategy | Rollback section | Whether migrations are forward-only or reversible determines whether a code rollback is sufficient after a failed deploy that included a migration. |
