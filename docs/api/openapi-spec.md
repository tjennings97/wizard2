# Wizard — OpenAPI 3.0 Specification

## Info, Servers, and Shared Components

```yaml
openapi: 3.0.3
info:
  title: Wizard Game API
  version: 1.0.0
  description: >
    REST API for the Wizard card game platform.
    All endpoints are prefixed with /api/v1.
    Authentication uses HTTP-only session cookies.
    Real-time game events are handled via Socket.io (not documented here).

servers:
  - url: https://yourdomain.com/api/v1
    description: Production
  - url: http://localhost:3001/api/v1
    description: Local development

components:
  securitySchemes:
    sessionCookie:
      type: apiKey
      in: cookie
      name: wizard_session
      description: HTTP-only session cookie issued on login.

  schemas:

    Error:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          example: UNAUTHORIZED
        message:
          type: string
          example: Session is invalid or expired.
        details:
          type: object
          description: Optional field-level validation errors.

    AvatarConfig:
      type: object
      description: >
        A player's avatar: one slug per key from the option catalog in
        docs/architecture/avatar-system.md (shared code: server/src/shared/avatar.ts). Exactly these
        four keys; a missing or extra key, a non-string, an unknown slug, or a valid slug under the
        wrong key (head: hair-01) is rejected with 400 VALIDATION_ERROR.
      required: [head, skin, face, hair]
      additionalProperties: false
      properties:
        head:
          type: string
          enum: [head-01, head-02, head-03, head-04]
          example: head-02
        skin:
          type: string
          enum: [skin-01, skin-02, skin-03, skin-04, skin-05, skin-06]
          example: skin-04
        face:
          type: string
          enum: [face-01, face-02, face-03, face-04, face-05, face-06]
          example: face-01
        hair:
          type: string
          enum: [hair-01, hair-02, hair-03, hair-04, hair-05, hair-06, hair-07, hair-08]
          example: hair-07

    User:
      type: object
      properties:
        id:
          type: string
          format: uuid
        username:
          type: string
          example: jsmith
        displayName:
          type: string
          example: Jake
        role:
          type: string
          enum: [player, admin]
        avatarConfig:
          $ref: '#/components/schemas/AvatarConfig'
        createdAt:
          type: string
          format: date-time
        requiresCredentialChange:
          type: boolean
          description: >
            True when the admin has reset this user's credentials.
            The client should redirect to a forced change-password flow
            on the next login response when this flag is true. The server
            enforces it: while true, every authenticated route except
            GET /users/me, PATCH /users/me and POST /auth/logout returns
            403 CREDENTIAL_CHANGE_REQUIRED.

    RoomConfig:
      type: object
      required: [roundCount, bidRule]
      properties:
        roundCount:
          type: integer
          minimum: 1
          example: 10
        bidRule:
          type: string
          enum: [open, uneven]
          default: open
        deckType:
          type: string
          enum: [standard]
          default: standard

    RoomMember:
      type: object
      properties:
        userId:
          type: string
          format: uuid
        displayName:
          type: string
        avatarConfig:
          $ref: '#/components/schemas/AvatarConfig'
        role:
          type: string
          enum: [player, spectator]
        joinOrder:
          type: integer
        isHost:
          type: boolean
        connected:
          type: boolean

    Room:
      type: object
      properties:
        id:
          type: string
          format: uuid
        state:
          type: string
          enum: [open, in_progress, completing, closed]
        hostUserId:
          type: string
          format: uuid
        config:
          $ref: '#/components/schemas/RoomConfig'
        members:
          type: array
          items:
            $ref: '#/components/schemas/RoomMember'
        createdAt:
          type: string
          format: date-time
        closedAt:
          type: string
          format: date-time
          nullable: true

    GameResultEntry:
      type: object
      properties:
        gameId:
          type: string
          format: uuid
        outcome:
          type: string
          enum: [win, loss, incomplete]
        finalScore:
          type: integer
        roundsPlayed:
          type: integer
        playerCount:
          type: integer
        roundCount:
          type: integer
        playedAt:
          type: string
          format: date-time

    PlayerMetrics:
      type: object
      properties:
        totalGames:
          type: integer
        wins:
          type: integer
        losses:
          type: integer
        incomplete:
          type: integer
        winRate:
          type: number
          format: float
        averageScore:
          type: number
          format: float
        averageScorePerRound:
          type: number
          format: float
        totalTricksWon:
          type: integer
        bidAccuracyRate:
          type: number
          format: float
          description: Fraction of rounds where bid was exactly correct.
        averageBidError:
          type: number
          format: float
          description: Average absolute difference between bid and tricks won.
        overbidRate:
          type: number
          format: float
        underbidRate:
          type: number
          format: float
        perfectGames:
          type: integer
          description: Games where every round bid was exact.
        winRateByPlayerCount:
          type: object
          additionalProperties:
            type: number
          description: Keys are player counts ("3" through "10").

    Invite:
      type: object
      properties:
        id:
          type: string
          format: uuid
        label:
          type: string
          nullable: true
        status:
          type: string
          enum: [pending, accepted, expired, revoked]
        createdAt:
          type: string
          format: date-time
        expiresAt:
          type: string
          format: date-time
        redeemedAt:
          type: string
          format: date-time
          nullable: true
        redeemedBy:
          type: string
          format: uuid
          nullable: true
        redeemedByUsername:
          type: string
          nullable: true
          description: Username of the user who redeemed the invite. Null until redeemed.
```

## Auth Endpoints

```yaml
paths:

  /auth/register:
    post:
      summary: Register a new user account
      description: >
        Requires a valid, unexpired, unredeemed invite code.
        Creates the user account and marks the invite as accepted.
        Operation is atomic — if user creation fails, invite is not consumed.
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [inviteCode, username, displayName, password, recoveryPassphrase, avatarConfig]
              properties:
                inviteCode:
                  type: string
                  description: >
                    As issued by POST /admin/invites. Case, spaces and dashes are ignored, so a
                    code read out or retyped still matches. (Invites stored before this rule,
                    hashed exactly as written, also match the code exactly as written.)
                  example: k3vq-7xmd-wq7a-ph2e-r4tn-j6cb-sy
                username:
                  type: string
                  minLength: 3
                  maxLength: 32
                  pattern: '^[a-z0-9_]+$'
                  example: jsmith
                displayName:
                  type: string
                  minLength: 1
                  maxLength: 64
                  example: Jake
                password:
                  type: string
                  minLength: 8
                  format: password
                recoveryPassphrase:
                  type: string
                  minLength: 8
                  format: password
                  description: Used to reset password if forgotten. Stored hashed. Must differ from password.
                avatarConfig:
                  $ref: '#/components/schemas/AvatarConfig'
              description: >
                The server never accepts client SVG: an avatarSvg field, like any other unknown
                field, is ignored and never stored or returned.
      responses:
        '201':
          description: Account created successfully.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '400':
          description: Validation error (missing fields, username format, password too short).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: VALIDATION_ERROR
                message: Username must be 3–32 lowercase alphanumeric characters or underscores.
        '409':
          description: Username already taken.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: USERNAME_TAKEN
                message: That username is already in use.
        '422':
          description: Invite code invalid, expired, or already redeemed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: INVITE_INVALID
                message: Invite code is invalid, expired, or has already been used.

  /auth/login:
    post:
      summary: Log in and receive a session cookie
      description: >
        Validates credentials and issues an HTTP-only session cookie.
        Any existing active session for this user is invalidated.
        The username is trimmed and matched case-insensitively (usernames are stored lowercase).
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [username, password]
              properties:
                username:
                  type: string
                  example: jsmith
                password:
                  type: string
                  format: password
      responses:
        '200':
          description: Login successful. Session cookie set.
          headers:
            Set-Cookie:
              description: HTTP-only session cookie (wizard_session).
              schema:
                type: string
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '401':
          description: Invalid username or password.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: INVALID_CREDENTIALS
                message: Username or password is incorrect.
        '429':
          description: Too many login attempts. Rate limited.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: RATE_LIMITED
                message: Too many login attempts. Please try again later.

  /auth/logout:
    post:
      summary: Log out and invalidate the current session
      tags: [Auth]
      security:
        - sessionCookie: []
      responses:
        '204':
          description: Logged out successfully. Session cookie cleared.
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /auth/reset-password:
    post:
      summary: Reset password using recovery passphrase
      description: >
        Validates the recovery passphrase for the given username.
        On success, updates the password. Does not require an active session.
        The username is trimmed and matched case-insensitively (usernames are stored lowercase).
      tags: [Auth]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [username, recoveryPassphrase, newPassword]
              properties:
                username:
                  type: string
                  example: jsmith
                recoveryPassphrase:
                  type: string
                  format: password
                newPassword:
                  type: string
                  minLength: 8
                  format: password
      responses:
        '204':
          description: Password reset successfully.
        '401':
          description: >
            Username not found or recovery passphrase does not match. Both cases return
            the same response so the endpoint does not reveal which usernames exist.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: INVALID_RECOVERY
                message: Username or recovery passphrase is incorrect.
        '429':
          description: Rate limited.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## User Endpoints

```yaml
  /users/me:
    get:
      summary: Get the authenticated user's profile
      tags: [Users]
      security:
        - sessionCookie: []
      responses:
        '200':
          description: Current user profile.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '401':
          description: >
            Not authenticated, or REAUTH_REQUIRED: the session is within 24 hours of its
            30-day cap and the user is not an active player in a game in progress. The client
            calls this on app load, and on REAUTH_REQUIRED shows the login screen.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

    patch:
      summary: Update the authenticated user's profile
      description: >
        Updates one or more mutable profile fields: display name, password, recovery passphrase.
        Username is immutable and cannot be changed. Send at least one of displayName, password
        or recoveryPassphrase.


        Changing the password or the recovery passphrase requires currentPassword, and each new
        secret must differ from the current one. It rotates the session: every other session of
        the user ends (their sockets get session_error SESSION_INVALIDATED with reason
        "credential_change") and this response sets a new session cookie, so the device that
        made the change stays signed in.


        Allowed while requires_credential_change is true (it is how the forced change is made).
        The flag clears once both the password and the recovery passphrase have been changed
        since the admin reset, in one request or two; a user who changes only one stays flagged.


        avatarConfig replaces the whole avatar (partial configs are rejected). The change is not
        broadcast: other players see it in their next lobby or room snapshot
        (docs/architecture/avatar-system.md, "Changing an Avatar"). avatarSvg is not part of the
        API; like any other unknown field it is ignored, and on its own it is "nothing to update".
      tags: [Users]
      security:
        - sessionCookie: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                displayName:
                  type: string
                  minLength: 1
                  maxLength: 64
                  description: Trimmed before it is stored.
                avatarConfig:
                  $ref: '#/components/schemas/AvatarConfig'
                password:
                  type: string
                  minLength: 8
                  format: password
                  description: New password (at most 72 bytes). Requires currentPassword; must differ from it.
                recoveryPassphrase:
                  type: string
                  minLength: 8
                  format: password
                  description: New recovery passphrase (at most 72 bytes). Requires currentPassword; must differ from the current passphrase and from the password (the new one if this request sets it).
                currentPassword:
                  type: string
                  format: password
                  description: Required when changing password or recoveryPassphrase.
      responses:
        '200':
          description: >
            Profile updated. When a secret changed, the response carries a new session cookie
            (Set-Cookie) and requiresCredentialChange reflects whether the forced change is complete.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '400':
          description: >
            VALIDATION_ERROR: a field is invalid, nothing to update, currentPassword missing when
            changing a secret, a new secret equal to the current one, or an invalid avatarConfig.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: >
            Not authenticated (UNAUTHORIZED, SESSION_INVALIDATED, REAUTH_REQUIRED), or
            INVALID_CURRENT_PASSWORD. INVALID_CURRENT_PASSWORD leaves the session and cookie as
            they were; nothing is changed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '429':
          description: >
            RATE_LIMITED: too many wrong currentPassword attempts (10 401 responses per 15
            minutes per IP; successes, 400 validation errors and requests without
            currentPassword do not count).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /users/me/history:
    get:
      summary: Get the authenticated user's game history
      tags: [Users]
      security:
        - sessionCookie: []
      parameters:
        - name: page
          in: query
          schema:
            type: integer
            default: 1
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
            maximum: 100
        - name: outcome
          in: query
          schema:
            type: string
            enum: [win, loss, incomplete]
          description: Filter by outcome.
      responses:
        '200':
          description: Paginated list of game results.
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/GameResultEntry'
                  total:
                    type: integer
                  page:
                    type: integer
                  limit:
                    type: integer
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /users/me/metrics:
    get:
      summary: Get the authenticated user's performance metrics
      tags: [Users]
      security:
        - sessionCookie: []
      responses:
        '200':
          description: Aggregated player metrics.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PlayerMetrics'
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## Lobby Endpoints

```yaml
  /lobby/rooms:
    get:
      summary: List all active rooms
      description: >
        Returns all rooms in the open or in_progress state.
        Rooms in completing or closed states are excluded.
        Used to populate the lobby room list.
      tags: [Lobby]
      security:
        - sessionCookie: []
      responses:
        '200':
          description: List of active rooms.
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
                      format: uuid
                    state:
                      type: string
                      enum: [open, in_progress]
                    hostUserId:
                      type: string
                      format: uuid
                    config:
                      $ref: '#/components/schemas/RoomConfig'
                    playerCount:
                      type: integer
                    spectatorCount:
                      type: integer
                    maxPlayers:
                      type: integer
                      example: 10
                    maxSpectators:
                      type: integer
                      example: 5
                    createdAt:
                      type: string
                      format: date-time
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /lobby/presence:
    get:
      summary: Get the list of users currently in the lobby
      description: >
        Returns users who are authenticated and in the lobby
        (not currently in any room or game).
        Used to display lobby presence list.
      tags: [Lobby]
      security:
        - sessionCookie: []
      responses:
        '200':
          description: List of users in the lobby.
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    userId:
                      type: string
                      format: uuid
                    displayName:
                      type: string
                    avatarConfig:
                      $ref: '#/components/schemas/AvatarConfig'
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## Room Endpoints

```yaml
  /rooms:
    post:
      summary: Open a new room
      description: >
        Creates a new room and assigns the requesting user as host.
        User must not already be in an active room or game.
        Room config can be updated later; round count defaults to max for
        the current player count and must be confirmed before game start.
      tags: [Rooms]
      security:
        - sessionCookie: []
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                config:
                  $ref: '#/components/schemas/RoomConfig'
      responses:
        '201':
          description: Room created.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Room'
        '401':
          description: >
            Not authenticated, or REAUTH_REQUIRED: the session is within 24 hours of its
            30-day cap, so the user must log in again before entering a new game.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: REAUTH_REQUIRED
                message: Your session is about to expire. Please log in again.
        '409':
          description: User is already in a room or game.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: ALREADY_IN_ROOM
                message: You are already in an active room or game.

  /rooms/{roomId}:
    get:
      summary: Get room details
      tags: [Rooms]
      security:
        - sessionCookie: []
      parameters:
        - name: roomId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Room details including members.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Room'
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Room not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

    delete:
      summary: Close a room (host only, before game starts)
      tags: [Rooms]
      security:
        - sessionCookie: []
      parameters:
        - name: roomId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '204':
          description: Room closed. All members returned to lobby via socket event.
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: Not the host, or game already started.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Room not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /rooms/{roomId}/config:
    patch:
      summary: Update room configuration (host only, before game starts)
      tags: [Rooms]
      security:
        - sessionCookie: []
      parameters:
        - name: roomId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                roundCount:
                  type: integer
                  minimum: 1
                bidRule:
                  type: string
                  enum: [open, uneven]
      responses:
        '200':
          description: Config updated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RoomConfig'
        '400':
          description: roundCount exceeds maximum for current player count.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: ROUND_COUNT_EXCEEDS_MAX
                message: Maximum rounds for 5 players is 12.
        '403':
          description: Not the host or game already started.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /rooms/{roomId}/join:
    post:
      summary: Join a room as a player or spectator
      tags: [Rooms]
      security:
        - sessionCookie: []
      parameters:
        - name: roomId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [role]
              properties:
                role:
                  type: string
                  enum: [player, spectator]
      responses:
        '200':
          description: Joined room successfully.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Room'
        '401':
          description: >
            Not authenticated, or REAUTH_REQUIRED: the session is within 24 hours of its
            30-day cap, so the user must log in again before entering a new game.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: REAUTH_REQUIRED
                message: Your session is about to expire. Please log in again.
        '400':
          description: Invalid role.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: >
            Room is not joinable (in_progress for players, completing/closed for all).
            A user who previously left an open room may rejoin it in either role;
            a player who quit an in_progress game may rejoin only as a spectator.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: ROOM_NOT_JOINABLE
                message: This room is not accepting new players.
        '409':
          description: Room is full (player or spectator limit reached) or user already in a room.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: ROOM_FULL
                message: This room has reached its player limit.

  /rooms/{roomId}/leave:
    post:
      summary: Leave a room voluntarily
      description: >
        If leaving before game starts, removes the user from the room.
        If the host leaves before game starts, host transfers to next player.
        If leaving during a game (as a player), the player has quit: they are permanently
        removed and cannot rejoin as a player (they may rejoin as a spectator), and the
        player-drop rules apply: with 3 or more players left the current round is voided and
        re-dealt; with 2 the remaining players are asked whether to continue; with 1 the game
        ends incomplete (see the WebSocket Event Taxonomy, `user_left`). Host transfer skips
        spectators; if no players remain, the room closes.
        Once the game is over (room `completing`, the game-over countdown) anyone may leave;
        it is not a quit. The last member to leave closes the room at once.
      tags: [Rooms]
      security:
        - sessionCookie: []
      parameters:
        - name: roomId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '204':
          description: Left the room successfully.
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: >
            `GAME_ALREADY_STARTED`: a player cannot leave a game in progress yet (player-drop
            rules are not built).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Room not found or user not in this room.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /rooms/{roomId}/start:
    post:
      summary: Start the game (host only)
      description: >
        Transitions the room from open to in_progress and starts the game.
        Requires at least 3 players. Once started, no new players can join
        (spectators still can). Creates the games row; the players are seated
        in join order and seat 1 deals round 1. The game itself arrives over the
        socket: game_starting, game_started, round_started, then each player's
        hand_dealt (see the WebSocket Event Taxonomy).
      tags: [Rooms]
      security:
        - sessionCookie: []
      parameters:
        - name: roomId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Game started. Returns the room, now in_progress.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Room'
        '401':
          description: >
            Not authenticated, or REAUTH_REQUIRED: the session is within 24 hours of its
            30-day cap, so the user must log in again before entering a new game.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: REAUTH_REQUIRED
                message: Your session is about to expire. Please log in again.
        '400':
          description: Not enough players (minimum 3 required).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: NOT_ENOUGH_PLAYERS
                message: At least 3 players are required to start.
        '403':
          description: Not the host (NOT_HOST), or the game already started (GAME_ALREADY_STARTED).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Room not found or closed.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## Game Endpoints

```yaml
  /games/{gameId}:
    get:
      summary: Get game summary
      description: >
        Returns high-level game information including status, player list,
        and per-round scoring summary. Does not include hand data.
        Available during and after the game.
      tags: [Games]
      security:
        - sessionCookie: []
      parameters:
        - name: gameId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Game summary.
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                    format: uuid
                  roomId:
                    type: string
                    format: uuid
                  status:
                    type: string
                    enum: [in_progress, complete, incomplete]
                  config:
                    $ref: '#/components/schemas/RoomConfig'
                  players:
                    type: array
                    items:
                      type: object
                      properties:
                        userId:
                          type: string
                          format: uuid
                        displayName:
                          type: string
                        avatarConfig:
                          $ref: '#/components/schemas/AvatarConfig'
                        cumulativeScore:
                          type: integer
                        connected:
                          type: boolean
                  rounds:
                    type: array
                    items:
                      type: object
                      properties:
                        roundNumber:
                          type: integer
                        trumpSuit:
                          type: string
                          nullable: true
                        results:
                          type: array
                          items:
                            type: object
                            properties:
                              userId:
                                type: string
                                format: uuid
                              bid:
                                type: integer
                              tricksWon:
                                type: integer
                              scoreDelta:
                                type: integer
                  startedAt:
                    type: string
                    format: date-time
                  endedAt:
                    type: string
                    format: date-time
                    nullable: true
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: User is not a participant or spectator of this game.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Game not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /games/{gameId}/state:
    get:
      summary: Get the current game state snapshot
      description: >
        Returns the full GameState snapshot for the requesting user.
        For players, includes their own hand. Hand data for other players
        is never included. For spectators, no hand data is returned.
        Used for reconnection restoration (primary delivery is via socket;
        this REST endpoint is a fallback).
      tags: [Games]
      security:
        - sessionCookie: []
      parameters:
        - name: gameId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Current game state for the requesting user.
          content:
            application/json:
              schema:
                type: object
                description: GameState snapshot. Hand included only for the requesting player.
                properties:
                  gameId:
                    type: string
                    format: uuid
                  currentRound:
                    type: integer
                  currentTrick:
                    type: integer
                  trumpSuit:
                    type: string
                    nullable: true
                  phase:
                    type: string
                    enum: [bidding, trick, complete]
                  currentTurnUserId:
                    type: string
                    format: uuid
                    nullable: true
                  myHand:
                    type: array
                    description: Present only when requester is a player.
                    items:
                      type: object
                      properties:
                        suit:
                          type: string
                          nullable: true
                          enum: [hearts, diamonds, spades, clubs]
                        rank:
                          type: integer
                          nullable: true
                          minimum: 2
                          maximum: 14
                        type:
                          type: string
                          enum: [suited, wizard, jester]
                  players:
                    type: array
                    items:
                      type: object
                      properties:
                        userId:
                          type: string
                          format: uuid
                        displayName:
                          type: string
                        bid:
                          type: integer
                          nullable: true
                        tricksWon:
                          type: integer
                        cumulativeScore:
                          type: integer
                        connected:
                          type: boolean
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          description: Not a participant or spectator of this game.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Game not found or not in progress.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## Admin Endpoints

All admin endpoints require an authenticated session with `role: admin`. Non-admin requests receive `403 FORBIDDEN`. The role is read from the database on every request, so a promotion or demotion takes effect on the user's next request without a new login. The usual session rules apply first (`401` for a missing or ended session, `401 REAUTH_REQUIRED` in the re-auth window, `403 CREDENTIAL_CHANGE_REQUIRED` while the admin's own credentials await a forced change). Role changes and credential resets re-check the acting admin's role under a row lock once the work is done, so an admin demoted while their request is in flight gets `403 FORBIDDEN` and nothing is changed. An unknown path under `/admin` is a plain `404`, as for any other unknown route.

Responses that carry a one-time secret (`POST /admin/invites`, `POST /admin/users/{userId}/reset-credentials`) are sent with `Cache-Control: no-store`.

```yaml
  /admin/invites:
    get:
      summary: List all invites
      description: >
        Newest first. Pending invites past their expiry are marked `expired` before the list is
        read. The invite code itself is never stored, so it is never listed.
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: status
          in: query
          schema:
            type: string
            enum: [pending, accepted, expired, revoked]
          description: Filter by invite status.
      responses:
        '200':
          description: List of invites.
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Invite'
        '400':
          description: Unknown status filter (VALIDATION_ERROR).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

    post:
      summary: Create a new invite code
      description: >
        Generates a cryptographically random invite code: 128 random bits as lowercase base32
        (26 characters), grouped in fours with dashes. The raw code is returned once in the
        response and never stored; `invites.code_hash` holds the SHA-256 of the code with the
        dashes removed. The invite expires 7 days after creation. The label is trimmed, and a
        blank label is stored as null.
      tags: [Admin]
      security:
        - sessionCookie: []
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                label:
                  type: string
                  maxLength: 128
                  description: Optional label to identify the intended recipient.
      responses:
        '201':
          description: Invite created. Raw code returned once.
          content:
            application/json:
              schema:
                type: object
                properties:
                  invite:
                    $ref: '#/components/schemas/Invite'
                  code:
                    type: string
                    description: Raw invite code. Show to admin and discard — not stored.
                    example: k3vq-7xmd-wq7a-ph2e-r4tn-j6cb-sy
        '400':
          description: Label is not a string of at most 128 characters (VALIDATION_ERROR).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/invites/{inviteId}:
    delete:
      summary: Revoke a pending invite
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: inviteId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '204':
          description: Invite revoked.
        '400':
          description: >
            Invite is not pending (already accepted, revoked, or past its expiry) and cannot be
            revoked.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: INVITE_NOT_REVOCABLE
                message: Only pending invites can be revoked.
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Invite not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/users:
    get:
      summary: List all registered users
      description: >
        Oldest account first. Each item is the public `User`.
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: role
          in: query
          schema:
            type: string
            enum: [player, admin]
        - name: page
          in: query
          schema:
            type: integer
            default: 1
        - name: limit
          in: query
          schema:
            type: integer
            default: 50
            maximum: 200
      responses:
        '200':
          description: Paginated list of users.
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      $ref: '#/components/schemas/User'
                  total:
                    type: integer
                  page:
                    type: integer
                  limit:
                    type: integer
        '400':
          description: Unknown role, or page / limit not an integer in range (VALIDATION_ERROR).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/bug-reports:
    get:
      summary: List bug reports
      description: >
        Newest first. Each item is the stored report with the reporter's
        username and display name joined in. `context` is returned as stored
        (see data-model.md, bug_reports.context); its `game_state_summary`
        holds the reporter's own player view, including their hand, which is
        why the route is admin-only. Search the server logs by `traceId`.
        Without `status`, both open and dismissed reports are listed.
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: severity
          in: query
          schema:
            type: string
            enum: [low, medium, high]
        - name: status
          in: query
          description: "`open`: not yet dismissed (resolution is null). `dismissed`: has a resolution."
          schema:
            type: string
            enum: [open, dismissed]
        - name: page
          in: query
          schema:
            type: integer
            default: 1
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
            maximum: 100
      responses:
        '200':
          description: Paginated list of bug reports.
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      type: object
                      properties:
                        id:
                          type: string
                          format: uuid
                        createdAt:
                          type: string
                          format: date-time
                        severity:
                          type: string
                          enum: [low, medium, high]
                          nullable: true
                        description:
                          type: string
                        reporter:
                          type: object
                          nullable: true
                          description: >
                            Null when the report has no user_id. The submit route
                            always sets it, so this is not expected; accounts with
                            reports cannot be deleted (user_id is a foreign key).
                          properties:
                            id:
                              type: string
                              format: uuid
                            username:
                              type: string
                              nullable: true
                            displayName:
                              type: string
                              nullable: true
                        roomId:
                          type: string
                          format: uuid
                          nullable: true
                        gameId:
                          type: string
                          format: uuid
                          nullable: true
                        traceId:
                          type: string
                          format: uuid
                        context:
                          type: object
                        resolution:
                          type: string
                          enum: [resolved, not_a_bug, cannot_reproduce, wont_fix]
                          nullable: true
                          description: Why an admin dismissed the report. Null while it is open.
                        resolvedAt:
                          type: string
                          format: date-time
                          nullable: true
                        resolvedBy:
                          type: object
                          nullable: true
                          description: The admin who dismissed the report. Null while it is open.
                          properties:
                            id:
                              type: string
                              format: uuid
                            username:
                              type: string
                              nullable: true
                            displayName:
                              type: string
                              nullable: true
                  total:
                    type: integer
                  page:
                    type: integer
                  limit:
                    type: integer
        '400':
          description: Unknown severity or status, or page / limit not an integer in range (VALIDATION_ERROR).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/bug-reports/{reportId}:
    patch:
      summary: Dismiss or reopen a bug report
      description: >
        Dismisses a handled report with the reason, recording the acting admin and the time, or
        reopens it with `resolution: null`, which clears all three. Dismissing a report that is
        already dismissed replaces its resolution, admin and time.
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: reportId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [resolution]
              properties:
                resolution:
                  type: string
                  enum: [resolved, not_a_bug, cannot_reproduce, wont_fix]
                  nullable: true
      responses:
        '200':
          description: >
            The updated report, in the same shape as a `GET /admin/bug-reports` item.
          content:
            application/json:
              schema:
                type: object
        '400':
          description: "`resolution` missing, or not null or one of the four values (VALIDATION_ERROR)."
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Not authenticated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: Bug report not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/users/{userId}/role:
    patch:
      summary: Update a user's role
      description: >
        Promotes a player to admin or demotes an admin to player.
        An admin cannot demote themselves (to prevent accidental lockout); another admin must.
        Setting a user's current role again succeeds and changes nothing. The acting admin's role
        is re-checked under a row lock, so two admins demoting each other at the same moment
        cannot both succeed: the second gets 403.
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: userId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [role]
              properties:
                role:
                  type: string
                  enum: [player, admin]
      responses:
        '200':
          description: Role updated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '400':
          description: >
            Admin attempting to demote themselves (SELF_DEMOTION_FORBIDDEN), or `role` missing
            or not one of the enum values (VALIDATION_ERROR).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: SELF_DEMOTION_FORBIDDEN
                message: You cannot remove your own admin role.
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: User not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/users/{userId}/reset-credentials:
    post:
      summary: Admin reset of a user's password and recovery passphrase
      description: >
        Sets a temporary password and recovery passphrase for the user.
        Admin use only, for cases where a user has lost access to both credentials.
        The server generates both (100 random bits each, lowercase base32 grouped in fours with
        dashes), stores only their bcrypt hashes, and returns them once; there is no request body.
        Sets requires_credential_change = true and clears password_changed_at and
        recovery_changed_at, so the user must change both on next login (PATCH /users/me).
        Ends every session of the user: their devices get 401 SESSION_INVALIDATED (and sockets
        session_error) with reason `admin_reset`. An admin cannot reset their own credentials
        (they change them from their profile with PATCH /users/me).
      tags: [Admin]
      security:
        - sessionCookie: []
      parameters:
        - name: userId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: Temporary credentials set.
          content:
            application/json:
              schema:
                type: object
                properties:
                  temporaryPassword:
                    type: string
                    description: One-time temporary password. Share with user securely.
                    example: m4qz-t7wd-k2pa-x5eh-c3nr
                  temporaryPassphrase:
                    type: string
                    description: One-time temporary recovery passphrase.
                    example: b6sv-h2gy-q3fm-z4ul-w5ok
                  note:
                    type: string
                    example: The user's credentials are marked temporary. They will be prompted to change their password and recovery passphrase on next login.
        '400':
          description: The admin named themselves (SELF_RESET_FORBIDDEN).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
              example:
                code: SELF_RESET_FORBIDDEN
                message: Change your own credentials from your profile.
        '403':
          description: Not an admin (including an admin demoted while the request was in flight).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '404':
          description: User not found.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## Bug Report Endpoint

```yaml
  /bug-reports:
    post:
      summary: Submit a bug report
      description: >
        Accepts a user-submitted bug report with automatic context. Requires a
        session: the report is linked to the user and to the trace ID of their
        session, which correlates it with the server logs. The usual session
        checks apply (REAUTH_REQUIRED in the re-auth window unless mid-game;
        CREDENTIAL_CHANGE_REQUIRED while a credential change is pending).
        The server works out the reporter's room and game from their active
        membership (the client's roomId/gameId are a fallback, kept only if
        those rows exist), takes the user agent from the request header, and,
        for a player seated in a live game, stores their own
        game.toPlayerView(userId) as context.game_state_summary. It never stores
        another player's hand; a client-sent gameStateSummary is ignored.
        Logged at INFO with the trace ID. Rate limited to 10 reports per hour
        per user.
      tags: [BugReports]
      security:
        - sessionCookie: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [description, context]
              properties:
                description:
                  type: string
                  minLength: 1
                  maxLength: 2000
                  description: User-written description of the issue.
                severity:
                  type: string
                  enum: [low, medium, high]
                  description: Optional severity rating provided by the user.
                context:
                  type: object
                  description: Automatically captured client-side context.
                  required: [url, clientTimestamp]
                  properties:
                    url:
                      type: string
                      format: uri
                      maxLength: 2048
                      description: http(s) URL of the page the user was on.
                    page:
                      type: string
                      maxLength: 64
                      example: game
                    roomId:
                      type: string
                      format: uuid
                      nullable: true
                    gameId:
                      type: string
                      format: uuid
                      nullable: true
                    roundNumber:
                      type: integer
                      nullable: true
                    trickNumber:
                      type: integer
                      nullable: true
                    gameStateSummary:
                      type: object
                      nullable: true
                      deprecated: true
                      description: >
                        Ignored. The server stores the reporter's own player view
                        instead, so a report can never carry a hand the reporter
                        did not hold.
                    userAgent:
                      type: string
                      maxLength: 512
                      description: Used only if the request has no User-Agent header.
                    clientTimestamp:
                      type: string
                      format: date-time
      responses:
        '201':
          description: Bug report submitted successfully.
          content:
            application/json:
              schema:
                type: object
                properties:
                  reportId:
                    type: string
                    format: uuid
                  message:
                    type: string
                    example: Your report has been submitted. Thank you.
        '400':
          description: >
            Validation error (missing or invalid description, severity or
            context). details.fields is keyed by field, e.g. `description`,
            `context.url`, `context.clientTimestamp`.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: No valid session (UNAUTHORIZED, SESSION_INVALIDATED or REAUTH_REQUIRED).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '403':
          description: CREDENTIAL_CHANGE_REQUIRED.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '429':
          description: Rate limited (10 reports per hour per user) to prevent report flooding.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
```

## Health Endpoint

```yaml
  /health:
    get:
      summary: Health check
      description: Returns the server's current health status. No authentication required. Safe to call from monitoring systems and smoke tests.
      operationId: getHealth
      tags: [Health]
      security: []
      responses:
        '200':
          description: Server is healthy
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status:
                    type: string
                    enum: [ok]
                    example: ok
        '500':
          $ref: '#/components/responses/InternalServerError'
```

## Error Catalogue

All error responses use the `Error` schema: `{ code: string, message: string, details?: object }`. The `code` is a machine-readable string constant for client handling. The `message` is human-readable. `details` is optional and carries field-level validation errors where applicable.

| HTTP Status | Error Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Request body or query param failed validation. `details` contains field errors. |
| 400 | `ROUND_COUNT_EXCEEDS_MAX` | Selected round count is above the maximum for the current player count. |
| 400 | `NOT_ENOUGH_PLAYERS` | Game start attempted with fewer than 3 players. |
| 400 | `INVITE_NOT_REVOCABLE` | Invite is not pending (accepted, revoked, or past its expiry). |
| 400 | `SELF_DEMOTION_FORBIDDEN` | Admin attempted to remove their own admin role. |
| 400 | `SELF_RESET_FORBIDDEN` | Admin attempted to reset their own credentials through the admin route. |
| 401 | `UNAUTHORIZED` | No valid session cookie present. |
| 401 | `INVALID_CREDENTIALS` | Username or password is incorrect on login. |
| 401 | `INVALID_CURRENT_PASSWORD` | `currentPassword` is wrong on `PATCH /users/me`. Not a session failure: the session stays valid. |
| 401 | `INVALID_RECOVERY` | Username not found or recovery passphrase does not match on password reset (one response for both). |
| 401 | `SESSION_INVALIDATED` | Session was invalidated by a new login on another device, a logout, a password reset, or a password / passphrase change. `details.reason` says which (`displaced`, `logout`, `password_reset`, `credential_change`, `admin_reset`) when it was recorded. The session cookie is not cleared: a stale request must not wipe a cookie the browser has just replaced. |
| 401 | `REAUTH_REQUIRED` | Session is within 24 hours of its 30-day cap. The user must log in again before doing anything except finishing a game in progress. The session is still valid and the cookie is not cleared. |
| 403 | `FORBIDDEN` | Authenticated but not permitted (e.g. non-admin on admin route). |
| 403 | `CREDENTIAL_CHANGE_REQUIRED` | An admin reset this user's credentials. Only `GET /users/me`, `PATCH /users/me` and `POST /auth/logout` are allowed until both the password and recovery passphrase are changed. |
| 403 | `NOT_HOST` | Action requires host role in the room. |
| 403 | `GAME_ALREADY_STARTED` | Action is only valid before the game starts. |
| 403 | `ROOM_NOT_JOINABLE` | Room state does not permit joining. |
| 403 | `NOT_IN_GAME` | Action requires the user to be a participant of this game. |
| 404 | `NOT_FOUND` | Generic not found. Used for rooms, games, users, invites. |
| 409 | `ALREADY_IN_ROOM` | User is already an active member of a room or game. |
| 409 | `USERNAME_TAKEN` | Username is already registered. |
| 409 | `ROOM_FULL` | Room has reached its player or spectator limit. |
| 413 | `PAYLOAD_TOO_LARGE` | Request body is over the JSON body size limit (100 KB). |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Request body uses an unsupported content encoding or charset. |
| 422 | `INVITE_INVALID` | Invite code not found, expired, or already redeemed. |
| 429 | `RATE_LIMITED` | Too many requests. Applies to auth endpoints, failed `currentPassword` attempts on `PATCH /users/me`, and bug report endpoints. |
| 500 | `INTERNAL_ERROR` | Unexpected server error. Includes a `traceId` field in `details` for correlation with logs. |

### 500 Internal Error Shape

```yaml
# All 500 responses include the trace ID for log correlation
{
  code: "INTERNAL_ERROR",
  message: "An unexpected error occurred.",
  details: {
    traceId: "uuid"
  }
}
```

### Notes

- All endpoints that require authentication return `401 UNAUTHORIZED` when no valid session is present — not `403`.
- `403` is reserved for cases where the user is authenticated but lacks permission for the specific action.
- Sessions use a sliding 24-hour idle timeout with a 30-day hard cap. In the last 24 hours before the cap, authenticated requests return `401 REAUTH_REQUIRED` unless the user is an active player in a game in progress. `POST /rooms`, `POST /rooms/{roomId}/join`, and `POST /rooms/{roomId}/start` return it in that window regardless, so no game can start that the session would not outlast (games are capped at 3 hours). `POST /auth/logout` is always allowed.
- The `traceId` in 500 responses matches the `trace_id` on the user's session record and in server logs, enabling support correlation.
- Rate limiting headers (`Retry-After`, `X-RateLimit-Remaining`) are returned on `429` responses.
