# Wizard — System Architecture Document

## System Overview

Wizard is a single-domain web application: a React frontend and an Express backend served from the same Railway service, backed by a collocated Postgres database, with real-time game state delivered over Socket.io WebSockets. Grafana Cloud scrapes Prometheus metrics; Railway captures structured logs.

The system has five major runtime layers:

- **Frontend** — React SPA, mobile-first, renders game state and relays player actions via Socket.io
- **API layer** — Express REST endpoints under `/api/v1/`, handling auth, lobby, admin, history, and bug reports
- **Socket layer** — Socket.io server managing rooms, event broadcasting, reconnection, and spectator filtering
- **Game engine** — Pure TypeScript/JavaScript OOP layer: `Card`, `Deck`, `Round`, `Trick`, `GameState`, `Game`, `User`/`Player`/`Spectator`/`BotPlayer`; no knowledge of HTTP or sockets
- **Persistence layer** — Postgres accessed via a query builder (Knex); stores users, sessions, rooms, game state snapshots, event log, metrics, invites, and bug reports

All game logic is isolated in the game engine. The socket layer calls engine methods and broadcasts the results. This separation means the engine can be unit-tested without any network or database involvement.

## Technology Stack

| Layer | Technology | Rationale |
| --- | --- | --- |
| Frontend | React 18 | Component model suits game state rendering; wide ecosystem |
| Backend | Node.js + Express 4 | Same language as frontend; Socket.io native support; lightweight |
| Real-time | Socket.io 4 | WebSocket abstraction with rooms, reconnection events, and HTTP fallback |
| Language | TypeScript | Type safety across engine, API, and socket layers |
| Database | PostgreSQL 16 | Relational integrity for game/user data; JSONB for event log payloads |
| Query builder | Knex | Lightweight; no ORM overhead; migration support |
| Password hashing | bcrypt | Industry standard; intentionally slow |
| Logging | pino | Structured JSON; high throughput; minimal overhead |
| Metrics | prom-client | Prometheus-compatible; standard in Node.js |
| Observability | Grafana Cloud (free tier) | Hosted dashboards; scrapes `/api/v1/metrics`; no self-hosted infra |
| Hosting | Railway | App + Postgres collocated; WebSocket support; auto-deploy from GitHub |
| API style | REST, `/api/v1/` prefix | Simple; versioned from day one |
| API spec | OpenAPI 3.0 | Spec-first; contract for tests and AI task context |
| API tests | pytest + requests | Familiar; readable; decoupled from Node test runner |
| Unit/integration tests | Jest + Supertest | Native Node; in-process Express testing |
| E2E / UI tests | Playwright | Browser-level; socket-aware; mobile viewport testing; parallel test execution |

## Deployment Topology

&#91;embedded content: deployment topology · Railway private network + external services\]

All production services run within Railway's private network. The Express app serves the React build and handles both REST and WebSocket traffic on a single port behind TLS with a custom domain. Postgres is reachable only from within the Railway project — its port is not exposed to the public internet. Grafana Cloud scrapes the `/api/v1/metrics` endpoint from outside Railway over HTTPS using a bearer token. GitHub triggers automatic deploys on push to main.

**Environment tiers:** `development` (local, `.env` file), `production` (Railway, env vars set in dashboard). There is no staging tier: Railway's deploy history and rollback UI cover recovery from a bad deploy, and pre-release E2E and performance tests run in CI.

**TLS:** Railway provisions Let's Encrypt certificates automatically on custom domain attachment. All browser traffic is HTTPS; WebSocket connections upgrade to WSS.

## Application Layer Architecture

The Express app is structured in four layers that depend downward only — upper layers call lower ones; lower layers have no knowledge of upper ones.

```
┌─────────────────────────────────────────┐
│           API Layer (Express routes)     │  /api/v1/*
│           Socket Layer (Socket.io)       │  socket events
├─────────────────────────────────────────┤
│           Game Engine Layer              │  pure logic, no I/O
├─────────────────────────────────────────┤
│           Persistence Layer (Knex)       │  Postgres queries
└─────────────────────────────────────────┘
```

**API layer:** Express routers mounted under `/api/v1/`. Route groups: `auth`, `lobby`, `rooms`, `games`, `users`, `admin`, `bug-reports`, `metrics` (Prometheus endpoint). Each route validates the request, calls a service function, and returns a response. No game logic lives here.

**Socket layer:** Socket.io server shares the same HTTP server as Express. Handles: player/spectator join, leave, reconnect; game action events (bid, play card, declare trump); chat messages; lobby and room presence broadcasts. Validates session on every event. Calls game engine methods and persists `GameState` snapshots after state-changing events.

**Game engine layer:** Pure OOP classes with no I/O dependencies. Receives method calls from the socket layer, mutates game state, and returns results. Fully unit-testable in isolation. Exposes `toGameState()` for serialization.

**Persistence layer:** Knex query builder with Postgres. Provides typed repository functions for each entity (users, sessions, rooms, games, rounds, tricks, events, invites, bug reports). No raw SQL outside this layer. Migrations managed with Knex migrate.

**Config and startup validation:** A `config.ts` module reads all required environment variables on startup and throws a descriptive error if any are missing. The app will not start with an incomplete config. Categories: database, session secret, Prometheus bearer token, environment name, Socket.io config.

## Frontend Architecture

The React app is a single-page application (SPA) built with Vite, served as a static build from the Express app in production. It is specifically designed for mobile browsers with full desktop support.

**Directory structure:**

```
src/
  components/       # Reusable UI components (Avatar, Card, Scoreboard, Chat)
  pages/            # Route-level components (Lobby, Room, Game, Profile, Admin)
  hooks/            # Custom hooks (useSocket, useGame, useAuth, useRoom)
  context/          # React context providers (AuthContext, GameContext, SocketContext)
  engine/           # Shared types mirroring server-side game engine models
  api/              # Typed fetch wrappers for REST endpoints
  socket/           # Socket.io client setup and event handlers
  assets/           # Static SVG avatar layers
  styles/           # Global styles and mobile-first CSS
```

**State management:** React context + hooks. No external state library (Redux, Zustand) is used at this scale. `GameContext` holds live game state received from socket events. `AuthContext` holds session state. `SocketContext` holds the Socket.io client instance.

**Socket client:** A single Socket.io client instance, created on login and torn down on logout. The `useSocket` hook provides access to it. All incoming game events update `GameContext` via dispatchers. Outgoing actions (bid, play card) call socket emit functions exposed by `useGame`.

**Routing:** React Router v7. Routes: `/` (lobby), `/room/:id` (room/pre-game), `/game/:id` (active game), `/profile` (history and settings), `/admin` (admin panel, role-guarded).

**Mobile-first layout:** CSS uses `min-width` media queries (mobile base, desktop enhancement). Touch targets are at least 44×44px. No hover-only interactions. Game board layout is a round table on every screen size: players sit around an oval felt (the viewer at the bottom, the rest clockwise in seat order, spaced evenly around the rim), trump lies in the middle and each played card lands in front of the player who played it; the viewer's hand and actions sit below the table. The oval is portrait on mobile and landscape on wider screens, and it seats the 10-player maximum at every size. From 1100px the scoreboard sits beside the table.

**Avatar rendering:** Avatar config is four slugs (`head`, `skin`, `face`, `hair`, per the Avatar System Specification). The client stacks three bundled SVG layer files (`head`, `face`, `hair`) with CSS `position: absolute` inside a fixed-size circle; `skin` is the head layer's fill colour. The option catalog lives in one module that client and server both import (`server/src/shared/avatar.ts`), and the server validates every slug against it. No SVG is accepted from clients or stored, and there is no image processing on the server.

**Performance:** Code-split by route. Avatar SVGs are lightweight and inline-rendered. Socket events update only the relevant slice of `GameContext`, minimising re-renders.

## Game Engine Architecture

&#91;embedded content: game engine class hierarchy · inheritance and composition\]

The game engine is a pure TypeScript layer with no I/O dependencies. All classes live under `src/engine/` on the server and are importable by the socket layer and tests without any HTTP or database involvement.

**Card:** Immutable value object. Properties: `suit` (Hearts/Diamonds/Spades/Clubs/null for special), `rank` (2–14 for Ace, null for special), `type` (suited/wizard/jester). Equality by suit+rank+type. Future editions add new values to `type`; how each type behaves in a trick is defined by the edition's `Ruleset`, not by `Card`.

**Deck:** Holds a `Card[]`, built from a deck type (`standard`; `camelot` in future) whose ruleset supplies the cards and `deckSize` (60 for both). Methods: `shuffle()`, `deal(n)` returns n cards and removes them, `flip()` returns the next card for trump. Deck is stateful per round and reconstructed fresh each round.

**Round:** Tracks: dealt hands per player, bids per player, tricks won per player, score deltas. Owns a `Trick[]` for the round. Exposes `recordBid(playerId, n)`, `recordTrickWon(playerId)`, `computeScores()`. Immutable after `computeScores()` is called.

**Trick:** Tracks cards played in order with their player IDs. Method `resolve(trump)` returns the winning player ID using its edition's ruleset. Standard priority: first Wizard → highest trump → highest led suit → first Jester. Records winning card type for event log.

**GameState:** A plain serializable object (no methods) produced by `game.toGameState()`. Contains: game config, current round number, current trick number, all hands (per player, private), all bids, all tricks-won counts, trump suit, whose turn, scores to date, room ID, dropped players (with names and final scores), and any pending continue-or-end decision. Used for: Postgres checkpoint (a record for history), bug report snapshot. It is not used to resume games after a server restart; those games are abandoned. Never sent to clients as-is: `game.toPlayerView(userId)` and `game.toSpectatorView()` produce filtered copies.

**Game:** The orchestrator. Owns the `Deck`, current `Round`, and player list. Methods: `startRound()`, `declareTrump()`, `placeBid()`, `playCard()`, `endGame()`, `removePlayer()`, `resolveContinueOrEnd()`. Tricks advance and rounds are scored inside `playCard()`. Each method returns a result describing what happened; Game emits no events, and the socket layer broadcasts the results. `toGameState()` serializes full state; `toPlayerView(userId)` and `toSpectatorView()` produce client-safe copies.

**User / Player / Spectator / BotPlayer:** `User` is the base class (id, username, displayName, avatarConfig, sessionId). `Player` adds hand, bid, tricksWon, and action methods `placeBid(n)` and `playCard(card)`. `Spectator` extends `User` with no action methods — read-only. `BotPlayer` extends `Player` with `placeBid` and `playCard` throwing `NotImplementedError`, preserving the interface for future AI integration.

**Ruleset:** One per deck edition, selected by the game's `deckType`. Defines the deck's cards and size, trump from the flipped card, follow-suit legality, and trick resolution. `Trick`, `Round` and `Game` delegate to it rather than hard-coding card behaviour.

**Extensibility for other editions:** The Wizard Camelot Edition is the planned second edition. Adding it means a new `Ruleset` plus its new card types, not changes to the standard rules or the core classes. Max-round formula is `Math.floor(deckSize / playerCount)`, with `deckSize` taken from the ruleset. See the Game Rules Reference for Camelot's rules and open questions.

## Real-Time Communication Architecture

**Socket.io room model:** Each game room maps to a Socket.io room named `room:<roomId>`. Lobby presence is a separate room `lobby`. Players and spectators join the same Socket.io room; spectator filtering is applied at the emit level — hand data is never broadcast to a room, only sent in individual player-targeted events.

**Session-socket binding:** On socket connect, the browser sends the signed HTTP-only session cookie with the handshake (`withCredentials: true`); the client never reads the token. The server validates the cookie's session, looks up the user, and stores `socket.data.userId` and `socket.data.roomId`. Every subsequent event handler reads from `socket.data` — no session lookup per event.

**Reconnection sequence:**

1. Socket disconnect detected → server starts a 2-minute `setTimeout` keyed by `userId`
2. `player_disconnected` broadcast to the room; other players see a visual indicator
3. Client attempts to reconnect (Socket.io built-in retry with the same session token)
4. On reconnect: session validated, `setTimeout` cleared, `game.toPlayerView(userId)` (own hand only) sent to the reconnecting socket via `state_snapshot`
5. `player_reconnected` broadcast to the room; indicator cleared
6. If timer expires before reconnect: player treated as quit, `user_left` (`reason: "timeout"`) broadcast, game drop logic applied

A player who leaves intentionally (`leave_game`) has quit immediately: `user_left` (`reason: "voluntary"`) is broadcast and there is no reconnection window.

**Event flow — lobby:** Client connects → joins `lobby` room → receives `lobby_snapshot` (current rooms, presence). On room changes or player joins/leaves lobby: `rooms_updated` and `presence_updated` broadcast to all lobby members.

**Event flow — room:** Player opens/joins room → joins `room:<id>` → receives `room_snapshot`. Events: `user_joined`, `user_left`, `host_changed`, `chat_message`, `room_config_updated` (rounds, bid rule), `game_starting`.

**Event flow — game:** `game_started`, then per round: `round_started`, `trump_revealed`, `bid_placed`, `all_bids_placed`, `card_played`, `trick_complete`, `round_complete`; finally `game_over` (or `game_abandoned` after a server restart). Player-specific events: `hand_dealt`, `trump_selection_request`, `bid_request`, `play_request`, `state_snapshot`. Event names and payloads are defined in the WebSocket Event Taxonomy.

**Spectator filtering:** Game events sent to the room omit hand data. After each deal, `hand_dealt` is emitted individually to each player socket using `socket.to(socketId).emit(...)`. Spectators never receive a hand payload.

## Persistence Architecture

**Database:** PostgreSQL 16, collocated with the app on Railway. Accessed exclusively through Knex; no raw SQL outside the persistence layer. Schema migrations managed with `knex migrate`.

**Core tables:**

| Table | Key columns | Notes |
| --- | --- | --- |
| `users` | id, username, display\_name, password\_hash, recovery\_hash, role, avatar\_config (JSONB, NOT NULL), created\_at | `role`: player / admin |
| `sessions` | id, user\_id, token\_hash, created\_at, expires\_at, invalidated\_at | One active session per user; new login invalidates prior |
| `invites` | id, code\_hash, label, created\_by, created\_at, expires\_at, redeemed\_at, status | status: pending / accepted / expired / revoked |
| `rooms` | id, state, host\_user\_id, config (JSONB), created\_at, closed\_at | config: round\_count, bid\_rule, deck\_type |
| `room_members` | room\_id, user\_id, role, join\_order, joined\_at, left\_at | role: player / spectator |
| `games` | id, room\_id, state (JSONB), started\_at, ended\_at, status | status: in\_progress / complete / incomplete |
| `rounds` | id, game\_id, round\_number, dealer\_user\_id, trump\_suit, started\_at, ended\_at |  |
| `round_players` | round\_id, user\_id, bid, tricks\_won, score\_delta |  |
| `game_results` | id, game\_id, user\_id, final\_score, outcome, drop\_reason | outcome: win / loss / incomplete |
| `game_events` | id, game\_id, round\_number, trick\_number, event\_type, actor\_user\_id, payload (JSONB), created\_at | Append-only event log |
| `bug_reports` | id, user\_id, room\_id, game\_id, trace\_id, description, severity, context (JSONB), created\_at |  |

**GameState checkpointing:** After each round ends, `game.toGameState()` is serialized and written to `games.state` as a record for history and bug reports. Games are not resumed from it. If the server restarts mid-game, startup cleanup marks every `in_progress` game `incomplete` (`drop_reason = 'server_restart'`) and reconnecting clients receive `game_abandoned` (see the Backup & Recovery Runbook).

**Event log pattern:** `game_events` is append-only. No updates or deletes. JSONB payloads store full context per event type (hand snapshots, bid context, play context). This table is the source for bot training data and audit.

**Session storage:** Sessions are stored in Postgres (not in-memory or Redis). On each authenticated request, the session token is validated against `sessions` with a single indexed lookup on `token_hash`. This keeps sessions durable across server restarts without requiring Redis at this scale.

## Authentication and Session Architecture

**Session lifecycle:**

1. User submits username + password to `POST /api/v1/auth/login`
2. Server looks up user by username, verifies password with bcrypt
3. Any existing active session for that user is invalidated (single-session enforcement)
4. A new session record is created with a signed token; token returned to client as an HTTP-only cookie
5. The application code stores nothing on the client — the browser manages the cookie automatically, sending it with every request. The HTTP-only flag prevents JavaScript from reading the token, so XSS attacks cannot exfiltrate it
6. On logout (`POST /api/v1/auth/logout`), the session record is invalidated

**Single-session enforcement:** The `sessions` table has at most one non-invalidated row per user at any time. On new login, the server sets `invalidated_at` on any existing active session before creating the new one. If a displaced session's socket is still connected, it receives `session_error` (`code: "SESSION_INVALIDATED"`, `fatal: true`) and is disconnected.

**Session validation middleware:** All authenticated API routes run an Express middleware that reads the session cookie, hashes the token, looks up the session in Postgres, checks expiry and invalidation, and attaches the user object to `req.user`. Rejected requests receive 401.

**Session-socket binding:** On Socket.io connection, the server reads the signed session cookie from the handshake headers and runs the same validation logic as the REST middleware and binds `socket.data.userId`. If validation fails, the connection is rejected. All socket event handlers trust `socket.data.userId` — no per-event re-validation.

**Reconnection window:** When a socket disconnects, the session remains valid in Postgres. The 2-minute reconnection timer is server-side state (in-memory `setTimeout`). If the server restarts during the window, the timer is lost along with the game itself: the game is abandoned (see GameState checkpointing).

**Password and passphrase hashing:** Both are hashed with bcrypt (work factor 12) before storage. The server never stores or logs plaintext credentials. Recovery passphrase reset follows the same flow as password reset — valid passphrase match required before allowing credential change.

**Forced credential change:** When an admin resets a user's credentials, the `requires_credential_change` flag on the `users` record is set to `true`. On the next successful login, the server includes this flag in the response. The client intercepts it and redirects the user to a forced change-password flow before allowing any other navigation. Once the user updates both their password and recovery passphrase, the server sets the flag back to `false`. While the flag is `true`, the server allows only `GET /users/me`, `PATCH /users/me` and `POST /auth/logout`; every other authenticated route returns `403 CREDENTIAL_CHANGE_REQUIRED`, so the change cannot be skipped by calling the API directly.

**Session expiry:** Sessions expire after a configurable duration (default: 24 hours). Expired sessions are treated as invalid by the middleware. A background cleanup job (or lazy deletion on lookup) removes expired rows.

## Observability Architecture

**Structured logging (pino):** All server-side log output is structured JSON emitted to stdout. Railway captures stdout and makes it searchable in the Railway log viewer. Every log entry includes: `timestamp`, `level`, `traceId`, `userId` (if authenticated), `roomId`, `gameId`, `event`, `message`. The `traceId` is a UUID generated per session on login and stored in the session record — it persists across requests and socket events for the lifetime of that session.

**Trace ID propagation:** The `traceId` is attached to `req.user` by the session middleware and to `socket.data` on socket connect. All log calls in the API and socket layers include it. When a bug report is submitted, the server looks up the current `traceId` from the session and stores it in the `bug_reports` record. This is the correlation key between a user's bug report and the server logs.

**Prometheus metrics (`prom-client`):** The Express app registers a `/api/v1/metrics` endpoint that Grafana Cloud scrapes. The endpoint requires a bearer token (set via environment variable) to prevent public access.

**Metric registry:**

| Metric | Type | Labels |
| --- | --- | --- |
| `http_request_duration_seconds` | Histogram | method, route, status\_code |
| `http_requests_total` | Counter | method, route, status\_code |
| `ws_connections_active` | Gauge | — |
| `ws_reconnections_total` | Counter | outcome (success/timeout) |
| `games_active` | Gauge | — |
| `rooms_active` | Gauge | — |
| `games_started_total` | Counter | — |
| `games_completed_total` | Counter | status (complete/incomplete) |
| `bug_reports_total` | Counter | severity |
| `players_connected` | Gauge | — |

**Grafana Cloud:** Scrapes `/api/v1/metrics` on a 30-second interval. Dashboards: infrastructure health (HTTP latency, error rate, WS connections) and game activity (active games, rooms, reconnection success rate). Alerting configured for error rate spikes and service downtime.

## Scalability Design

**Current model — single instance:** The application runs as a single Railway service. All game state is held in memory by the Node.js process and checkpointed to Postgres. Socket.io rooms are in-process. This supports n simultaneous games bounded only by available RAM and CPU on the Railway instance. At the target scale (3–20 concurrent games, \~100 connected users), a single instance is well within Railway's standard tier capacity.

**No hard game count limit:** The application does not enforce a maximum number of concurrent games in code. The Prometheus `games_active` gauge provides visibility into current load. Capacity is managed operationally (upgrade Railway plan) rather than by application-level caps.

**Horizontal scaling path (future):** If the single instance becomes a bottleneck, the following changes enable horizontal scaling:

1. **Socket.io adapter:** Replace the default in-memory adapter with `@socket.io/redis-adapter`. All Socket.io instances share a Redis pub/sub channel, so events broadcast from any instance reach all connected clients regardless of which instance they connected to.
2. **Session validation:** Already DB-backed (Postgres), so sessions are inherently shared across instances.
3. **Game state:** Already checkpointed to Postgres per round. Mid-round state would need to be moved from in-memory to Postgres or Redis to survive instance routing changes mid-trick.
4. **Load balancer:** Railway or an external LB configured with sticky sessions (by session cookie) to minimize cross-instance routing during a game.
5. **PgBouncer:** Connection pooling added between the app instances and Postgres to avoid exhausting connection limits under high load.

**Reconnection timer:** The 2-minute in-memory `setTimeout` does not survive server restarts or cross-instance routing. At single-instance scale this is acceptable. Horizontal scaling would require the reconnection timer to be moved to Redis (TTL key) for reliability.

## Security Architecture

**Transport:** All traffic is TLS (HTTPS + WSS). Railway provisions Let's Encrypt certificates automatically. HTTP requests are redirected to HTTPS.

**CORS:** In production, CORS is configured to allow only the production domain (`origin: 'https://yourdomain.com'`). `credentials: true` is set to allow the session cookie. No wildcard origins in production. In development, `localhost:5173` (Vite dev server) is allowed.

**Session security:** Session tokens are HTTP-only cookies (not accessible to JavaScript). Tokens are hashed before storage in Postgres — the raw token never persists. Sessions expire after 24 hours. Tokens are rotated on password change.

**Game action authorization:** Every game action (bid, play card, declare trump) is validated server-side: the acting user must be the current player, it must be their turn, and the action must be legal given the current game state. The client cannot trigger an action out of turn or on behalf of another player.

**Hand data isolation:** Player hand data is never broadcast to a Socket.io room. It is sent only in individual socket events addressed to the specific player's socket ID. Spectators receive no hand data at any point.

**Database isolation:** The Postgres instance is accessible only within Railway's private network. Its port is not exposed to the public internet. Database credentials are stored only as Railway environment variables.

**Secrets management:** All secrets (session secret, Prometheus bearer token, database URL) are stored as environment variables. They are never committed to source control. The `.env.example` file documents required keys without values. The `config.ts` startup validator ensures all required variables are present before the app accepts traffic.

**Admin route protection:** All `/admin` routes and admin socket events are guarded by a role-check middleware that verifies `req.user.role === 'admin'`. A non-admin receiving a 403 sees no admin UI.

**Rate limiting:** `express-rate-limit` applied to auth endpoints (`/login`, `/register`, `/reset-password`) to limit brute-force attempts. Configurable per environment.

**Dependency security:** `npm audit` run as part of CI. Known vulnerabilities in direct dependencies block deployment. Transitive vulnerability policy documented in the upgrade/patch management guide.

## Key Architectural Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Real-time transport | Socket.io | WebSocket abstraction with built-in rooms, reconnection events, and HTTP fallback. Maps naturally to game rooms and lobby presence. |
| Game engine isolation | Pure OOP layer, no I/O | Engine is fully unit-testable without HTTP or DB. Socket layer calls engine methods and handles I/O. Clean separation of concerns. |
| Same-domain serving | Express serves React build | Eliminates CORS complexity in production. Simplifies Railway deployment to a single service. |
| Database | Postgres (collocated) | Relational integrity for game data. JSONB for flexible event log payloads. Colocation keeps latency low and cost within budget. |
| Session storage | Postgres (not Redis) | Sessions are low-volume and don't change frequently. DB-backed sessions survive server restarts and are inherently shared for future horizontal scaling without adding Redis at this stage. |
| No email collection | Username + recovery passphrase | Eliminates PII collection and compliance concerns for an invite-only personal project. Recovery handled by passphrase; admin fallback for total lockout. |
| Secrets management | Environment variables | Sufficient for single-service deployment. Railway injects them securely. No secrets management service needed at this scale. |
| Logging | pino | Structured JSON output; low overhead; Railway captures stdout. TraceId propagation links logs to bug reports. |
| Metrics | prom-client + Grafana Cloud | Standard Prometheus model. Free tier covers current scale. No self-hosted observability infra needed. |
| Reconnection authority | Server-side timer | Server is the authoritative source. Client reconnects do not self-certify. Timer survives client-side page refreshes. |
| Bot player interface | Stub in `BotPlayer` class | Preserves the `Player` interface contract so the game engine accepts bots without modification. Training data (event log) collected from day one. |
| Deck extensibility | `Ruleset` per edition, selected by `deckType` | Card behaviour that differs between editions lives in one place. The Camelot Edition is added as a new ruleset and card types without touching the standard rules. |
