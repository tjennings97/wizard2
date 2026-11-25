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

`seq` increments per-session, per direction. Clients detect gaps and emit `sync_request` if `seq` jumps by more than 1.

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
| `select_trump` | Dealer picks trump suit (only when trump card is a Wizard) | `player_id: string`, `suit: "hearts"\|"diamonds"\|"clubs"\|"spades"`, `idempotency_key?: string` |

### Bidding Phase

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `place_bid` | Player submits bid | `player_id: string`, `bid: integer (0–round_number)`, `idempotency_key?: string` |

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
| `game_starting` | All | `countdown_seconds: integer`, `player_order: string[]` |
| `game_started` | All | `round_count: integer`, `players: PlayerSummary[]` |
| `game_over` | All | `final_scores: ScoreEntry[]`, `winner_ids: string[]` — every player tied for the highest score; tied players are co-winners |
| `game_time_warning` | All | `game_id: string`, `ends_at: ISO-8601`, `minutes_remaining: 15`: sent once, 15 minutes before the 3-hour game time limit |
| `game_abandoned` | All | `reason: "server_restart"\|"time_limit"`, `game_id: string` |
| `player_disconnected` | All | `player_id`, `reconnect_deadline: ISO-8601` — socket dropped; the player's seat is held until the deadline |
| `player_reconnected` | All | `player_id` — the player rejoined within the window; clears the disconnect indicator |
| `continue_or_end_request` | All | `remaining_player_ids: string[]` — a drop left exactly two players; each answers with `choose_continue_or_end` within 60 s (no answer counts as end) |

### Round & Deal

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `round_started` | All | `round_number: integer`, `trump_suit: string\|null`, `trump_card?: Card` |
| `hand_dealt` | **U** | `hand: Card[]`, `round_number: integer` |
| `trump_revealed` | All | `trump_suit: string`, `trump_card: Card` — broadcast after dealer's select\_trump (Wizard up-card) or immediately for any other rank |
| `trump_selection_request` | **U** | `player_id` (the dealer), `round_number: integer` — sent only when the turned-up trump card is a Wizard; dealer must respond with `select_trump` |

### Bidding Phase

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `bid_request` | **U** | `player_id`, `round_number`, `bids_so_far: BidEntry[]`, `hand_size: integer` |
| `bid_placed` | All | `player_id`, `bid: integer` |
| `all_bids_placed` | All | `bids: BidEntry[]` |

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
| `state_snapshot` | **U** | `game_state: GameStateView`, `seq: integer` (replay from `last_seq_seen`) — the recipient's filtered view (`game.toPlayerView(userId)`: own hand only; spectators get `game.toSpectatorView()`), never the server-side `GameState` |
| `pong` | **U** | `server_time: ISO-8601` |
| `invalid_play_error` | **U** | `player_id`, `reason: string`, `legal_cards: Card[]` |
| `invalid_bid_error` | **U** | `player_id`, `reason: string`, `min_bid: integer`, `max_bid: integer` |
| `session_error` | **U** | `code: string`, `message: string`, `fatal: boolean` — `code: "SESSION_INVALIDATED"` (fatal) is sent to every socket on a session that a newer login, a password reset or a logout has ended, and the socket is then disconnected; `code: "REAUTH_REQUIRED"` (fatal) is sent on connect when the session is within 24 hours of its 30-day cap and the user is not reconnecting to a game in progress |

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
| Session ended elsewhere | Server → Client | `session_error` | When a newer login, a password reset or a logout ends a session, every socket using it receives `code: "SESSION_INVALIDATED"` (`fatal: true`) and is disconnected. The auth routes publish the ended session ids in-process once their transaction commits; the socket layer subscribes. Single-instance only |
| Join | Client → Server | `join_game` | Server uses the session bound at connect (`socket.data.userId`); assigns seat |
| Seat confirmed | Server → Client | `user_joined` (broadcast) | All room members receive the newcomer's info and role |
| Leave (intentional) | Client → Server | `leave_game` | The player has quit. Server broadcasts `user_left` with `reason: "voluntary"`; in a game, player-drop rules apply |
| Disconnect detected | Server → All | `player_disconnected` | Socket closed or no `ping` for 30 s. Seat held; 30-second reconnection window starts |
| Reconnect (within window) | Client → Server | `join_game` with `last_seq_seen` | Server sends `state_snapshot`, replays missed events, broadcasts `player_reconnected` |
| Window expires | Server → All | `user_left` | `reason: "timeout"`; treated as a quit, player-drop rules apply |

### Spectator Mode

Spectators connect with `join_game` and a `role: "spectator"` payload field. The server:

- Sends them all broadcast events.
- Never sends `bid_request`, `play_request`, or `hand_dealt` to them.
- Rejects any action events (`place_bid`, `play_card`) with `session_error` code `SPECTATOR_ACTION_FORBIDDEN`.

Spectator joins and leaves are broadcast to the room like players': `user_joined` / `user_left` with `role: "spectator"`. A spectator leaving never triggers player-drop rules.

### Idle & Timeout Policy

| Condition | Timeout | Server Action |
| --- | --- | --- |
| No `ping` from client | 30 s | Treated as a disconnect: `player_disconnected`, then the 30-second reconnection window |
| Disconnected player does not rejoin | 30 s after `player_disconnected` | `user_left` (timeout) |
| Host of an open room has no connected socket | 120 s | The host role passes to the connected player with the lowest join order (`host_changed` to the room, `rooms_updated` to the lobby). The old host stays a member and returns as a regular player. If no other player is connected, nothing changes. Reconnecting within the 120 s keeps the role |

There are no turn timers: the game waits for a player to bid, play, or declare trump. A player who is disconnected is handled by the reconnection window above.
