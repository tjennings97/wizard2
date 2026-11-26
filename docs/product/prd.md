# Wizard — Product Requirements Document (PRD)

Oct 13, 2026 · @TJ

## Product Overview

Wizard is a web-based multiplayer implementation of the Wizard card game, playable on desktop and mobile browsers. It supports 3 to 10 players per game with up to 5 spectators per room, real-time gameplay via WebSockets, in-room chat, player history and performance metrics, and an invite-only registration system.

**Vision:** A polished, reliable online version of Wizard for a private group of players, with the infrastructure and design quality to support a broader public launch in the future.

**Current scope:**

- Invite-only registration managed by an admin
- Lobby with room creation, joining as player or spectator
- Full Wizard game engine (standard 60-card deck) with configurable round count and bid total rule
- Real-time game state, chat, and presence via Socket.io
- Player avatars composed from SVG layers
- Per-player game history and performance metrics
- Bug reporting with session and game state context
- Structured logging and Prometheus/Grafana observability
- Hosted on Railway with collocated Postgres; custom domain

**Out of scope (this version):**

- Bot/AI players (interface stubbed for future implementation)
- Public registration and discovery
- Wizard Camelot Edition deck option (engine groundwork in place; rules not implemented)
- Full analytics dashboard (metrics collected, display deferred)
- Mobile native apps (mobile browser is first-class; native apps are not planned)

## User Roles

| Role | Description | Key Capabilities |
| --- | --- | --- |
| **Unauthenticated visitor** | A user who has not logged in | View login and registration pages only; no lobby or game access |
| **Player** | An authenticated user participating in a game | Join rooms, play cards, bid, chat, view scoreboard, quit game |
| **Spectator** | An authenticated user observing a game | Join rooms as observer (up to 5 per room), view board and played cards, chat; cannot see player hands |
| **Host** | The first player to enter a room (a role within Player) | Configure round count and bid total rule, start the game; host role transfers to next player if host leaves, or is disconnected for 2 minutes, before game starts |
| **Admin** | An elevated user role | Access admin panel, create and revoke invite codes, upgrade any user to admin, view invite status |

**Role assignment:** All registered users are Players by default. Admin role is assigned manually by an existing admin. Host is a transient per-room role, not a persistent account role.

**Single session:** A user can hold only one active session at a time. A new login from another device terminates the previous session.

**Game exclusivity:** A user cannot be an active Player in more than one game simultaneously. A user already in a game cannot join another as a player or spectator until they leave or the game ends.

## Authentication and Account Management

**Registration:**

- Requires a valid, unexpired, unredeemed invite code issued by an admin
- User provides: display name, username (unique), password
- No email address collected
- Invite code is marked redeemed on successful registration; codes expire after 7 days if unused
- On registration, user configures their avatar (see Avatar System)

**Login:**

- Username and password
- A valid session token is issued on success
- Only one active session permitted per user; a new login invalidates any existing session
- Session is tied to Socket.io reconnection: if a socket disconnects, the server holds the session open for 30 seconds to allow reconnection before treating the player as timed out

**Password reset:**

- User provides username and recovery passphrase (set at registration)
- Recovery passphrase is hashed and stored; it is not the same as the password
- On successful match, user is prompted to set a new password
- If both password and recovery passphrase are forgotten, an admin must manually reset the account
- No email-based reset flow

**Account settings:**

- User may update display name, password, recovery passphrase, and avatar configuration at any time
- Username is immutable after registration
  - **Forced credential change:** If an admin has reset the user's credentials, the login response includes a `requiresCredentialChange` flag set to `true`. The client redirects to a forced change-password screen before any other navigation. Once both password and recovery passphrase are updated the flag is cleared and normal access resumes.

**Security:**

- Passwords and recovery passphrases are hashed using bcrypt
- Session tokens are signed and validated server-side
- A user cannot impersonate another player's actions; all game actions are validated against the authenticated session

## Admin

**Admin panel** is a protected section of the main application, accessible only to users with the admin role. It is not a separate application.

**Invite management:**

- Admin creates an invite by entering the intended recipient's display name (optional label) and generating a code
- The generated code is displayed once for the admin to share out-of-band (text, voice, etc.) — no in-app delivery
- Each invite record stores: code, optional label, created timestamp, expiry timestamp (7 days from creation), status (pending / accepted / expired / revoked)
- Admin can revoke a pending invite at any time
- Expired and unredeemed invites are automatically marked expired; they cannot be redeemed
- Admin sees all invites in a table with their current status

**Role management:**

- Admin can upgrade any registered user to admin role
- Admin role cannot be self-removed (to prevent accidental lockout); another admin must do so
- There is no hard limit on the number of admins

**Account reset:**

- Admin can reset a user's password and recovery passphrase when the user has lost access to both
- Admin cannot view passwords or passphrases (all hashed)
  - When resetting credentials, the admin sets a temporary password and recovery passphrase, returned once in the response and never stored in plaintext. The user's account is flagged `requires_credential_change = true`. On next login the client forces a change-password flow before any other action is permitted. The flag clears once the user updates both password and recovery passphrase.

## Lobby

The lobby is the default landing page for authenticated users. It displays all active rooms and allows users to open, join, or spectate games.

**Room listing:** Each room entry displays room ID or name, current player count, spectator count, room state, and round count configured by the host. Rooms in the completed state are not shown.

**Room states:**

| State | Description | Joinable as Player | Joinable as Spectator |
| --- | --- | --- | --- |
| Open | Room created, waiting for players, game not started | Yes (if under 10 players) | Yes (if under 5 spectators) |
| In Progress | Game is actively being played | No | Yes (if under 5 spectators) |
| Completing | Game finished, 30s countdown active | No | No |
| Closed | Room expired (timeout) or all players left after game ended. The room record is removed from the lobby. To play again, any user must open a brand new room — a closed room cannot be reopened. | No | No |

**Lobby presence:** Users in the lobby see each other's display names and avatars in a lobby presence list, updated in real time via Socket.io.

**Actions available in lobby:**

- Open a new room (becomes host)
- Join an open room as a player
- Join an open or in-progress room as a spectator
- View own play history and metrics

**Constraints:**

- A user already in a game (as player or spectator) cannot open or join another room
- A user cannot join a completing or closed room
- A user who left a room before the game started may rejoin it as a player or spectator; a player who quit mid-game may rejoin only as a spectator

## Room and Pre-Game

**Opening a room:** Any authenticated user not currently in a game can open a room. The opening user becomes the host. The room appears in the lobby immediately in the Open state.

**Host role:**

- The host is the first player to enter the room
- If the host leaves before the game starts, the host role transfers to the next player who joined (determined by join order); spectators are never promoted. If no players remain, the room closes
- If the host is disconnected for 2 minutes before the game starts, the host role passes to the next connected player by join order. The old host stays in the room as a player. If they reconnect within the 2 minutes, they keep the role
- Host transfer is automatic and immediate; the new host is notified
- Once the game starts, the host role is dissolved — no player has elevated control mid-game

**Room timeout:** If the game has not started within 10 minutes of the room being opened, the room is automatically closed and all players are returned to the lobby. The 10-minute timer is inactivity relative to game start, not to chat or player joins.

**Player limits:** Minimum 3 players to start; maximum 10 players per room. Preferred range is 3–8.

**Spectator limits:** Maximum 5 spectators per room.

**Room chat:** Chat is available to all players and spectators in the room from the moment the room opens. Chat persists for the duration of the room lifecycle and is not stored after the room closes.

**Round selection:** The host selects the number of rounds before starting. The selector shows all valid options from 1 to the computed maximum (`floor(60 / playerCount)`). The maximum updates live as players join or leave. Round count is locked when the game starts.

**Bid total rule:** The host selects one of two modes before starting:

- **Open bidding (default):** No restriction on the sum of bids
- **Uneven bidding:** Sum of all bids must differ from trick count by at least 1; enforced on the dealer's bid in every round except round 1

**Game start:** Only the host can start the game. The start button is enabled when at least 3 players are in the room. Starting the game transitions the room to In Progress and is irreversible.

**Player list in room:** All players and spectators in the room are visible to each other with their display name and avatar. Join order is displayed.

## Game Engine Requirements

**OOP class hierarchy:**

| Class | Responsibility |
| --- | --- |
| `Card` | Suit, rank, type (suited / Wizard / Jester); equality and comparison |
| `Deck` | Card collection, shuffle, deal; built from a deck type (standard now; Camelot Edition in future) |
| `Ruleset` | Per-edition rules: deck composition, trump from the flipped card, follow-suit legality, trick resolution |
| `Round` | Tracks dealt hands, bids, tricks won, scores for one round |
| `Trick` | Cards played in one trick; determines winner using its edition's ruleset |
| `GameState` | Full serializable snapshot of the game, server-side only (holds every hand). Checkpointed after each round as a record for history and bug reports. Games are not resumed from it: a server restart abandons in-progress games. Clients receive filtered views (`toPlayerView(userId)` / `toSpectatorView()`), never the raw snapshot |
| `Game` | Orchestrates rounds and tricks; owns game configuration and lifecycle |
| `User` | Base class: id, username, display name, avatar config, session |
| `Player` | Extends User: hand, bid, tricks won, score; exposes `placeBid(n)` and `playCard(card)` |
| `Spectator` | Extends User: read-only game view; no hand or action methods |
| `BotPlayer` | Extends Player: stub only; implements same interface as Player for future AI integration |

**Game configuration (set at start, immutable mid-game):**

- Player list and seat order
- Round count (chosen by host)
- Bid total rule (open or uneven)
- Deck type (`standard`; `camelot` as a future option)

**Game lifecycle:**

1. Game created from room configuration
2. For each round N (1 to chosen round count): a. Deck shuffled, N cards dealt to each player b. Trump card flipped (or declared if Wizard flipped) c. Bidding phase — in seat order starting left of dealer d. Trick-taking phase — N tricks played e. Scores computed and applied
3. Final round complete → game ends, results persisted

**Trump determination:** Per rules reference — suited card sets trump, Jester means no trump, Wizard means dealer declares after viewing hand, last round with all cards dealt means no trump if \`deckSize\` is exactly divisible by player count (60 for both the standard and Camelot decks).

**Trick resolution priority:** First Wizard played → highest trump → highest led suit → first Jester if all Jesters.

**Player drop mid-game:**

- Intentional leave (`leave_game`): the player has quit and is removed permanently; current round is voided and re-dealt to remaining players; game continues
- Disconnect: the player's seat is held for 30s so they can reconnect; if they do not, they are treated as having quit (`user_left`, `reason: "timeout"`)
- Drop to 2 players: remaining players are prompted to continue or end the game
- If the game ends due to player drop, the session is recorded as incomplete with no winner

**Reconnection:**

- On reconnect within 30s, the player continues where they left off: their view of the live game (`toPlayerView(userId)`: their own hand only) is pushed via `state_snapshot` and missed events are replayed
- Other players see a disconnection indicator during the 30s window
- Server-side timer is authoritative; client reconnection attempts are validated against session
- Server restart: in-progress games are abandoned; players receive `game_abandoned` and return to the lobby
- Game time limit: a game lasts at most 3 hours; players get `game_time_warning` 15 minutes before, then the game is abandoned (`game_abandoned`, `reason: "time_limit"`) and recorded as incomplete with no winner
- Session lifetime: a session expires after 24 hours of inactivity and at most 30 days after login. In the last 24 hours before the 30-day cap, the user is sent to the login screen unless they are mid-game, and cannot create, join, or start a room until they log in again

**Bot player stub:** `BotPlayer` class is defined with the same interface as `Player` (`placeBid`, `playCard`), but both action methods throw `NotImplementedError`. All other inherited `Player` behaviour (receiving a hand, tracking tricks won and score) works normally. The game engine accepts `BotPlayer` instances without modification to core logic.

## Scoring and Scoreboard

**Per-round scoring rules:**

- Exact bid: 20 points + (10 × tricks won)
- Overbid: −10 points × tricks over bid
- Underbid: −10 points × tricks under bid
- Scores may go negative; there is no floor

**Running scoreboard (always visible):** During a game, all players and spectators see a persistent scoreboard showing each player's cumulative score, current round bid, and current tricks won. As tricks are won or lost mid-round, the over/under status updates live (e.g. "Bid 3 — Won 1 — Need 2 more").

**Full scoreboard (popup):** A player or spectator can open a popup showing the complete round-by-round breakdown: bid, tricks won, and score delta per player per round. Available at any time during and after the game.

**End-of-game flow:**

1. Final round scores applied
2. Winner(s) announced (tied players are co-winners)
3. Full scoreboard displayed
4. 30-second visible countdown begins
5. On countdown expiry, all users are returned to the lobby automatically
6. Users may leave manually before countdown ends
7. Room transitions to Completing state; no new joins permitted
8. After all users leave or countdown expires, room closes

## Player Metrics and History

**Outcome metrics (per player, per game):**

- Win / loss / incomplete result — incomplete applies when a player drops mid-game (their record) or when remaining players choose to end a 2-player game early (all remaining players' records); partial per-round stats up to the drop point are still recorded
- Total score and per-round score delta
- Tricks won per round and total
- Bid placed per round
- Bid accuracy: exact / over / under per round
- Bid error magnitude: tricks overbid or underbid per round
- Bid error direction: ran over vs. ran under across a game
- Game player count and round count (for filtering and segmentation)
- Win rate broken down by player count
- Average score per round
- Perfect game flag: bid exactly correct every round

* Game result flag: complete / incomplete, with drop reason (player quit, player timeout, 2-player mutual end) and player count at time of drop when incomplete

**Event log (for bot training and audit):**

All discrete game events are stored in an append-only `game_events` table with the following structure:

| Field | Description |
| --- | --- |
| `id` | Event ID |
| `game_id` | Parent game |
| `round_number` | Round the event occurred in |
| `trick_number` | Trick within the round (null for non-trick events) |
| `event_type` | `bid_placed`, `card_played`, `trump_declared`, `trick_completed`, `round_completed`, `game_completed` |
| `actor_user_id` | Player who acted |
| `payload` | JSONB snapshot of full game state and action context at the moment of the event |
| `created_at` | Server timestamp |

The JSONB payload for each event type captures: player hand at time of action, all bids placed (for bid events and card play events), tricks won per player so far, trump suit, round and trick number, seat/play-order position, and the action taken. Trump declaration events capture the dealer's hand and declared suit. Trick completion events flag winning card type (Wizard / trump / suited / Jester).

**Access:** Player history and metrics are scoped to the authenticated user and available upon login from their profile. A full analytics dashboard is deferred to a future release; raw data is collected now.

## Real-Time Communication

**Technology:** Socket.io over WebSockets, with HTTP long-polling fallback. The server manages Socket.io rooms that map 1:1 to game rooms. All real-time events for a room are broadcast within its Socket.io room.

**Reconnection logic:**

- Socket disconnect detected server-side → 30-second server timer starts
- Other players in the room receive a `player_disconnected` event and see a visual indicator
- If the player reconnects within 30s (session validated), their player view of the current game (`toPlayerView(userId)`, own hand only — never the raw `GameState`) is sent via `state_snapshot` to restore their view
- If the timer expires, the player is treated as having quit: `user_left` (`reason: "timeout"`) broadcast, game proceeds per player-drop rules
- A player who leaves intentionally (`leave_game`) has quit: `user_left` (`reason: "voluntary"`) broadcast, game proceeds per player-drop rules
- Page refresh is treated as a disconnect + reconnect; the server timer is the authoritative source, not client state

**Spectator event filtering:** Spectators receive all public game events (cards played, tricks won, bids, scores, trump) but do not receive any event containing hand data. Hand data is sent only in player-specific events addressed to the individual player.

**Key event categories:**

- Lobby: `lobby_snapshot`, `rooms_updated`, `presence_updated`
- Room: `room_snapshot`, `user_joined`, `user_left`, `host_changed`, `chat_message`, `room_config_updated`, `room_closed`, `game_starting`
- Game: `game_started`, `round_started`, `trump_revealed`, `bid_placed`, `all_bids_placed`, `card_played`, `trick_complete`, `round_complete`, `continue_or_end_request`, `game_over`, `game_abandoned`
- Player-specific: `hand_dealt`, `trump_selection_request`, `bid_request`, `play_request`, `state_snapshot`
- Connection: `player_disconnected`, `player_reconnected`, `user_left`, `session_error`

Full event schemas and payload definitions are documented in the WebSocket Event Taxonomy.

## Avatar System

Avatars are composited client-side from layered SVG files. No image uploads are required; the avatar is defined by a stored configuration of selection IDs.

**Configurable parts:** head shape, skin tone, face, and hair, as defined in the Avatar System Specification.

All SVG layers share a consistent coordinate system and viewBox so that any combination renders correctly.

**Storage:** Avatar configuration is stored on the user record as an object with four string keys (`head`, `skin`, `face`, `hair`), plus the composited SVG cached in `avatar_svg`. No uploaded image is stored.

**Configuration:** Users set their avatar at registration and may update it at any time from account settings.

**Visibility:**

- Lobby: avatar displayed next to display name in lobby presence list and in room player list
- In-game: avatar displayed at each player's seat position on the game board
- Scoreboard: avatar displayed next to player name in running totals and full scoreboard popup

**Mobile:** Avatar rendering uses responsive SVG sizing and displays correctly at small screen sizes.

## Bug Reporting

**Report a bug button** is available at all times in the application UI, accessible from any screen including during a game.

**Captured context (automatic):**

- Authenticated user ID (if logged in)
- Current URL and page/screen name
- Room ID and game ID (if in a room or game)
- Current game state snapshot (if in a game): round number, trick number, player turn, bid totals
- Client-side trace/correlation ID for the current session
- Timestamp (UTC)
- Browser and OS metadata (user agent)

**User input:**

- Free-text description of the issue (required)
- Optional: severity rating (low / medium / high)

**Submission:**

- Report is sent to a dedicated `/api/v1/bug-reports` endpoint
- Server enriches the report with the server-side trace ID linked to the user's session
- Report is stored in the database and logged at INFO level with the trace ID
- The trace ID is the correlation key between the stored report and server logs in Railway / Grafana

**User feedback:** A confirmation message is shown after submission. No response or follow-up is sent to the user (no email).

## Observability and Logging

**Structured logging:** All server-side logs are emitted as structured JSON using `pino`. Logs are written to stdout and captured by Railway's log aggregation. Each log entry includes: timestamp, level, trace/correlation ID, user ID (if authenticated), room ID and game ID (if applicable), and message.

**Prometheus metrics:** The Express app exposes a `/metrics` endpoint via `prom-client`. The endpoint is protected and not publicly accessible (bearer token or IP allowlist). Grafana Cloud scrapes this endpoint on a configured interval.

**Standard infrastructure metrics:**

- HTTP request count and duration (by route and status code)
- WebSocket connection count (current active)
- Error rate by type

**Custom game metrics:**

- Active rooms count
- Active games count
- Games started and completed (counters)
- Players currently connected
- Reconnection events (success vs. timeout)
- Bug reports submitted

**Grafana Cloud:** Dashboards for infrastructure health and game activity. Alerting on error rate spikes and service unavailability.

**Health endpoint:** The server exposes `GET /health` (no authentication required) returning `{ status: "ok" }` with HTTP 200 when healthy, or HTTP 500 on failure. This endpoint is used by the deployment platform for liveness checks and by the prod smoke test suite after every deployment.

**Trace IDs:** A correlation ID is generated per session (or per request for stateless endpoints) and propagated through logs and bug reports. This is the primary mechanism for linking a user-reported bug to server-side log entries.

## Non-Functional Requirements

**Scale:**

- Minimum: 3 simultaneous games (9–30 players + up to 15 spectators)
- Target: n simultaneous games; architecture must not hard-code game count limits
- A user cannot participate in more than one game at a time
- Game count is limited in practice by Railway instance resources; horizontal scaling is a future concern

**Performance:**

- Game state updates must be delivered to all players within 500ms under normal conditions
- API response time for non-game endpoints: under 300ms at p95
- Lobby presence and room list updates: near real-time (within 1s)

**Mobile-first:**

- The UI is specifically designed for mobile browsers; desktop is also fully supported
- All interactions must be touch-friendly; no hover-only affordances
- Layout adapts to small screens (portrait and landscape)
- Game board, player hand, scoreboard, and chat are all usable on a 375px-wide viewport
- SVG assets and avatars scale correctly at all sizes

**Browser support:** Latest two major versions of Chrome, Safari, Firefox, and Edge on both desktop and mobile.

**Security:**

- All passwords and recovery passphrases hashed with bcrypt
- Session tokens signed server-side; validated on every authenticated request and socket event
- Game actions validated against authenticated session; a player cannot act out of turn or on behalf of another
- CORS configured to allow only the production domain in production; relaxed for local development
- Environment secrets managed via environment variables; never committed to source control
- `/metrics` endpoint protected from public access
- Admin routes protected by role check middleware

**Data retention:**

- Game history and event logs retained indefinitely (primary value for metrics and bot training)
- Chat messages are not persisted after room closure
- Bug reports retained for a configurable period (default: 90 days)

**Availability:** Best-effort for a personal project; Railway SLA applies. No formal uptime SLA defined for this version.

## Infrastructure and Hosting

**Application host:** Railway. Express app and React build served from a single service on a single domain. WebSockets supported natively.

**Database:** Postgres, collocated on Railway in the same project as the application. Managed by Railway; connection via environment variable.

**Domain:** Custom domain attached to Railway service. SSL certificate provisioned automatically via Let's Encrypt.

**Environment configuration:**

- All secrets and configuration stored as environment variables
- Local development uses a `.env` file (not committed to source control); a `.env.example` documents required keys
- Application validates all required environment variables on startup and fails loudly if any are missing
- Variable categories: database URL, session secret, Socket.io config, Prometheus bearer token, environment name (development / production)

**Observability:** Grafana Cloud (free tier) scrapes the `/metrics` endpoint. Railway captures stdout logs.

**Backups:** Railway provides automated Postgres backups. Backup frequency and retention to be configured per Railway plan. Manual export capability via `pg_dump` for additional safety.

**Budget:** $10–20/month target. Railway usage-based pricing covers app and database within this range at personal project traffic levels.

**Deployment:** Automatic deploys triggered by push to the main branch on GitHub. Rollback via Railway's deploy history UI.

**Documentation:** Markdown files in a `/docs` directory in the GitHub repository. No separate documentation hosting required.

## Constraints and Future Considerations

**Current constraints:**

- Invite-only registration; no public sign-up
- No email collection or email-based features
- No native mobile apps; mobile browser only
- No bot players (interface stubbed)
- Single Railway service instance; no horizontal scaling in this version
- Standard 60-card Wizard deck only

**Planned future features:**

- **Bot players:** `BotPlayer` class stub is in place. Bots will be trained on the `game_events` event log data collected from real play. Bot implementation requires the event log schema to be stable, which it is as of this version.
- **Camelot Edition deck:** A 60-card deck with the 2s removed and four new special cards (Holy Grail, Excalibur, Merlin, Morgan le Fay). The engine already selects rules by deck type, so Camelot is added as a new ruleset without changing the standard rules. See Camelot Edition (Future) in the Game Rules Reference for the rules, open questions, and remaining work.
- **Public launch:** Registration opens, invite system retired or made optional, discovery and public lobby enabled. Requires review of rate limiting, abuse prevention, and CORS policy.
- **Full analytics dashboard:** Metrics are collected now. A player-facing dashboard visualising bid accuracy, score trends, win rates by player count, and perfect game history is deferred.
- **Horizontal scaling:** If game count grows beyond single-instance capacity, Socket.io can be adapted to use Redis pub/sub as a message broker, allowing multiple Express instances to share game state. Database connection pooling (e.g. PgBouncer) would be added at the same time.
- **API versioning:** `/api/v1/` is in place. A `/api/v2/` prefix will be introduced only when breaking changes are required and backward compatibility must be maintained.
