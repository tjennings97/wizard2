# Wizard — UI/UX Flow Diagrams

## Overview

This document maps every user-facing flow in Wizard to the states defined in the Game State Machine and the requirements in the PRD. Each flow shows the screens a user sees, the decisions they make, and the socket events or API calls that move them to the next state. Flows are ordered from first use (authentication) through a complete game to admin operations.

**How to read the flows: **Rounded rectangles are screens or UI states; diamonds are decisions; arrows are user actions or system transitions; dashed arrows are socket events broadcast by the server. Guards from the State Machine are noted in italics on the relevant decision.

## Flow 1 — Authentication

Three separate sub-flows share the landing page entry point: login, invite-code registration, and password reset. The forced credential change intercepts login when an admin has reset a user's credentials.

&#91;embedded content: authentication flow · login, registration, password reset, forced credential change\]

**Key guards: **A new login invalidates any existing session (single-session rule). Invite codes expire after 7 days; expired or redeemed codes are rejected at the server before the avatar step. Password reset has no email step — username + recovery passphrase only. An admin-triggered credential reset sets `requires_credential_change = true`; the client redirects to the forced change screen before any other navigation and clears the flag once both password and recovery passphrase are saved.

**Forced credential change screen:** One form: temporary password (from the admin), new password, new recovery passphrase (each entered twice), sent as a single `PATCH /users/me`. The new secrets must differ from the current ones. When the response comes back with `requiresCredentialChange: false` the user goes straight to the lobby; until then nothing else in the app is reachable (no lobby, no socket). A Log out button is always available.

**Re-auth prompt and signed-out notices:** When the session ends, or is about to reach its 30-day cap, the client returns to the existing login screen (no separate dialog) and shows why:

| Trigger | Login screen shows |
| --- | --- |
| `401 UNAUTHORIZED` (no session, expired, bad cookie) | Login screen, no message |
| `401 SESSION_INVALIDATED` or socket `session_error` with `reason: "displaced"` | “You signed in on another device.” |
| `SESSION_INVALIDATED` with no `reason` (session ended before reasons were recorded) | “You were signed out. Please sign in again.” |
| `reason: "logout"` | “You logged out in another tab.” |
| `reason: "password_reset"` | “You were signed out because your password was reset.” |
| `reason: "credential_change"` (changed on another device) | “You were signed out because your password or recovery passphrase was changed.” |
| `401 REAUTH_REQUIRED` (REST or socket `session_error`) — the **re-auth prompt** | “Please sign in again to continue.” with the username pre-filled and the password field focused |

The `reason` comes from REST `details.reason` or the socket `session_error`. A fatal socket `session_error` tears down the socket and applies the same mapping. For `credential_change` the client first checks `GET /users/me` (immediately, then after 1 s and 3 s): another tab on the same browser may have made the change and its new cookie may still be landing. Only a `401` there signs the user out; a network or server error keeps them signed in and reconnects the socket, whose handshake decides. The re-auth prompt is shown when the session is within 24 hours of its 30-day cap: on app load (`GET /users/me`), on any request, or when the socket connects, unless the user is an active player in a game in progress, who finishes the game first. Signing in again issues a fresh 30-day session and returns the user to the URL they were on. On app load the client does not know who the user is, so the pre-filled username is the last one that signed in on this device (kept in browser storage; left empty if storage is unavailable).

**Profile (`/profile`, from the lobby header):** Display name, password and recovery passphrase, each its own form. Changing the password or passphrase asks for the current password and signs out every other device (they see the `credential_change` notice above); this device stays signed in on a new session and its socket reconnects. The recovery passphrase must differ from the password. A new display name shows up straight away in lobby presence and in an open room's member list; a game in progress keeps the name it started with. Username is shown but cannot be changed. The avatar picker is added with the avatar system.

## Flow 2 — Lobby

The lobby is the default screen for any authenticated user not in a game. All active rooms and the live presence list are pushed in real time via Socket.io.

&#91;embedded content: lobby flow · room listing, presence, four actions\]

**Constraints: **A user already in a game (as player or spectator) cannot open or join another room — the lobby disables those actions. COMPLETING and CLOSED rooms are not shown. Spectators joining an in-progress game see the board but never receive hand data (`hand_dealt` is player-specific only).

## Flow 3 — Room & Pre-Game

This flow covers the waiting room from entry through game start. Host and non-host players see different controls.

**Entry:** Player joins from lobby → `user_joined` broadcast → all members see updated player list and avatars. Join order is shown.

**Host controls (only the host sees these):**

| Control | Options | Notes |
| --- | --- | --- |
| Round count | 1 – floor(60 / playerCount) | Selector updates live as players join/leave |
| Bid rule | Open bidding (default) / Uneven | Uneven: dealer’s bid cannot make sum equal trick count |
| Start game | Button enabled when ≥ 3 players | Disabled below 3 players; grayed with count shown |

**Host transfer:** If the host leaves before the game starts, or is disconnected for 2 minutes, the role passes automatically to the next player by join order (for a disconnect, the next connected player; the old host stays as a player). The new host is notified via `host_changed`; no page reload required.

**Room timeout:** If the game has not started within 10 minutes of the room opening, the server fires `room_closed` and all members are returned to the lobby.

**Game start sequence:**

1. Host taps Start → server validates ≥ 3 players, room is OPEN
2. Room transitions to IN PROGRESS; 10-minute timer cancelled
3. Server emits `game_starting` to room, then `round_started` with trump card info, then `hand_dealt` to each player individually
4. All players are taken to the Game board; spectators remain in observer view
5. Host role dissolves — no elevated control during the game

**Chat** is available from the moment the room opens and persists for the room’s lifecycle. It is not stored after the room closes.

## Flow 4 — Round Setup: Trump Determination

At the start of every round the server flips the top card of the remaining deck. The card type determines which of four paths is taken before bidding begins.

&#91;embedded content: trump determination · 4 paths from flip to bidding\]

**Path details:**

| Flip result | Trump | UI shown |
| --- | --- | --- |
| Suited card | Card’s suit | Trump indicator updated for all |
| Jester | None | “No trump this round” banner |
| Wizard | Dealer declares | Dealer sees a suit-selection prompt; others see “Waiting for dealer” |
| No card (60 ÷ players = 0) | None | Silent — no flip, no prompt |

After any path resolves, `trump_revealed` is broadcast and the Bidding Phase begins.

## Flow 5 — Bidding Phase

Bidding proceeds in seat order starting left of the dealer. Each player bids 0 to N (the round number = number of tricks this round). The scoreboard shows all bids placed so far.

&#91;embedded content: bidding phase · bid order, last-bidder constraint, trick phase entry\]

**Uneven rule:** When the host chose Uneven bidding, the last bidder’s UI blocks any bid that would make the total equal the trick count. The forbidden bid is shown greyed-out. All other bids remain valid.

**Scoreboard during bidding: **Running totals update live. Each player’s row shows their bid once placed; the current bidder is highlighted.

## Flow 6 — Trick Phase

For each of the N tricks in the round, the play loop runs until all players have played a card, then resolves a winner.

**Trick play loop:**

1. Lead player identified (left of dealer for trick 1; winner of previous trick thereafter)
2. `play_request` emitted to the active player; all others see “waiting”
3. Active player plays a card from their hand
   - **Guard:** Card must be in hand. If the player holds cards of the led suit, they must follow suit. Jester and Wizard may always be played.
   - Invalid play is rejected server-side; client shows an error and re-prompts
4. `card_played` broadcast to room (hand size decrements for that player)
5. If more players remain: advance to next player, return to step 2
6. When all players have played: resolve the trick

**Trick resolution (server-side, no UI input needed):**

| Priority | Winner |
| --- | --- |
| 1st | First Wizard played |
| 2nd | Highest trump card |
| 3rd | Highest card of the led suit |
| 4th | First Jester (all-Jester trick) |

`trick_complete` broadcast with winner and winning card type. `tricksWon` increments for the winner. Scoreboard shows live over/under status (e.g. “Bid 3 — Won 1 — Need 2 more”).

**After each trick:** If more tricks remain, winner leads the next trick (return to step 1). When all N tricks are played, `round_complete` is emitted and the Round Scoring flow begins (Flow 7).

**Suit-follow display:** Playable cards are highlighted; unplayable cards are dimmed. Jester and Wizard are always selectable.

## Flow 7 — Round End & Scoring

After all N tricks are played, the server computes scores and decides whether to start the next round or end the game.

**Scoring rules applied (per player):**

| Result | Score |
| --- | --- |
| Exact bid | +20 + (10 × tricks won) |
| Overbid | −10 × (tricks over bid) |
| Underbid | −10 × (tricks under bid) |

Scores may go negative. Results written to `round_players`; `games.state` checkpoint written.

**UI shown after `round_complete`:**

- Full round summary: each player’s bid, tricks won, score delta, and cumulative score
- Full scoreboard popup available (round-by-round breakdown for all past rounds)
- Players see their updated hand (empty) and the scoreboard

**Branch: more rounds?**

- `currentRound < config.roundCount` → next round begins (dealer rotates; deck shuffled; N+1 cards dealt; return to Flow 4)
- `currentRound === config.roundCount` → Game End (Flow 8)

## Flow 8 — Game End

The final round’s scores trigger the game end sequence.

**Sequence after final scoring:**

1. `game_results` written to DB; `games.status = complete`; `game_over` broadcast
2. Winner(s) announced — tied players are co-winners
3. Full scoreboard displayed (round-by-round breakdown)
4. 30-second countdown timer starts and is visible to all
5. Players may leave manually before countdown ends
6. On countdown expiry: all remaining users sent to lobby; room transitions to COMPLETING → CLOSED

**Incomplete game:** If the game ended due to player drop (`outcome = incomplete`), a banner explains why. No winner is declared. Partial per-round stats are still recorded.

## Flow 9 — Player Drop & Edge Cases

Three events can remove a player from an active game: socket disconnect (with a 30-second reconnect window), explicit quit, and timeout. All paths converge at a “players remaining” decision.

&#91;embedded content: player drop · disconnect/reconnect, quit, drop to 2 players\]

**Reconnection window:** A disconnected player has 30 seconds to reconnect (validated against their session token). During this window, other players see a disconnect indicator and the game pauses for that player’s turn. A page refresh counts as disconnect + reconnect — the server timer is authoritative.

**Drop to ≥ 3 players:** Current round voided; re-dealt to remaining players for the same round number. Scores from prior rounds are kept.

**Drop to exactly 2 players:** Both remaining players receive `continue_or_end_request`. They have 60 seconds to respond. If both choose continue, the round is re-dealt for 2 players. If either chooses end, or the timeout expires, the game ends as INCOMPLETE.

**Drop to ≤ 1 player:** Game ends as INCOMPLETE automatically.

**Host leaves before game starts:** The host role transfers to the next player by join order. `host_changed` broadcast. If no players remain, the room closes.

## Flow 10 — Admin Panel

The admin panel is a protected section of the main application, accessible only to users with the admin role. It is not a separate app.

**Invite management flow:**

1. Admin navigates to Admin Panel (role-checked by middleware)
2. Admin enters optional recipient label and clicks Generate Code
3. Code displayed once — admin copies and shares out-of-band (text, voice, etc.)
4. Code record stored: label, created, expiry (7 days), status = pending
5. Admin can revoke any pending invite at any time (status → revoked)
6. Expired unclaimed codes auto-transition to expired status; cannot be redeemed

**Invite table columns:** Code · Label · Created · Expires · Status (pending / accepted / expired / revoked)

**Role management flow:**

1. Admin views user list
2. Selects a user → Upgrade to Admin
3. Confirmation prompt → role updated
4. Admin cannot remove their own admin role (lockout prevention); another admin must do so

**Account reset flow (when user loses both credentials):**

1. Admin locates user record
2. Admin sets a temporary password and recovery passphrase
3. Temporary credentials returned once in the response (never stored in plaintext)
4. `requires_credential_change = true` flag set on the user record
5. On the user’s next login, the client intercepts and forces the credential change screen before any other navigation (see Flow 1). The server enforces this too: until the change is made, every route except `GET /users/me`, `PATCH /users/me` and logout returns `403 CREDENTIAL_CHANGE_REQUIRED`
6. Flag clears once both password and recovery passphrase are updated

**Security:** All admin routes are protected by role-check middleware. Admin panel is part of the main React app, not a separate service.
