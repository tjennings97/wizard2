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
| — | Host opens room | User not already in a room or game | **OPEN** | Insert `rooms` row; join Socket.io room; broadcast `rooms_updated`; start 10-minute inactivity timer |
| **OPEN** | Host starts game | ≥ 3 players in room; room is OPEN | **IN PROGRESS** | Cancel inactivity timer; dissolve the host role; create `games` row; deal round 1; broadcast `game_starting`, `game_started`, `round_started`; emit `hand_dealt` to each player |
| **OPEN** | 10-minute inactivity timer fires | Game not yet started | **CLOSED** | Set `rooms.closed_at`; broadcast `room_closed`; all members returned to lobby |
| **OPEN** | Host leaves | Room is OPEN; at least one other player remains | **OPEN** | Set host's `room_members.left_at`; promote the remaining player with the lowest `join_order` (`role = 'player'`, `left_at IS NULL`; spectators are never promoted); update `rooms.host_user_id`; broadcast `user_left`, then `host_changed`; broadcast `rooms_updated` |
| **OPEN** | Host has no connected socket for 120 s | Room is OPEN; host still has no socket; another player is connected | **OPEN** | Promote the connected player with the lowest `join_order` (`role = 'player'`, `left_at IS NULL`); the old host stays a member; update `rooms.host_user_id`; broadcast `host_changed`; broadcast `rooms_updated`. Reconnecting within 120 s cancels the timer |
| **OPEN** | All players leave | Room is OPEN (spectators may remain) | **CLOSED** | Set `rooms.closed_at`; broadcast `room_closed` (`reason: "empty"`) to the room; remaining spectators returned to lobby; broadcast `rooms_updated` |
| **OPEN** | Host closes room (`DELETE /rooms/{roomId}`) | Requester is host; room is OPEN | **CLOSED** | Cancel inactivity timer; set `rooms.closed_at`; broadcast `room_closed` (`reason: "host_closed"`); all members returned to lobby; broadcast `rooms_updated` |
| **IN PROGRESS** | Final round scoring complete | — | **COMPLETING** | In one transaction: write the final round's `rounds` / `round_players`, write `game_results`, set `games.status = complete`, `games.ended_at` and the final `games.state`, set `rooms.state = completing`. Broadcast `game_over` (with `closes_at`); start the 30-second countdown timer; broadcast `rooms_updated` (a completing room leaves the lobby list) |
| **IN PROGRESS** | A player quits (`leave_game` / `POST /rooms/{roomId}/leave`) or their reconnection window runs out | At least 2 players remain | **IN PROGRESS** | Set their `room_members.left_at`; broadcast `user_left` (`voluntary` / `timeout`); player-drop game logic (re-deal, or `continue_or_end_request` at 2 players). A spectator leaving sets `left_at` and broadcasts `user_left` only |
| **IN PROGRESS** | The game ends early: a drop leaves 1 player; or, at 2 players, either chooses end or no answer arrives within 60 s | — | **COMPLETING** | In one transaction: `games.status = incomplete`, `drop_reason` (`player_quit` / `player_timeout` for the drop that left one player; `mutual_end` for end or no answer), `player_count_at_drop`, `ended_at` and the final `games.state`; `game_results` with `outcome = incomplete` for every player, including those who left (with their own `drop_reason`); `rooms.state = completing`. Broadcast `game_over` (`status: "incomplete"`, no winner); start the 30-second countdown; broadcast `rooms_updated` |
| **IN PROGRESS** | 3-hour game time limit reached | — | **COMPLETING** | As above with `drop_reason = 'time_limit'`; the round in progress is not scored. Broadcast `game_abandoned` (`reason: "time_limit"`); start the 30-second countdown |
| **IN PROGRESS** | Server restarts | — | **CLOSED** | Startup cleanup, before accepting traffic: `games.status = incomplete`, `drop_reason = 'server_restart'`; `game_results` (`outcome = incomplete`) for the players still seated; set `rooms.closed_at` and every member's `left_at`. A client that then sends `join_game` or a game action gets `game_abandoned` |
| **COMPLETING** | A member leaves (`POST /rooms/{roomId}/leave`) | Others remain | **COMPLETING** | Set their `room_members.left_at`; broadcast `user_left` (`reason: "voluntary"`). Not a quit: no player-drop rules |
| **COMPLETING** | 30-second countdown timer fires | — | **CLOSED** | Set `rooms.closed_at` and every remaining member's `left_at`; drop the in-memory game; broadcast `room_closed` (`reason: "game_finished"`); all users returned to lobby; broadcast `rooms_updated` |
| **COMPLETING** | All users leave before countdown | The last member leaves | **CLOSED** | Set `rooms.closed_at` immediately; cancel the countdown; drop the in-memory game; broadcast `rooms_updated` |
| **COMPLETING** | Server restarts | — | **CLOSED** | Startup cleanup closes the room before accepting traffic (the countdown timer and the game are gone); the game is already recorded `complete` |

## Game Lifecycle

&#91;embedded content: game lifecycle · 6 states · round loop and early-exit paths\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| Room IN PROGRESS | Game created | — | **INITIALISING** | Shuffle deck; assign seat order; determine dealer (seat 1 for round 1); write `games` row |
| **INITIALISING** | Trump card flipped (or dealer declares) | — | **BIDDING** | Record trump suit and source; emit `round_started` with trump; emit `hand_dealt` to each player |
| **BIDDING** | All players have placed bids | Bid total constraint satisfied if `bid_rule = uneven` | **TRICK PHASE** | Emit `all_bids_placed`; set first lead to player left of dealer |
| **TRICK PHASE** | All tricks in round played | — | **ROUND END** | Compute scores; write `rounds` and `round_players`; write `games.state` checkpoint; emit `round_complete` |
| **ROUND END** | More rounds remain | `currentRound < config.roundCount` | **INITIALISING** | Increment round; rotate dealer; shuffle deck; deal |
| **ROUND END** | Final round just scored | `currentRound === config.roundCount` | **GAME END** | Write `game_results`; set `games.status = complete`; emit `game_over` (see Room Lifecycle, IN PROGRESS → COMPLETING) |
| **Any active phase** (INITIALISING, TRUMP DETERMINATION, BIDDING PHASE, TRICK PHASE) | Player drop reduces game to 2 players and either chooses end (or no answer within 60 s); or a drop leaves 1 player | — | **INCOMPLETE** | Set `games.status = incomplete`; write partial `game_results`; emit `game_over` |
| Any active phase (INITIALISING, TRUMP DETERMINATION, BIDDING PHASE, TRICK PHASE) | Player quits or times out; ≥ 3 players remain after drop | remainingPlayerCount >= 3 | INITIALISING (same round number) | Void current round; remove dropped player; re-deal same round number to remaining players; emit `user_left` to room, then the re-dealt round (`round_started`, `hand_dealt`) |
| **GAME END** | — | — | (Room → COMPLETING) | Room state machine takes over |
| **INCOMPLETE** | — | — | (Room → COMPLETING) | Room state machine takes over |

## Round State Machine

&#91;embedded content: round state machine · 5 sequential states\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| Game INITIALISING | Round begins | `currentRound ≤ config.roundCount` | **ROUND START** | Create fresh Round object (resets tricksWon, bids, and hand to empty for each player); shuffle deck; deal N cards to each player (N = round number); note the start time (the `rounds` row is written when the round is scored, with `started_at` = this time); emit `hand_dealt` to each player individually |
| **ROUND START** | Top card flipped | Card is a suited card | **TRUMP DETERMINATION** | Set `rounds.trump_suit`; set `rounds.trump_source = flip`; proceed immediately to BIDDING |
| **ROUND START** | Top card flipped | Card is a Jester | **TRUMP DETERMINATION** | Set `rounds.trump_suit = null`; proceed immediately to BIDDING |
| **ROUND START** | Top card flipped | Card is a Wizard | **TRUMP DETERMINATION** | Emit `trump_selection_request` to the dealer; wait for dealer declaration (`select_trump`) |
| ROUND START | No card remains to flip | All cards dealt: deckSize % playerCount === 0 and this is the final round | TRUMP DETERMINATION | Set trump\_suit = null, trump\_source = null; skip any flip or declaration; proceed immediately to BIDDING PHASE |
| **TRUMP DETERMINATION** | Dealer declares trump suit | Top card was a Wizard; dealer has viewed hand | **TRUMP DETERMINATION → BIDDING** | Set `rounds.trump_suit` to declared suit; set `rounds.trump_source = declaration`; write `game_events` (trump\_declared); emit `trump_revealed` |
| **TRUMP DETERMINATION** | (Superseded) No top card to flip — final round, all cards dealt | Handled at ROUND START before entering TRUMP DETERMINATION. This row is kept for reference only. Condition: `deckSize % playerCount === 0` | **TRUMP DETERMINATION → BIDDING** | Set `rounds.trump_suit = null`; no trump for this round |
| **TRUMP DETERMINATION** | Trump resolved | — | **BIDDING PHASE** | Set bid order starting left of dealer; emit `bid_request` to the first bidder |
| **BIDDING PHASE** | Each player places bid | Player's turn; bid is 0–N; if last bidder and `bid_rule = uneven`, bid cannot make total equal trick count | **BIDDING PHASE** (until all bid) | Record bid; emit `bid_placed`; write `game_events` (bid\_placed) |
| **BIDDING PHASE** | All players have bid | — | **TRICK PHASE** | Emit `all_bids_placed`; set first lead to player left of dealer |
| BIDDING PHASE | All players have bid | — | TRICK PHASE | Emit all_bids_placed; set first trick lead to player left of dealer; Trick state machine takes over for each trick |
| **TRICK PHASE** | All N tricks completed | — | **ROUND SCORING** | Compute score deltas; write `rounds` and `round_players`; emit `round_complete` |
| **ROUND SCORING** | Scores applied | — | (Game → ROUND END) | Write `games.state` checkpoint (same transaction as `rounds` / `round_players`); Game lifecycle takes over — next state is INITIALISING (if rounds remain: the next round is dealt at once, with no server-side pause; clients hold the round summary on screen themselves) or GAME END (if final round) |

## Trick State Machine

&#91;embedded content: trick state machine · 4 states per trick\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| Round TRICK PHASE begins | Trick N starts | `currentTrick ≤ roundNumber` | **TRICK START** | Set lead player (left of dealer for trick 1, right after `all_bids_placed`; winner of prior trick thereafter, right after `trick_complete`) |
| **TRICK START** | Lead player identified | — | **AWAITING PLAY** | Emit `play_request` to lead player; record led suit once first card is played |
| **AWAITING PLAY** | Current player plays a card | Card is in player's hand; suit-follow rule satisfied (must follow led suit if able; opening Jesters are skipped and the first non-Jester card decides: a Wizard = any card for the rest of the trick, a suited card = its suit must be followed, even if a Wizard is played later) | **CARD PLAYED** | Remove card from player's hand; record card in trick; write `game_events` (card\_played); emit `card_played` to room |
| **CARD PLAYED** | More players remain to play | `cardsInTrick < playerCount` | **AWAITING PLAY** | Advance turn to next player; emit `play_request` |
| **CARD PLAYED** | All players have played | `cardsInTrick === playerCount` | **TRICK RESOLUTION** | Apply winner priority rules: first Wizard wins; else highest trump; else highest card of led suit; else first Jester |
| **TRICK RESOLUTION** | Winner determined | — | **TRICK END** | Increment `tricksWon` for winner; write `game_events` (trick\_completed, broadcast as `trick_complete`) with winning card type; emit `trick_complete` |
| **TRICK END** | More tricks remain in round | `currentTrick < roundNumber` | **TRICK START** | Increment trick number; winner becomes lead player |
| **TRICK END** | All tricks played | `currentTrick === roundNumber` | (Round → ROUND SCORING) | Round state machine takes over |

## Player Connection State Machine

&#91;embedded content: player connection state machine · reconnection window and exit paths\]

| From | Event / Trigger | Guard | To | Actions |
| --- | --- | --- | --- | --- |
| — | Player joins room (socket connect) | Valid signed session cookie in handshake | **CONNECTED** | Bind `socket.data.userId`; join Socket.io room; emit `user_joined` |
| **CONNECTED** | Socket disconnect detected (the player's last socket in the room closed, or a client that pings stopped pinging for 30 s) | Player is still seated in a game being played (not over) | **DISCONNECTED** | Start 30-second server-side `setTimeout` keyed by `userId`; set the player's `connected = false`; emit `player_disconnected` to room; other players see indicator |
| — | Game starts | The player has no socket in the room | **DISCONNECTED** | As above, right after the game's opening events, so a game never waits on someone who never shows up |
| **CONNECTED** | Player sends `leave_game` (intentional quit) | — | **QUIT** | Set `room_members.left_at`; emit `user_left` (`reason: "voluntary"`) to room; trigger player-drop game logic; player cannot rejoin as a player (may rejoin as a spectator) |
| **DISCONNECTED** | Player reconnects (socket reconnect) | Session still valid; timer still running; `clearTimeout` | **RECONNECTED** | Send `game.toPlayerView(userId)` (own hand only) via `state_snapshot` to reconnecting socket, then the pending prompt; emit `player_reconnected` to room; indicator cleared. The client's `join_game` with `last_seq_seen` then gets the missed events replayed from `game_events` |
| **DISCONNECTED** | Player sends `leave_game` while socket is down | Server receives leave event on reconnect before timer clears | **QUIT** | Treat as explicit quit; clear timer; trigger player-drop game logic |
| **DISCONNECTED** | 30-second timer fires | Player has not reconnected | **TIMED OUT** | Treat as quit; trigger player-drop game logic; emit `user_left` (`reason: "timeout"`) to room; set `room_members.left_at` |
| **RECONNECTED** | Continues playing | — | **CONNECTED** | Normal gameplay resumes |
| **QUIT** | — | — | (terminal) | Player removed permanently; cannot re-enter this game |
| **TIMED OUT** | — | — | (terminal) | Same as QUIT; player-drop game logic applied |

**Player-drop game logic** (triggered from QUIT or TIMED OUT):

1. Current round is voided
2. Remaining player count checked
3. If ≥ 3 players remain: re-deal to remaining players for the same round number
4. If exactly 2 players remain: emit `continue_or_end_request` prompt to both; await mutual decision
5. If ≤ 1 player remains: game ends as INCOMPLETE automatically (`drop_reason` is the drop's own: `player_quit` or `player_timeout`)

A dropped player's `game_results` row (written when the game ends, however it ends) has `outcome = incomplete`, their own `drop_reason`, and their score and rounds played when they left.

## Special Cases

**Two-player edge case:** When dropout reduces a game to exactly 2 players, the server emits `continue_or_end_request` to the room (with `decision_deadline`). Both must confirm within 60 seconds. If both choose continue, the voided round is re-dealt for 2 players at the same round number. If either chooses end, or the timeout expires, the game transitions to INCOMPLETE (`drop_reason = 'mutual_end'`) with `outcome = incomplete` for both. The room then enters COMPLETING. A player who reconnects while the decision is pending gets the request again after `state_snapshot`. If one of the two drops meanwhile, one player is left and the game ends as INCOMPLETE.

**Game time limit:** A game may run for at most 3 hours from start. The server sets one timer when the game starts. At 2 h 45 min it broadcasts `game_time_warning`; at 3 hours it abandons the game from whatever phase it is in (the round in progress is not scored), records it incomplete with `drop_reason = 'time_limit'` and no winner, and broadcasts `game_abandoned` (`reason: "time_limit"`). The timers are cleared if the game ends first. The limit also guarantees a game ends before the players' sessions do: entering a room or starting a game requires more than 24 hours left on the session.

**Host leaves before game starts:** The game engine is not involved. The server queries `room_members` ordered by `join_order ASC` where `role = 'player'` and `left_at IS NULL` and promotes the first result as the new host. Spectators are never promoted. `rooms.host_user_id` is updated and `host_changed` is broadcast. If no players remain, the room closes.

**All-Jester trick:** No special branch in code. Trick resolution applies the priority rules — with no Wizards, no trump, and no suited cards, the first Jester played wins. The lead player wins the trick. `winningCardType = jester` is recorded.

**Wizard flip — trump declaration sequence:**

1. Round enters TRUMP DETERMINATION; server emits `trump_selection_request`
2. All players see the prompt; dealer sees their full hand
3. Dealer selects a suit; server validates (correct user, valid suit)
4. `rounds.trump_suit` and `rounds.trump_source = declaration` set
5. `game_events` row written (event\_type: `trump_declared`; payload includes dealer hand)
6. `trump_revealed` broadcast; bidding phase begins

No timeout on trump declaration. If the dealer disconnects mid-declaration, the 30-second reconnection window applies. On reconnect, the dealer's `state_snapshot` view has `phase: 'trump_declaration'` with the dealer as `currentTurnUserId`, which re-prompts the declaration.

## State Persistence and Restore

**Checkpoint events:** Not every state transition writes to Postgres — only durable progress points. Mid-trick state is held in memory only.

| Transition | Checkpoint | What is written |
| --- | --- | --- |
| ROUND SCORING complete | Full | `games.state` snapshot; `rounds` row; `round_players` rows |
| GAME END | Full | `games.state`; `game_results`; `games.status = complete`, `games.ended_at`; `rooms.state = completing` |
| INCOMPLETE | Full | `games.state`; `game_results` with `outcome = incomplete`; `games.status = incomplete`, `drop_reason`, `player_count_at_drop`, `ended_at`; `rooms.state = completing` |
| Bid placed | Partial | `game_events` row only |
| Card played | Partial | `game_events` row only |
| Trick completed | Partial | `game_events` row only |
| Round scored, game over (`round_complete`, `game_over`) | Partial | `game_events` row (`round_completed`, `game_completed`), alongside the full checkpoints above |
| Trump declared | Partial | `game_events` row only |
| Any other event broadcast to the game's room (`game_starting`, `game_started`, `round_started`, `trump_revealed`, `all_bids_placed`, `user_joined` / `user_left`, `player_disconnected`, `player_reconnected`, `continue_or_end_request`, `game_time_warning`, `game_abandoned`) | Partial | `game_events` row only, numbered by the game's `seq` for reconnect replay |

**Reconnection restore sequence:** On reconnect within 30s: session validated → `game.toPlayerView(userId)` called (snapshot with only the reconnecting player's own hand; other players show a card count) → `state_snapshot` emitted, then the pending prompt → `clearTimeout` → `player_reconnected` broadcast to room. The client then sends `join_game` with `last_seq_seen` and gets a fresh `state_snapshot` followed by the broadcasts it missed (`game_events` rows with `seq > last_seq_seen`, at most 200). Player resumes from current state with no round rewind.

**Server restart mid-game:** The in-memory `Game` object and all timers are lost, and in-progress games are abandoned rather than resumed. Before accepting traffic, startup cleanup marks every `in_progress` game `incomplete` (`drop_reason = 'server_restart'`); clients that reconnect receive `game_abandoned` and return to the lobby. The `games.state` checkpoint is kept as a record but is not used to rebuild the game. See the Backup & Recovery Runbook.
