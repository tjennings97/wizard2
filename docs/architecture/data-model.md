# Wizard — Entity Relationship Diagram & Data Dictionary

## Entity Relationship Diagram

&#91;embedded content: Wizard database ERD · 11 tables · PostgreSQL 16\]

The database has 11 tables. `users` is the central entity — sessions, invites, room membership, round participation, game results, and bug reports all foreign-key to it. `games` and `game_events` are the two most write-intensive tables; `game_events` is append-only and never updated or deleted.

## Data Dictionary — users

Central entity. Every other table that tracks a person foreign-keys to this table.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `username` | `varchar(32)` | No | UNIQUE, NOT NULL | Login identifier. Immutable after creation. Lowercase, alphanumeric + underscore. |
| `display_name` | `varchar(64)` | No | NOT NULL | Name shown to other players. Does not need to be unique. Mutable. |
| `password_hash` | `varchar(255)` | No | NOT NULL | bcrypt hash (work factor 12) of the user's password. |
| `recovery_hash` | `varchar(255)` | No | NOT NULL | bcrypt hash of the recovery passphrase. Used for password reset without email. |
| `role` | `varchar(16)` | No | NOT NULL, CHECK (`role` IN ('player','admin')), default `'player'` | Account role. `player` = standard user; `admin` = elevated privileges. |
| `avatar_config` | `jsonb` | No | NULL | Structured avatar part selections. Schema: {"head": "round", "skin": "medium", "face": "smile-01", "hair": "curly-short-brown"}. Each value is a slug mapping to an SVG layer asset in the frontend. Null means no avatar set.. |
| `avatar_svg` | `text` | Yes | — | Cached SVG string of the fully composited avatar. Written at registration and on each avatar update. Null until avatar is first set. Rendered directly in the browser — avoids recompositing layers on every load. |
| `requires_credential_change` | `boolean` | No | NOT NULL, default `false` | Set to `true` by an admin when resetting a user's credentials. On next login the server includes this flag and the client forces a change-password flow before any other action. Reset to `false` by `PATCH /users/me` once the user has changed both the password and the recovery passphrase since the reset (both `password_changed_at` and `recovery_changed_at` set). While the flag is `true`, the server allows only `GET /users/me`, `PATCH /users/me` and `POST /auth/logout`; every other authenticated route returns `403 CREDENTIAL_CHANGE_REQUIRED`, so the change cannot be skipped by calling the API directly. |
| `password_changed_at` | `timestamptz` | Yes | — | When the user last chose their password themselves: `PATCH /users/me` or `POST /auth/reset-password`. Null until then. An admin credential reset sets it back to null. |
| `recovery_changed_at` | `timestamptz` | Yes | — | When the user last chose their recovery passphrase themselves (`PATCH /users/me`). Null until then. An admin credential reset sets it back to null. |
| `created_at` | `timestamptz` | No | NOT NULL, default `now()` | Account creation timestamp (UTC). |

## Data Dictionary — sessions

One active session per user at any time. A new login invalidates the prior session by setting `invalidated_at`, and deletes the user's sessions that ended (invalidated or expired) more than 24 hours earlier. Ended rows are kept for those 24 hours so a displaced device still receives `SESSION_INVALIDATED` rather than `UNAUTHORIZED`.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `user_id` | `uuid` | No | FK → `users.id`, NOT NULL | The authenticated user |
| `token_hash` | `varchar(255)` | No | UNIQUE, NOT NULL | SHA-256 hash of the session token. Raw token is in the HTTP-only cookie only. |
| `trace_id` | `uuid` | No | NOT NULL, default `gen_random_uuid()` | Correlation ID for logs and bug reports. Unique per session. |
| `created_at` | `timestamptz` | No | NOT NULL, default `now()` | Session creation time |
| `expires_at` | `timestamptz` | No | NOT NULL | Sliding expiry: 24 hours after the session's last authenticated activity (HTTP request or socket event), so active players are not logged out mid-game. Moved forward at most once an hour. Never later than `created_at` + 30 days (hard cap). In the last 24 hours before the cap the user must log in again (`401 REAUTH_REQUIRED`) unless they are an active player in a game in progress. |
| `invalidated_at` | `timestamptz` | Yes | — | Set on logout, when a new login displaces this session, on a password reset, or when the user changes their password or recovery passphrase from another session (that session is replaced by a new one). Null = still valid (if not expired). |
| `invalidated_reason` | `varchar(32)` | Yes | — | Why the session ended: `displaced`, `logout`, `password_reset` or `credential_change`. Returned as `details.reason` on `401 SESSION_INVALIDATED` and as `reason` on the socket `session_error`. Null while the session is valid, and for sessions ended before the column existed. |

## Data Dictionary — invites

Admin-issued invite codes for new user registration. Codes expire after 7 days if not redeemed.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `code_hash` | `varchar(255)` | No | UNIQUE, NOT NULL | SHA-256 hash of the invite code. Raw code shown to admin once only. |
| `label` | `varchar(128)` | Yes | — | Optional admin-provided label (e.g. intended recipient name) |
| `created_by` | `uuid` | No | FK → `users.id`, NOT NULL | Admin user who generated the invite |
| `created_at` | `timestamptz` | No | NOT NULL, default `now()` | Invite creation time |
| `expires_at` | `timestamptz` | No | NOT NULL | 7 days after `created_at` |
| `redeemed_at` | `timestamptz` | Yes | — | Set when the invite is used to register. Null = not yet redeemed. |
| `redeemed_by` | `uuid` | Yes | FK → `users.id` | The user who redeemed this invite. Null until redeemed. |
| `status` | `varchar(16)` | No | NOT NULL, CHECK (`status` IN ('pending','accepted','expired','revoked')), default `'pending'` | Current invite status |

## Data Dictionary — rooms

A room is the pre-game and game container. Created by the host; transitions through Open → In Progress → Completing → Closed.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `state` | `varchar(16)` | No | NOT NULL, CHECK (`state` IN ('open','in\_progress','completing','closed')), default `'open'` | Current room lifecycle state |
| `host_user_id` | `uuid` | No | FK → `users.id`, NOT NULL | Current host. Updated on host transfer. |
| `config` | `jsonb` | No | NOT NULL, default `'{}'` | Room configuration. Schema: `{"round_count": 10, "bid_rule": "open", "deck_type": "standard"}`. Set by host before game start; locked on start. |
| `created_at` | `timestamptz` | No | NOT NULL, default `now()` | Room creation time |
| `closed_at` | `timestamptz` | Yes | — | Set when room transitions to Closed state |

## Data Dictionary — room\_members

Junction table tracking who is in a room and in what role. A user can appear once per room.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `room_id` | `uuid` | No | FK → `rooms.id`, NOT NULL | The room |
| `user_id` | `uuid` | No | FK → `users.id`, NOT NULL | The member |
| `role` | `varchar(16)` | No | NOT NULL, CHECK (`role` IN ('player','spectator')) | Member role in this room |
| `join_order` | `integer` | No | NOT NULL | Sequential join position across all members (1 = first to join). Used for host transfer ordering: the new host is the active player (`role = 'player'`, `left_at IS NULL`) with the lowest `join_order`. Spectators are never promoted. |
| `joined_at` | `timestamptz` | No | NOT NULL, default `now()` | When the user joined the room |
| `left_at` | `timestamptz` | Yes | — | When the user left. Null = still in room. |

Composite PK: `(room_id, user_id)`.

**Rejoining.** A user who leaves and rejoins the same room reuses their existing row rather than inserting a new one: clear `left_at`, set the new `role`, set `join_order` to the room's current maximum + 1, and reset `joined_at`. Allowed roles on rejoin:

- Room `open`: player or spectator.
- Room `in_progress`: spectator only. A player who quit mid-game cannot rejoin as a player.

Past game participation is preserved in `round_players` and `game_results`, not in this row.

## Data Dictionary — games

One game per room per lifecycle. The `state` column holds the latest `GameState` snapshot serialized from the engine.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `room_id` | `uuid` | No | FK → `rooms.id`, NOT NULL | The room this game belongs to |
| `state` | `jsonb` | Yes | — | Latest `GameState` snapshot. Written after each round ends. Null before first round completes. |
| `started_at` | `timestamptz` | No | NOT NULL, default `now()` | When the game started |
| `ended_at` | `timestamptz` | Yes | — | When the game ended (all rounds complete or early termination). Null while in progress. |
| `status` | `varchar(16)` | No | NOT NULL, CHECK (`status` IN ('in\_progress','complete','incomplete')), default `'in_progress'` | Game completion status |
| `drop_reason` | `varchar(32)` | Yes | CHECK (`drop_reason` IN ('player\_quit','player\_timeout','mutual\_end','server\_restart','time\_limit')) | Populated only when `status = 'incomplete'`. Records why the game ended early: `player_quit` / `player_timeout` when a drop left one player; `mutual_end` when one of the last two chose end or neither answered in time; `time_limit` at the 3-hour limit; `server_restart` by the startup cleanup. |
| `player_count_at_drop` | `smallint` | Yes | — | Player count when the game ended early. Null for complete games. |

## Data Dictionary — rounds

One row per round per game. Rounds are numbered sequentially starting at 1. Written when the round is scored, together with its `round_players` rows and the `games.state` checkpoint, in one transaction; `started_at` is when the round was dealt.

| Column | Type | Nullable | Description |
| --- | --- | --- | --- |
| `id` | `uuid` | No | PK. Surrogate primary key. |
| `game_id` | `uuid` | No | FK → `games.id`. The parent game. |
| `round_number` | `smallint` | No | Round sequence number (1 = first round). |
| `dealer_user_id` | `uuid` | No | FK → `users.id`. The player who dealt this round. |
| `trump_suit` | `varchar(16)` | Yes | The trump suit. One of: `hearts`, `diamonds`, `spades`, `clubs`. Null if no trump (Jester flipped, or final round with all cards dealt and deck size divisible by player count). |
| `trump_source` | `varchar(16)` | Yes | How trump was determined. `flip` = suited card turned; `declaration` = Wizard flipped, dealer declared after viewing hand. Null when no trump. |
| `started_at` | `timestamptz` | No | Round start time (UTC). |
| `ended_at` | `timestamptz` | Yes | Round end time. Null while in progress. |

One row per round per game. Rounds are numbered sequentially starting at 1.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `game_id` | `uuid` | No | FK → `games.id`, NOT NULL | The parent game |
| `round_number` | `smallint` | No | NOT NULL | Round sequence number (1 = first round) |
| `dealer_user_id` | `uuid` | No | FK → `users.id`, NOT NULL | The player who dealt this round |
| `trump_suit` | `varchar(16)` | Yes | CHECK (`trump_suit` IN ('hearts','diamonds','spades','clubs')) | The trump suit for this round. Null if no trump (Jester flipped or final round with all cards dealt). |
| `trump_source` | `varchar(16)` | Yes | CHECK (`trump_source` IN ('flip','declaration')) | How trump was determined. `flip` = suited card turned; `declaration` = Wizard flipped, dealer declared. |
| `started_at` | `timestamptz` | No | NOT NULL, default `now()` | Round start time |
| `ended_at` | `timestamptz` | Yes | — | Round end time. Null while in progress. |

## Data Dictionary — round\_players

Per-player per-round record of bid, tricks won, and score. Written at round end.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `round_id` | `uuid` | No | FK → `rounds.id`, NOT NULL | The parent round |
| `user_id` | `uuid` | No | FK → `users.id`, NOT NULL | The player |
| `bid` | `smallint` | No | NOT NULL | The bid placed for this round |
| `tricks_won` | `smallint` | No | NOT NULL | Tricks actually won this round |
| `score_delta` | `smallint` | No | NOT NULL | Score change for this round (positive or negative per scoring rules) |
| `bid_position` | `smallint` | No | NOT NULL | Bidding order position for this round (1 = first to bid) |

Composite PK: `(round_id, user_id)`.

## Data Dictionary — game\_results

Per-player outcome record for each game. Written at game end (complete or incomplete), for every player who was seated, including those who quit or timed out: they get `outcome = incomplete` with their own `drop_reason` (`player_quit` / `player_timeout`), their score when they left and the rounds scored before they left. The startup cleanup writes rows only for the players still seated.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `game_id` | `uuid` | No | FK → `games.id`, NOT NULL | The parent game |
| `user_id` | `uuid` | No | FK → `users.id`, NOT NULL | The player |
| `final_score` | `integer` | No | NOT NULL | Denormalised cumulative score for this player at game end (or at point of departure for incomplete). Derived from summing \`round\_players.score\_delta\` for this player; stored here to avoid recomputing on every query. Head-to-head scores for all players in a game are obtained by fetching all \`game\_results\` rows with the same \`game\_id\` |
| `outcome` | `varchar(16)` | No | NOT NULL, CHECK (`outcome` IN ('win','loss','incomplete')) | Player's game outcome |
| `drop_reason` | `varchar(32)` | Yes | CHECK (`drop_reason` IN ('player\_quit','player\_timeout','mutual\_end','server\_restart','time\_limit')) | For incomplete records: why this player's game ended early |
| `rounds_played` | `smallint` | No | NOT NULL | Number of rounds this player participated in |

Composite UNIQUE: `(game_id, user_id)` — one result row per player per game.

## Data Dictionary — game\_events

Append-only event log. Never updated or deleted. Primary source for bot training data and audit, and the log a reconnecting client is replayed from. Every event broadcast to a game's room is one row, numbered by the game's `seq` (the envelope `seq` the clients received; see the WebSocket Event Taxonomy). Unicast events (`hand_dealt`, `bid_request`, `play_request`, errors) are not logged. The `payload` JSONB schema varies by `event_type` — see JSONB Payload Schemas.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `game_id` | `uuid` | No | FK → `games.id`, NOT NULL | The parent game |
| `seq` | `integer` | No | NOT NULL, UNIQUE (`game_id`, `seq`) | The game's sequence number for this event, from 1. Equals the envelope `seq` the event was broadcast with |
| `event` | `varchar(32)` | No | NOT NULL | The socket event name that was broadcast (for example `trump_revealed` for a row whose `event_type` is `trump_declared`) |
| `round_number` | `smallint` | No | NOT NULL | Round in which the event occurred. `0` for events before round 1 (`game_starting`, `game_started`) |
| `trick_number` | `smallint` | Yes | — | Trick within the round. Null for round-level and game-level events. |
| `event_type` | `varchar(32)` | No | NOT NULL, CHECK (`event_type` IN ('bid\_placed','card\_played','trump\_declared','trick\_completed','round\_completed','game\_completed','game\_starting','game\_started','round\_started','trump\_revealed','all\_bids\_placed','user\_joined','user\_left','player\_disconnected','player\_reconnected','continue\_or\_end\_request','game\_time\_warning','game\_abandoned')) | Event classification. A Wizard-flip declaration is `trump_declared`; trump settled any other way is `trump_revealed` |
| `actor_user_id` | `uuid` | Yes | FK → `users.id` | Player who caused the event. Null for system events (round/game completion). |
| `payload` | `jsonb` | No | NOT NULL | Full context snapshot for this event. Schema defined per `event_type`. Server-side only: may contain hands. |
| `sent_payload` | `jsonb` | No | NOT NULL | The payload exactly as broadcast. A reconnect replays this, never `payload`. Never contains hands, since hands are never broadcast. |
| `created_at` | `timestamptz` | No | NOT NULL, default `now()` | Server timestamp when event was recorded |

## Data Dictionary — bug\_reports

Stores user-submitted bug reports with automatic context capture. The `trace_id` links the report to server logs in Railway / Grafana.

| Column | Type | Nullable | Constraints | Description |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | No | PK, default `gen_random_uuid()` | Surrogate primary key |
| `user_id` | `uuid` | Yes | FK → `users.id` | Authenticated user who submitted the report. Null for unauthenticated submissions (not expected, included for safety). |
| `room_id` | `uuid` | Yes | FK → `rooms.id` | Room the user was in when reporting. Null if not in a room. |
| `game_id` | `uuid` | Yes | FK → `games.id` | Game the user was in when reporting. Null if not in a game. |
| `trace_id` | `uuid` | No | NOT NULL | Correlation ID from the user's session. Links this report to server log entries. |
| `description` | `text` | No | NOT NULL | User-written description of the issue |
| `severity` | `varchar(8)` | Yes | CHECK (`severity` IN ('low','medium','high')) | Optional severity rating provided by user |
| `context` | `jsonb` | No | NOT NULL, default `'{}'` | Automatically captured context. Schema: `{"url": "...", "page": "...", "round_number": 3, "trick_number": 2, "game_state_summary": {...}, "user_agent": "...", "client_timestamp": "..."}`. |
| `created_at` | `timestamptz` | No | NOT NULL, default `now()` | Server-side receipt timestamp |

## Index Strategy

| Table | Index | Columns | Type | Rationale |
| --- | --- | --- | --- | --- |
| `users` | PK | `id` | B-tree (auto) | Primary key lookup |
| `users` | `users_username_idx` | `username` | B-tree, UNIQUE | Login lookup by username |
| `sessions` | PK | `id` | B-tree (auto) | — |
| `sessions` | `sessions_token_hash_idx` | `token_hash` | B-tree, UNIQUE | Session validation on every request |
| `sessions` | `sessions_user_id_idx` | `user_id` | B-tree | Single-session enforcement: find active session for a user on login |
| `invites` | PK | `id` | B-tree (auto) | — |
| `invites` | `invites_code_hash_idx` | `code_hash` | B-tree, UNIQUE | Invite redemption lookup |
| `rooms` | PK | `id` | B-tree (auto) | — |
| `rooms` | `rooms_state_idx` | `state` | B-tree | Lobby query: fetch all non-closed rooms |
| `room_members` | PK | `(room_id, user_id)` | B-tree (auto) | Composite primary key |
| `room_members` | `room_members_user_idx` | `user_id` | B-tree | Check if user is already in a room |
| `games` | PK | `id` | B-tree (auto) | — |
| `games` | `games_room_id_idx` | `room_id` | B-tree | Find game for a room |
| `rounds` | PK | `id` | B-tree (auto) | — |
| `rounds` | `rounds_game_id_idx` | `game_id` | B-tree | Fetch all rounds for a game |
| `round_players` | PK | `(round_id, user_id)` | B-tree (auto) | Composite primary key |
| `round_players` | `round_players_user_idx` | `user_id` | B-tree | Fetch player's round history for metrics |
| `game_results` | PK | `id` | B-tree (auto) | — |
| `game_results` | `game_results_user_idx` | `user_id` | B-tree | Fetch all results for a user (play history) |
| `game_results` | `game_results_game_user_idx` | `(game_id, user_id)` | B-tree, UNIQUE | Enforce one result row per player per game |
| `game_events` | PK | `id` | B-tree (auto) | — |
| `game_events` | `game_events_game_id_idx` | `game_id` | B-tree | Fetch all events for a game (bot training, audit) |
| `game_events` | `game_events_game_round_idx` | `(game_id, round_number)` | B-tree | Fetch events for a specific round |
| `game_events` | `game_events_game_seq_idx` | `(game_id, seq)` | Unique B-tree | One row per game seq; replay events after `last_seq_seen` |
| `bug_reports` | PK | `id` | B-tree (auto) | — |
| `bug_reports` | `bug_reports_trace_id_idx` | `trace_id` | B-tree | Correlate a bug report to server logs |

## JSONB Payload Schemas

Avatar configuration is stored as a free-form `avatar_config` field directly on the `users` table. There are no separate `avatars` or `player_avatars` tables.

### rooms.config

```json
{
  "round_count": 10,
  "bid_rule": "open",
  "deck_type": "standard"
}
```

`bid_rule`: `"open"` (no restriction) or `"uneven"` (total must differ from trick count by ≥1, from round 2; round 1 is unrestricted). `deck_type`: `"standard"` (60 cards). `"camelot"` (Wizard Camelot Edition, also 60 cards) is planned for a future version.

### games.state (GameState snapshot)

```json
{
  "gameId": "uuid",
  "roomId": "uuid",
  "config": { "roundCount": 10, "bidRule": "open", "deckType": "standard", "deckSize": 60 },
  "currentRound": 4,
  "currentTrick": 2,
  "trumpSuit": "hearts",
  "trumpSource": "flip",
  "phase": "trick",
  "currentTurnUserId": "uuid",
  "players": [
    {
      "userId": "uuid",
      "displayName": "Jake",
      "seatOrder": 1,
      "hand": [{ "suit": "hearts", "rank": 10, "type": "suited" }],
      "bid": 2,
      "tricksWon": 1,
      "cumulativeScore": 85,
      "connected": true
    }
  ],
  "tricksSoFar": [
    {
      "trickNumber": 1,
      "cards": [{ "userId": "uuid", "card": { "suit": "spades", "rank": 7, "type": "suited" } }],
      "winnerUserId": "uuid",
      "winningCardType": "suited"
    }
  ],
  "scores": { "uuid": 85 },
  "droppedPlayers": [
    { "userId": "uuid", "username": "sam", "displayName": "Sam", "avatarConfig": null, "isBot": false, "finalScore": 40 }
  ],
  "pendingContinue": null,
  "winnerUserIds": []
}
```

`pendingContinue` is set only while two remaining players decide whether to continue: `{ "resumePhase": "round_end", "redeal": false }`, or `redeal: true` when a round was voided and must be re-dealt.

The `hand` array is included in `GameState` for server-side use only. Clients never receive the raw snapshot: `game.toPlayerView(userId)` keeps only that player's hand (others become `hand: null` plus `handCount`), and `game.toSpectatorView()` keeps no hands. The snapshot is a record only: no game is rebuilt from it, and a server restart abandons in-progress games.

### game\_events payload examples

Rows whose `event_type` is not listed below (`user_joined`, `user_left`, `trump_revealed`, `player_disconnected`, `player_reconnected`, `continue_or_end_request` and `game_time_warning`) store the sent payload as `payload`. A `game_abandoned` row adds the phase, round number and scores at the time to the sent payload. An incomplete game's `game_over` is logged as `game_completed` with `status: "incomplete"`, `winners: []` and its `dropReason`.

Where the broadcast name differs from the `event_type`: `trump_revealed` after a Wizard flip is `trump_declared`; `trick_complete` is `trick_completed`; `round_complete` is `round_completed`; `game_over` is `game_completed`. `card_played` and `trick_completed` rows carry `trick_number`; every other row's is null.

**game\_starting**, **game\_started** (`round_number` 0)

```json
{
  "config": { "roundCount": 10, "bidRule": "open", "deckType": "standard", "deckSize": 60 },
  "players": [{ "userId": "uuid", "displayName": "Jake", "seatOrder": 1 }]
}
```

**round\_started**

```json
{
  "roundNumber": 4,
  "dealerUserId": "uuid",
  "trumpCard": { "suit": null, "rank": null, "type": "wizard" },
  "trumpSuit": null,
  "trumpSource": null,
  "requiresDeclaration": true,
  "dealtHands": { "uuid": [{ "suit": "hearts", "rank": 10, "type": "suited" }] },
  "scoresBeforeRound": { "uuid": 85 }
}
```

**all\_bids\_placed**

```json
{
  "roundNumber": 4,
  "bids": { "uuid": 2 },
  "bidTotal": 5,
  "trickCount": 4
}
```

**bid\_placed**

```json
{
  "playerId": "uuid",
  "bid": 3,
  "bidPosition": 2,
  "handAtBid": [{ "suit": "hearts", "rank": 10, "type": "suited" }, { "suit": null, "rank": null, "type": "wizard" }],
  "trumpSuit": "hearts",
  "trumpSource": "flip",
  "priorBids": [{ "playerId": "uuid", "bid": 1 }],
  "roundNumber": 4,
  "scoresBeforeBid": { "uuid": 85 }
}
```

**card\_played**

```json
{
  "playerId": "uuid",
  "card": { "suit": "hearts", "rank": 10, "type": "suited" },
  "playPosition": 3,
  "handBeforePlay": [ ],
  "ledSuit": "hearts",
  "trumpSuit": "hearts",
  "cardsPlayedInTrick": [{ "playerId": "uuid", "card": { "suit": "hearts", "rank": 4, "type": "suited" } }],
  "tricksWonPerPlayer": { "uuid": 1 },
  "bidsThisRound": { "uuid": 3 },
  "roundNumber": 4,
  "trickNumber": 2
}
```

**trump\_declared**

```json
{
  "dealerUserId": "uuid",
  "declaredSuit": "spades",
  "dealerHand": [ ],
  "roundNumber": 7,
  "scoresBeforeRound": { "uuid": 110 }
}
```

**trick\_completed**

```json
{
  "trickNumber": 2,
  "roundNumber": 4,
  "winnerUserId": "uuid",
  "winningCard": { "suit": null, "rank": null, "type": "wizard" },
  "winningCardType": "wizard",
  "allCardsPlayed": [{ "playerId": "uuid", "card": { "suit": null, "rank": null, "type": "wizard" } }],
  "tricksWonPerPlayer": { "uuid": 2 }
}
```

**round\_completed**

```json
{
  "roundNumber": 4,
  "results": [
    { "userId": "uuid", "bid": 3, "tricksWon": 3, "scoreDelta": 50, "cumulativeScore": 135 }
  ]
}
```

**game\_completed**

```json
{
  "finalScores": { "uuid": 210 },
  "winners": ["uuid"],
  "status": "complete",
  "roundCount": 10,
  "playerCount": 4
}
```
