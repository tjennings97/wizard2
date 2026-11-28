import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config } from '../config';
import { isSessionInvalidated } from '../auth/sessions';
import { sessionEvents, type InvalidationReason } from '../auth/sessionEvents';
import { userEvents } from '../auth/userEvents';
import { getUserProfile } from '../auth/users';
import type { AvatarConfig } from '../shared/avatar';
import { logger } from '../logger';
import { activeMembershipFor, getRoomView, listLobbyRooms, type RoomSummary, type RoomView } from '../rooms/queries';
import type { RoomService } from '../rooms/service';
import { authenticateSocket, INVALIDATION_MESSAGES, recheckSocketSession, SESSION_ERROR_MESSAGES } from './auth';
import { NotAPlayerError, type GameService } from '../games/service';
import { abandonedGameFor } from '../games/queries';
import { gameAbandonedPayload } from '../games/payloads';
import { ApiError } from '../http/errors';
import { Realtime, sessionChannel, userChannel, type AppServer, type AppSocket } from './realtime';

export interface AttachedSocket {
  io: AppServer;
  realtime: Realtime;
  /** Stops listening for ended sessions. Call when closing `io`. */
  detach(): void;
}

/**
 * Creates the Socket.io server and makes it the room service's notifier.
 *
 * On connect: authenticates the session cookie (session_error + disconnect on failure), then
 * puts the socket where the user is (placeSocket): in their open room (room_snapshot), in the
 * channel of a started game, or in the lobby (lobby_snapshot, and presence_updated to everyone
 * else there).
 */
export interface SocketOptions {
  /** Minimum time between session re-checks on game actions, per socket. Tests lower it. */
  sessionRecheckMs?: number;
  /** A socket that has pinged is disconnected after this long without another ping. Tests lower it. */
  pingTimeoutMs?: number;
}

/** No `ping` from a client that pings (every 15 s) for this long: treated as a disconnect. */
export const PING_TIMEOUT_MS = 30 * 1000;

interface Timing {
  recheckMs: number;
  pingTimeoutMs: number;
}

export function attachSocket(httpServer: HttpServer, rooms: RoomService, options: SocketOptions = {}): AttachedSocket {
  const io: AppServer = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });
  const realtime = new Realtime(io, rooms.games);
  rooms.setNotifier(realtime);
  rooms.games.setNotifier(realtime);
  const timing: Timing = {
    recheckMs: options.sessionRecheckMs ?? SESSION_RECHECK_MS,
    pingTimeoutMs: options.pingTimeoutMs ?? PING_TIMEOUT_MS,
  };

  // A newer login, a password reset or a logout ended these sessions: drop their sockets.
  const onInvalidated = (sessionIds: string[], reason: InvalidationReason) =>
    realtime.sessionsInvalidated(sessionIds, reason, INVALIDATION_MESSAGES[reason]);
  sessionEvents.on('invalidated', onInvalidated);
  const onDisplayName = (userId: string, displayName: string) => {
    realtime.displayNameChanged(userId, displayName).catch((err) =>
      logger.error({ err, userId }, 'refreshing a renamed user failed'),
    );
  };
  userEvents.on('displayNameChanged', onDisplayName);
  const onAvatar = (userId: string, avatarConfig: AvatarConfig) => realtime.avatarChanged(userId, avatarConfig);
  userEvents.on('avatarChanged', onAvatar);

  io.on('connection', (socket: AppSocket) => {
    socket.data.seq = 0;
    socket.data.roomId = null;
    socket.data.moves = 0;
    socket.data.placed = false;
    socket.data.authCheckedAt = Date.now();
    socket.data.inbox = Promise.resolve();
    socket.data.pingWatchdog = null;
    void onConnection(realtime, rooms, socket, timing).catch((err) => {
      realtime.logError(socket, err, 'socket connect handling failed');
      socket.disconnect(true);
    });
  });

  return {
    io,
    realtime,
    detach: () => {
      sessionEvents.off('invalidated', onInvalidated);
      userEvents.off('displayNameChanged', onDisplayName);
      userEvents.off('avatarChanged', onAvatar);
    },
  };
}

async function onConnection(realtime: Realtime, rooms: RoomService, socket: AppSocket, timing: Timing): Promise<void> {
  const auth = await authenticateSocket(socket.handshake.headers.cookie);
  if (!auth.ok) {
    logger.info(
      { socketId: socket.id, userId: auth.userId, traceId: auth.traceId, code: auth.code },
      'socket rejected',
    );
    // An already-ended session says why, as the live SESSION_INVALIDATED does.
    realtime.rejectSocket(socket, auth.code, SESSION_ERROR_MESSAGES[auth.code], auth.reason ? { reason: auth.reason } : {});
    return;
  }
  if (!socket.connected) return;

  const { user, session } = auth;
  socket.data.userId = user.id;
  socket.data.sessionId = session.id;
  socket.data.traceId = session.traceId;
  socket.data.user = { userId: user.id, displayName: user.displayName, avatarConfig: user.avatarConfig };
  socket.join(sessionChannel(session.id));
  socket.join(userChannel(user.id));

  // Registered as soon as the socket counts as connected (it is in the user channel), so no
  // disconnect from here on is missed.
  socket.on('disconnect', (reason) => {
    logger.info({ ...realtime.logContext(socket), reason }, 'socket disconnected');
    if (socket.data.pingWatchdog) clearTimeout(socket.data.pingWatchdog);
    // The user's last socket in a room with a game: a player still seated keeps the seat for the
    // reconnection window (player_disconnected). Not a quit.
    const roomId = socket.data.roomId;
    if (roomId !== null && !realtime.isInRoom(roomId, user.id)) {
      rooms.games.playerDisconnected(roomId, user.id).catch((err) => realtime.logError(socket, err, 'player disconnect handling failed'));
    }
    // Rooms are already left by now; another tab may still hold the user's lobby presence.
    if (socket.data.roomId === null && !realtime.isInLobby(user.id)) realtime.broadcastPresence();
    if (realtime.isConnected(user.id)) return;
    // The user's last socket is gone: start the host-away grace period (a no-op unless they
    // host an open room). A socket that dropped before it was placed has no roomId yet, and the
    // user's earlier away timer may have fired while it was connecting, so look the room up.
    if (socket.data.roomId !== null) {
      rooms.userDisconnected(user.id, socket.data.roomId);
    } else if (!socket.data.placed) {
      armAwayFromMembership(rooms, user.id).catch((err) => realtime.logError(socket, err, 'host-away arm failed'));
    }
  });

  // An invalidation emitted while authenticateSocket was querying found no socket in the session
  // channel. Now that this socket is in it, check once more so it cannot slip through.
  if (await isSessionInvalidated(session.id)) {
    realtime.rejectSocket(socket, 'SESSION_INVALIDATED', SESSION_ERROR_MESSAGES.SESSION_INVALIDATED);
    return;
  }
  if (!socket.connected) return;

  // Likewise a rename or avatar change saved while authenticateSocket was querying found no
  // socket in the user channel, so this one still carries the old profile. Re-read it, unless a
  // change event has updated the socket since (each replaces socket.data.user), which is newer.
  const before = socket.data.user;
  const profile = await getUserProfile(user.id);
  if (profile && socket.data.user === before) socket.data.user = { userId: user.id, ...profile };
  if (!socket.connected) return;

  registerClientEvents(realtime, rooms, socket, timing);
  if (!(await placeSocket(realtime, socket))) return;
  socket.data.placed = true;
  // Only now is the user back where they belong: they keep the host role.
  rooms.userReconnected(user.id);
  logger.info({ ...realtime.logContext(socket), placement: socket.data.roomId ? 'room' : 'lobby' }, 'socket connected');
}

async function armAwayFromMembership(rooms: RoomService, userId: string): Promise<void> {
  const membership = await activeMembershipFor(userId);
  if (membership?.roomState === 'open') rooms.userDisconnected(userId, membership.roomId);
}

type Placement =
  | { kind: 'room'; room: RoomView }
  | { kind: 'game'; roomId: string }
  | { kind: 'lobby'; rooms: RoomSummary[] };

async function readPlacement(userId: string): Promise<Placement> {
  const membership = await activeMembershipFor(userId);
  if (!membership) return { kind: 'lobby', rooms: await listLobbyRooms() };
  if (membership.roomState === 'open') {
    const room = await getRoomView(membership.roomId);
    if (room) return { kind: 'room', room };
  }
  return { kind: 'game', roomId: membership.roomId };
}

function applyPlacement(realtime: Realtime, socket: AppSocket, target: Placement): void {
  switch (target.kind) {
    case 'room':
      realtime.enterRoom(socket, target.room);
      break;
    case 'game':
      // A game has started in this room: state_snapshot if it is live in this process. A game
      // lost to a restart has nothing to send yet (startup cleanup comes with player drops).
      void realtime.enterGame(socket, target.roomId).catch((err) => realtime.logError(socket, err, 'game snapshot failed'));
      break;
    case 'lobby':
      realtime.enterLobby(socket, target.rooms);
      realtime.broadcastPresence();
      break;
  }
}

const MAX_PLACEMENT_READS = 5;

/**
 * Puts the socket where the user is (room, started game or lobby) and sends the snapshot.
 *
 * The socket is in the user channel while this reads, so a create, join, leave or close in
 * another tab can move it (RoomNotifier) at any point, and a read can return state from before a
 * change whose broadcast this socket then missed. So: apply only a read the notifier did not
 * overtake, then read again and stop once a read matches what was applied. A change committed
 * after that last read began is broadcast to the channels the socket is already in.
 *
 * Returns false if the socket disconnected meanwhile.
 */
async function placeSocket(realtime: Realtime, socket: AppSocket): Promise<boolean> {
  let applied: string | null = null;
  for (let i = 0; i < MAX_PLACEMENT_READS; i++) {
    const moves = socket.data.moves;
    const target = await readPlacement(socket.data.userId);
    if (!socket.connected) return false;
    if (socket.data.moves !== moves) {
      // The notifier placed the socket during the read; this read may be older than that.
      applied = null;
      continue;
    }
    const key = JSON.stringify(target);
    if (key === applied) return true;
    applyPlacement(realtime, socket, target);
    applied = key;
  }
  logger.warn(realtime.logContext(socket), 'socket placement did not settle; keeping the last one');
  return true;
}

/** Game actions re-check the session (and slide it) at most this often per socket. */
export const SESSION_RECHECK_MS = 5 * 60 * 1000;

function payloadOf(envelope: unknown): Record<string, unknown> {
  const payload = (envelope as { payload?: unknown } | null)?.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

/**
 * The client events. Each one except ping is handled after the previous event from this socket,
 * so a socket's events reach the game in the order sent.
 *
 * Game actions (select_trump, place_bid, play_card, choose_continue_or_end): the session is
 * re-validated first, at most once per `recheckMs`, which also slides it: a player who only uses
 * the socket stays logged in. The acting player is always the socket's user; a payload player_id
 * is ignored.
 *
 * join_game and sync_request (same session check): state_snapshot, the events missed after
 * `last_seq_seen`, then the pending prompt. leave_game (same check): leave the room; in a game in
 * progress that is a quit. ping: pong, and the ping watchdog.
 */
function registerClientEvents(realtime: Realtime, rooms: RoomService, socket: AppSocket, timing: Timing): void {
  const games = rooms.games;
  const queue = (event: string, handle: (p: Record<string, unknown>) => Promise<void>) => {
    socket.on(event, (envelope: unknown) => {
      socket.data.inbox = socket.data.inbox
        .then(() => handle(payloadOf(envelope)))
        .catch((err) => realtime.logError(socket, err, `${event} failed`));
    });
  };

  const actions: Record<string, (roomId: string, p: Record<string, unknown>) => Promise<void>> = {
    select_trump: (roomId, p) => games.selectTrump(roomId, actor(socket), p.suit, p.idempotency_key),
    place_bid: (roomId, p) => games.placeBid(roomId, actor(socket), p.bid, p.idempotency_key),
    play_card: (roomId, p) => games.playCard(roomId, actor(socket), p.card, p.idempotency_key),
    choose_continue_or_end: (roomId, p) => games.chooseContinueOrEnd(roomId, actor(socket), p.choice, p.idempotency_key),
  };
  for (const [event, act] of Object.entries(actions)) {
    queue(event, (p) =>
      handleGameAction(realtime, games, socket, timing.recheckMs, event, () => {
        const roomId = socket.data.roomId;
        return roomId ? act(roomId, p) : Promise.resolve();
      }),
    );
  }

  for (const event of ['join_game', 'sync_request']) {
    queue(event, async (p) => {
      if (!socket.connected || !(await checkSession(realtime, socket, timing.recheckMs, event))) return;
      const last = p.last_seq_seen;
      const lastSeqSeen = typeof last === 'number' && Number.isInteger(last) && last >= 0 ? last : null;
      const roomId = socket.data.roomId;
      if (roomId && (await realtime.resyncGame(socket, roomId, lastSeqSeen))) return;
      // Not in a live game: a client still showing one the server abandoned is told so.
      await sendIfAbandoned(realtime, socket);
    });
  }

  queue('leave_game', async () => {
    if (!socket.connected || !(await checkSession(realtime, socket, timing.recheckMs, 'leave_game'))) return;
    const roomId = socket.data.roomId;
    if (!roomId) return;
    try {
      await rooms.leaveRoom(socket.data.userId, roomId);
    } catch (err) {
      if (err instanceof ApiError) {
        logger.debug({ ...realtime.logContext(socket), code: err.code }, 'leave_game refused');
        return;
      }
      realtime.logError(socket, err, 'leave_game failed');
      actionFailed(realtime, socket, 'leave_game');
    }
  });

  socket.on('ping', () => {
    if (socket.data.pingWatchdog) clearTimeout(socket.data.pingWatchdog);
    const watchdog = setTimeout(() => {
      if (socket.data.pingWatchdog !== watchdog || !socket.connected) return;
      logger.info(realtime.logContext(socket), 'no ping from client: disconnecting');
      socket.disconnect(true);
    }, timing.pingTimeoutMs);
    watchdog.unref();
    socket.data.pingWatchdog = watchdog;
    realtime.send(socket, 'pong', { server_time: new Date().toISOString() });
  });
}

/**
 * Re-validates the session before an event (at most once per `recheckMs`; connecting counts).
 * Returns false, having told the client, if the event must not be processed.
 */
async function checkSession(realtime: Realtime, socket: AppSocket, recheckMs: number, event: string): Promise<boolean> {
  if (Date.now() - socket.data.authCheckedAt < recheckMs) return true;
  let code;
  try {
    code = await recheckSocketSession(socket.handshake.headers.cookie, socket.data.sessionId);
  } catch (err) {
    // The check did not run (e.g. a database error): do not apply the event, tell the client,
    // and leave authCheckedAt alone so the next event checks again.
    realtime.logError(socket, err, `${event} session check failed`);
    actionFailed(realtime, socket, event);
    return false;
  }
  if (code) {
    logger.info({ ...realtime.logContext(socket), event: 'socket.session_rejected', code, socketEvent: event }, 'socket rejected on game action');
    realtime.rejectSocket(socket, code, SESSION_ERROR_MESSAGES[code]);
    return false;
  }
  socket.data.authCheckedAt = Date.now();
  return true;
}

/** game_abandoned if the user's latest game was abandoned. Returns whether it was sent. */
async function sendIfAbandoned(realtime: Realtime, socket: AppSocket): Promise<boolean> {
  const abandoned = await abandonedGameFor(socket.data.userId);
  if (!abandoned || !socket.connected) return false;
  realtime.send(socket, 'game_abandoned', gameAbandonedPayload(abandoned.gameId, abandoned.reason));
  return true;
}

const NO_GAME = 'No game is in progress.';

/**
 * A game action from a socket that is not in a room with a live game (for example a client still
 * showing a bid panel after a restart). It is not applied, but answered so the client can recover:
 * game_abandoned if the user's game was abandoned; otherwise the action's error with INVALID_PHASE
 * (choose_continue_or_end has no error event and gets nothing).
 */
async function answerOutsideGame(realtime: Realtime, socket: AppSocket, event: string): Promise<void> {
  if (await sendIfAbandoned(realtime, socket)) return;
  const player_id = socket.data.userId;
  const base = { player_id, code: 'INVALID_PHASE', reason: NO_GAME };
  if (event === 'select_trump') realtime.send(socket, 'invalid_trump_error', base);
  else if (event === 'place_bid') realtime.send(socket, 'invalid_bid_error', { ...base, min_bid: 0, max_bid: 0, allowed_bids: [] });
  else if (event === 'play_card') realtime.send(socket, 'invalid_play_error', { ...base, legal_cards: [] });
}

function actor(socket: AppSocket) {
  return { userId: socket.data.userId, traceId: socket.data.traceId };
}

/** Non-fatal reply when an action could not be processed; the client may retry it. */
function actionFailed(realtime: Realtime, socket: AppSocket, event: string): void {
  realtime.send(socket, 'session_error', {
    code: 'ACTION_FAILED',
    message: `The server could not process ${event}. Try again.`,
    fatal: false,
  });
}

async function handleGameAction(
  realtime: Realtime,
  games: GameService,
  socket: AppSocket,
  recheckMs: number,
  event: string,
  act: () => Promise<void>,
): Promise<void> {
  if (!socket.connected) return;
  const roomId = socket.data.roomId;
  if (!roomId || !games.isLive(roomId)) {
    logger.debug({ ...realtime.logContext(socket), event: 'game.action_outside_game', socketEvent: event }, 'game action outside a live game');
    await answerOutsideGame(realtime, socket, event);
    return;
  }
  if (!(await checkSession(realtime, socket, recheckMs, event))) return;
  try {
    await act();
  } catch (err) {
    if (err instanceof NotAPlayerError) {
      realtime.send(socket, 'session_error', { code: 'SPECTATOR_ACTION_FORBIDDEN', message: err.message, fatal: false });
      return;
    }
    realtime.logError(socket, err, `${event} failed`);
    if (socket.connected) actionFailed(realtime, socket, event);
  }
}
