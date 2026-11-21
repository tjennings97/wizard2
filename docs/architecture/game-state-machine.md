# Wizard — Game State Machine

## Overview

This document defines the complete state machines that govern Wizard's room, game, round, trick, and player connection lifecycles. Each state machine is presented as a diagram and a transition table. Together they are the authoritative specification for the game engine, socket layer, and persistence layer — any state transition must be traceable to an entry here.

**How to read this document:** Each state machine names its states, the events or conditions that trigger transitions between them, and the guards (conditions that must be true for the transition to fire). Actions taken on transition (socket broadcasts, database writes, timer starts) are listed in the transition tables.

**Relationship to the codebase:**

- `States map to the state column on the rooms and games tables, and to server-side in-memory Game, Round, and Trick objects held in the Node.js process heap on Railway. The client holds only a rendered copy of the last state the server pushed via Socket.io — it is never the source of truth`
- Transitions are fired by socket event handlers in the socket layer calling game engine methods
- Guards are enforced by the socket layer before calling engine methods
- Checkpoint actions correspond to `game.toGameState()` writes to `games.state`
- Socket broadcasts correspond to the events listed in the WebSocket Event Taxonomy

**Machines in this document:**

1. Room Lifecycle
2. Game Lifecycle
3. Round (within a game)
4. Trick (within a round)
5. Player Connection

## Room Lifecycle

&#91;embedded content: room lifecycle · 4 states · transitions with guards\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| — | Host opens room | User not already in a room or game | **OPEN** | Insert `rooms` row; join Socket.io room; broadcast `lobby:rooms_updated`; start 10-minute inactivity timer |
| **OPEN** | Host starts game | ≥ 3 players in room; room is OPEN | **IN PROGRESS** | Cancel inactivity timer; create `games` row; deal round 1; broadcast `room:game_starting`, `game:round_started`; emit `player:hand_dealt` to each player |
| **OPEN** | 10-minute inactivity timer fires | Game not yet started | **CLOSED** | Set `rooms.closed_at`; broadcast `room:closed`; all members returned to lobby |
| **OPEN** | All players leave | Room is OPEN | **CLOSED** | Set `rooms.closed_at`; broadcast `lobby:rooms_updated` |
| **IN PROGRESS** | Final round scoring complete | — | **COMPLETING** | Write final `game_results`; write `games.state` snapshot; broadcast `game:completed`; start 30-second countdown timer |
| **IN PROGRESS** | Player drop reduces game to 2 players and both choose to end | — | **COMPLETING** | Write `games.status = incomplete`; write `game_results` with `outcome = incomplete`; broadcast `game:completed`; start 30-second countdown |
| **COMPLETING** | 30-second countdown timer fires | — | **CLOSED** | Set `rooms.closed_at`; broadcast `room:closed`; all users returned to lobby |
| **COMPLETING** | All users leave before countdown | — | **CLOSED** | Set `rooms.closed_at` immediately |

## Game Lifecycle

&#91;embedded content: game lifecycle · 6 states · round loop and early-exit paths\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| Room IN PROGRESS | Game created | — | **INITIALISING** | Shuffle deck; assign seat order; determine dealer (seat 1 for round 1); write `games` row |
| **INITIALISING** | Trump card flipped (or dealer declares) | — | **BIDDING** | Record trump suit and source; emit `game:round_started` with trump; emit `player:hand_dealt` to each player |
| **BIDDING** | All players have placed bids | Bid total constraint satisfied if `bid_rule = uneven` | **TRICK PHASE** | Emit `game:trick_phase`; set first lead to player left of dealer |
| **TRICK PHASE** | All tricks in round played | — | **ROUND END** | Compute scores; write `round_players`; emit `game:round_completed`; write `games.state` checkpoint |
| **ROUND END** | More rounds remain | `currentRound < config.roundCount` | **INITIALISING** | Increment round; rotate dealer; shuffle deck; deal |
| **ROUND END** | Final round just scored | `currentRound === config.roundCount` | **GAME END** | Write `game_results`; set `games.status = complete`; emit `game:completed` |
| **Any active phase** (INITIALISING, TRUMP DETERMINATION, BIDDING PHASE, TRICK PHASE) | Player drop reduces game to 2 players and mutual end chosen | — | **INCOMPLETE** | Set `games.status = incomplete`; write partial `game_results`; emit `game:completed` |
| Any active phase (INITIALISING, TRUMP DETERMINATION, BIDDING PHASE, TRICK PHASE) | Player quits or times out; ≥ 3 players remain after drop | remainingPlayerCount >= 3 | INITIALISING (same round number) | Void current round; remove dropped player; re-deal same round number to remaining players; emit player:quit and game:round\_redealt to room |
| **GAME END** | — | — | (Room → COMPLETING) | Room state machine takes over |
| **INCOMPLETE** | — | — | (Room → COMPLETING) | Room state machine takes over |

## Round State Machine

&#91;embedded content: round state machine · 5 sequential states\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| Game INITIALISING | Round begins | `currentRound ≤ config.roundCount` | **ROUND START** | Create fresh Round object (resets tricksWon, bids, and hand to empty for each player); shuffle deck; deal N cards to each player (N = round number); write `rounds` row; emit `player:hand_dealt` to each player individually |
| **ROUND START** | Top card flipped | Card is a suited card | **TRUMP DETERMINATION** | Set `rounds.trump_suit`; set `rounds.trump_source = flip`; proceed immediately to BIDDING |
| **ROUND START** | Top card flipped | Card is a Jester | **TRUMP DETERMINATION** | Set `rounds.trump_suit = null`; proceed immediately to BIDDING |
| **ROUND START** | Top card flipped | Card is a Wizard | **TRUMP DETERMINATION** | Emit `game:trump_declared` pending; wait for dealer declaration |
| ROUND START | No card remains to flip | All cards dealt: deckSize % playerCount === 0 and this is the final round | TRUMP DETERMINATION | Set trump\_suit = null, trump\_source = null; skip any flip or declaration; proceed immediately to BIDDING PHASE |
| **TRUMP DETERMINATION** | Dealer declares trump suit | Top card was a Wizard; dealer has viewed hand | **TRUMP DETERMINATION → BIDDING** | Set `rounds.trump_suit` to declared suit; set `rounds.trump_source = declaration`; write `game_events` (trump\_declared); emit `game:trump_set` |
| **TRUMP DETERMINATION** | (Superseded) No top card to flip — final round, all cards dealt | Handled at ROUND START before entering TRUMP DETERMINATION. This row is kept for reference only. Condition: `deckSize % playerCount === 0` | **TRUMP DETERMINATION → BIDDING** | Set `rounds.trump_suit = null`; no trump for this round |
| **TRUMP DETERMINATION** | Trump resolved | — | **BIDDING PHASE** | Emit `game:bid_phase`; set bid order starting left of dealer |
| **BIDDING PHASE** | Each player places bid | Player's turn; bid is 0–N; if last bidder and `bid_rule = uneven`, bid cannot make total equal trick count | **BIDDING PHASE** (until all bid) | Record bid; emit `game:bid_placed`; write `game_events` (bid\_placed) |
| **BIDDING PHASE** | All players have bid | — | **TRICK PHASE** | Emit `game:trick_phase`; set first lead to player left of dealer |
| BIDDING PHASE | All players have bid | — | TRICK PHASE | Emit game:trick\_phase; set first trick lead to player left of dealer; Trick state machine takes over for each trick |
| **TRICK PHASE** | All N tricks completed | — | **ROUND SCORING** | Compute score deltas; write `round_players`; emit `game:round_completed` |
| **ROUND SCORING** | Scores applied | — | (Game → ROUND END) | Write `games.state` checkpoint; Game lifecycle takes over — next state is INITIALISING (if rounds remain) or GAME END (if final round) |

## Trick State Machine

&#91;embedded content: trick state machine · 4 states per trick\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| Round TRICK PHASE begins | Trick N starts | `currentTrick ≤ roundNumber` | **TRICK START** | Set lead player (left of dealer for trick 1; winner of prior trick thereafter); emit `game:trick_phase` with trick number |
| **TRICK START** | Lead player identified | — | **AWAITING PLAY** | Emit `player:your_turn` to lead player; record led suit once first card is played |
| **AWAITING PLAY** | Current player plays a card | Card is in player's hand; suit-follow rule satisfied (must follow led suit if able; exception: Jester or Wizard led = any card) | **CARD PLAYED** | Remove card from player's hand; record card in trick; write `game_events` (card\_played); emit `game:card_played` to room |
| **CARD PLAYED** | More players remain to play | `cardsInTrick < playerCount` | **AWAITING PLAY** | Advance turn to next player; emit `player:your_turn` |
| **CARD PLAYED** | All players have played | `cardsInTrick === playerCount` | **TRICK RESOLUTION** | Apply winner priority rules: first Wizard wins; else highest trump; else highest card of led suit; else first Jester |
| **TRICK RESOLUTION** | Winner determined | — | **TRICK END** | Increment `tricksWon` for winner; write `game_events` (trick\_completed) with winning card type; emit `game:trick_completed` |
| **TRICK END** | More tricks remain in round | `currentTrick < roundNumber` | **TRICK START** | Increment trick number; winner becomes lead player |
| **TRICK END** | All tricks played | `currentTrick === roundNumber` | (Round → ROUND SCORING) | Round state machine takes over |

## Player Connection State Machine

&#91;embedded content: player connection state machine · reconnection window and exit paths\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| — | Player joins room (socket connect) | Valid session token in handshake | **CONNECTED** | Bind `socket.data.userId`; join Socket.io room; emit `room:player_joined` |
| **CONNECTED** | Socket disconnect detected | Player is in an active game | **DISCONNECTED** | Start 30-second server-side `setTimeout` keyed by `userId`; emit `player:disconnected` to room; other players see indicator |
| **CONNECTED** | Player sends `/leave` (explicit quit) | — | **QUIT** | Set `room_members.left_at`; emit `player:quit` to room; trigger player-drop game logic; player cannot rejoin |
| **DISCONNECTED** | Player reconnects (socket reconnect) | Session still valid; timer still running; `clearTimeout` | **RECONNECTED** | Restore `GameState` snapshot; emit `player:state_restored` to reconnecting socket; emit `player:reconnected` to room; indicator cleared |
| **DISCONNECTED** | Player sends `/leave` while socket is down | Server receives leave event on reconnect before timer clears | **QUIT** | Treat as explicit quit; clear timer; trigger player-drop game logic |
| **DISCONNECTED** | 30-second timer fires | Player has not reconnected | **TIMED OUT** | Treat as quit; trigger player-drop game logic; emit `player:quit` to room; set `room_members.left_at` |
| **RECONNECTED** | Continues playing | — | **CONNECTED** | Normal gameplay resumes |
| **QUIT** | — | — | (terminal) | Player removed permanently; cannot re-enter this game |
| **TIMED OUT** | — | — | (terminal) | Same as QUIT; player-drop game logic applied |

**Player-drop game logic** (triggered from QUIT or TIMED OUT):

1. Current round is voided
2. Remaining player count checked
3. If ≥ 3 players remain: re-deal to remaining players for the same round number
4. If exactly 2 players remain: emit `game:continue_or_end` prompt to both; await mutual decision
5. If ≤ 1 player remains: game ends as INCOMPLETE automatically

## Special Cases

**Two-player edge case:** When dropout reduces a game to exactly 2 players, the server emits `game:continue_or_end` to both remaining players. Both must confirm within 60 seconds. If both choose continue, the round is re-dealt for 2 players. If either chooses end, or the timeout expires, the game transitions to INCOMPLETE with `outcome = incomplete` for both. The room then enters COMPLETING.

**Host leaves before game starts:** The game engine is not involved. The server queries `room_members` ordered by `join_order ASC` where `left_at IS NULL` and promotes the first result as the new host. `rooms.host_user_id` is updated and `room:host_changed` is broadcast. If no players remain, the room closes.

**All-Jester trick:** No special branch in code. Trick resolution applies the priority rules — with no Wizards, no trump, and no suited cards, the first Jester played wins. The lead player wins the trick. `winningCardType = jester` is recorded.

**Wizard flip — trump declaration sequence:**

1. Round enters TRUMP DETERMINATION; server emits `game:trump_declaration_required`
2. All players see the prompt; dealer sees their full hand
3. Dealer selects a suit; server validates (correct user, valid suit)
4. `rounds.trump_suit` and `rounds.trump_source = declaration` set
5. `game_events` row written (event\_type: `trump_declared`; payload includes dealer hand)
6. `game:trump_set` broadcast; bidding phase begins

No timeout on trump declaration. If the dealer disconnects mid-declaration, the 30-second reconnection window applies and the declaration prompt is re-sent via `GameState` restore.

## State Persistence and Restore

**Checkpoint events:** Not every state transition writes to Postgres — only durable progress points. Mid-trick state is held in memory only.

| Transition | Checkpoint | What is written |
| --- | --- | --- |
| ROUND SCORING complete | Full | `games.state` snapshot; `round_players` rows |
| GAME END | Full | `games.state`; `game_results`; `games.status = complete` |
| INCOMPLETE | Full | `games.state`; `game_results` with `outcome = incomplete`; `games.status = incomplete` |
| Bid placed | Partial | `game_events` row only |
| Card played | Partial | `game_events` row only |
| Trick completed | Partial | `game_events` row only |
| Trump declared | Partial | `game_events` row only |

**Reconnection restore sequence:** On reconnect within 30s: session validated → `clearTimeout` → `game.toGameState()` called → snapshot filtered to reconnecting player's own hand → `player:state_restored` emitted → `player:reconnected` broadcast to room. Player resumes from current state with no round rewind.

**Server restart mid-game:** The in-memory `Game` object and all timers are lost. On restart the server reads all `in_progress` game records and reconstructs `Game` objects from their `games.state` snapshots (last round-end checkpoint). Mid-trick progress is lost and the current trick is voided. Players mid-disconnection-window are treated as timed out. Durability of the reconnection timer across restarts requires moving it to Redis (TTL key) — part of the horizontal scaling path in the System Architecture Document.
