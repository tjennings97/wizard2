# Wizard — Multiplayer Card Game

## Project Overview

Web-based multiplayer implementation of the Wizard card game. React frontend + Express backend, served from a single Railway service, with real-time gameplay via Socket.io and a collocated Postgres database.

**Invite-only registration. Mobile-first. 3–10 players per game, up to 5 spectators.**

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router v6, Vite |
| Backend | Node.js + Express 4 |
| Language | TypeScript (throughout) |
| Real-time | Socket.io 4 |
| Database | PostgreSQL 16 (Knex query builder) |
| Hosting | Railway (app + DB collocated) |
| Logging | pino (structured JSON → stdout) |
| Metrics | prom-client + Grafana Cloud |
| Auth | bcrypt passwords, HTTP-only session cookies |
| Tests | Jest + Supertest (unit/integration), pytest + requests (API), Playwright (E2E) |

## Repository Structure

```
src/
  components/     # Reusable UI: Avatar, Card, Scoreboard, Chat
  pages/          # Route-level: Lobby, Room, Game, Profile, Admin
  hooks/          # useSocket, useGame, useAuth, useRoom
  context/        # AuthContext, GameContext, SocketContext
  engine/         # Shared types mirroring server-side game engine
  api/            # Typed fetch wrappers for REST endpoints
  socket/         # Socket.io client setup and event handlers
  assets/         # Static SVG avatar layers
  styles/         # Global styles, mobile-first CSS
docs/             # Markdown documentation (this project's design docs)
```

## Architecture

Four layers, dependencies flow downward only:

```
API Layer (Express routes)   /api/v1/*
Socket Layer (Socket.io)     socket events
─────────────────────────────────────────
Game Engine Layer            pure TS logic, no I/O
─────────────────────────────────────────
Persistence Layer (Knex)     Postgres queries
```

**Key principle:** The game engine (`src/engine/`) is pure TypeScript with zero I/O dependencies. The socket layer calls engine methods and handles all I/O. Engine is fully unit-testable in isolation.

## Game Engine Classes

- `Card` — immutable value object: suit, rank, type (suited/wizard/jester)
- `Deck` — shuffle, deal, flip trump; `deckSize` config (60 standard, 68 extended future)
- `Round` — hands, bids, tricks won, score deltas per round
- `Trick` — cards played in order; `resolve(trump)` returns winner
- `GameState` — plain serializable snapshot; produced by `game.toGameState()`
- `Game` — orchestrator; owns Deck, current Round, player list; emits nothing
- `User` — base: id, username, displayName, avatarConfig, sessionId
- `Player extends User` — hand, bid, tricksWon; `placeBid(n)`, `playCard(card)`
- `Spectator extends User` — read-only view, no action methods
- `BotPlayer extends Player` — stub only; `placeBid`/`playCard` throw `NotImplementedError`

## API Routes (`/api/v1/`)

Route groups: `auth`, `lobby`, `rooms`, `games`, `users`, `admin`, `bug-reports`, `metrics`

Key endpoints:
- `POST /auth/login` — issues HTTP-only session cookie; invalidates prior session
- `POST /auth/logout` — invalidates session
- `POST /auth/register` — requires valid invite code
- `POST /auth/reset-password` — username + recovery passphrase
- `GET /health` — `{ status: "ok" }`, no auth, used for liveness checks
- `GET /metrics` — Prometheus endpoint, bearer token protected

## Socket.io Events

**Lobby:** `lobby:state`, `lobby:rooms_updated`, `lobby:presence_updated`

**Room:** `room:state`, `room:player_joined`, `room:player_left`, `room:host_changed`, `room:chat_message`, `room:config_updated`, `room:game_starting`

**Game:** `game:round_started`, `game:bid_phase`, `game:bid_placed`, `game:trick_phase`, `game:card_played`, `game:trick_completed`, `game:round_completed`, `game:completed`

**Player-specific (individual socket only):** `player:hand_dealt`, `player:your_turn`, `player:state_restored`

**Connection:** `player:disconnected`, `player:reconnected`, `player:quit`, `session:invalidated`

**Spectator filtering:** Hand data is NEVER broadcast to a room. It is sent only via `socket.to(socketId).emit(...)` to the individual player.

## Database Tables

`users`, `sessions`, `invites`, `rooms`, `room_members`, `games`, `rounds`, `round_players`, `game_results`, `game_events` (append-only event log), `bug_reports`

Key schema notes:
- `users.avatar_config` — JSONB (three layer IDs)
- `games.state` — JSONB checkpoint of `GameState`, written after each round
- `game_events.payload` — JSONB full context snapshot per event
- `sessions` stored in Postgres (not Redis); one active session per user

## Scoring Rules

- Exact bid: **+20 + (10 × tricks won)**
- Overbid: **−10 × tricks over bid**
- Underbid: **−10 × tricks under bid**
- Scores may go negative; no floor

## Game Rules (key points)

- Standard 60-card deck (4 suits × 13 ranks + 4 Wizards + 4 Jesters)
- Max rounds: `Math.floor(deckSize / playerCount)`
- Trump determination: suited card → sets trump; Jester → no trump; Wizard → dealer declares; last round if `deckSize % playerCount === 0` → no trump
- Trick winner priority: **first Wizard → highest trump → highest led suit → first Jester**
- Bid total rule: open (default) or uneven (dealer's bid cannot make sum equal trick count)

## Key Behaviors

**Reconnection:** 30-second server-side timer (`setTimeout` keyed by userId). On reconnect within window: session validated, `GameState` snapshot pushed via `player:state_restored`. On timeout: player treated as quit.

**Player drop mid-game:** Current round is voided and re-dealt to remaining players. Drop to 2 players: remaining players prompted to continue or end.

**Single session:** New login invalidates any existing session. Displaced socket receives `session:invalidated`.

**Forced credential change:** Admin credential reset sets `requires_credential_change = true` on the user record. Client intercepts the flag on next login and forces a change-password flow before any other navigation.

**Room timeout:** Room auto-closes 10 minutes after creation if game hasn't started.

**GameState checkpointing:** Written to `games.state` after each round ends. Mid-trick state is not checkpointed.

## User Roles

| Role | Notes |
|---|---|
| Player | Default for all registered users |
| Spectator | Transient per-room role; max 5 per room; cannot see hands |
| Host | First player to enter a room; role transfers on leave; dissolved when game starts |
| Admin | Manages invites, roles, account resets; cannot self-remove admin role |

## Frontend Notes

- **State management:** React context + hooks only. No Redux/Zustand.
- `GameContext` — live game state from socket events
- `AuthContext` — session state
- `SocketContext` — single Socket.io client instance (created on login, torn down on logout)
- **Routing:** React Router v6. Routes: `/` (lobby), `/room/:id`, `/game/:id`, `/profile`, `/admin`
- **Mobile-first:** `min-width` media queries; touch targets ≥ 44×44px; no hover-only affordances; 375px viewport minimum
- **Game board layout:** Vertical single-column on mobile (hand at bottom, trick in middle, opponents at top); table-surround on desktop
- **Avatars:** Three SVG layers (face, expression, hair) composited via `position: absolute` stacking. No server-side image processing.

## Security

- Passwords and recovery passphrases: bcrypt work factor 12
- Session tokens: HTTP-only cookies; hashed before Postgres storage; never logged
- CORS: production domain only; `credentials: true`; dev allows `localhost:5173`
- Game actions: server validates acting user is current player, it's their turn, action is legal
- `/metrics`: bearer token protected, not publicly accessible
- Admin routes: role-check middleware (`req.user.role === 'admin'`)
- Rate limiting: `express-rate-limit` on auth endpoints
- Secrets: environment variables only; never committed; `config.ts` validates all required vars on startup and fails loudly if any are missing

## Observability

- **Logging:** pino structured JSON; every entry includes `timestamp`, `level`, `traceId`, `userId`, `roomId`, `gameId`, `message`
- **TraceId:** UUID per session; persists across all requests and socket events; stored in bug reports for correlation with server logs
- **Prometheus metrics:** `http_request_duration_seconds`, `http_requests_total`, `ws_connections_active`, `ws_reconnections_total`, `games_active`, `rooms_active`, `games_started_total`, `games_completed_total`, `bug_reports_total`, `players_connected`
- **Grafana Cloud:** scrapes `/metrics` every 30s; alerts on error rate spikes and downtime

## Environment Variables

Required (validated at startup via `config.ts`):
- Database URL
- Session secret
- JWT signing key (if applicable)
- Socket.io config
- Prometheus bearer token
- `NODE_ENV` (`development` | `production`)

Local dev: `.env` file (not committed). See `.env.example` for required keys.

## Deployment

- **Platform:** Railway — single service, single domain
- **Deploy:** Auto-deploy on push to `main` branch (GitHub)
- **Rollback:** Railway deploy history UI
- **TLS:** Let's Encrypt via Railway; HTTP redirected to HTTPS; WebSocket connections upgrade to WSS
- **Budget:** $10–20/month target

## What's Out of Scope (This Version)

- Bot/AI players (interface stubbed in `BotPlayer`; `game_events` log collects training data)
- Extended 68-card deck (engine parameterised; `Deck` takes `deckSize` constructor arg)
- Public registration (invite system only)
- Full analytics dashboard (metrics collected, display deferred)
- Native mobile apps (mobile browser is first-class)
- Horizontal scaling (single Railway instance; Redis adapter path documented for future)

## Project Documents

| Document | URL |
|---|---|
| Getting Started (local dev / onboarding) | /Users/tamarajennings/wizard2/docs/development/getting-started.md |
| PRD | /Users/tamarajennings/wizard2/docs/product/prd.md |
| System Architecture | /Users/tamarajennings/wizard2/docs/architecture/system-architecture.md |
| Entity Relationship Diagram & Data Dictionary | /Users/tamarajennings/wizard2/docs/architecture/data-model.md |
| OpenAPI 3.0 Specification | /Users/tamarajennings/wizard2/docs/api/openapi-spec.md |
| WebSocket Event Taxonomy | /Users/tamarajennings/wizard2/docs/api/websocket-events.md |
| Game Rules Reference | /Users/tamarajennings/wizard2/docs/product/game-rules.md |
| Game State Machine | /Users/tamarajennings/wizard2/docs/architecture/game-state-machine.md |
| UI/UX Flow Diagrams | /Users/tamarajennings/wizard2/docs/product/ui-ux-flows.md |
| Use Case Document | /Users/tamarajennings/wizard2/docs/product/use-cases.md |
| Avatar System Specification | /Users/tamarajennings/wizard2/docs/architecture/avatar-system.md |
| UI Foundation Brief | /Users/tamarajennings/wizard2/docs/design/ui-foundation.md |
| Animation & Transition Spec | /Users/tamarajennings/wizard2/docs/design/animation-transitions.md |
| Test Plan | /Users/tamarajennings/wizard2/docs/testing/test-plan.md |
| Deployment & Infrastructure Plan | /Users/tamarajennings/wizard2/docs/operations/deployment-infrastructure.md |
| Security Considerations | /Users/tamarajennings/wizard2/docs/architecture/security.md |
| Observability & Alerting Guide | /Users/tamarajennings/wizard2/docs/operations/observability-alerting.md |
| Backup & Recovery Runbook | /Users/tamarajennings/wizard2/docs/operations/backup-recovery.md |