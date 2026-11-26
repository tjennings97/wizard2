# Wizard — Multiplayer Card Game

## Project Overview

Web-based multiplayer implementation of the Wizard card game. React frontend + Express backend, served from a single Railway service, with real-time gameplay via Socket.io and a collocated Postgres database.

**Invite-only registration. Mobile-first. 3–10 players per game, up to 5 spectators.**

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Router v7, Vite |
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
- `Deck` — shuffle, deal, flip trump; built from a deck type (`standard`; `camelot` future)
- `Ruleset` — per-edition rules: deck, trump from flip, follow-suit legality, trick resolution
- `Round` — hands, bids, tricks won, score deltas per round
- `Trick` — cards played in order; `resolve(trump)` returns winner
- `GameState` — plain serializable snapshot (server-side only: holds every hand); produced by `game.toGameState()` and written to `games.state` as a record; not used to resume games after a server restart. Client-safe views: `game.toPlayerView(userId)` (own hand only) and `game.toSpectatorView()` (no hands)
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

Event names and payloads are defined in the WebSocket Event Taxonomy ([docs/api/websocket-events.md](docs/api/websocket-events.md)), which is authoritative for event names. All names are `snake_case`.

**Client → server:** `join_game` (also used to reconnect, with `last_seq_seen`), `leave_game`, `send_chat_message`, `select_trump`, `place_bid`, `play_card`, `choose_continue_or_end`, `sync_request`, `ping`

**Lobby:** `lobby_snapshot`, `rooms_updated`, `presence_updated`

**Room:** `room_snapshot`, `user_joined`, `user_left`, `host_changed`, `chat_message`, `room_config_updated`, `room_closed`, `game_starting`

**Game:** `game_started`, `round_started`, `trump_revealed`, `bid_placed`, `all_bids_placed`, `card_played`, `trick_complete`, `round_complete`, `continue_or_end_request`, `game_time_warning`, `game_over`, `game_abandoned`

**Player-specific (individual socket only):** `hand_dealt`, `trump_selection_request`, `bid_request`, `play_request`, `state_snapshot`, `invalid_bid_error`, `invalid_trump_error`, `invalid_play_error`, `pong`

**Connection:** `player_disconnected`, `player_reconnected`, `user_left` (`reason: "voluntary"` = quit, `"timeout"` = did not reconnect in time), `session_error` (`code: "SESSION_INVALIDATED"` for a displaced socket)

**Spectator filtering:** Hand data is NEVER broadcast to a room. It is sent only via `socket.to(socketId).emit(...)` to the individual player.

## Database Tables

`users`, `sessions`, `invites`, `rooms`, `room_members`, `games`, `rounds`, `round_players`, `game_results`, `game_events` (append-only event log), `bug_reports`

Key schema notes:
- `users.avatar_config` — JSONB (four keys: `head`, `skin`, `face`, `hair`)
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

**Reconnection:** A dropped connection is not a quit. The server broadcasts `player_disconnected` and holds the player's seat for 30 seconds (`setTimeout` keyed by userId). If the player rejoins within the window (`join_game` with `last_seq_seen`): session validated, `game.toPlayerView(userId)` sent via `state_snapshot` (never the raw `GameState`), missed events replayed, `player_reconnected` broadcast, and they continue exactly where they left off. If the window expires: `user_left` (`reason: "timeout"`) and player-drop rules apply.

**Quitting:** A player who leaves intentionally (`leave_game`, or `POST /rooms/{roomId}/leave`) has quit: `user_left` (`reason: "voluntary"`), player-drop rules apply, and they cannot rejoin as a player (they may rejoin as a spectator).

**No turn timers:** The game waits for each player to bid, play, or declare trump.

**Game time limit:** A game lasts at most 3 hours. `game_time_warning` is broadcast at 2 h 45 min; at 3 hours the game is abandoned (`game_abandoned`, `reason: "time_limit"`) and recorded `incomplete` (`drop_reason = 'time_limit'`, no winner).

**Session lifetime:** Sliding 24h idle timeout, 30-day hard cap (cookie lives 30 days; the database decides validity). In the last 24h before the cap, requests return `401 REAUTH_REQUIRED` unless the user is an active player in a game in progress; creating, joining, or starting a room returns it regardless (`requireSessionRunway`). Logout always works. The client shows the login screen on `REAUTH_REQUIRED`. Each login deletes the user's session rows that ended more than 24h ago (kept that long so a displaced device still gets `SESSION_INVALIDATED`). The socket layer must validate with `authenticateToken` on connect and on game actions so socket-only play keeps the session alive.

**Player drop mid-game:** Current round is voided and re-dealt to remaining players. Drop to 2 players: remaining players prompted to continue or end.

**Single session:** New login invalidates any existing session. Displaced socket receives `session_error` (`code: "SESSION_INVALIDATED"`, `fatal: true`).

**Forced credential change:** Admin credential reset sets `requires_credential_change = true` on the user record. Client intercepts the flag on next login and forces a change-password flow before any other navigation. While the flag is `true`, the server allows only `GET /users/me`, `PATCH /users/me` and `POST /auth/logout`; every other authenticated route returns `403 CREDENTIAL_CHANGE_REQUIRED`, so the change cannot be skipped by calling the API directly. Routes opt in with `authenticate({ allowDuringCredentialChange: true })`.

**Room timeout:** Room auto-closes 10 minutes after creation if game hasn't started.

**Server restart:** In-progress games are abandoned, not resumed. Before accepting traffic, startup cleanup marks every `in_progress` game `incomplete` (`drop_reason = 'server_restart'`). Clients that reconnect receive `game_abandoned` and return to the lobby. See the Backup & Recovery Runbook.

**GameState checkpointing:** Written to `games.state` after each round ends, as a record for history and bug reports. It is not used to resume a game.

## User Roles

| Role | Notes |
|---|---|
| Player | Default for all registered users |
| Spectator | Transient per-room role; max 5 per room; cannot see hands |
| Host | First player to enter a room; role transfers on leave or after 2 min disconnected (next connected player by join order); dissolved when game starts |
| Admin | Manages invites, roles, account resets; cannot self-remove admin role |

## Frontend Notes

- **State management:** React context + hooks only. No Redux/Zustand.
- `GameContext` — live game state from socket events
- `AuthContext` — session state
- `SocketContext` — single Socket.io client instance (created on login, torn down on logout)
- **Routing:** React Router v7 (import from `react-router`; `react-router-dom` is not used). Routes: `/` (lobby), `/room/:id`, `/game/:id`, `/profile`, `/admin`
- **Mobile-first:** `min-width` media queries; touch targets ≥ 44×44px; no hover-only affordances; 375px viewport minimum
- **Game board layout:** Vertical single-column on mobile (hand at bottom, trick in middle, opponents at top); table-surround on desktop
- **Avatars:** Four SVG layers (`head`, `skin`, `face`, `hair`; see the Avatar System Specification) composited via `position: absolute` stacking. No server-side image processing.

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
- Socket.io config
- Prometheus bearer token
- `NODE_ENV` (`development` | `production`)

Local dev: `.env` file (not committed). See `.env.example` for required keys.

## Deployment

- **Platform:** Railway — single service, single domain
- **Environments:** local dev and production only; no staging. E2E tests run in CI on every PR; k6 performance tests run on a CI schedule
- **Deploy:** Auto-deploy on push to `main` branch (GitHub); PRs to `main` must pass CI
- **Rollback:** Railway deploy history UI
- **TLS:** Let's Encrypt via Railway; HTTP redirected to HTTPS; WebSocket connections upgrade to WSS
- **Budget:** $10–20/month target

## What's Out of Scope (This Version)

- Bot/AI players (interface stubbed in `BotPlayer`; `game_events` log collects training data)
- Wizard Camelot Edition deck (engine selects a `Ruleset` by `deckType`; Camelot ruleset and card types not built)
- Public registration (invite system only)
- Full analytics dashboard (metrics collected, display deferred)
- Native mobile apps (mobile browser is first-class)
- Horizontal scaling (single Railway instance; Redis adapter path documented for future)

## Project Documents

The documents below, in this repo, are the source of truth for the project's specs. Copies kept elsewhere (for example in Claude Docs) may be out of date and are not authoritative. Event names are defined by the WebSocket Event Taxonomy.

| Document | URL |
|---|---|
| Getting Started (local dev / onboarding) | docs/development/getting-started.md |
| PRD | docs/product/prd.md |
| System Architecture | docs/architecture/system-architecture.md |
| Entity Relationship Diagram & Data Dictionary | docs/architecture/data-model.md |
| OpenAPI 3.0 Specification | docs/api/openapi-spec.md |
| WebSocket Event Taxonomy | docs/api/websocket-events.md |
| Game Rules Reference | docs/product/game-rules.md |
| Game State Machine | docs/architecture/game-state-machine.md |
| UI/UX Flow Diagrams | docs/product/ui-ux-flows.md |
| Use Case Document | docs/product/use-cases.md |
| Avatar System Specification | docs/architecture/avatar-system.md |
| UI Foundation Brief | docs/design/ui-foundation.md |
| Animation & Transition Spec | docs/design/animation-transitions.md |
| Test Plan | docs/testing/test-plan.md |
| Deployment & Infrastructure Plan | docs/operations/deployment-infrastructure.md |
| Security Considerations | docs/architecture/security.md |
| Observability & Alerting Guide | docs/operations/observability-alerting.md |
| Backup & Recovery Runbook | docs/operations/backup-recovery.md |