# Wizard Card Game – Use Case Document

Oct 21, 2026 · @TJ

## Introduction

This document defines every significant interaction between users and the Wizard card game system, serving as the authoritative reference for feature scope, QA test planning, and API contract validation.

**Scope.** Covers all use cases from player registration through end-of-game scoring, including lobby management, real-time gameplay, spectator access, disconnect recovery, and server-side error handling. Out of scope: payment flows, third-party OAuth integration internals, and backend infrastructure provisioning.

**Relationship to other planning documents.**

| Reference document | How this document uses it |
| --- | --- |
| PRD | Source of prioritized features; each use case maps to a PRD requirement ID |
| Game State Machine | Preconditions and postconditions reflect valid state transitions (e.g. `LOBBY → IN_ROUND`) |
| OpenAPI Spec | Each use case names the endpoint(s) it invokes; request/response shapes are not repeated here |
| UI/UX Flow Diagrams | Trigger events and success paths align with the screen flows; edge cases extend them |

**Document conventions.** Each use case entry includes: ID, name, actors, precondition, trigger, main success scenario, extensions (alternate/error flows), and cross-references to the State Machine and OpenAPI spec.

## Actors & Roles

| Actor | Description | Authenticated? |
| --- | --- | --- |
| Registered Player | Full account; game history, stats, and friend lists persisted | Yes |
| Unregistered User | Person who has received an invite link but has not yet created an account; limited to the registration flow only | No |
| Host | A Registered Player who created the game room; controls start, kick, and settings | Yes |
| Spectator | Registered Player observing an in-progress game without participating | Optional |
| System / Server | Backend services handling game logic, state transitions, and WebSocket events | N/A |

All human actors except Unregistered Users must be authenticated (Registered Player) before entering the lobby. An Unregistered User becomes a Registered Player upon completing registration via an invite link (UC-26). The System actor is referenced in use cases that describe automated actions (deal cards, advance round, resolve trick) driven by game logic rather than a user gesture.

## UC-01 through UC-05: Player Registration and Authentication

**UC-01 Register Account** · Actors: Unauthenticated User, System · Pre: unauthenticated, invite code unused · Trigger: registration form submitted · Main: validate inputs, create account, issue session token, redirect to lobby · Ext: 1a email taken 409 prompt login; 1b weak password inline error · State: UNAUTHENTICATED to AUTHENTICATED · API: POST /auth/register

**UC-02 Log In** · Actors: Registered Player, System · Pre: account exists and verified · Trigger: login form submitted · Main: validate credentials, issue an HTTP-only session cookie (invalidating any prior session), land on lobby · Ext: 1a bad credentials 401 generic error; 1b 5 failed attempts 403 cooldown message · State: UNAUTHENTICATED to AUTHENTICATED · API: POST /auth/login

**UC-04 Log Out** · Actors: Registered Player, System · Pre: authenticated and not in active game · Trigger: user clicks Log out · Main: System invalidates the session, clears the session cookie, returns to landing screen · Ext: 0a mid-game UI warns Leaving forfeits your seat, · State: AUTHENTICATED to UNAUTHENTICATED · API: POST /auth/logout

**UC-05 Edit Profile** · Actors: Registered Player, System · Pre: authenticated · Trigger: user submits profile settings changes · Main: System validates display name uniqueness, persists changes, UI updates immediately · Ext: 1a name taken 409 prompt alternate · State: no transition · API: PATCH /players/{playerId}

**UC-26 Redeem Invite and Register** · Actors: Unregistered User, System · Pre: Admin has issued an invite code via UC-09 ; invite code is valid and not expired · Trigger: Unregistered User clicks the Register button on the home page · Main: UI presents a lightweight registration form (invite code, username, password only); on submit, System checks validity of invite code. If code is valid, System creates account, marks invite consumed, issues session token, and places the new Registered Player directly into the invited game room in LOBBY state · Ext: 1a invite code expired (default 7 days) → 410, UI prompts Host to resend; 1b username taken → 409, inline prompt for alternate; 1c game already started when user completes registration → player joins as Spectator (UC-19) · State: UNREGISTERED USER to AUTHENTICATED, then IN LOBBY · API: GET /invites/{token} (validate); POST /auth/register-via-invite

## UC-06 through UC-10: Lobby and Game Setup

**UC-06 Create Game Room** · Actors: Host (Registered Player), System · Pre: authenticated, not in another active game · Trigger: Host clicks Create Game · Main: Host sets room name, Host sets room name, round count, and bid total rule (open or uneven); System creates room in LOBBY state and returns a join code; Host is placed in the room as first seat · Ext: 0a Host already in a room, UI prompts Leave first; 3a room limit reached server-side, 409 returned · State: AUTHENTICATED to IN LOBBY · API: POST /games

**UC-07 Join Game Room (by code or browse)** · Actors: Registered Player or Unregistered User, System · Pre: room exists and is in LOBBY state; seat count below limit · Trigger: Player enters join code or selects public room from browser · Main: System validates code and seat availability, adds Player to room, broadcasts updated player list to all occupants · Ext: 1a invalid code 404; 1b room full 409; 1c game already started 403 redirect to spectate · State: AUTHENTICATED or UNREGISTERED USER to AUTHENTICATED (post-registration) then IN LOBBY · API: POST /games/{gameId}/join

**UC-08 Configure Game Settings** · Actors: Host, System · Pre: room in LOBBY state; requester is the Host · Trigger: Host updates settings panel (round count) · Main: System persists updated settings, broadcasts SETTINGS UPDATED event to all players in the room · Ext: 1a non-Host player attempts change, 403 returned, change ignored · State: stays IN LOBBY · API: PATCH /games/{gameId}/settings

**UC-09 Create Invite Code (Admin)** · Actors: Admin, System · Pre: authenticated as Admin · Trigger: Admin opens invite management in admin panel and clicks Generate Invite · Main: Admin optionally enters a label for the recipient; System generates an invite code, stores it with a 7-day expiry, and displays it once for the Admin to share out-of-band (text, voice, etc.); no in-app delivery · Ext: 1a Admin revokes a pending invite — System marks it revoked, code can no longer be redeemed · State: no transition · API: POST /admin/invites; DELETE /admin/invites/{id}

**UC-10 Start Game** · Actors: Host, System · Pre: room in LOBBY state; minimum 3 players seated · Trigger: Host clicks Start Game · Main: System transitions room to DEALING state, deals cards for round 1, broadcasts GAME STARTED event, all players navigate to game board UI · Ext: 1a fewer than 3 players, Start button disabled with tooltip; 1b a player drops between Start click and DEALING, System waits 30 s for reconnect, then treats drop as quit (current round voided and re-dealt to remaining players)  · State: IN LOBBY to DEALING · API: POST /games/{gameId}/start

## UC-11 through UC-18: Core Gameplay

**UC-11 Deal Cards** · Actors: System · Pre: game in DEALING state · Trigger: game transitions from LOBBY on Start, or from SCORING at end of previous round · Main: System deals N cards per player (N = round number), sets trump suit by turning the next deck card, broadcasts CARDS DEALT event; each player's hand is private over WebSocket · Ext: 1a deck exhausted in final round, no trump card turned, trump is NONE; 1b Jester turned up, trump is NONE; 1c Wizard turned up, System sends trump\_selection\_request to the dealer, who views their hand and names one of the four suits with select\_trump before bidding begins; all others wait; the named suit is broadcast as trump\_revealed · State: DEALING to BIDDING · API: WebSocket: round\_started (server→all) + hand\_dealt (server→player, unicast); for 1c, trump\_selection\_request (server→dealer, unicast), select\_trump (dealer→server), trump\_revealed (server→all); no REST endpoint

**UC-12 Place Bid** · Actors: Player, System · Pre: game in BIDDING state; it is this player's bid turn (clockwise from dealer) · Trigger: Player selects bid value (0 to N) and confirms · Main: System records bid, advances bid turn to next player; when all have bid, broadcasts BIDDING COMPLETE · Ext: 1a player disconnected, bidding waits for the 30 s reconnection window (UC-21); if they do not reconnect, they are treated as quit and the round is re-dealt · State: stays BIDDING until all bids placed, then to IN TRICK · API: WebSocket only — no REST endpoint for bids · WebSocket: bid\_placed (server→all), all\_bids\_placed (server→all)

**UC-13 Play Card** · Actors: Player, System · Pre: game in IN TRICK state; it is this player's turn; card is in the player's hand · Trigger: Player selects and confirms a card · Main: System validates legal play (must follow suit if able, unless Wizard or Jester); broadcasts CARD PLAYED event with card and player; advances trick turn · Ext: 1a illegal card played, System rejects with 422 and prompts retry; 1b player disconnects, their seat is held for the 30 s reconnection window (UC-21); if they do not reconnect, they are treated as quit — current round voided and re-dealt to remaining players · API: POST /games/{gameId}/tricks/current/plays · WebSocket: card\_played (server→all)

**UC-14 Resolve Trick** · Actors: System · Pre: all players have played one card in the current trick · Trigger: last card of the trick is received · Main: System applies Wizard rules to determine winner (first Wizard wins; if no Wizard, highest trump wins; if no trump, highest card of led suit); broadcasts TRICK WON event with winner; winner leads next trick · Ext: 1a all Jesters played, trick winner is the first player who played a card (per Wizard rules) · State: stays IN TRICK; after all tricks in the round, transitions to SCORING · API: WebSocket: trick\_complete (server→all)

**UC-15 Handle Wizard Card Played** · Actors: Player, System · Pre: game in IN TRICK state · Trigger: Wizard card played · Main: System records the Wizard; the first Wizard played in a trick wins it, regardless of trump or lead suit; a Wizard may always be played; next player plays normally · Ext: 1a Wizard led (or the first card after opening Jesters), no suit obligation for the rest of the trick; 1b Wizard played after a lead suit is established, the obligation is unchanged and later players must still follow that suit if they can; 1c a second or later Wizard in the trick, it does not win · State: stays IN TRICK · API: No separate endpoint; handled in UC-13 play validation and UC-14 resolution. Trump declaration after a Wizard is turned up at the deal is part of UC-11

**UC-16 Handle Jester Card Played** · Actors: Player, System · Pre: game in IN TRICK state · Trigger: Jester card played · Main: System records Jester; it never wins a trick and never sets the suit to follow; next player plays normally · Ext: 1a all players play Jester, first Jester played wins the trick; 1b Jester led, the first card played that is not a Jester decides the suit obligation (a suited card sets the suit to follow; a Wizard means none) · State: stays IN TRICK · API: No separate endpoint; handled in UC-13 play validation

**UC-17 Score Round** · Actors: System · Pre: all tricks in the round have been resolved (state transitions from IN TRICK) · Trigger: last trick of the round resolved · Main: System calculates scores (correct bid: 20 + 10 per trick taken; incorrect bid: -10 per trick over or under); broadcasts ROUND SCORED with scoreboard; UI shows round summary overlay with 10 s countdown · Ext: 1a tie in bid accuracy, no special rule, both score normally · State: IN TRICK to SCORING, then back to DEALING for next round · API: GET /games/{gameId}/scores · WebSocket: round\_complete (server→all)

**UC-18 End Game** · Actors: System · Pre: final round scored · Trigger: SCORING state reached after the last round (round count defined in settings) · Main: System broadcasts GAME OVER with final leaderboard; persists results to player histories; room transitions to COMPLETING state; UI shows final results screen with 30 s countdown; on expiry all users returned to lobby; users may leave manually before expiry · State: SCORING to COMPLETING · API: GET /games/{gameId}/results · WebSocket: game\_over (server→all)

## UC-19 through UC-22: Spectator and Session Management

**UC-19 Spectate Game** · Actors: Spectator (Registered Player), System · Pre: game exists in any active state (IN TRICK, BIDDING, etc.); room is public or Spectator has the join code; spectator count below 5  · Trigger: Spectator joins via the game browser or share link · Main: System adds Spectator to the room in read-only mode; Spectator receives the same WebSocket broadcast stream as players but their hand is hidden; scoreboard and play history are visible · Ext: 1a game in FINISHED state, Spectator sees the final results screen only; 1b private room without code, 403 returned · State: no game-state transition · API: POST /games/{gameId}/spectate

**UC-21 Reconnect After Disconnect** · Actors: Player, System · Pre: Player was seated in an active game; connection dropped · Trigger: Player reloads the page or re-opens the app within the reconnect window (30 s)  · Main: System detects returning session token, restores Player's seat, sends `state_snapshot` (the Player's own view) and replays missed events; Player continues exactly where they left off · Ext: 1a reconnect window expires, player treated as quit (`player_left`, reason timeout) — current round voided and re-dealt; 1c server restarted during the game, game abandoned, Player receives `game_abandoned` and returns to the lobby; 1b Player reconnects in a different browser, old socket closed, new one accepted · State: no transition (Player returns to whatever state the game is in) · API: WebSocket `join_game` with `last_seq_seen` → `state_snapshot`; GET /games/{gameId}/state as REST fallback

**UC-22 Leave Game Mid-Session** · Actors: Player, System · Pre: Player is seated in a game in any active state · Trigger: Player clicks Leave Game and confirms the warning · Main: System removes Player from seat broadcasts PLAYER LEFT event· State: Player moves to UNAUTHENTICATED or lobby; game continues · API: POST /rooms/{roomId}/leave

## UC-23 through UC-25: Admin and System

**UC-23 Manage Game Room (Host Controls)** · Actors: Host, System · Pre: room in LOBBY state · Trigger: Host uses the host panel to remove a player · Main: System removes the target player from the room via POST /rooms/{roomId}/leave; seat becomes available; host role is derived — the connected player with the lowest joinOrder is always treated as host, so no explicit transfer action or API call is needed · Ext: 1a Host tries to kick mid-game, action blocked with tooltip Only available in lobby; 1b only one player remains after kick, Start button disabled; 1c Host leaves the room — host role implicitly transfers to the next player by joinOrder (see UC-22) · State: no transition · API: POST /rooms/{roomId}/leave (kick); host transfer is a derived postcondition of membership change, not a stored update

**UC-24 AI Player Substitution** · Out of scope for v1. BotPlayer class is stubbed (all methods throw NotImplemented); the game engine accepts the interface but no AI logic runs. Vacant seats are resolved through the quit/disconnect flow in UC-22 and UC-21.

**UC-25 Handle API Error and Timeout Recovery** · Actors: System, Player · Pre: any active game state · Trigger: REST call returns 5xx or WebSocket connection drops unexpectedly · Main (REST 5xx): UI shows a transient error toast and retries the request up to 3 times with exponential backoff; if all retries fail, shows persistent error with Retry and Leave options · Main (WebSocket drop): client attempts reconnect every 2 s for 30 s; ; on reconnect, client fetches snapshot via GET /games/{gameId}/state and re-subscribes · Ext: 1a server returns 503 during deal or trick resolution, action is idempotent and safe to retry; 1b 60 s elapsed without reconnect, UC-21 ext 1a applies · State: no transition (game state preserved on server) · API: GET /games/{gameId}/state for snapshot · WebSocket: client sends join\_game with last\_seq\_seen; server responds with state\_snapshot (unicast) then replays missed events

## Use Case Relationships and Cross-References

The table below maps each use case to the State Machine states it touches and the primary OpenAPI endpoints it invokes.

| UC | Name | State Machine transition | Primary endpoint(s) |
| --- | --- | --- | --- |
| UC-01 | Register | UNAUTHENTICATED to AUTHENTICATED | POST /auth/register |
| UC-26 | Redeem Invite & Register | UNREGISTERED USER to AUTHENTICATED, then IN LOBBY | GET /invites/{token}; POST /auth/register-via-invite |
| UC-02 | Log In | UNAUTHENTICATED to AUTHENTICATED | POST /auth/login |
| UC-04 | Log Out | AUTHENTICATED to UNAUTHENTICATED | POST /auth/logout |
| UC-05 | Edit Profile | None | PATCH /players/{playerId} |
| UC-06 | Create Game Room | AUTHENTICATED to IN LOBBY | POST /games |
| UC-07 | Join Game Room | AUTHENTICATED to IN LOBBY | POST /rooms/{roomId}/join |
| UC-08 | Configure Settings | None (IN LOBBY) | PATCH /rooms/{roomId}/config |
| UC-09 | Invite Player | None | POST /admin/invites |
| UC-10 | Start Game | IN LOBBY to DEALING | POST /rooms/{roomId}/start |
| UC-11 | Deal Cards | DEALING to BIDDING | WebSocket: round\_started + hand\_dealt (Wizard turned up: trump\_selection\_request, select\_trump, trump\_revealed) |
| UC-12 | Place Bid | BIDDING (all bids) to IN TRICK | WebSocket only (bid\_placed, all\_bids\_placed) |
| UC-13 | Play Card | IN TRICK | WebSocket only (card\_played) |
| UC-14 | Resolve Trick | IN TRICK (all tricks) to SCORING | WebSocket: trick\_complete |
| UC-15 | Handle Wizard | IN TRICK | (handled in UC-13 validation and UC-14 resolution) |
| UC-16 | Handle Jester | IN TRICK | (handled in UC-13 validation) |
| UC-17 | Score Round | SCORING to DEALING (or FINISHED) | GET /games/{gameId} |
| UC-18 | End Game | SCORING to FINISHED | GET /games/{gameId} |
| UC-19 | Spectate | None | POST /rooms/{roomId}/join (role: spectator) |
| UC-21 | Reconnect | None | GET /games/{gameId}/state |
| UC-22 | Leave Mid-Session | None (game continues) | POST /rooms/{roomId}/leave |
| UC-23 | Manage Room (Host) | None | POST /rooms/{roomId}/leave (kick); host role derived from joinOrder — no API |
| UC-24 | AI Substitution | None (internal) | Internal only |
| UC-25 | Error Recovery | None | GET /games/{gameId}/state |

**Key include and extend relationships:**

- UC-10 Start Game includes UC-11 Deal Cards (system-triggered immediately after).
- UC-13 Play Card extends into UC-15 Handle Wizard and UC-16 Handle Jester when the relevant card is played.
- UC-14 Resolve Trick includes UC-17 Score Round after the final trick of a round.
- UC-17 Score Round includes UC-18 End Game when the scored round is the final one.
- UC-25 Error Recovery is an extend relationship on every mutating use case (UC-06 through UC-23).
