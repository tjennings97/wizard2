# Wizard — Backup and Recovery Runbook

2026-10-24 · TJ

## Overview

This runbook covers operational backup and recovery procedures for the Wizard card game production environment. It is intended for the operator and any future team members with production access.

The production environment runs on Railway's Hobby plan with a single Express/Node.js service and a collocated managed Postgres database. All persistent state lives in the database. In-memory state — active game sessions and reconnection timers — does not survive a process restart.

**Scope.** This runbook addresses the automated backup schedule and how to verify it; manual export via pg\_dump; restoration from a Railway backup; recovery from specific failure scenarios (accidental data deletion, failed migration, and unexpected server restart); and what state is and is not recoverable in each scenario.

**Related documents.** Deployment and Infrastructure Plan (backup configuration, rollback procedure), System Architecture Document (persistence architecture, GameState checkpointing), PRD (data retention requirements).

**Audience.** The operator and any future team members with Railway dashboard and production database access.

## Backup Strategy

### Automated Backups

Railway's built-in backup scheduler runs against the production Postgres volume. Two schedules are enabled concurrently:

| Schedule | Frequency | Retention |
| --- | --- | --- |
| Daily | Every 24 hours | 6 days |
| Weekly | Every 7 days | 27 days |

Manual backups may be triggered at any time from the Railway dashboard, capped at 50% of the volume's total size. Backup storage is billed at the same rate as volume storage ($0.15/GB/month). The Hobby plan includes up to 5 GB of volume storage total.

**How to verify backup configuration.** In the Railway dashboard: select the production environment → locate the `wizard-db` Postgres service → open the Backups tab. Confirm that both daily and weekly schedules are enabled and that recent backup entries are present. Verify this after first setup and after any Railway plan change.

### Manual Export (pg\_dump)

`pg_dump` is the secondary safety measure. It is not a substitute for automated backups but provides an additional recovery option — particularly before a major database migration.

**When to run a manual export:**

- Before any database migration that cannot be trivially reversed (see Open Decisions — OD-2)
- Before a significant data import or bulk update
- On demand, when additional assurance is needed

**Procedure:**

1. Obtain the `DATABASE_URL` for the production environment from the Railway dashboard (Environment Variables).
2. Run: `pg_dump "$DATABASE_URL" -Fc -f wizard_$(date +%Y%m%d).dump`
3. Store the dump file in a location outside Railway (local disk, cloud storage). Do not commit it to source control.
4. Verify the dump is non-empty before treating it as a valid backup.

The `-Fc` flag produces a custom-format archive compatible with `pg_restore`. To inspect the dump without restoring: `pg_restore --list wizard_<date>.dump`.

### What Is and Is Not Backed Up

All tables defined in the system schema are part of the Postgres volume and are included in both automated and manual backups: `users`, `sessions`, `invites`, `rooms`, `room_members`, `games`, `rounds`, `round_players`, `game_results`, `game_events`, `bug_reports`.

The following are **not** in the database and are therefore not covered by database backups:

- In-memory game state (mid-trick state that has not yet been checkpointed). The last committed checkpoint is the `games.state` JSONB column, written after each round ends.
- Active Socket.io connections and reconnection timers.
- Railway environment variables (secrets). These must be documented separately and are not recoverable from a database backup alone.
- The deployed application build. This is recoverable from GitHub via Railway's deploy history.

## Recovery Scenarios

The scenarios below cover the most likely recovery situations. Each defines: what happened, what state is recoverable, and the step-by-step procedure.

### Scenario 1 — Accidental Data Deletion

**What happened.** A row or set of rows has been deleted from a production table (e.g. a user record, game history, or invite) via a manual query or a bug in application code.

**What is recoverable.** Any data present in the most recent automated backup that predates the deletion. Data written between the last backup and the deletion is lost.

**Procedure.**

1. Identify what was deleted and when (Railway log viewer, filtering by `userId` or `gameId` via the trace ID).
2. Determine which backup predates the deletion. Open the Railway dashboard → production environment → `wizard-db` → Backups tab.
3. **Do not restore the full volume immediately.** First, assess whether a targeted recovery is possible:
   - If you have a recent `pg_dump` export, use `pg_restore` to extract only the affected rows into a temporary local database, then manually re-insert them into production.
   - If you do not have a `pg_dump` export and the data loss is limited to non-critical tables (e.g. a single bug report), document the loss and move on without a full restore.
4. If a full volume restore is required (large-scale deletion or critical data loss): follow the restoration procedure in the Railway Backup Restoration section below.
5. After recovery, run the production smoke tests to confirm application health.
6. Open a post-mortem issue in the repository documenting what was deleted, when, how it was detected, and what was recovered.

### Scenario 2 — Failed Database Migration

**What happened.** A `knex migrate:latest` run applied one or more migrations that left the database in a broken or partially migrated state, or a migration caused application errors in production.

**What is recoverable.** The database state as of the last backup before the migration ran. Application code can be rolled back independently via Railway's deploy history.

**Procedure.**

1. Immediately roll back the application code: Railway dashboard → production environment → Deployments → locate the last known-good deployment → Redeploy. This stops the broken code from running against the broken schema, but it does not undo the migration.
2. Assess whether the migration is reversible (see Open Decisions — OD-2). If reversible, run `knex migrate:down` to undo the last migration batch, then confirm the schema is correct.
3. If the migration is not reversible or cannot be safely rolled back at the schema level, a volume restore is required.
4. Before restoring: take a manual `pg_dump` of the current (broken) state to preserve any data written after the last automated backup.
5. Follow the Railway Backup Restoration procedure below, selecting the backup immediately prior to the migration deployment.
6. Re-apply any data written between that backup and the migration by hand if it can be identified from logs; otherwise document the data loss.
7. Run the production smoke tests to confirm application health after the code rollback and schema restoration.
8. Open a post-mortem issue documenting the migration failure, what was restored, and any unrecoverable data.

**Pre-migration precaution.** Before any migration that cannot be trivially reversed, take a manual `pg_dump` export. This is the primary mitigation against migration-induced data loss and allows targeted row-level recovery without a full volume restore.

### Railway Backup Restoration Procedure

This procedure applies to both Scenario 1 and Scenario 2 when a full volume restore is required.

1. Open the Railway dashboard.
2. Select the **production** environment.
3. Locate the `wizard-db` Postgres service.
4. Open the **Backups** tab.
5. Select the backup by date stamp that predates the incident.
6. Click **Restore**. Railway stages the change for review before applying it.
7. Review the staged restore. Confirm the backup date is correct.
8. Click **Deploy** to apply the restore. The current volume is replaced; the previous volume remains unmounted in the project.
9. Confirm the application is reachable: `GET /health` should return `{ status: "ok" }` with HTTP 200.
10. Run the production smoke tests (`ci-smoke.yml` or manually via Playwright against the production URL).
11. If the smoke tests pass, the restore is complete. If they fail, do not release — investigate before opening the application to users.

## Server Restart Recovery

### What Happens on Restart

When the Railway service restarts — whether due to a crash, a deployment, or a Railway infrastructure event — the following occurs:

**Lost immediately (in-memory only):**

- All active Socket.io connections are dropped. Connected clients will experience a disconnect event.
- All in-memory reconnection timers (`setTimeout` keyed by `userId`) are lost.
- Any mid-trick game state that has not been checkpointed is lost. The last checkpoint written to `games.state` is after the previous round ended; mid-trick play for the current round is not recoverable.

**Preserved (in Postgres):**

- All user accounts, sessions, and invite records.
- Completed game records, round results, and the full `game_events` event log.
- The last-committed `GameState` snapshot in `games.state` for each in-progress game (state as of the end of the last completed round).
- All `bug_reports`.

### How In-Progress Games Are Handled on Restart

Upon server startup, the application must query for any games with `status = 'in_progress'` and close them as abandoned. These are games that were active at the time of the restart and can no longer be continued.

**Startup cleanup procedure (application code responsibility):**

1. Query `games` where `status = 'in_progress'`.
2. For each such game, set `status = 'incomplete'` and `ended_at = now()`.
3. For each player in that game, insert a row into `game_results` with `outcome = 'incomplete'` and `drop_reason = 'server_restart'`.
4. Partial per-round stats up to the last committed checkpoint are retained in `rounds` and `round_players` and are not modified.
5. Log each closed game at INFO level with the `gameId` and `drop_reason`.

This cleanup runs before the application begins accepting traffic. It is idempotent: if the server restarts twice in quick succession, the second run finds no `in_progress` games and does nothing.

### Client Behaviour After Restart

Clients whose sockets disconnected during the restart will attempt to reconnect using Socket.io's built-in retry. On reconnect, the server validates their session token. Since sessions are stored in Postgres (not in memory), they survive the restart and remain valid for their configured 24-hour expiry.

However, because all in-progress games have been marked incomplete by the startup cleanup, reconnecting clients whose game was in progress will not be restored to a game. The server emits `game_abandoned` to any client that reconnects and whose last known room is now closed, directing them back to the lobby.

### Recovery Checklist — After an Unexpected Restart

1. Confirm the service is healthy: `GET /health` returns HTTP 200 with `{ status: "ok" }`.
2. Check the Railway log viewer for the startup cleanup log entries — confirm which games (if any) were closed and that the cleanup completed without errors.
3. Check Grafana: confirm that `games_active` and `rooms_active` metrics have reset to 0 or their correct post-restart values.
4. If the restart was caused by an application crash (not a deployment), open a post-mortem issue in the repository and review the crash logs via the Railway log viewer, filtering by the relevant `traceId` where possible.
5. If the restart was caused by a failed deployment, follow the rollback procedure in the Deployment and Infrastructure Plan.

## Open Decisions

| # | Decision | Blocking | Notes |
| --- | --- | --- | --- |
| OD-2 | Database migration strategy | Scenario 2 rollback procedure | Whether migrations are forward-only or reversible determines whether a code rollback is sufficient after a failed deploy that included a migration. Until this is decided, the full volume restore path must be assumed for migration failures. See Deployment and Infrastructure Plan for context. |
