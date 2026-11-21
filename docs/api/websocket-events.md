# WebSocket Event Taxonomy

Oct 17, 2026 · @TJ

## Overview

This taxonomy defines every WebSocket message exchanged between client and server in the Wizard card game. It is the authoritative contract between the frontend and the game server; the OpenAPI spec governs REST endpoints for session setup, while this document covers all real-time events once a WebSocket connection is established.

**Scope.** All events emitted or consumed during a game session: lobby management, bidding, card play, scoring, reconnection, and error handling. Out of scope: HTTP authentication, lobby listing (REST), and static asset delivery.

**Relationship to the Game State Machine.** Each server-emitted event corresponds to one or more state transitions defined in the Game State Machine doc. The `event` field on every server message maps directly to a GSM transition label. Clients must apply events in order; out-of-order delivery triggers a `sync_request`.

**Relationship to the OpenAPI Spec.** The OpenAPI spec defines the `POST /sessions` endpoint that returns the `session_token` and WebSocket URL (`wss://…/game/{sessionId}`). All subsequent real-time communication uses the events below, not HTTP.

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

### Versioning

The WebSocket URL includes the API version: `wss://…/v1/game/{sessionId}`. Breaking changes to the event schema increment the major version. Additive fields (new optional payload keys) are non-breaking and may appear in any minor release.

## Client → Server Events

All events below are sent by the client inside the standard envelope. `seq` is always `0` from the client.

### Session & Lobby

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `join_game` | Player opens game URL | `session_token: string`, `player_id: string`, `display_name: string`, `last_seq_seen?: number` |
| `leave_game` | Player clicks Leave | `player_id: string` |

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

### Sync & Control

| Event | Trigger | Key Payload Fields |
| --- | --- | --- |
| `sync_request` | Client detects a `seq` gap | `player_id: string`, `last_seq_seen: number` |
| `ping` | Client keepalive (every 15 s) | `client_time: ISO-8601` |

## Server → Client Events

The server broadcasts most events to all players in the session. Unicast events (marked **U**) are sent only to the addressed player.

### Lobby & Game Flow

| Event | Broadcast | Key Payload Fields |
| --- | --- | --- |
| `player_joined` | All | `player_id`, `display_name`, `seat_index`, `player_count` |
| `player_left` | All | `player_id`, `reason: "voluntary"\|"timeout"` |
| `game_starting` | All | `countdown_seconds: integer`, `player_order: string[]` |
| `game_started` | All | `round_count: integer`, `players: PlayerSummary[]` |
| `game_over` | All | `final_scores: ScoreEntry[]`, `winner_id: string` |
| `game_abandoned` | All | `reason: "server_restart"`, `game_id: string` |

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
| `state_snapshot` | **U** | `game_state: FullGameState`, `seq: integer` (replay from `last_seq_seen`) |
| `pong` | **U** | `server_time: ISO-8601` |
| `invalid_play_error` | **U** | `player_id`, `reason: string`, `legal_cards: Card[]` |
| `invalid_bid_error` | **U** | `player_id`, `reason: string`, `min_bid: integer`, `max_bid: integer` |
| `session_error` | **U** | `code: string`, `message: string`, `fatal: boolean` |

## Event Sequencing & State Transitions

The table below maps each GSM state to the events that drive entry, the client events valid in that state, and the exit event that signals the transition.

| GSM State | Entry Event (Server) | Valid Client Events | Exit Event (Server) |
| --- | --- | --- | --- |
| `LOBBY` | `player_joined` | &#32;`leave_game` | `game_starting` |
| `DEALING` | `game_started` / `round_started` | — | `hand_dealt` (all players) |
| `BIDDING` | `all_bids_placed` pending; `bid_request` per player | `place_bid` | `all_bids_placed` |
| `PLAYING` | `all_bids_placed` | `play_card` | `round_complete` |
| `SCORING` | `round_complete` | — | `round_started` or `game_over` |
| `GAME_OVER` | `game_over` | `leave_game` | — |

**Server restart.** `game_abandoned` (broadcast, `reason: "server_restart"`) may be emitted from any non-terminal state (`DEALING`, `BIDDING`, `PLAYING`, `SCORING`) when the server restarts and the startup cleanup closes an in-progress game. Clients that reconnect and receive this event must return the player to the lobby. There is no valid client event in response; the game cannot be resumed.

### Ordering Guarantees

- The server never emits two events for the same session simultaneously; they are serialised and `seq`-stamped before delivery.
- Clients must buffer events received during a network hiccup and apply them in `seq` order after reconnection.
- A client that receives `seq N+2` without `seq N+1` emits `sync_request` immediately; the server replies with `state_snapshot` replaying from `last_seq_seen`.

### Error Recovery

1. **Invalid action:** Server emits `invalid_play_error` or `invalid_bid_error` (unicast). State does not change; the client re-enables the relevant UI.
2. **Fatal session error:** Server emits `session_error` with `fatal: true`. The client disconnects and shows a re-join prompt.
3. **Reconnect:** Client sends `join_game` with `last_seq_seen`. Server emits `state_snapshot` then replays any events with `seq > last_seq_seen`.

## Room & Session Management Events

### Lifecycle Summary

| Phase | Who | Event | Notes |
| --- | --- | --- | --- |
| Connect | Client | *(WebSocket upgrade, no event)* | Bearer token in `Authorization` header per OpenAPI spec |
| Join | Client → Server | `join_game` | Carries `session_token`; server validates, assigns seat |
| Seat confirmed | Server → Client | `player_joined` (broadcast) | All players receive newcomer's info |
| Disconnect (clean) | Client → Server | `leave_game` | Server broadcasts `player_left` with `reason: "voluntary"` |
| Disconnect (timeout) | Server → All | `player_left` | After 30 s no `ping`; `reason: "timeout"` |
| Reconnect | Client → Server | `join_game` with `last_seq_seen` | Server replays missed events via `state_snapshot` |

### Spectator Mode

Spectators connect with `join_game` and a `role: "spectator"` payload field. The server:

- Sends them all broadcast events.
- Never sends `bid_request`, `play_request`, or `hand_dealt` to them.
- Rejects any action events (`place_bid`, `play_card`) with `session_error` code `SPECTATOR_ACTION_FORBIDDEN`.

Spectator presence is not broadcast to players; `player_joined` is only emitted for active players.

### Idle & Timeout Policy

| Condition | Timeout | Server Action |
| --- | --- | --- |
| No `ping` from client | 30 s | `player_left` (timeout) |
| No `place_bid` after `bid_request` | 60 s | Auto-bid 0; `bid_placed` broadcast |
| No `play_card` after `play_request` | 60 s | Auto-play lowest legal card; `card_played` broadcast |
| Host disconnects in LOBBY | 120 s | Session terminated; `session_error` (fatal) to all |
