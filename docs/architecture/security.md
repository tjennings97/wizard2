# Wizard — Security Considerations

This document identifies threats, gaps, and security rules of thumb for the Wizard card game. It does not repeat implemented controls; it focuses on what could go wrong and the mitigations that address each risk.

## 1. Threat Model

The assets an attacker has most incentive to target, the realistic actors, and the surfaces they can reach.

### Protected assets

| Asset | Why it matters |
| --- | --- |
| Player credentials (password hash, recovery passphrase hash) | Account takeover; no email means no out-of-band recovery if both are compromised |
| Session tokens | Hijacking a session gives full game and account access without knowing the password |
| Game state (hands, bids, scores) | Cheating by reading other players' hidden cards or manipulating scores |
| Admin credentials | Full user management access; highest-privilege path in the system |
| Railway environment variables (DB URL, session secret) | Compromise gives full database and session-forging access |

### Threat actors

| Actor | Capability | Most likely goal |
| --- | --- | --- |
| Cheating player | Authenticated; inside an active game | Read other players' hands; alter their own bid or score |
| Credential attacker | External; no account required | Brute-force login or invite-code enumeration |
| Malicious invitee | Has a valid invite code | Abuse trust to enumerate accounts or disrupt games |
| Compromised dependency | In the supply chain | Exfiltrate secrets, inject malicious code at build time |
| Insider / compromised Railway account | Access to environment config | Steal DB credentials or session secret |

### Attack surfaces

- **HTTP/REST endpoints** — login, register, reset-password, admin routes
- **Socket.io event bus** — all real-time game actions (bid, play card, declare trump)
- **Room chat** — freeform text sent by authenticated players pre-game
- **Railway dashboard and environment variables** — infrastructure configuration
- **npm dependency graph** — build-time and runtime code execution

## 2. Authentication Threats

### Credential brute force

**Risk:** An attacker submits many password attempts against a known username. Because there is no email address, an account cannot be recovered externally if the password and passphrase are both lost or guessed.

**Mitigation:** Rate limiting on auth endpoints (see §6). Bcrypt's cost factor inherently slows each attempt; ensure the work factor is set to 12 or above and reviewed as hardware costs fall.

### Invite-code enumeration

**Risk:** Registration requires an invite code. An attacker could submit requests with guessed codes to determine valid ones, especially if codes are short or sequential.

**Mitigation:** Invite codes must be cryptographically random (minimum 128 bits of entropy) and not sequential or predictable. Rate-limit the registration endpoint (see §6). Return a generic failure message that does not distinguish between an invalid code and an already-used code.

### Credential stuffing

**Risk:** Credentials leaked from other services are tried against Wizard accounts. Players reuse passwords.

**Mitigation:** Enforce a minimum password length of 12 characters. Recommend (but do not require) a passphrase style. Consider checking submitted passwords against a known-breached list (e.g. the HaveIBeenPwned k-anonymity API) at registration and on password change.

### Password and recovery passphrase requirements

Best practice minimums to apply at registration and on change:

| Field | Minimum length | Character requirement | Notes |
| --- | --- | --- | --- |
| Password | 12 characters | None beyond length | Reject passwords on known-breach lists |
| Recovery passphrase | 16 characters (or 4 words if diceware) | None | Used as a second credential; treat with the same hashing and rate-limit protections as the password |

### Session hijacking

**Risk:** An attacker obtains a valid session token via network interception, XSS, or server-side leakage, then impersonates the victim.

**Mitigation:** HTTP-only cookies prevent JavaScript access. TLS prevents network interception. Tokens are hashed before storage, so a database breach does not yield usable tokens. Ensure `SameSite=Strict` or `SameSite=Lax` is set on the session cookie to reduce CSRF exposure.

### Account takeover via reset flow

**Risk:** The recovery passphrase is the sole account-recovery credential. If an attacker learns it, they can reset the password without any secondary verification.

**Mitigation:** Rate-limit the reset-password endpoint (see §6). The reset flow should invalidate all existing sessions immediately on success. Log all reset attempts with timestamp and IP for audit purposes.

### Single-session enforcement gap

**Risk:** The PRD specifies one active session per account. If a token is stolen, the legitimate user may not notice because they are not forcibly logged out.

**Mitigation:** On new login, explicitly invalidate any prior session token before issuing a new one. On password or passphrase change, rotate all tokens. Provide the user with a visible "active session" indicator so they can detect unexpected concurrent access.

## 3. Authorization Threats

### Game action spoofing

**Risk:** A player crafts a malicious Socket.io event to play a card out of turn, submit a bid for another player, or declare trump when it is not their right to do so.

**Mitigation:** Every game action must be validated server-side against three conditions: the authenticated session matches the acting player, it is that player's turn, and the action is legal given the current game state. The client is never trusted as the source of game-state truth.

### Hand data leakage

**Risk:** A player intercepts Socket.io room broadcasts to read other players' hidden cards.

**Mitigation:** Hand data must never be sent to a room. It must be emitted only to the specific socket ID of the player who owns that hand. Verify this at the socket-event layer, not only at the application layer — a refactor that inadvertently changes a `to(socketId)` to a `to(roomId)` must be caught by tests.

### Privilege escalation to admin

**Risk:** An authenticated player accesses admin routes (user management, invite-code generation) by directly requesting admin endpoints.

**Mitigation:** Admin routes must check the `isAdmin` flag on the authenticated session on every request, not only at login. The flag must be read from the database, not from the session payload, so it cannot be forged by manipulating session data.

### Spectator accessing player data

**Risk:** A spectator in a room receives hand or bid data they are not entitled to see.

**Mitigation:** Spectators must receive no hand data at any point. Per-role event filtering must be applied before any emit. Spectator access is read-only for public game state (scores, current trick) only.

### Replay attacks on game actions

**Risk:** A player captures a valid Socket.io event (e.g. a winning card play) and replays it to repeat the action.

**Mitigation:** Game state on the server must be authoritative and sequential. The server rejects any action that does not match the current expected state (e.g. playing a card when the trick is already complete). Sequence or turn counters checked server-side provide an additional guard.

## 4. Transport and Data Exposure

### Downgrade attack / mixed content

**Risk:** A browser or intermediary downgrades an HTTPS connection to HTTP, exposing session cookies or game events in transit.

**Mitigation:** Railway redirects all HTTP to HTTPS. Additionally, set the `Strict-Transport-Security` (HSTS) header with a `max-age` of at least 1 year so browsers refuse future non-TLS connections to the domain. Set the `Secure` flag on all cookies so they are never sent over plain HTTP.

### WebSocket (WSS) exposure

**Risk:** Socket.io falls back to plain WS if WSS is not enforced, or if the client is misconfigured to connect to `ws://` instead of `wss://`.

**Mitigation:** Configure Socket.io to connect using the same origin as the HTTPS page. Do not allow `ws://` origins in the CORS or transport config. Railway's TLS termination covers WSS automatically when the app is accessed over HTTPS.

### Database credential exposure

**Risk:** The Postgres connection string (which includes username, password, and host) is exposed through logs, error messages, or source control.

**Mitigation:** The database is accessible only within Railway's private network. Never log the `DATABASE_URL` variable. Ensure error handlers do not surface stack traces containing connection strings to the client. Confirm `.env` files are in `.gitignore` and never committed.

### Sensitive data in logs

**Risk:** Application logs inadvertently capture passwords, session tokens, or recovery passphrases during request processing.

**Mitigation:** Never log request bodies on auth endpoints. Ensure logging middleware strips or masks `password`, `passphrase`, `token`, and `cookie` fields before writing to any log sink.

## 5. Input Validation and Injection

This section sets framework-level rules of thumb. The specific controls are expected to be enforced by the chosen libraries (Knex for SQL, React for rendering) rather than implemented by hand.

### SQL injection

**Rule:** Always use Knex's query builder or parameterised methods. Never construct SQL strings by concatenating user input. This applies to every database access path, including admin and game-state queries.

**What to check:** Any direct use of `knex.raw()` must be reviewed. If `knex.raw()` is necessary, bindings must be used: `knex.raw('WHERE id = ?', [userId])`, never string interpolation.

### XSS (Cross-Site Scripting)

**Rule:** Rely on React's default JSX escaping for all user-supplied content rendered to the DOM. Never use `dangerouslySetInnerHTML` with user input. This covers player names, room names, and chat messages.

**What to check:** Any use of `dangerouslySetInnerHTML` must be audited and justified. Content Security Policy (CSP) headers should be set to disallow inline scripts as a defence-in-depth measure.

### Chat message content

**Rule:** Chat messages are user-supplied strings. On the server, validate that each message is a non-empty string within a defined maximum length (recommended: 300 characters) before broadcasting. Reject messages that exceed this limit with an informative error rather than silently truncating.

### Websocket event payloads

**Rule:** All Socket.io event payloads must be validated server-side against an expected schema before processing. Unexpected fields must be ignored or stripped. A malformed payload must be rejected and the event discarded — it must not cause an unhandled exception that crashes the game room.

### Username and room name inputs

**Rule:** Apply consistent length and character constraints at the server on all user-controlled identifiers. Validate on submission, not only on the client. Reject inputs that exceed the defined maximum or contain disallowed characters; return a clear error rather than silently accepting invalid data.

## 6. Rate Limiting

All limits apply per IP address unless noted. Limits are configurable per environment; the values below are the production minimums.

### Auth endpoint limits

| Endpoint | Limit | Window | Rationale |
| --- | --- | --- | --- |
| `POST /login` | 10 requests | 15 minutes | Allows several typos; makes exhausting even a short password list take hours |
| `POST /register` | 5 requests | 1 hour | Registration is a one-time action; prevents invite-code enumeration |
| `POST /reset-password` | 5 requests | 1 hour | Recovery passphrase is a second secret; same risk profile as login, slower cadence appropriate |

### Chat message limits

**Limit:** 10 messages per 30 seconds, per authenticated user, per room.

**Scope:** Enforced at the Socket.io event layer on the server. The limit resets per room, so a user present in multiple rooms is not penalised across them.

**User feedback:** When the limit is reached, the server must emit a visible error event back to the sending client (e.g. `chat:throttled`) with a message such as "You are sending messages too quickly. Please wait before sending again." Messages beyond the limit are dropped silently for all other room participants; only the sender is notified.

### General guidance

- Return HTTP 429 with a `Retry-After` header on rate-limited REST requests so well-behaved clients back off gracefully.
- Log rate-limit hits with IP and endpoint for operational visibility; a sudden spike is an indicator of an ongoing attack.

## 7. Secrets and Infrastructure Hygiene

### Environment variable discipline

**Rule:** All secrets (session secret, database URL, Prometheus bearer token) live only in Railway environment variables. They are never committed to source control, never logged, and never returned in API responses or error messages.

The `config.ts` startup validator must fail fast if any required variable is absent, preventing the app from accepting traffic in a misconfigured state. The `.env.example` file documents required keys with placeholder values only — never real values.

### Session secret strength

**Rule:** The session secret must be a cryptographically random string of at least 256 bits (32 bytes, base64- or hex-encoded). A short or guessable secret allows an attacker to forge session tokens. Rotate the secret if it is ever suspected of exposure; rotation immediately invalidates all active sessions.

### JWT signing key (removed)

The infrastructure plan included a placeholder for a JWT signing key. No JWT-based authentication is used in this system — sessions are HTTP-only cookie tokens hashed in Postgres. This variable should be removed from the infrastructure plan to avoid confusion.

### Dependency scanning

**Rule:** `npm audit` runs in CI and blocks deployment on known vulnerabilities in direct dependencies. The transitive vulnerability policy must be documented in the upgrade/patch management guide before the first production deployment.

**Recommended cadence:** Review `npm audit` output and apply patch-level upgrades at least monthly. Schedule a dedicated dependency review for minor/major upgrades quarterly.

### Railway account security

**Risk:** Compromise of the Railway account gives an attacker access to all environment variables, including the database URL and session secret.

**Mitigation:** Enable MFA on the Railway account. Restrict project access to the minimum set of collaborators. Review access periodically and remove former contributors promptly.

## 8. Open Risks

These items are not fully resolved by the current documentation and should be addressed before or shortly after the first production deployment.

| Risk | Gap | Recommended action |
| --- | --- | --- |
| No email on accounts | If a player loses both their password and recovery passphrase, their account is permanently inaccessible. No out-of-band recovery path exists. | Define an admin-assisted account recovery process. Document what an admin can and cannot do (e.g. reset password but not read private game history). |
| Transitive dependency vulnerabilities | The policy for transitive (indirect) npm dependency vulnerabilities is described as "documented in the upgrade/patch management guide" — that guide does not yet exist. | Write the policy before first production deployment. |
| No security-specific logging or alerting | There is no mention of alerting on suspicious patterns (repeated rate-limit hits, failed login spikes, admin route access). | Define a minimum set of security events to log and the threshold at which an alert fires. |
| CSRF protection not explicitly confirmed | `SameSite` cookie attribute and CORS restriction to production domain reduce CSRF risk, but there is no explicit mention of a CSRF token on state-changing REST endpoints. | Confirm whether CSRF tokens are required given the cookie + CORS configuration, and document the conclusion. |
| Bcrypt work factor not specified | The docs specify bcrypt but not the cost factor. An inadequate factor weakens offline brute-force resistance. | Set and document a minimum cost factor of 12; review annually as hardware improves. |
| Chat rate limiting not scalable beyond single instance | The in-memory counter approach for Socket.io chat rate limiting only works on a single server instance. With multiple instances each maintains its own counter, effectively multiplying the limit by the number of instances. | Replace in-memory counters with a shared Redis store (keyed by userId + roomId) before introducing horizontal scaling. Note: Redis is not currently part of the architecture. |
| Stolen session token undetected | Single-session enforcement only prevents two concurrent logins. A stolen token used before the legitimate user next logs in is invisible — no forced logout, no alert. The active session indicator is reactive and depends on the user noticing.&#32; | Evaluate short token expiry with silent refresh, or session binding to a device/IP fingerprint, as a stronger detection mechanism. |
