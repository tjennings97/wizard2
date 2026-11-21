# Wizard — Deployment and Infrastructure Plan

Oct 22, 2026 · @TJ

This plan governs how the Wizard card game is built, tested, and shipped to production on Railway.

## Overview

This document defines how the Wizard card game is built, verified, and shipped. It covers the Railway project structure, the three-tier environment model, the GitHub Actions CI pipeline, test automation execution gates, rollback procedure, secret management, database backup strategy, and the production smoke test account.

Related documents: PRD (requirements and NFRs), System Architecture Document (component design), and Test Plan (test suites and pass criteria). Where this document references those specs it does not restate them — it defines the operational steps that implement them.

**Note on the System Architecture Document.** That document states "No staging tier initially; Railway's deploy history and rollback UI serve that purpose." This plan supersedes that statement. A staging environment is supported natively by Railway and is required by the Test Plan's promotion gates. The System Architecture Document should be updated to reflect the three-tier model defined here.

## Environments

Three environments are defined, matching the Test Plan. Each is an isolated Railway environment within the same Railway project, with its own services, Postgres instance, and environment variables.

| Environment | Purpose | Railway environment name | Auto-deploy branch |
| --- | --- | --- | --- |
| Dev | Day-to-day development and local testing | `development` | None (local only; not hosted) |
| Staging | Pre-release validation | `staging` | `staging` |
| Prod | Live application | `production` | `main` |

**Dev** runs locally. Developers use a `.env` file (never committed to source control) and a local Postgres instance. No Railway service is provisioned for dev.

**Staging** is a persistent Railway environment duplicated from production. It deploys automatically when changes are pushed to the `staging` branch. It has its own Postgres database, its own environment variables, and is not reachable from production's private network.

**Prod** is the live environment. It deploys automatically when changes are pushed to `main`. Promotion from staging to prod requires all promotion gates to pass (see Deploy Pipeline).

## Railway Project Setup

One Railway project contains both the staging and production environments. Each environment provisions two services: the Express application and a managed Postgres database.

| Service | Type | Notes |
| --- | --- | --- |
| `wizard-app` | Web service | Serves React build, REST API, and WebSocket traffic on a single port behind TLS |
| `wizard-db` | Postgres | Managed by Railway; reachable only from within the Railway project's private network |

**Custom domain.** A custom domain is attached to the `wizard-app` service in the production environment. SSL is provisioned automatically via Let's Encrypt. The staging environment uses Railway's generated URL.

**Environment variables.** All configuration is stored as Railway environment variables, scoped per environment. Variables are never committed to source control. The application validates all required variables on startup and fails loudly if any are missing. Variable categories:

- Database URL
- Session secret
- JWT signing key (if applicable)
- Socket.io config
- Prometheus bearer token
- `NODE_ENV` / environment name (`development` / `production`)

**Private networking.** The Postgres service is not exposed to the public internet. The application connects via Railway's internal hostname. Staging and production networks are fully isolated from each other.

## Deploy Pipeline

Deployment is triggered by Git branch pushes. Railway autodeploy handles the actual deploy; GitHub Actions (see CI section) runs test gates before promotion is permitted.

**Branch strategy.**

| Branch | Deploys to | Who merges |
| --- | --- | --- |
| `main` | Production | Merge from `staging` only after all promotion gates pass |
| `staging` | Staging | Merge from feature branches after dev-gate tests pass |
| Feature branches | Nowhere (CI only) | Developer opens PR targeting `staging` |

**Promotion gates.** These are defined in the Test Plan and enforced by the CI pipeline.

- **Dev → Staging:** All unit, integration, API, and WebSocket tests must pass on the PR before merge to `staging` is permitted.
- **Staging → Prod:** The full E2E suite and all performance tests must pass their NFR thresholds on staging before merge to `main` is permitted.

**Rollback.** See Rollback section.

## CI — GitHub Actions

GitHub Actions is the CI platform. No Railway-specific CI is required; Railway handles autodeploy from branch pushes independently. GitHub Actions runs test suites and enforces gates before a branch is eligible for promotion.

**Workflows.**

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci-pr.yml` | PR opened or updated targeting `staging` | Runs unit, integration, API, and WebSocket tests. PR is blocked from merge if any test fails. |
| `ci-staging.yml` | Push to `staging` (after merge) | Runs full E2E suite against the deployed staging environment. Result determines eligibility for prod promotion. |
| `ci-perf.yml` | Scheduled (against staging) | Runs k6 performance tests. Results stored as CI artifacts. A Grafana dashboard in staging visualizes trends across runs. |
| `ci-smoke.yml` | Post-deploy to prod | Runs production smoke tests against the live environment using the `smoke_test` account. |

**`npm audit`.** Dependency audit runs as part of `ci-pr.yml`. Known vulnerabilities in direct dependencies block merge.

**Secrets.** The `RAILWAY_TOKEN` and any other CI-required secrets are stored as GitHub Actions secrets, not in the repository.

## Test Automation Execution

Test suites, environments, tools, and pass criteria are defined in the Test Plan. This section defines when and how each suite is executed in the pipeline.

| Suite | Tool | Runs in | Triggered by | Pass criteria |
| --- | --- | --- | --- | --- |
| Unit | Jest | Dev (local) + CI | PR to `staging` | All tests green |
| API | pytest + httpx | Dev (local) + CI | PR to `staging` | All tests green |
| WebSocket | socket.io-client (Node.js) | Dev (local) + CI | PR to `staging` | All tests green |
| E2E | Playwright | Staging | Push to `staging` | All tests green |
| Performance | k6 | Staging | Scheduled | All NFR thresholds met (per Test Plan) |
| Smoke | Playwright | Prod | Post-deploy to `main` | All 8 smoke tests pass |

**Test data.** Each test run provisions its own data and cleans up after itself, as defined in the Test Plan. No shared state between runs.

**Failure behaviour.**

- A failure in `ci-pr.yml` blocks merge. The developer must fix and push again.
- A failure in `ci-staging.yml` (E2E) blocks promotion to prod. The merge to `main` must not proceed until the E2E suite passes.
- A performance test failure blocks prod promotion and must be resolved or explicitly overridden before the next release.
- A smoke test failure after a prod deploy pages the on-call engineer and blocks the next release until resolved.

**Performance test results.** k6 captures p50, p95, and p99 latency per scenario. Results are stored as CI artifacts. A Grafana dashboard in staging visualises trends across runs. If the PRD NFR section is updated, the k6 load profiles must be updated to match before the next performance run.

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

**Runtime secrets (Railway).** Set per environment in the Railway dashboard. Each environment has its own scoped variable set — staging and production variables are never shared.

| Variable category | Examples |
| --- | --- |
| Database | `DATABASE_URL` |
| Session | Session secret |
| Auth | JWT signing key (if applicable) |
| Real-time | Socket.io config |
| Observability | Prometheus bearer token |
| App config | `NODE_ENV`, environment name |

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

**Staging backups.** Backup configuration for the staging environment is at the operator's discretion. Staging data is not production data and can be re-seeded from test fixtures if lost.

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

**Note for Test Plan.** The Test Plan references a `smoke@wizard…` email address for this account. That reference should be updated: the account uses the username `smoke_test` with no associated email address.

## Observability

Observability requirements are defined in the PRD. This section describes how they are operational in the deployed environments.

**Structured logging.** All server-side logs are emitted as structured JSON using `pino`. Logs are written to stdout and captured by Railway's log aggregation. Each entry includes: timestamp, level, trace/correlation ID, user ID (if authenticated), room ID and game ID (if applicable), and message.

**Metrics.** The Express app exposes a `GET /metrics` endpoint via `prom-client`. The endpoint requires a bearer token (stored as an environment variable). Grafana Cloud (free tier) scrapes this endpoint over HTTPS.

**Dashboards.** Grafana Cloud hosts production dashboards. A second Grafana dashboard in the staging environment visualises k6 performance test trends across runs.

**Health endpoint.** The server exposes `GET /health` (no authentication required) returning `{ status: "ok" }` with HTTP 200. This endpoint is used by Railway for health checks and can be used by external uptime monitors.

**Trace IDs.** A correlation ID is attached to every request and propagated through logs. It is the correlation key between stored bug reports and server logs.

**Availability.** Best-effort for a personal project. Railway SLA applies. No formal uptime SLA is defined for this version.

## Open Decisions

| # | Decision | Blocking | Notes |
| --- | --- | --- | --- |
| OD-2 | Database migration strategy | Rollback section | Whether migrations are forward-only or reversible determines whether a code rollback is sufficient after a failed deploy that included a migration. |
