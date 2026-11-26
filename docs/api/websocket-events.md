# WebSocket Event Taxonomy

Oct 17, 2026 · @TJ

## Overview

This taxonomy defines every WebSocket message exchanged between client and server in the Wizard card game. It is the authoritative contract between the frontend and the game server; the OpenAPI spec governs REST endpoints for session setup, while this document covers all real-time events once a WebSocket connection is established.

**Scope.** All events emitted or consumed over the WebSocket: lobby presence and room updates, room chat, bidding, card play, scoring, disconnection and reconnection, and error handling. Out of scope: HTTP authentication, REST actions such as creating a room or changing its config (their results are pushed as events below), and static asset delivery.

**Source of truth for event names.** Every other document uses the event names defined here.

**Relationship to the Game State Machine.** Each server-emitted event corresponds to one or more state transitions defined in the Game State Machine doc. The `event` field on every server message maps directly to a GSM transition label. Clients must apply events in order; out-of-order delivery triggers a `sync_request`.

**Relationship to the OpenAPI Spec.** The OpenAPI spec defines `POST /auth/login`, which sets the signed HTTP-only session cookie. The browser sends that cookie with the Socket.io handshake; the client never reads or sends the token itself. All subsequent real-time communication uses the events below, not HTTP.

## Event Design Principles

### Naming Convention

All event names use `snake_case`. Client→Server events are imperative verbs (`place_bid`, `play_card`). Server→Client events are past-tense facts (`bid_placed`, `card_played`, `round_started`). Error events always end in `_error` (`invalid_play_error`).

### Envelope Schema

Every message, in both directions, is a JSON object with this top-level envelope:

```json
{
  "event": "string",       // event name
  "seq": 42,               // monotonic sequence number (server assigns on outbound; client sends 0)
  "timestamp": "ISO-8601", // UTC, millisecond precision
  "payload": {}            // event-specific data (see per-event schemas below)
}
```

`seq` is assigned by the server; clients send `0`. How it counts depends on where the socket is:

- **Lobby and open rooms:** per socket. Each event sent on the socket takes the next number.
- **A room whose game has started (players and spectators):** per game. Every event broadcast to the game's room takes the game's next `seq`, and every socket in the room receives it with the same number. Each one is logged in `game_events` with that `seq` (see the data model), which is what a reconnect replays from. A unicast (`hand_dealt`, `bid_request`, `trump_selection_request`, `state_snapshot`, `invalid_bid_error`, `invalid_trump_error`, a non-fatal `session_error`) carries the game's current `seq` without advancing it, so it has the same number as the broadcast before it. Unicasts are not logged; `state_snapshot` restores what they carried.

Clients detect gaps and emit `sync_request` if `seq` jumps by more than 1. A repeated `seq` (a unicast after a broadcast) is not a gap. On entering a game, the client takes the `seq` of `state_snapshot` (or of `game_starting`, which is `1`) as its starting point.

### Delivery Guarantees

- **Ordering:** The server processes client events serially within a session. Server→Client events are emitted in state-machine transition order.
- **At-most-once from client:** Clients do not retry unless they receive a connection-level disconnect; reconnect carries a `last_seq_seen` to allow the server to replay missed events.
- **Idempotency:** Client events include an optional `idempotency_key` (UUID v4). Replayed events with a duplicate key within a 60-second window are silently acknowledged without reprocessing.

### Connection

The client opens one Socket.io connection per logged-in session, on the same origin as the page, at Socket.io's default path (`/socket.io/`, default namespace). In local dev, Vite proxies `/socket.io` to the server. The URL carries no session or game identifier: the session comes from the cookie sent with the handshake, and lobby/room/game membership is managed server-side via Socket.io rooms (`lobby`, `room:<roomId>`).

The event protocol is not versioned. The client and server ship in the same build and deploy together.

## Client → Server Events

All events below are sent by the client inside the standard envelope. `seq` is always `0` from the client.

### Session & Lobby

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `join_game` | Player opens game URL | `player_id: string`, `display_name: string`, `last_seq_seen?: number` |
| `leave_game` | Player clicks Leave | `player_id: string` |

### Room

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `send_chat_message` | Player or spectator sends a chat message | `room_id: string`, `text: string` |

### Trump Selection Phase

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `select_trump` | Dealer picks trump suit (only when trump card is a Wizard) | `player_id: string`, `suit: "hearts"\|"diamonds"\|"clubs"\|"spades"`, `idempotency_key?: string` — answered with `invalid_trump_error` if the sender is not the dealer, trump is not awaiting a declaration, or `suit` is not a suit |

### Bidding Phase

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `place_bid` | Player submits bid | `player_id: string`, `bid: integer (0–round_number)`, `idempotency_key?: string` — answered with `invalid_bid_error` if it is not the sender's turn, bidding is not open, or the bid is not allowed |

### Trick-Playing Phase

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `play_card` | Player plays a card | `player_id: string`, `card: { suit: string, rank: string }`, `idempotency_key?: string` |

### Player Drop

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `choose_continue_or_end` | One of the two remaining players answers `continue_or_end_request` | `player_id: string`, `choice: "continue"\|"end"` |

### Sync & Control

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `sync_request` | Client detects a `seq` gap | `player_id: string`, `last_seq_seen: number` |
| `ping` | Client keepalive (every 15 s) | `client_time: ISO-8601` |

### Game actions: who acts, ordering and session refresh

These rules apply to every game action (`select_trump`, `place_bid`, and later `play_card` and `choose_continue_or_end`):

- **The acting player is the socket's user.** The `player_id` in the payload is informational and is ignored; a socket cannot act for someone else.
- **Ordering:** events from one socket are handled one at a time, in the order sent, and actions on one game are applied one at a time across all its players.
- **Session refresh:** before an action, the server validates the socket's session cookie again with `authenticateToken`, which also slides the session's 24-hour idle expiry, so a player who only uses the socket stays logged in. This is throttled per socket: at most once every 5 minutes (connecting counts as a check). If the session has ended or expired, the server sends `session_error` (`fatal: true`, with the failure `code`) and disconnects, and the action is not applied.
- **Not a player:** an action from a spectator (or anyone not seated in the game) gets `session_error` `{ code: "SPECTATOR_ACTION_FORBIDDEN", fatal: false }`; the socket stays connected.
- **Outside a game:** an action from a socket that is not in a room with a game in progress is ignored.

## Server → Client Events

The server broadcasts most events to all players in the session. Unicast events (marked **U**) are sent only to the addressed player.

### Lobby & Room

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `lobby_snapshot` | **U** | `rooms: RoomSummary[]`, `online_users: UserSummary[]` — sent on entering the lobby |
| `rooms_updated` | Lobby | `rooms: RoomSummary[]` |
| `presence_updated` | Lobby | `online_users: UserSummary[]` |
| `room_snapshot` | **U** | `room_id`, `config: RoomConfig`, `members: MemberSummary[]`, `host_id` — sent on entering a room |
| `host_changed` | Room | `room_id`, `host_id` |
| `room_config_updated` | Room | `room_id`, `config: RoomConfig` — after the host changes config via REST |
| `chat_message` | Room | `room_id`, `sender_id`, `display_name`, `text`, `sent_at: ISO-8601` |
| `room_closed` | Room | `room_id`, `reason: "inactivity"\|"game_finished"\|"empty"\|"host_closed"` — members (including spectators) return to the lobby. `empty`: the last player left an open room; `host_closed`: the host closed it via `DELETE /rooms/{roomId}` |

### Lobby & Game Flow

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `user_joined` | All | `user_id`, `display_name`, `role: "player"\|"spectator"`, `seat_index: integer\|null` (null for spectators), `player_count`, `spectator_count` — sent for players and spectators |
| `user_left` | All | `user_id`, `role: "player"\|"spectator"`, `reason: "voluntary"\|"timeout"`, `player_count`, `spectator_count` — player-drop rules apply only when `role` is `player` and a game is in progress |
| `game_starting` | All | `game_id: string`, `countdown_seconds: integer`, `player_order: string[]` — the host started the game (`POST /rooms/{roomId}/start`). `countdown_seconds` is `0`: the game starts at once. `player_order` is the seat order (join order); seat 1 deals round 1 |
| `game_started` | All | `game_id: string`, `room_id: string`, `round_count: integer`, `bid_rule: "open"\|"uneven"`, `players: PlayerSummary[]` — `PlayerSummary` is `{ user_id, display_name, seat_index }` (0-based, as in `user_joined`). Clients go to the game screen (`/game/{game_id}`) |
| `game_over` | All | `final_scores: ScoreEntry[]`, `winner_ids: string[]` — every player tied for the highest score; tied players are co-winners |
| `game_time_warning` | All | `game_id: string`, `ends_at: ISO-8601`, `minutes_remaining: 15`: sent once, 15 minutes before the 3-hour game time limit |
| `game_abandoned` | All | `reason: "server_restart"\|"time_limit"`, `game_id: string` |
| `player_disconnected` | All | `player_id`, `reconnect_deadline: ISO-8601` — socket dropped; the player's seat is held until the deadline |
| `player_reconnected` | All | `player_id` — the player rejoined within the window; clears the disconnect indicator |
| `continue_or_end_request` | All | `remaining_player_ids: string[]` — a drop left exactly two players; each answers with `choose_continue_or_end` within 60 s (no answer counts as end) |

### Round & Deal

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `round_started` | All | `round_number: integer`, `dealer_id: string`, `trump_suit: string\|null`, `trump_card: Card\|null` — `trump_card` is the flipped card, `null` when every card was dealt and nothing is flipped. `trump_suit` is `null` for a Jester, a Wizard (until the dealer declares) and no flip. `Card` is `{ suit: string\|null, rank: integer\|null, type: "suited"\|"wizard"\|"jester" }` (rank 2–14, Ace = 14; Wizards and Jesters have no suit or rank) |
| `hand_dealt` | **U** | `hand: Card[]`, `round_number: integer` — each player gets only their own hand, after `round_started`; never sent to spectators |
| `trump_revealed` | All | `round_number: integer`, `trump_suit: string\|null`, `trump_card: Card\|null`, `trump_source: "flip"\|"declaration"\|null` — trump is settled for the round and bidding starts. Sent right after the `hand_dealt` events for a suited card (`flip`), a Jester (`trump_suit: null`, `trump_source: null`) and no flip (`trump_card: null`); after the dealer's `select_trump` for a Wizard (`declaration`) |
| `trump_selection_request` | **U** | `player_id` (the dealer), `round_number: integer` — sent only when the turned-up trump card is a Wizard; dealer must respond with `select_trump`. Other players learn of it from `round_started` (`trump_card` is a Wizard, `trump_suit` is `null`) |

### Bidding Phase

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `bid_request` | **U** | `player_id`, `round_number`, `bids_so_far: BidEntry[]`, `hand_size: integer`, `allowed_bids: integer[]` — to the next bidder only, starting left of the dealer; the dealer bids last. `BidEntry` is `{ player_id, bid }`, in bidding order. `allowed_bids` is `0…round_number`, minus the one bid that would make the total equal the trick count when the dealer bids under the uneven rule |
| `bid_placed` | All | `player_id`, `bid: integer` |
| `all_bids_placed` | All | `bids: BidEntry[]` — every player has bid, in bidding order; trick play begins |

### Trick-Playing Phase

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `play_request` | **U** | `player_id`, `trick_number`, `trick_so_far: PlayEntry[]`, `legal_cards: Card[]` |
| `card_played` | All | `player_id`, `card: Card`, `trick_number: integer` |
| `trick_complete` | All | `winner_id: string`, `cards_played: PlayEntry[]`, `trick_number: integer` |
| `round_complete` | All | `scores_this_round: ScoreEntry[]`, `cumulative_scores: ScoreEntry[]` |

### Sync, Error & Control

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `state_snapshot` | **U** | `game_state: GameStateView`, `seq: integer` (replay from `last_seq_seen`) — the recipient's filtered view (`game.toPlayerView(userId)`: own hand only; spectators get `game.toSpectatorView()`), never the server-side `GameState`. `seq` is the game seq the view reflects. Sent when a socket connects while its user is in a room with a game in progress, and to a spectator who joins a game in progress (instead of `room_snapshot`). If it is the recipient's turn to bid or declare trump, the matching `bid_request` or `trump_selection_request` follows it |
| `pong` | **U** | `server_time: ISO-8601` |
| `invalid_play_error` | **U** | `player_id`, `reason: string`, `legal_cards: Card[]` |
| `invalid_bid_error` | **U** | `player_id`, `code: string`, `reason: string`, `min_bid: integer`, `max_bid: integer`, `allowed_bids: integer[]` — `code` is `NOT_YOUR_TURN`, `INVALID_BID` (out of range, not an integer, or blocked by the uneven rule), `ALREADY_BID` or `INVALID_PHASE` (not bidding now). `allowed_bids` is empty when it is not the sender's turn |
| `invalid_trump_error` | **U** | `player_id`, `code: string`, `reason: string` — a refused `select_trump`: `code` is `NOT_YOUR_TURN` (not the dealer), `INVALID_SUIT` or `INVALID_PHASE` (no declaration pending) |
| `session_error` | **U** | `code: string`, `message: string`, `fatal: boolean`, `reason?: string` — `code: "SESSION_INVALIDATED"` (fatal) is sent to every socket on a session that a newer login, a password reset or a logout has ended, with `reason` `"displaced"`, `"password_reset"` or `"logout"` so the client can say which, and the socket is then disconnected (on connect with an already-ended session there is no `reason`); `code: "REAUTH_REQUIRED"` (fatal) is sent on connect when the session is within 24 hours of its 30-day cap and the user is not reconnecting to a game in progress |

## Event Sequencing & State Transitions

The table below maps each GSM state to the events that drive entry, the client events valid in that state, and the exit event that signals the transition.

| GSM State | Entry Event (Server) | Valid Client Events | Exit Event (Server) |
| --- | --- | --- | --- |
| `LOBBY` | `user_joined` | &#32;`leave_game` | `game_starting` |
| `DEALING` | `game_started` / `round_started` | — | `hand_dealt` (all players) |
| `BIDDING` | `all_bids_placed` pending; `bid_request` per player | `place_bid` | `all_bids_placed` |
| `PLAYING` | `all_bids_placed` | `play_card` | `round_complete` |
| `SCORING` | `round_complete` | — | `round_started` or `game_over` |
| `GAME_OVER` | `game_over` | `leave_game` | — |

**Server restart.** `game_abandoned` (broadcast, `reason: "server_restart"`) may be emitted from any non-terminal state (`DEALING`, `BIDDING`, `PLAYING`, `SCORING`) when the server restarts and the startup cleanup closes an in-progress game. Clients that reconnect and receive this event must return the player to the lobby. There is no valid client event in response; the game cannot be resumed.

**Game time limit.** A game may run for at most 3 hours from `game_started`. At 2 h 45 min the server broadcasts `game_time_warning`. At 3 hours it broadcasts `game_abandoned` (`reason: "time_limit"`) from whatever non-terminal state the game is in, and the game is recorded as incomplete with no winner, exactly as for a server restart. Clients return to the lobby.

### Ordering Guarantees

- The server never emits two events for the same session simultaneously; they are serialised and `seq`-stamped before delivery.
- Clients must buffer events received during a network hiccup and apply them in `seq` order after reconnection.
- A client that receives `seq N+2` without `seq N+1` emits `sync_request` immediately; the server replies with `state_snapshot` replaying from `last_seq_seen`.

### Error Recovery

1. **Invalid action:** Server emits `invalid_play_error` or `invalid_bid_error` (unicast). State does not change; the client re-enables the relevant UI.
2. **Fatal session error:** Server emits `session_error` with `fatal: true`. The client disconnects and shows a re-join prompt.
3. **Reconnect:** Client sends `join_game` with `last_seq_seen` within the 30-second window. Server validates the session, emits `state_snapshot` (the player's own view, so they resume exactly where they left off), replays any events with `seq > last_seq_seen`, and broadcasts `player_reconnected`.

## Room & Session Management Events

### Lifecycle Summary

| Phase | Who | Event | Notes |
| --- | --- | --- | --- |
| Connect | Client | *(WebSocket upgrade, no event)* | The browser sends the signed HTTP-only session cookie with the handshake (`withCredentials: true`). The server verifies the cookie and calls `authenticateToken` (the same check as REST `requireAuth`). On failure it emits `session_error` (`code` = the failure code, e.g. `UNAUTHORIZED` or `SESSION_INVALIDATED`, `fatal: true`) and disconnects. If the session is within 24 hours of its 30-day cap and the user is not reconnecting to a game in progress, it emits `session_error` (`code: "REAUTH_REQUIRED"`, `fatal: true`) and disconnects. A user flagged for a forced credential change gets `code: "CREDENTIAL_CHANGE_REQUIRED"` (fatal) |
| Session ended elsewhere | Server → Client | `session_error` | When a newer login, a password reset or a logout ends a session, every socket using it receives `code: "SESSION_INVALIDATED"` (`fatal: true`, `reason`: `"displaced"`, `"password_reset"` or `"logout"`) and is disconnected. The auth routes publish the ended session ids in-process once their transaction commits; the socket layer subscribes. Single-instance only |
| Join | Client → Server | `join_game` | Server uses the session bound at connect (`socket.data.userId`); assigns seat |
| Seat confirmed | Server → Client | `user_joined` (broadcast) | All room members receive the newcomer's info and role |
| Leave (intentional) | Client → Server | `leave_game` | The player has quit. Server broadcasts `user_left` with `reason: "voluntary"`; in a game, player-drop rules apply |
| Disconnect detected | Server → All | `player_disconnected` | Socket closed or no `ping` for 30 s. Seat held; 30-second reconnection window starts |
| Reconnect (within window) | Client → Server | `join_game` with `last_seq_seen` | Server sends `state_snapshot`, replays missed events, broadcasts `player_reconnected` |
| Window expires | Server → All | `user_left` | `reason: "timeout"`; treated as a quit, player-drop rules apply |

### Spectator Mode

Spectators join a room with `POST /rooms/{roomId}/join` (`role: "spectator"`), before or during the game; their socket is then moved into the room (`room_snapshot` before the game, `state_snapshot` with the spectator view during it). `join_game` with `role: "spectator"` is the socket equivalent. The server:

- Sends them all broadcast events.
- Never sends `bid_request`, `play_request`, or `hand_dealt` to them.
- Rejects any action events (`select_trump`, `place_bid`, `play_card`) with `session_error` code `SPECTATOR_ACTION_FORBIDDEN` (`fatal: false`).

Spectator joins and leaves are broadcast to the room like players': `user_joined` / `user_left` with `role: "spectator"`. During a game they are part of the game's `seq` and event log like any other broadcast. A spectator leaving never triggers player-drop rules.

### Idle & Timeout Policy

| Condition | Timeout | Server Action |
| --- | --- | --- |
| No `ping` from client | 30 s | Treated as a disconnect: `player_disconnected`, then the 30-second reconnection window |
| Disconnected player does not rejoin | 30 s after `player_disconnected` | `user_left` (timeout) |
| Host of an open room has no connected socket | 120 s | The host role passes to the connected player with the lowest join order (`host_changed` to the room, `rooms_updated` to the lobby). The old host stays a member and returns as a regular player. If no other player is connected, nothing changes. Reconnecting within the 120 s keeps the role |

There are no turn timers: the game waits for a player to bid, play, or declare trump. A player who is disconnected is handled by the reconnection window above.
