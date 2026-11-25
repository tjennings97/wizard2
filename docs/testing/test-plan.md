# Wizard — Test Plan

Oct 22, 2026 · @TJ

## Scope & Objectives

This plan covers all automated testing for the Wizard web application across frontend, backend, and real-time layers. Automation is the target for every test area; manual fallback is noted only where automation is not feasible.

**In scope**

- Authentication and account management (UC-01 through UC-05, UC-26)
- Lobby: room listing, presence, and room creation (UC-06 through UC-09)
- Room and pre-game configuration (UC-08, UC-10)
- Game engine: dealing, bidding, trick play, scoring, and end-game (UC-11 through UC-18)
- Session management: spectator mode, disconnection, reconnection, and leave (UC-19 through UC-22)
- Admin: invite management and player removal (UC-23)
- Avatar system: configuration and rendering in game and lobby flows
- Bug reporting: submission and confirmation (POST /bug-reports)
- WebSocket event delivery, ordering, and error recovery
- Performance against NFR targets defined in the PRD

**Out of scope**

- Bot/AI player behaviour (UC-24). `BotPlayer` is a V1 stub with `NotImplemented` methods; no tests are written for it.
- Password reset email delivery (external mail provider; verified by manual spot-check only)
- Grafana Cloud dashboard configuration
- Railway infrastructure provisioning

## Test Environments

Two environments are defined. There is no staging environment; pre-release tests run in CI. Each environment has a distinct test load.

| Environment | Purpose | Tests executed |
| --- | --- | --- |
| **Dev (local and CI)** | Day-to-day development and pull request checks | Unit, integration, API, WebSocket, E2E (full suite); performance on a CI schedule |
| **Prod** | Live environment | Smoke tests only (read-only or non-destructive) |

**Merge gate.** A pull request may not merge to `main` (which deploys to prod) until all unit, integration, API, WebSocket, and E2E tests pass in CI. Performance tests run on a schedule; a threshold breach must be resolved or explicitly overridden before the next release.

**Prod smoke tests** are a curated read-only subset defined in §7. They run automatically after every production deployment and may be triggered manually at any time. They create no persistent data and do not mutate game or user state.

## Tools & Frameworks

| Layer | Tool | Used for |
| --- | --- | --- |
| Unit | Jest | Game engine logic (Game, Round, Trick, Player classes); scoring; trump determination; state machine transitions |
| API | pytest + requests | REST endpoint correctness, auth flows, error catalogue responses |
| WebSocket | socket.io-client (Node.js) | Event delivery, envelope schema, seq ordering, reconnection handshake |
| E2E / Frontend | Playwright | Full user journeys in a real browser; avatar rendering; bug report submission |
| Performance | k6 | REST load (p95 latency) and WebSocket fan-out (event delivery latency under concurrent load) |

**Test data.** Each test run provisions its own isolated data (users, rooms, games) via the API before each suite and tears it down after. No shared fixture state between suites.

**CI integration.** All suites (except performance) run in CI on every pull request targeting `main`, against the app and a throwaway Postgres started in the CI job. Performance tests run on a scheduled CI pipeline against the same setup.

## Feature × Test-Type Matrix

Each cell names the tool and a brief description of what is verified. A dash means that test type does not apply to the feature.

| Feature | Unit (Jest) | API (pytest) | WebSocket (socket.io-client) | E2E (Playwright) | Performance (k6) |
| --- | --- | --- | --- | --- | --- |
| **Authentication** | Password hashing; session token generation, hashing, and sliding expiry (24h idle, 30-day cap); invite code validation logic | POST /auth/register, POST /auth/login, POST /auth/logout, POST /auth/reset-password; activity extends session expiry; 400/401/409/422/429 error codes | — | Register → login → logout full browser flow; session persistence across refresh | POST /auth/login at concurrent load; p95 < 500 ms |
| **Invite system** | Invite code generation; expiry (7-day); single-use enforcement | POST /admin/invites, GET /admin/invites, DELETE /admin/invites/{id}; 403 for non-admin | — | Admin creates invite; user redeems via UC-26 registration flow | — |
| **User profile & avatar** | Avatar config serialisation; SVG layer ordering | GET /users/me, PATCH /users/me; avatar field round-trip | — | User sets avatar parts; avatar renders correctly in lobby and in-game | — |
| **Lobby** | Room filtering logic | GET /lobby/rooms; filter by state; pagination | `room_created`, `room_updated`, `room_removed` broadcast timing and payload schema | Browse lobby; see room appear when another player creates one | GET /lobby/rooms at concurrent load; p95 < 500 ms |
| **Room management** | — | POST /rooms, GET /rooms/{id}, DELETE /rooms/{id}; host-only guards | `room_config_updated`, `host_changed`, `player_joined`, `player_left` | Create room → configure → invite players → start game | — |
| **Game engine — dealing** | Card distribution (correct count per round); deck composition | — | `round_started` payload: hand contents, trump card, trump suit | — | — |
| **Game engine — trump selection** | Trump determination logic for all four Wizard-flip cases from state machine | POST /games/{id}/trump | `trump_selected` event | — | — |
| **Game engine — bidding** | Bid validation; bid-total rule (host-configurable); per-player ordering | POST /games/{id}/bids; 400 on invalid bid; 409 on out-of-turn | `bid_placed`, `bidding_complete` ordering and seq values | Full bidding round in browser | `bid_placed` fan-out to all players; delivery < 100 ms at target concurrent rooms |
| **Game engine — trick play** | Lead-suit enforcement; Wizard/Jester rules; winning card determination; all-Jester edge case | POST /games/{id}/tricks/current/play; 400 on illegal card | `card_played`, `trick_complete`, `trick_won` ordering | Play a full round end-to-end in browser | `card_played` fan-out; delivery < 100 ms |
| **Scoring** | Per-round score calc (exact bid +20 +2/trick; miss −10/trick off); running totals; end-game ranking | GET /games/{id}/scores | `scores_updated`, `game_ended` payloads | Score table displays correctly after each round | — |
| **Session — spectator** | — | — | `join_game` with `role: spectator`; spectator receives all server→client events; cannot emit player actions | Join as spectator; observe game in progress | — |
| **Session — disconnect / reconnect** | Reconnection timer logic; `state_snapshot` built from the live game's `toPlayerView(userId)` | — | Drop connection; `player_disconnected` broadcast; reconnect within window; `state_snapshot` emit; `player_reconnected` broadcast | Simulate network drop in Playwright; verify the player continues where they left off | — |
| **Session — leave & host transfer** | Host-promotion logic (`join_order ASC` where `left_at IS NULL`) | POST /rooms/{id}/leave | `player_left`, `host_changed` | Host leaves; next player promoted; game continues | — |
| **Admin — player removal** | — | POST /admin/rooms/{id}/kick | `player_left` broadcast after kick | Admin removes player from active room | — |
| **Bug reporting** | — | POST /bug-reports; 201 response; captured context fields present | — | Submit bug report via in-game UI; confirmation message displayed | — |
| **WebSocket delivery** | — | — | Envelope schema (`event`, `payload`, `seq`, `ts`); seq monotonicity; `sync_request` on seq gap; error event naming (`_error` suffix) | — | Sustained WebSocket connections at target scale; no missed events |

## Use Case Coverage Matrix

Rows map to the Use Case Document (UC-01 through UC-26). UC-24 (AI Player) is excluded per scope. Automation column indicates whether the test is fully automated (✅), partially automated with manual verification required (⚠️), or out of scope (—).

| Use Case | Title | Test Types | Environment | Automated |
| --- | --- | --- | --- | --- |
| UC-01 | Register | API, E2E | Dev | ✅ |
| UC-02 | Log In | API, E2E | Dev | ✅ |
| UC-03 | Password Reset | API | Dev | ⚠️ Email delivery manual |
| UC-04 | Log Out | API, E2E | Dev | ✅ |
| UC-05 | Edit Profile | API, E2E | Dev | ✅ |
| UC-06 | Create Room | API, WebSocket, E2E | Dev | ✅ |
| UC-07 | Join Room | API, WebSocket, E2E | Dev | ✅ |
| UC-08 | Configure Room | API, WebSocket, E2E | Dev | ✅ |
| UC-09 | Create Invite | API, E2E | Dev | ✅ |
| UC-10 | Start Game | API, WebSocket, E2E | Dev | ✅ |
| UC-11 | Deal Cards | Unit, WebSocket | Dev | ✅ |
| UC-12 | Place Bid | Unit, API, WebSocket, E2E | Dev | ✅ |
| UC-13 | Play Card | Unit, API, WebSocket, E2E | Dev | ✅ |
| UC-14 | Resolve Trick | Unit, WebSocket | Dev | ✅ |
| UC-15 | Hand Summary | WebSocket, E2E | Dev | ✅ |
| UC-16 | Handle Trump Selection | Unit, API, WebSocket | Dev | ✅ |
| UC-17 | Score Round | Unit, API, WebSocket, E2E | Dev | ✅ |
| UC-18 | End Game | API, WebSocket, E2E | Dev | ✅ |
| UC-19 | Spectator Mode | WebSocket, E2E | Dev | ✅ |
| UC-21 | Reconnect | WebSocket, E2E | Dev | ✅ |
| UC-22 | Leave Room | API, WebSocket, E2E | Dev | ✅ |
| UC-23 | Manage Players (Admin) | API, E2E | Dev | ✅ |
| UC-24 | AI Player | — | — | Out of scope |
| UC-25 | Handle Disconnect (server-side) | Unit, WebSocket | Dev | ✅ |
| UC-26 | Redeem Invite & Register | API, E2E | Dev | ✅ |

**Note on UC-20.** The Use Case Document does not include a UC-20 entry. No test is defined for it.

## Performance Test Criteria

All thresholds are taken directly from the PRD Non-Functional Requirements. Tests run in **CI** on a schedule, using k6 against the app and a throwaway Postgres started in the CI job. A release is blocked if any threshold is breached.

| Scenario | Tool | Load profile | Pass threshold |
| --- | --- | --- | --- |
| REST API — authenticated endpoints under load | k6 | Ramp to concurrent user target over 2 min; hold 5 min | p95 response time < 500 ms; error rate < 1% |
| REST API — POST /auth/login burst | k6 | 50 concurrent login attempts | p95 < 500 ms |
| WebSocket — `bid_placed` fan-out | k6 + socket.io-client | Target number of concurrent rooms, each with max players; all place bid simultaneously | Event delivery < 100 ms from server emit to last client receipt |
| WebSocket — `card_played` fan-out | k6 + socket.io-client | Same concurrent room/player load as above | Event delivery < 100 ms |
| WebSocket — `round_started` fan-out | k6 + socket.io-client | Same load | Event delivery < 100 ms |
| Sustained connections | k6 | Hold concurrent WebSocket connections at target scale for 10 min | Zero dropped connections; no missed events (seq gap detected) |

**Scale targets.** The PRD defines specific concurrent room and player counts. Those values are the load parameters for every WebSocket scenario above. If the PRD NFR section is updated, the k6 load profiles must be updated to match before the next performance run.

**Measurement.** k6 captures p50, p95, and p99 latency per scenario. Results are stored as CI artefacts and pushed to Grafana Cloud, where a dashboard visualises trends across runs.

## Prod Smoke Test Suite

Smoke tests run automatically after every production deployment. They are read-only or self-cleaning: any data created is deleted within the same test. They do not mutate live user or game state.

| # | Test | Tool | Verified by |
| --- | --- | --- | --- |
| S-01 | Health check — server responds 200 on GET /health | pytest | HTTP 200; `{ status: "ok" }` body |
| S-02 | Auth — login with a dedicated smoke-test account | pytest | 200 + HTTP-only session cookie set |
| S-03 | Auth — authenticated request with the session cookie | pytest | `GET /users/me` returns 200 with the `smoke_test` user |
| S-04 | Lobby — GET /lobby/rooms returns 200 | pytest | 200; response matches RoomSummary schema |
| S-05 | WebSocket — connect and receive `connection_ack` | socket.io-client | Envelope schema valid; `seq: 1` |
| S-06 | WebSocket — `sync_request` round-trip | socket.io-client | Server responds with `game_state` within 2 s |
| S-07 | E2E — login page loads and renders | Playwright | Page title present; login form visible |
| S-08 | E2E — lobby loads after login | Playwright | Room list visible; no console errors |

**Smoke test account.** A dedicated account (username: `smoke_test`, no email address) exists in production with the Player role. It must not be used for real games. Its credentials are stored in the production secrets store and injected into the smoke test pipeline at runtime.

**Pass criteria.** All 8 tests must pass. Any failure pages the on-call engineer and blocks the next release until the failure is resolved or explicitly overridden.
