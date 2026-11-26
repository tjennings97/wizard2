import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config } from '../config';
import { isSessionInvalidated } from '../auth/sessions';
import { sessionEvents, type InvalidationReason } from '../auth/sessionEvents';
import { logger } from '../logger';
import { activeMembershipFor, getRoomView, listLobbyRooms, type RoomSummary, type RoomView } from '../rooms/queries';
import type { RoomService } from '../rooms/service';
import { authenticateSocket, INVALIDATION_MESSAGES, recheckSocketSession, SESSION_ERROR_MESSAGES } from './auth';
import { NotAPlayerError, type GameService } from '../games/service';
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
}

export function attachSocket(httpServer: HttpServer, rooms: RoomService, options: SocketOptions = {}): AttachedSocket {
  const io: AppServer = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });
  const realtime = new Realtime(io, rooms.games);
  rooms.setNotifier(realtime);
  rooms.games.setNotifier(realtime);
  const recheckMs = options.sessionRecheckMs ?? SESSION_RECHECK_MS;

  // A newer login, a password reset or a logout ended these sessions: drop their sockets.
  const onInvalidated = (sessionIds: string[], reason: InvalidationReason) =>
    realtime.sessionsInvalidated(sessionIds, reason, INVALIDATION_MESSAGES[reason]);
  sessionEvents.on('invalidated', onInvalidated);

  io.on('connection', (socket: AppSocket) => {
    socket.data.seq = 0;
    socket.data.roomId = null;
    socket.data.moves = 0;
    socket.data.placed = false;
    socket.data.authCheckedAt = Date.now();
    socket.data.inbox = Promise.resolve();
    void onConnection(realtime, rooms, socket, recheckMs).catch((err) => {
      realtime.logError(socket, err, 'socket connect handling failed');
      socket.disconnect(true);
    });
  });

  return { io, realtime, detach: () => sessionEvents.off('invalidated', onInvalidated) };
}

async function onConnection(realtime: Realtime, rooms: RoomService, socket: AppSocket, recheckMs: number): Promise<void> {
  const auth = await authenticateSocket(socket.handshake.headers.cookie);
  if (!auth.ok) {
    logger.info(
      { socketId: socket.id, userId: auth.userId, traceId: auth.traceId, code: auth.code },
      'socket rejected',
    );
    realtime.rejectSocket(socket, auth.code, SESSION_ERROR_MESSAGES[auth.code]);
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

  registerGameActions(realtime, rooms.games, socket, recheckMs);
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
 * select_trump, place_bid and play_card. Each is handled after the previous event from this socket, so a
 * socket's actions reach the game in the order sent. The session is re-validated first, at most
 * once per `recheckMs`, which also slides it: a player who only uses the socket stays logged in.
 * The acting player is always the socket's user; a payload player_id is ignored.
 */
function registerGameActions(realtime: Realtime, games: GameService, socket: AppSocket, recheckMs: number): void {
  const actions: Record<string, (roomId: string, p: Record<string, unknown>) => Promise<void>> = {
    select_trump: (roomId, p) => games.selectTrump(roomId, actor(socket), p.suit, p.idempotency_key),
    place_bid: (roomId, p) => games.placeBid(roomId, actor(socket), p.bid, p.idempotency_key),
    play_card: (roomId, p) => games.playCard(roomId, actor(socket), p.card, p.idempotency_key),
  };
  for (const [event, act] of Object.entries(actions)) {
    socket.on(event, (envelope: unknown) => {
      socket.data.inbox = socket.data.inbox
        .then(() => handleGameAction(realtime, games, socket, recheckMs, event, () => {
          const roomId = socket.data.roomId;
          return roomId ? act(roomId, payloadOf(envelope)) : Promise.resolve();
        }))
        .catch((err) => realtime.logError(socket, err, `${event} failed`));
    });
  }
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
    logger.debug({ ...realtime.logContext(socket), event }, 'game action outside a live game ignored');
    return;
  }
  if (Date.now() - socket.data.authCheckedAt >= recheckMs) {
    let code;
    try {
      code = await recheckSocketSession(socket.handshake.headers.cookie, socket.data.sessionId);
    } catch (err) {
      // The check did not run (e.g. a database error): do not apply the action, tell the client,
      // and leave authCheckedAt alone so the next action checks again.
      realtime.logError(socket, err, `${event} session check failed`);
      actionFailed(realtime, socket, event);
      return;
    }
    if (code) {
      logger.info({ ...realtime.logContext(socket), code, event }, 'socket rejected on game action');
      realtime.rejectSocket(socket, code, SESSION_ERROR_MESSAGES[code]);
      return;
    }
    socket.data.authCheckedAt = Date.now();
  }
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
