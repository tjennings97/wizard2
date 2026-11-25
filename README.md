# Wizard

A web-based, real-time multiplayer version of the **Wizard** trick-taking card game, built for a private, invite-only group of players and playable in desktop and mobile browsers.

> **Status:** Scaffold. The repo has the product and technical specs plus a runnable skeleton: an Express + Socket.io server, a React client, and a Knex database connection. There is no game logic, auth, or schema yet.

## Quick start

```bash
npm install
cp .env.example .env     # then fill in the values
npm run dev              # server on :3000, client on :5173
```

Open http://localhost:5173. `curl localhost:3000/health` should return `{"status":"ok"}`.

For prerequisites, Postgres setup, commands, and troubleshooting, see **[Getting Started](docs/development/getting-started.md)**.

## Highlights

- **3–10 players** per game, plus up to **5 spectators** per room
- Full Wizard engine using the standard 60-card deck (52 suited cards + 4 Wizards + 4 Jesters), with a host-configurable round count and bid-total rule
- Real-time gameplay, in-room chat, and presence over **Socket.io**
- **Invite-only registration** managed by admins (no email collected; password reset via recovery passphrase)
- SVG-layered player **avatars**
- Per-player game history and performance metrics
- In-app **bug reporting** that captures session and game-state context
- Structured logging (pino) and Prometheus metrics scraped by Grafana Cloud

**Out of scope for v1:** bot/AI players (interface stubbed), public registration, the Wizard Camelot Edition deck, a full analytics dashboard, and native mobile apps.

## Planned tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18 SPA (mobile-first) |
| Backend | Node.js + Express 4, REST under `/api/v1/` |
| Real-time | Socket.io 4 (same HTTP server as Express) |
| Language | TypeScript |
| Database | PostgreSQL 16 via Knex (query builder + migrations) |
| Auth | bcrypt-hashed credentials, server-validated session tokens, single active session per user |
| Observability | pino logs, prom-client `/metrics` (bearer-token protected), Grafana Cloud |
| Hosting | Railway (app + private Postgres), auto-deploy on push to `main` |
| Testing | Jest + Supertest, pytest, socket.io-client, Playwright, k6 |

## Architecture at a glance

The backend is a single Express service with four layers. Each layer calls only the layers below it:

```
API layer (Express routes) + Socket layer (Socket.io)
            │
Game engine: pure TypeScript OOP, no I/O
(Card, Deck, Round, Trick, GameState, Game, Player, Spectator, BotPlayer)
            │
Persistence layer (Knex → Postgres)
```

All game rules live in the engine, so it can be unit-tested without a network or database. The socket layer validates the session on every event, calls engine methods, broadcasts the results, and persists `GameState` snapshots after each state change.

## Documentation map

New to the project? Begin with [Getting Started](docs/development/getting-started.md) to run the app locally. Then read the PRD, followed by the documents for the area you're working on.

**Product** ([docs/product/](docs/product/))

| Document | What it covers |
| --- | --- |
| [Product Requirements Document](docs/product/prd.md) | Scope, user roles (Player, Spectator, Host, Admin), auth, lobby, rooms, scoring, NFRs, hosting |
| [Game Rules Reference](docs/product/game-rules.md) | Deck, setup, trump, bidding, trick-taking, scoring, edge cases |
| [Use Case Document](docs/product/use-cases.md) | UC-01 – UC-25: registration, lobby, gameplay, spectating, admin |
| [UI/UX Flow Diagrams](docs/product/ui-ux-flows.md) | Screen flows from auth through game end, drop handling, admin panel |

**Development** ([docs/development/](docs/development/))

| Document | What it covers |
| --- | --- |
| [Getting Started](docs/development/getting-started.md) | Prerequisites, env setup, running locally, commands, project layout, migrations, troubleshooting |

**Architecture** ([docs/architecture/](docs/architecture/))

| Document | What it covers |
| --- | --- |
| [System Architecture](docs/architecture/system-architecture.md) | Stack, deployment topology, layering, engine, real-time, persistence, security, key decisions |
| [Game State Machine](docs/architecture/game-state-machine.md) | Room, game, round, trick, and player-connection lifecycles; persistence and restore |
| [ERD & Data Dictionary](docs/architecture/data-model.md) | Postgres tables, indexes, JSONB payload schemas |
| [Avatar System Specification](docs/architecture/avatar-system.md) | Avatar configuration, data model, endpoints, rendering |
| [Security Considerations](docs/architecture/security.md) | Threat model, auth and authorization threats, input validation, rate limits, secrets hygiene, open risks |

**Design** ([docs/design/](docs/design/))

| Document | What it covers |
| --- | --- |
| [UI Foundation Brief](docs/design/ui-foundation.md) | Design principles, color tokens, typography, spacing, core components, per-screen guidance |
| [Animation & Transition Spec](docs/design/animation-transitions.md) | Timing and easing tokens, per-event game animations, UI state animations, reduced motion |

**API** ([docs/api/](docs/api/))

| Document | What it covers |
| --- | --- |
| [OpenAPI 3.0 Specification](docs/api/openapi-spec.md) | REST endpoints (auth, users, lobby, rooms, games, admin, bug reports, health) and error catalogue |
| [WebSocket Event Taxonomy](docs/api/websocket-events.md) | Event naming, envelope schema, client↔server events, ordering, reconnection, spectator mode |

**Testing** ([docs/testing/](docs/testing/))

| Document | What it covers |
| --- | --- |
| [Test Plan](docs/testing/test-plan.md) | Test environments, tools, feature × test-type matrix, use-case coverage, performance criteria, prod smoke suite |

**Operations** ([docs/operations/](docs/operations/))

| Document | What it covers |
| --- | --- |
| [Deployment & Infrastructure Plan](docs/operations/deployment-infrastructure.md) | Dev and prod environments, Railway setup, branch strategy, GitHub Actions CI, rollback, secrets, backups |
| [Observability & Alerting Guide](docs/operations/observability-alerting.md) | Logging, Prometheus metrics, Grafana dashboards, alert rules and thresholds, k6 metrics, log retention |
| [Backup & Recovery Runbook](docs/operations/backup-recovery.md) | Backup schedule, `pg_dump` exports, restore procedure, recovery scenarios, server-restart handling |

## Configuration

See the [Deployment & Infrastructure Plan](docs/operations/deployment-infrastructure.md) for the full environment and secrets setup. Configuration comes from environment variables: a local `.env` file in development, and the Railway dashboard in production. A `config.ts` module checks them at startup and refuses to boot if any required variable is missing. The required categories are:

- Database connection URL
- Session secret
- Prometheus `/metrics` bearer token
- Environment name
- Socket.io settings

Currently required: `DATABASE_URL`, `SESSION_SECRET`, `PROMETHEUS_TOKEN`, `NODE_ENV`. Copy `.env.example` to `.env` for local development. Real secrets must never be committed.

## Spec inconsistencies to resolve

**Open:**

1. **Camelot Edition gaps (future):** the publisher's Camelot rules leave several points unclear, including null tricks and an incomplete Hand One rule. They are listed under Open questions in the Game Rules Reference's Camelot Edition section and must be settled before that edition is built.

**Resolved (Nov 25, 2026):** the docs were updated to match these decisions.

- **Environments:** local dev and production only, with no staging. E2E tests run in CI on every PR; k6 performance tests run on a CI schedule.
- **API test client:** `pytest + requests`.
- **JWT signing key:** removed. Auth uses HTTP-only session cookies only.
- **Smoke test account:** username `smoke_test`, with no email address.
- **Avatar config:** four keys (`head`, `skin`, `face`, `hair`), per the Avatar System Specification.
- **Following suit:** a Wizard or Jester may be played at any time, even by a player who holds the suit to follow.
- **Jester lead:** the first card that is not a Jester decides. A Wizard means no suit obligation for the rest of the trick; a suited card sets the suit, and a later Wizard does not cancel it.
- **Server restart:** in-progress games are abandoned (`game_abandoned`), not resumed.
- **Event names:** defined by the WebSocket Event Taxonomy (`docs/api/websocket-events.md`).
