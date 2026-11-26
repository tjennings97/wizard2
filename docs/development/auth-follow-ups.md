# Auth Follow-ups

Work left over from the authentication PR (session middleware, `POST /auth/register|login|logout|reset-password`, `GET /users/me`, sliding sessions with a re-auth window, server-enforced forced credential change, session row pruning, the React Router 7 upgrade, the 3-hour game time limit spec). Each section below is a separate work package that can go in its own PR. Packages marked **Decision needed** contain a product or security choice: stop and ask the project owner before building that part.

## Ground rules

- The docs in `docs/` are the source of truth. Copies kept elsewhere (for example in Claude Docs) are out of date. `docs/api/websocket-events.md` is authoritative for socket event names. If you change behaviour, update the doc that specifies it in the same PR.
- Follow `CLAUDE.md`. In particular: the layers depend downward only (API/Socket → Engine → Persistence); `src/engine/` stays pure with no I/O; hand data is never broadcast to a room.
- Reuse the auth building blocks rather than re-implementing them:

| Need | Use | File |
| --- | --- | --- |
| Validate a raw session token, slide its expiry, get user + session | `authenticateToken(token)` | `server/src/auth/sessions.ts` |
| Validate now, slide only once the action is allowed | `authenticateToken(token, { slide: false })`, then `slideSession(session)` | `server/src/auth/sessions.ts` |
| `traceId` for a log line | `requestTraceId(req)` (session's `trace_id`, else one UUID per request) | `server/src/http/trace.ts` |
| Is the user an active player in a game in progress? | `isInActiveGame(userId)` | `server/src/auth/sessions.ts` |
| End all of a user's sessions | `invalidateUserSessions(trx, userId)` | `server/src/auth/sessions.ts` |
| Issue a new session (ends the old ones) | `rotateSession(trx, userId)` inside a transaction that locks the user row | `server/src/auth/sessions.ts` |
| REST auth (re-auth window applied) | `requireAuth`, or `authenticate({ allowInReauthWindow: true })` | `server/src/auth/middleware.ts` |
| Require more than 24h left on the session | `requireSessionRunway` (stack after `requireAuth`) | `server/src/auth/middleware.ts` |
| Hash or verify a password / passphrase (bcrypt, factor 12) | `hashSecret`, `verifySecret` | `server/src/auth/credentials.ts` |
| Body validation with field errors | `BodyValidator` | `server/src/auth/validation.ts` |
| Error responses | `throw new ApiError(status, code, message)` | `server/src/http/errors.ts` |

- The session cookie is `wizard_session`, signed with `SESSION_SECRET` (cookie-parser). Read it from `req.signedCookies`, or for a socket handshake parse `socket.request.headers.cookie` and verify it with `cookie-parser`'s `signedCookie(value, config.sessionSecret)`.
- API tests: pytest in `tests/api/`. See "Running the API tests" in `docs/development/getting-started.md`. The server under test must run with `TRUST_PROXY_HOPS=1`. Seed rows directly in Postgres through the fixtures in `tests/api/conftest.py`, and register anything you create with the `cleanup` fixture.

---

## 1. Socket layer: session authentication

**Depends on:** the Socket.io layer being built (`server/src/socket/index.ts` is a stub today).

**Why:** Gameplay runs over the socket. If the socket does not validate and refresh the session, a player who only uses the socket expires after 24 hours idle, and a displaced or logged-out user keeps a working socket.

**Status:** done. Items 1, 2 and 4: `server/src/socket/auth.ts`, `server/src/auth/sessionEvents.ts`, tests in `server/src/socket/socket.int.test.ts`. Item 3: `recheckSocketSession` and the game-action handlers in `server/src/socket/index.ts`, tests in `server/src/games/games.int.test.ts`; wired for `select_trump`, `place_bid` and `play_card`, and `choose_continue_or_end` must use the same path when it is built.

**Build:**
1. **Done.** On connection, read the signed `wizard_session` cookie from the handshake and call `authenticateToken`. On failure emit `session_error` (`code` = the failure code, `fatal: true`) and disconnect.
2. **Done.** On connection, if `session.inReauthWindow` is true and the user is not reconnecting to a game in progress (`isInActiveGame`), emit `session_error` `{ code: "REAUTH_REQUIRED", fatal: true }` and disconnect.
3. **Done** for `select_trump`, `place_bid` and `play_card`. Call `authenticateToken` again on game actions (`place_bid`, `play_card`, `select_trump`, `choose_continue_or_end`) so that play slides the session expiry. Throttle per socket (for example, at most once every 5 minutes) to avoid a database query per card.
4. **Done.** **Displaced sockets:** when a session is invalidated by a new login, a password reset or a logout, every socket using that session must receive `session_error` `{ code: "SESSION_INVALIDATED", fatal: true }` and be disconnected. The auth routes live in the API layer, so add an in-process notification seam (for example, a small typed `EventEmitter` in `server/src/auth/` that emits invalidated session ids) and subscribe to it from the socket layer. Do not import socket code into the auth routes.

**Done when:**
- Socket tests (socket.io-client) cover: no cookie, tampered cookie, expired session, displaced session receiving `SESSION_INVALIDATED` after a second login, `REAUTH_REQUIRED` on connect in the window, a connect in the window that is allowed because the user is mid-game, and a game action moving `sessions.expires_at` forward.
- `docs/api/websocket-events.md` describes the handshake auth and the throttling.

## 2. Socket layer: 3-hour game time limit

**Depends on:** the in-memory game orchestration in the socket layer.

**Spec:** `docs/architecture/game-state-machine.md` (Game Lifecycle table and "Game time limit" under Special Cases), `docs/api/websocket-events.md` (`game_time_warning`; `game_abandoned` with `reason: "time_limit"`), and `docs/product/game-rules.md` (End of Game).

**Build:**
- When a game starts, schedule two timers keyed by game id: a warning at 2 h 45 min and a limit at 3 h.
- **Warning:** broadcast `game_time_warning` `{ game_id, ends_at, minutes_remaining: 15 }` once.
- **Limit:** from any non-terminal phase, abandon the game. Do not score the round in progress. Set `games.status = 'incomplete'`, `drop_reason = 'time_limit'`, `ended_at`; write `game_results` rows with `outcome = 'incomplete'`, `drop_reason = 'time_limit'`; write the `games.state` checkpoint; broadcast `game_abandoned` `{ reason: "time_limit", game_id }`; the room moves to COMPLETING.
- Clear both timers when the game ends any other way (completion, mutual end, server shutdown).
- The `time_limit` value is already allowed by migration `006_add_drop_reasons.ts`.

**Done when:** tests use fake timers to cover the warning, abandonment from each phase, and timers being cleared on normal completion.

## 3. Room routes: attach the session runway guard

**Depends on:** `POST /rooms`, `POST /rooms/{roomId}/join` and `POST /rooms/{roomId}/start` being built (see `docs/api/openapi-spec.md`).

**Status: done.** All three routes mount the guard; covered by `tests/api/test_rooms.py`.

**Build:** mount `requireAuth, requireSessionRunway` on all three routes. The OpenAPI spec already documents `401 REAUTH_REQUIRED` on each.

**Done when:** pytest covers, for each route, a session with 12h left before the cap getting `401 REAUTH_REQUIRED` and a fresh session not getting it. Use the `enter_reauth_window` helper pattern in `tests/api/test_auth.py`.

## 4. Account management endpoints

### 4a. Password and passphrase change (`PATCH /users/me`)

**Spec:** `docs/api/openapi-spec.md` (`/users/me` patch). `docs/architecture/security.md` says to rotate all tokens on a password or passphrase change.

**Status: done.** `PATCH /users/me` in `server/src/routes/users.ts`; migration `009_credential_change_tracking.ts` adds `users.password_changed_at` / `recovery_changed_at`, and the flag clears once both are set. `currentPassword` is required for either secret (wrong → `401 INVALID_CURRENT_PASSWORD`, rate-limited on failures), new secrets must differ from the current ones, and the rotation ends other sessions with `reason: "credential_change"`. Avatar fields are refused until the avatar work (§8). Tests: `tests/api/test_users.py`, socket cases in `server/src/socket/socket.int.test.ts`.

**Build:**
- Verify `currentPassword` with `verifySecret`; return `401` if it is wrong.
- Hash new secrets with `hashSecret`, using the same length rules as registration (8 characters minimum, 72 bytes maximum, via `BodyValidator.newSecret`).
- On a password or passphrase change, call `rotateSession` (inside a transaction that locks the user row) and set the new cookie, so other devices are logged out and this one stays logged in.
- Clear `requires_credential_change` once **both** the password and the recovery passphrase have been changed since the admin reset (`docs/architecture/data-model.md`, `docs/product/ui-ux-flows.md`). A user who changes only one stays flagged.
- Mount the route with `authenticate({ allowDuringCredentialChange: true })`. Otherwise a flagged user gets `403 CREDENTIAL_CHANGE_REQUIRED` from the very route that clears the flag.

### 4b. Admin credential reset (`POST /admin/users/{userId}/reset-credentials`)

**Build:** set `requires_credential_change = true`, set `password_changed_at` and `recovery_changed_at` to `NULL` (so the user must change both again, see §4a), set the temporary credentials as the spec describes, and call `invalidateUserSessions` so the user must log in again. Admin routes check `req.user.role === 'admin'`; `requireAuth` re-reads the role from the database on every request.

**Already enforced:** the server enforces the forced change in `authenticate()`. While the flag is true, every route returns `403 CREDENTIAL_CHANGE_REQUIRED` unless it opts in with `allowDuringCredentialChange`; only `GET /users/me`, `PATCH /users/me` and `POST /auth/logout` should. Do not opt any other route in.

**Done when:** (the `PATCH /users/me` half is covered in `tests/api/test_users.py` with a simulated reset; swap `simulate_admin_reset` for the real endpoint) pytest covers an admin reset followed by login (`requiresCredentialChange: true`), a blocked route returning `403 CREDENTIAL_CHANGE_REQUIRED`, `PATCH /users/me` changing only the password (still flagged), then the passphrase (flag cleared), and the blocked route then succeeding.

### 4c. Admin invites (`/admin/invites`)

**Build:**
- Generate codes with at least 128 bits of randomness (`crypto.randomBytes(16)` or more).
- Store only `sha256(code)` in `invites.code_hash`, and return the raw code once in the create response.
- Set `expires_at = now + 7 days`.
- Revoking sets `status = 'revoked'`. Registration already rejects revoked, expired and redeemed invites.

**Done when:** pytest covers create, list, revoke, `403` for non-admins, and a full flow in which an admin creates an invite and a new user registers with it.

## 5. Client auth flows

**Spec:** `docs/product/ui-ux-flows.md`, `CLAUDE.md` (Frontend Notes, Forced credential change).

**Status: done, except the avatar step.** Register, reset-password, forced change and `/profile` pages in `client/src/pages/`; the mapping below in `client/src/context/AuthContext.tsx`; the re-auth prompt is documented in `docs/product/ui-ux-flows.md` (Flow 1). Registration sends a placeholder `avatarConfig` and `avatarSvg: null` (`client/src/api/avatar.ts`) until the avatar picker lands with the §8 decision.

**Build:**
- `AuthContext`.
- Login, register (invite code plus the avatar builder output for `avatarConfig`/`avatarSvg`; settle the avatar SVG item in section 8 first, as it may remove `avatarSvg`) and reset-password screens.
- `GET /users/me` on app load to restore the session.
- Handle the 401 codes:

| Code | Client behaviour |
| --- | --- |
| `UNAUTHORIZED` | Go to the login screen. |
| `SESSION_INVALIDATED` | Go to the login screen with "You signed in on another device." |
| `REAUTH_REQUIRED` | Go to the existing login screen with the username pre-filled and the message "Please sign in again to continue." |

- Socket `session_error` with `fatal: true`: tear down the socket and apply the same mapping.
- Login response with `requiresCredentialChange: true`: force the change-password flow before any other navigation.

**Also:** ~~add the re-auth prompt to `docs/product/ui-ux-flows.md`~~ (done).

## 6. CI

**Why:** there is no `.github/` directory yet, but `docs/operations/deployment-infrastructure.md` says PRs to `main` must pass CI and that the API tests run there.

**Build:** `.github/workflows/ci-pr.yml`, the PR workflow named in the deployment doc, which:
- starts a Postgres 16 service,
- runs `npm ci`, `npm run typecheck` and `npm test -w server`,
- runs `npm run migrate:latest -w server`,
- starts the server with `NODE_ENV=test TRUST_PROXY_HOPS=1 PORT=3100` and waits for `/health`,
- installs `tests/api/requirements.txt` and runs `pytest tests/api` with `API_BASE_URL` and `DATABASE_URL` set,
- runs `npm audit`; the deployment doc says known vulnerabilities in direct dependencies block merge (see the dev-server advisories item in section 10).

`ci-perf.yml` and `ci-smoke.yml` are separate workflows and out of scope here.

**Note:** the post-deploy smoke tests (`docs/testing/test-plan.md` S-02/S-03) need the `smoke_test` account provisioned manually in production first (`docs/operations/deployment-infrastructure.md`).

## 7. Deployment and operations

- **Decision needed: migration strategy (OD-2 in `docs/operations/deployment-infrastructure.md`).** Nothing runs migrations on deploy. Migration `006_add_drop_reasons.ts` has to reach production before game code writes `server_restart` or `time_limit`. Decide whether migrations run automatically (for example, as a Railway pre-deploy command running `npm run migrate:latest -w server`) or by hand, and whether they are forward-only.
- **Startup cleanup is not implemented.** `server/src/index.ts` does not yet mark `in_progress` games `incomplete` with `drop_reason = 'server_restart'` before accepting traffic (`docs/operations/backup-recovery.md`). It works once 006 is applied; before 006 it violates the check constraint.
- **Node 20 on Railway.** The repo now requires Node 20 or newer (`engines` in `package.json`, `.nvmrc`), because React Router 7 needs it. Confirm the Railway build uses Node 20 or newer (it reads `engines.node`); if it picks another version, pin it in Railway's build settings. Do this before or with the first deploy of this change.
- **Verify proxy trust on Railway.** After deploy, confirm that `req.ip` is the real client IP (log it once on a request) and that rate limiting is per client rather than shared. If Railway adds more than one hop, raise `TRUST_PROXY_HOPS`.

## 8. Security hardening

- **HSTS:** send `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production (`docs/architecture/security.md`, downgrade attack). Consider `helmet` for this and the other standard headers.
- **CSRF conclusion:** `docs/architecture/security.md` lists "CSRF protection not explicitly confirmed" as a gap. The current controls are a `SameSite=Strict` cookie, CORS limited to one origin with credentials, and JSON-only request bodies. Write up whether that is sufficient (recommendation: yes, provided every state-changing route requires `Content-Type: application/json`, which should then be enforced) and update the gap table.
- **Decided (2026-11-26): recommended option.** The server stops accepting and storing client SVG; avatars are built from `avatarConfig` slugs only. Built by remaining-work prompt 7. **Client-supplied avatar SVG (stored XSS).** `POST /auth/register` stores the client's `avatarSvg` in `users.avatar_svg` with no checks beyond "string or null" (`v.nullableString('avatarSvg')` in `server/src/routes/auth.ts`). There is no length cap and no content check. Every other player receives it in the `User` object, and `docs/architecture/avatar-system.md` has `<AvatarImage>` render that string directly. Anyone with an invite code can register with markup such as `<svg><foreignObject><img src=x onerror=...></foreignObject></svg>`, and it runs in the session of every player whose client renders that avatar. Nothing renders avatars yet, so this is not exploitable today, but it must be fixed before `<AvatarImage>` ships or `PATCH /users/me` accepts `avatarSvg`. Also, `BodyValidator.avatarConfig()` accepts any non-empty string up to 64 characters as a slug, not just the app's real options.
  - **Recommended (chosen):** the avatar options are app-provided layer files, so the player's whole choice is `avatarConfig`. Stop accepting `avatarSvg`, drop the `avatar_svg` column in a new migration, and have `<AvatarImage>` stack the four layer files from `avatarConfig` (as `CLAUDE.md` Frontend Notes describes). Validate each slug against the app's option list once the layer assets exist (until then, at least restrict slugs to `^[a-z0-9]+(-[a-z0-9]+)*$`). Update `avatar-system.md`, `data-model.md`, `openapi-spec.md`, `prd.md` and `system-architecture.md`, which all describe the cached SVG.
  - **Alternatives:** have the server build the SVG from the validated slugs and never accept it from the client, or sanitize uploaded SVG on the server with an allowlist of elements and attributes plus a length cap. Sanitizing is the weakest option.
  - **Done when:** pytest shows that registering with markup in `avatarSvg` cannot store or return it, and that invalid slugs (`../x`, `<svg>`, `Round`) are rejected with `400 VALIDATION_ERROR`.
- **Breached-password check: deferred by the project owner.** `docs/architecture/security.md` mentions rejecting passwords on known-breach lists. Do not build it now.
- **Configurable rate limits:** `security.md` §6 says limits are configurable per environment. They are constants in `server/src/auth/rateLimits.ts`. If needed, read them from optional env vars, with the current values as defaults and minimums.
- **Session row retention: done.** Each login deletes the user's sessions that ended more than 24 hours earlier (`rotateSession` in `server/src/auth/sessions.ts`). Rows of users who never log in again stay. If that matters later, a periodic job can delete rows that ended more than 24 hours ago for everyone. Bug reports store their own `trace_id`, `user_id` and context, so they do not depend on session rows.

## 9. Observability

- **Request logging:** `CLAUDE.md` says every log entry carries `timestamp`, `level`, `traceId`, `userId`, `roomId`, `gameId`, `message`. There is no request-logging middleware yet. Add one that uses `requestTraceId(req)` from `server/src/http/trace.ts` (the session's `trace_id` when authenticated, otherwise one random UUID per request). The auth routes, rate limiter and error handler already use it. Never log request bodies; the logger already redacts `req.body` and the credential fields.
- **Security events:** add metrics or log-based alerts for login failures, rate-limit hits (already logged as `auth rate limit hit`) and reset attempts, per `docs/operations/observability-alerting.md` and the "No security-specific logging" gap in `security.md`.

## 10. Small fixes

- `docs/api/openapi-spec.md` lists the local dev server as `http://localhost:3001/api/v1`. The server and Vite proxy use port 3000. Correct the spec.
- **Dev-server advisories (`vite`, `esbuild`).** `npm audit` (including dev dependencies) reports advisories against `vite` 5.x and its bundled `esbuild` (≤ 0.24.2). They affect only the local dev server, not the production bundle, but `docs/operations/deployment-infrastructure.md` says known vulnerabilities in direct dependencies block merge. **Decision needed:** upgrade to `vite` 6.4.4 or newer (all listed advisories are fixed there; check that `@vitejs/plugin-react` supports it), or have `ci-pr.yml` audit production dependencies only (`npm audit --omit=dev`).
