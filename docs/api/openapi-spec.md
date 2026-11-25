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
      required: [head, skin, face, hair]
      properties:
        head:
          type: string
          example: round
        skin:
          type: string
          example: medium
        face:
          type: string
          example: smile-01
        hair:
          type: string
          example: curly-short-brown

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
        avatarSvg:
          type: string
          nullable: true
          description: Cached SVG string of the fully composited avatar. Null if not yet set.
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
              required: [inviteCode, username, displayName, password, recoveryPassphrase, avatarConfig, avatarSvg]
              properties:
                inviteCode:
                  type: string
                  example: ABC123XYZ
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
                  description: Used to reset password if forgotten. Stored hashed.
                avatarConfig:
                  $ref: '#/components/schemas/AvatarConfig'
                avatarSvg:
                  type: string
                  nullable: true
                  description: >
                    Serialized SVG string of the fully composited avatar, produced by the
                    builder UI. The key is required; the value may be null if not yet set.
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
        Updates one or more mutable profile fields.
        Username is immutable and cannot be changed.
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
                avatarConfig:
                  $ref: '#/components/schemas/AvatarConfig'
                avatarSvg:
                  type: string
                  description: Serialized SVG string of the composited avatar. Required when avatarConfig is provided.
                password:
                  type: string
                  minLength: 8
                  format: password
                  description: New password. Requires currentPassword to be provided.
                currentPassword:
                  type: string
                  format: password
                  description: Required when changing password.
                recoveryPassphrase:
                  type: string
                  minLength: 8
                  format: password
                  description: New recovery passphrase.
      responses:
        '200':
          description: Profile updated.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '400':
          description: Validation error or currentPassword missing when changing password.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '401':
          description: Not authenticated or currentPassword incorrect.
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
        If leaving during a game (as a player), the player is permanently
        removed and cannot rejoin as a player (they may rejoin as a spectator).
        Current round is voided and re-dealt. Host transfer skips spectators;
        if no players remain, the room closes.
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
        Requires at least 3 players. Once started, no new players can join.
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
          description: Game started. Returns the initial game state.
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
          description: Not the host.
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

All admin endpoints require an authenticated session with `role: admin`. Non-admin requests receive `403 FORBIDDEN`.

```yaml
  /admin/invites:
    get:
      summary: List all invites
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
        Generates a cryptographically random invite code.
        The raw code is returned once in the response and never stored.
        The hash is stored in the database.
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
                    example: XK9P2MWQRTJ4
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
          description: Invite is not in pending status and cannot be revoked.
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
        '403':
          description: Not an admin.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'

  /admin/users/{userId}/role:
    patch:
      summary: Update a user's role
      description: >
        Promotes a player to admin or demotes an admin to player.
        An admin cannot demote themselves (to prevent accidental lockout).
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
          description: Admin attempting to demote themselves.
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
        Returns the temporary credentials once; user must change them on next login.
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
                  temporaryPassphrase:
                    type: string
                    description: One-time temporary recovery passphrase.
                  note:
                    type: string
                    example: The user's credentials are marked temporary. They will be prompted to change their password and recovery passphrase on next login.
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
```

## Bug Report Endpoint

```yaml
  /bug-reports:
    post:
      summary: Submit a bug report
      description: >
        Accepts a user-submitted bug report with automatic context.
        If the user is authenticated, the report is linked to their account
        and enriched with the server-side trace ID from their session.
        Available at all times; no authentication required (but session
        is used if present to enrich the report).
      tags: [BugReports]
      security:
        - sessionCookie: []
        - {}  # Also accepts unauthenticated submissions
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
                    page:
                      type: string
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
                      description: Lightweight snapshot of game state at time of report.
                    userAgent:
                      type: string
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
          description: Validation error (missing description or context).
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '429':
          description: Rate limited (prevent report flooding).
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
| 400 | `INVITE_NOT_REVOCABLE` | Invite is not in pending status. |
| 400 | `SELF_DEMOTION_FORBIDDEN` | Admin attempted to remove their own admin role. |
| 401 | `UNAUTHORIZED` | No valid session cookie present. |
| 401 | `INVALID_CREDENTIALS` | Username or password is incorrect on login. |
| 401 | `INVALID_RECOVERY` | Username not found or recovery passphrase does not match on password reset (one response for both). |
| 401 | `SESSION_INVALIDATED` | Session was invalidated by a new login on another device. |
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
| 429 | `RATE_LIMITED` | Too many requests. Applies to auth and bug report endpoints. |
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
