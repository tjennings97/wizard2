# Remaining Work — Session Prompts

Paste-ready prompts for the remaining Claude Code sessions. Each prompt is one session and one PR. They are listed in the suggested order; the "Depends on" line says what must be merged first.

These prompts deliberately do not restate spec details (event names, payloads, column lists, layer counts). The docs in `docs/` own those. A prompt only says *what* to build and *which doc section* governs it, so the prompts don't go stale when a spec changes.

## Shared preamble (every prompt starts with this)

Every prompt below begins with "Follow the preamble in `docs/development/remaining-work.md`." It means:

1. Read `CLAUDE.md` and the "Ground rules" section of `docs/development/auth-follow-ups.md`. Reuse the helpers listed there; don't re-implement them.
2. The docs in `docs/` are the source of truth. Ignore copies elsewhere (for example Claude Docs). Take every socket event name and payload from `docs/api/websocket-events.md`. If you need an event or field that isn't there, add it to that doc in the same PR.
3. If the work changes behaviour a doc specifies, update that doc in the same PR.
4. Items marked **Decision needed** are the project owner's call. Stop and ask before building that part.
5. Tests are part of the work: Jest for engine and socket logic (`*.test.ts`, `*.int.test.ts`), pytest in `tests/api/` for REST endpoints. Run the full suite and typecheck before finishing.
6. Work on a branch, open one PR to `master`, and tick off the matching items in `auth-follow-ups.md` if the PR completes any.

---

## 0. Finish Lobby & Rooms (Phase 5)

**Depends on:** nothing. Most of this is already in the working tree, uncommitted.

```
Follow the preamble in docs/development/remaining-work.md.

The lobby and room system (Phase 5) is mostly built but uncommitted, and a
stash pop left conflicts. Finish it and open the PR.

1. Resolve the conflicts:
   - .gitignore: keep the lines from both sides (.venv/, __pycache__/,
     .pytest_cache/, *.pyc).
   - docs/api/websocket-events.md (Lifecycle Summary, Connect row): keep the
     "Updated upstream" version, which documents session_error codes and
     REAUTH_REQUIRED.
2. Audit the work in progress against the specs and fill any gaps:
   - Lobby and room events in docs/api/websocket-events.md (lobby_snapshot,
     rooms_updated, presence_updated, room_snapshot, user_joined, user_left,
     host_changed, room_config_updated, room_closed, spectator mode).
   - Room state machine in docs/architecture/game-state-machine.md: OPEN →
     CLOSED via the 10-minute timer, all players leaving, or host close; host
     transfer by join order.
   - Room routes in docs/api/openapi-spec.md, with requireAuth +
     requireSessionRunway on create, join and start (auth-follow-ups §3).
   - Limits: 3–10 players, 5 spectators.
   - Socket session auth (auth-follow-ups §1, items 1, 2 and 4): cookie
     handshake, REAUTH_REQUIRED on connect, displaced sockets receiving
     SESSION_INVALIDATED through an in-process notification seam. Item 3
     (re-auth on game actions) belongs to prompt 2.
   - Frontend: Lobby (live room list, presence, create room) and Room (players
     in join order, spectators, host controls for round count and bid rule,
     Start enabled at 3+ players). Start may call the start endpoint but must
     not wire the engine yet.
3. Make sure the tests cover §1's "Done when" list (apart from the game-action
   item) and §3's pytest cases.

Do not wire the game engine.
```

## 1. CI pipeline

**Depends on:** 0.

```
Follow the preamble in docs/development/remaining-work.md.

Build the PR CI workflow described in auth-follow-ups §6 and the "CI — GitHub
Actions" section of docs/operations/deployment-infrastructure.md:
.github/workflows/ci-pr.yml with Postgres 16, npm ci, typecheck, Jest (unit
and integration configs), migrations, the server started with
NODE_ENV=test TRUST_PROXY_HOPS=1 PORT=3100 and polled on /health, then
pytest tests/api.

Decision needed (auth-follow-ups §10): npm audit currently flags vite/esbuild.
Ask whether to upgrade vite to 6.4.4+ or audit production deps only
(--omit=dev) before adding the audit step.

Do not build ci-perf.yml or ci-smoke.yml.
```

## 2. Game: start, trump and bidding (Phase 6a)

**Depends on:** 0, 1.

```
Follow the preamble in docs/development/remaining-work.md.

Wire the game engine (server/src/engine/) to the socket layer, from Start
Game through the end of bidding. The engine stays pure; all I/O is in the
socket layer.

Governing docs: docs/architecture/game-state-machine.md (game lifecycle,
round phases), docs/api/websocket-events.md (game, round, trump and bidding
events, and the envelope with seq), docs/product/game-rules.md (trump
determination, bid rules).

Build:
1. Start: host starts from the room (POST /rooms/{roomId}/start and/or the
   socket flow the docs specify). Create the Game from the room config,
   create the games row, move the room to IN PROGRESS, broadcast the start
   events. The route and its checks exist (RoomService.startGame) but end in
   a temporary 501 NOT_IMPLEMENTED: replace that, and remove the 501 notes
   from docs/api/openapi-spec.md.
2. Deal and trump: send each hand only to that player's socket, never to the
   room. Handle every trump case in game-rules.md: suited card, Jester (no
   trump), Wizard (dealer is asked to choose via trump_selection_request /
   select_trump), and the last round with no flip.
3. Bidding: bid_request to the current bidder; validate place_bid (current
   player, legal value, the uneven rule for the dealer when configured); reply
   invalid_bid_error on failure; broadcast bid_placed, then all_bids_placed.
4. Event log: append each game event to game_events with its seq, as
   data-model.md describes. Reconnect replay (prompt 4) depends on this.
5. Session refresh on game actions (auth-follow-ups §1 item 3): call
   authenticateToken on select_trump / place_bid, throttled per socket.
6. Spectators get every broadcast event but never hand data. Use
   game.toPlayerView / toSpectatorView for anything state-shaped.

Do not write games.state on every event. It is written after each round, as
a record (prompt 3).

Frontend (Game page, functional): own hand, trump card or "no trump",
opponents with their bids, a trump picker when asked, and a bid input when
it's your turn, with invalid_bid_error shown inline. Mobile layout per
CLAUDE.md (hand at the bottom, trick in the middle, opponents on top).

Stop after all_bids_placed; trick play is the next session.
```

## 3. Game: tricks, scoring and game end (Phase 6b)

**Depends on:** 2.

```
Follow the preamble in docs/development/remaining-work.md.

Continue from bidding: trick play through end of game.

Governing docs: docs/architecture/game-state-machine.md (trick phase, round
end, game end, room COMPLETING → CLOSED), docs/api/websocket-events.md
(trick-playing and game-end events), docs/product/game-rules.md (follow-suit,
trick resolution, scoring), docs/architecture/data-model.md (games, rounds,
round_players, game_results).

Build:
1. play_request to the current player; validate play_card (their turn, card
   in hand, follow-suit legality from the Ruleset); reply invalid_play_error
   on failure; broadcast card_played.
2. When the trick is full, resolve it and broadcast trick_complete; the winner
   leads next.
3. After the last trick: score, broadcast round_complete, persist rounds and
   round_players, and write the games.state checkpoint (toGameState) as a
   record. Then deal the next round, reusing prompt 2's flow.
4. After the final round: write game_results, set the game's final status,
   broadcast game_over, move the room to COMPLETING, start the 30-second
   countdown, then close the room (room_closed) and return everyone to the
   lobby. Handle "all users leave before the countdown ends".
5. Keep the event log and session refresh from prompt 2 for play_card.

Frontend: playable hand (only legal cards enabled, touch targets ≥ 44px),
current trick, tricks won against bid per player, a running scoreboard,
round-end summary and the game-over screen with a countdown.

Out of scope here (prompt 4): disconnects, quits, player drop, time limit,
server restart.
```

## 4. Game: disconnects, quits, drops and limits (Phase 6c)

**Depends on:** 3. Decide the migration strategy (prompt 11, OD-2) before deploying this, because it writes the drop reasons added by migration 006.

```
Follow the preamble in docs/development/remaining-work.md.

Implement the connection and player-drop behaviour from CLAUDE.md "Key
Behaviors", docs/architecture/game-state-machine.md (Special Cases) and
docs/api/websocket-events.md (Lifecycle Summary, Error Recovery, Idle &
Timeout Policy).

Build:
1. Disconnect is not a quit: broadcast player_disconnected and hold the seat
   for 30 s with a timer keyed by userId.
2. Reconnect within the window: join_game with last_seq_seen → validate the
   session → state_snapshot built from game.toPlayerView(userId) (never the
   raw GameState) → replay events with seq > last_seq_seen from game_events
   → broadcast player_reconnected. Also handle sync_request and ping/pong per
   the doc.
3. Window expiry: user_left with reason "timeout", then the player-drop rules.
4. Voluntary quit (leave_game or POST /rooms/{roomId}/leave): user_left with
   reason "voluntary", player-drop rules, and the player cannot rejoin as a
   player (spectator is allowed).
5. Player drop: void the current round and re-deal to the remaining players.
   At 2 players: continue_or_end_request to both, choose_continue_or_end,
   60 s timeout; end or timeout → incomplete, game_results outcome incomplete,
   room COMPLETING.
6. 3-hour limit: auth-follow-ups §2 (game_time_warning at 2 h 45 m,
   game_abandoned with reason "time_limit" at 3 h, timers cleared on any
   other ending).
7. Server restart: startup cleanup in server/src/index.ts marks every
   in_progress game incomplete with drop_reason 'server_restart' before the
   server accepts traffic; a client reconnecting to such a game gets
   game_abandoned and returns to the lobby (auth-follow-ups §7,
   docs/operations/backup-recovery.md).

Frontend: "reconnecting…" state, disconnected badges on opponents, the
continue/end prompt, time warning banner, abandoned-game message.

Tests: fake timers for the 30 s window, the 60 s prompt and the 3 h limit;
socket integration tests for reconnect with replay and for a drop to 2
players.
```

## 5. Client auth flows and profile

**Depends on:** 0. Settle the avatar decision (prompt 7) first, or do registration without the avatar picker and add it in prompt 7.

```
Follow the preamble in docs/development/remaining-work.md.

Build auth-follow-ups §5 (client auth flows) and §4a (PATCH /users/me),
following docs/product/ui-ux-flows.md and docs/api/openapi-spec.md.

Server (§4a): PATCH /users/me for display name and for password/passphrase
change, with currentPassword verification, rotateSession on a secret change,
clearing requires_credential_change only after both secrets changed, mounted
with authenticate({ allowDuringCredentialChange: true }). pytest per §4a/§4b
"Done when" (the admin reset part can use a seeded flagged user until
prompt 6 lands).

Client: register (invite code), reset password, the forced change-password
flow before any other navigation, the /profile page (display name, password,
passphrase), and the 401/session_error mapping table in §5
(UNAUTHORIZED, SESSION_INVALIDATED, REAUTH_REQUIRED with the username
pre-filled). Login.tsx and AuthContext already exist; extend them.

Add the re-auth prompt to docs/product/ui-ux-flows.md.
```

## 6. Admin panel

**Depends on:** 5.

```
Follow the preamble in docs/development/remaining-work.md.

Build the admin panel: routes under /api/v1/admin (docs/api/openapi-spec.md)
and the /admin page. Every admin route checks req.user.role === 'admin'.

1. Invites: auth-follow-ups §4c (128-bit codes, only sha256 stored, raw code
   shown once, 7-day expiry, optional label, revoke, list with status).
2. Roles: promote a user to admin; an admin cannot remove their own admin
   role (see the PRD and use cases for the exact rules).
3. Credential reset: auth-follow-ups §4b (temporary credentials returned
   once, never stored in plaintext; requires_credential_change = true;
   invalidateUserSessions).

Frontend: plain tables and forms, mobile-friendly. Show a new invite code or
temporary credential once, with a copy button.

Tests: pytest per §4b and §4c "Done when", including 403 for non-admins and
the full invite → register flow.
```

## 7. Avatar system

**Depends on:** 5. **Decision needed first:** auth-follow-ups §8, "client-supplied avatar SVG". The recommended option is assumed below; change the prompt if you choose otherwise.

```
Follow the preamble in docs/development/remaining-work.md.

Implement the avatar system per docs/architecture/avatar-system.md: four
layers (head, skin, face, hair), each value a slug that maps to a frontend
SVG layer asset, stored in users.avatar_config.

Decision (owner chose the recommended option in auth-follow-ups §8): the
server no longer accepts or stores client SVG.
- New migration dropping users.avatar_svg; stop accepting avatarSvg on
  register and PATCH /users/me.
- Validate every slug against the app's option list (shared from one module
  so client and server agree); reject anything else with 400
  VALIDATION_ERROR.
- Update avatar-system.md, data-model.md, openapi-spec.md, prd.md and
  system-architecture.md, which all describe the cached SVG.

Build:
1. Placeholder SVG layer files for each option under client/src/assets/
   (option counts per avatar-system.md).
2. Avatar component that stacks the four layers with position: absolute in a
   fixed-size container, with a fallback for a null config.
3. Avatar picker at registration and on /profile.
4. Show avatars in the lobby presence list, room player list, game seats and
   scoreboard.

Tests: pytest from §8 "Done when" (markup in avatarSvg is never stored or
returned; ../x, <svg>, Round are rejected).
```

## 8. Bug reporting

**Depends on:** 0. Better after 3, so game context can be captured.

```
Follow the preamble in docs/development/remaining-work.md.

Implement bug reporting: POST /api/v1/bug-reports (docs/api/openapi-spec.md)
storing a row as described in docs/architecture/data-model.md
"Data Dictionary — bug_reports".

- The client sends the description, optional severity and its current
  context (URL, room and game ids). The server adds userId, traceId (from
  the session via requestTraceId), user agent, timestamp and, if the user is
  in an active game, a game.toPlayerView(userId) snapshot. Never store other
  players' hands.
- Log at INFO with traceId, per docs/operations/observability-alerting.md
  "Correlating a bug report with server logs". Increment bug_reports_total if
  the metrics registry exists (prompt 10); otherwise leave a TODO.
- Frontend: a "Report a bug" button reachable on every screen (no hover-only
  affordance), a short form, and a confirmation message.

pytest: create a report, required fields, auth required, context captured.
```

## 9. Chat

**Depends on:** 0.

```
Follow the preamble in docs/development/remaining-work.md.

Implement room and game chat: send_chat_message → chat_message, per
docs/api/websocket-events.md and the PRD / UI flows for who can send and see
chat (players and spectators), length limits and any rate limiting. Validate
and trim on the server. React must render the text as text, never as HTML.

Frontend: Chat component in the room and game pages that doesn't cover the
hand on mobile (docs/product/ui-ux-flows.md).

Tests: socket integration test for send/receive, rejection of empty or
oversized messages, spectator behaviour per spec.
```

## 10. Observability

**Depends on:** 3, so the game metrics have something to count.

```
Follow the preamble in docs/development/remaining-work.md.

Implement docs/operations/observability-alerting.md (Structured Logging,
Metrics Registry, Metric update points) and auth-follow-ups §9.

1. Request-logging middleware with the CLAUDE.md log fields, using
   requestTraceId(req). Never log bodies or tokens. Add roomId and gameId to
   socket-event logs.
2. prom-client registry with every metric in the Metrics Registry, updated at
   the listed points (HTTP, sockets, reconnections, games, rooms, players,
   bug reports, DB).
3. GET /api/v1/metrics protected by the Prometheus bearer token from
   config.ts.
4. Security events from §9 (login failures, rate-limit hits, reset attempts)
   as metrics and/or log lines.

Document the Grafana Cloud setup steps the owner must do by hand; don't try
to configure Grafana from code. Tests: /metrics returns 401 without the
token and Prometheus text with it; counters move on the instrumented paths.
```

## 11. Deployment and operations

**Depends on:** 1. Must be settled before prompt 4 reaches production.

```
Follow the preamble in docs/development/remaining-work.md.

Work through auth-follow-ups §7 with docs/operations/deployment-infrastructure.md.

Decision needed (OD-2): how migrations run in production (Railway pre-deploy
command vs. manual) and whether they are forward-only. Ask first, then
implement the chosen approach and record the decision in the deployment doc.

Also:
- Make sure the Railway build uses Node 20+ (engines.node / build settings).
- Write a short checklist for the owner to verify proxy trust after deploy
  (req.ip is the client IP; rate limits are per client; adjust
  TRUST_PROXY_HOPS).
- Production serving: Express serves the built client from the same service,
  HTTP → HTTPS redirect, CORS limited to the production origin.
- Document provisioning the smoke_test account.
```

## 12. Security hardening

**Depends on:** 0.

```
Follow the preamble in docs/development/remaining-work.md.

Work through auth-follow-ups §8 except the avatar item (prompt 7) and the
breached-password check (deferred by the owner):
- HSTS and standard headers (helmet), production only where appropriate;
  make sure helmet's CSP doesn't break Vite assets or the socket connection.
- CSRF: enforce Content-Type: application/json on every state-changing route
  (415 otherwise), then write up the conclusion and update the gap table in
  docs/architecture/security.md.
- Rate limits readable from optional env vars, current values as defaults
  and minimums.
Also fix the openapi-spec.md dev server port (3001 → 3000, §10).

pytest: HSTS header present in production mode; non-JSON POST rejected.
```

## 13. UI polish

**Depends on:** 3, 4, 7. Can be split into several sessions (lobby/room, game board, transitions).

```
Follow the preamble in docs/development/remaining-work.md.

Bring the functional pages up to the design specs:
docs/design/ui-foundation.md (tokens, typography, components),
docs/design/animation-transitions.md (deal, play, trick win, round end,
reduced-motion handling) and docs/product/ui-ux-flows.md.

- Global tokens and mobile-first CSS in client/src/styles; min-width media
  queries, 375px minimum, touch targets ≥ 44×44px, no hover-only affordances.
- Game board: vertical single column on mobile; table-surround layout on
  desktop.
- Card, Scoreboard and Avatar presentation per the brief.
- Respect prefers-reduced-motion.

Check each screen at 375px and at desktop width with the run skill or
Playwright screenshots. Don't change server behaviour.
```

## 14. E2E, performance and smoke tests

**Depends on:** 4, 11. Can be split into three sessions.

```
Follow the preamble in docs/development/remaining-work.md.

Implement the automated suites in docs/testing/test-plan.md and
"Test Automation Execution" in docs/operations/deployment-infrastructure.md:

1. Playwright E2E covering the use-case matrix rows marked E2E (multi-browser-
   context games, spectator, reconnect, mobile viewport), added to
   ci-pr.yml.
2. k6 performance tests against the Performance Test Criteria, with
   ci-perf.yml on a schedule and results sent to Grafana per
   observability-alerting.md "k6 Performance Test Metrics".
3. The prod smoke suite (S-xx) and ci-smoke.yml, using the smoke_test account.

List every secret the workflows need so the owner can add them in GitHub.
```
