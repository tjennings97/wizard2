import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config } from '../config';
import { isSessionInvalidated } from '../auth/sessions';
import { sessionEvents } from '../auth/sessionEvents';
import { logger } from '../logger';
import { activeMembershipFor, getRoomView, listLobbyRooms } from '../rooms/queries';
import type { RoomService } from '../rooms/service';
import { authenticateSocket, SESSION_ERROR_MESSAGES } from './auth';
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
 * puts the socket where the user is: in their open room (room_snapshot), in the channel of a
 * started game, or in the lobby (lobby_snapshot, and presence_updated to everyone else there).
 */
export function attachSocket(httpServer: HttpServer, rooms: RoomService): AttachedSocket {
  const io: AppServer = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });
  const realtime = new Realtime(io);
  rooms.setNotifier(realtime);

  // A newer login, a password reset or a logout ended these sessions: drop their sockets.
  const onInvalidated = (sessionIds: string[]) =>
    realtime.sessionsInvalidated(sessionIds, SESSION_ERROR_MESSAGES.SESSION_INVALIDATED);
  sessionEvents.on('invalidated', onInvalidated);

  io.on('connection', (socket: AppSocket) => {
    socket.data.seq = 0;
    socket.data.roomId = null;
    void onConnection(realtime, socket).catch((err) => {
      realtime.logError(socket, err, 'socket connect handling failed');
      socket.disconnect(true);
    });
  });

  return { io, realtime, detach: () => sessionEvents.off('invalidated', onInvalidated) };
}

async function onConnection(realtime: Realtime, socket: AppSocket): Promise<void> {
  const auth = await authenticateSocket(socket.handshake.headers.cookie);
  if (!auth.ok) {
    logger.info({ socketId: socket.id, code: auth.code }, 'socket rejected');
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

  // An invalidation emitted while authenticateSocket was querying found no socket in the session
  // channel. Now that this socket is in it, check once more so it cannot slip through.
  if (await isSessionInvalidated(session.id)) {
    realtime.rejectSocket(socket, 'SESSION_INVALIDATED', SESSION_ERROR_MESSAGES.SESSION_INVALIDATED);
    return;
  }
  if (!socket.connected) return;

  socket.on('disconnect', (reason) => {
    logger.info({ ...realtime.logContext(socket), reason }, 'socket disconnected');
    // Rooms are already left by now; another tab may still hold the user's lobby presence.
    if (socket.data.roomId === null && !realtime.isInLobby(user.id)) realtime.broadcastPresence();
  });

  // Read first, then join channels synchronously, so a socket that dropped meanwhile is not
  // added to a channel after its disconnect.
  const membership = await activeMembershipFor(user.id);
  const room = membership?.roomState === 'open' ? await getRoomView(membership.roomId) : null;
  const lobbyRooms = membership ? null : await listLobbyRooms();
  if (!socket.connected) return;

  if (room) {
    realtime.enterRoom(socket, room);
    logger.info(realtime.logContext(socket), 'socket connected to room');
  } else if (membership) {
    // A game has started in this room. Game events and state_snapshot come with the engine wiring.
    realtime.joinRoomChannel(socket, membership.roomId);
    logger.info(realtime.logContext(socket), 'socket connected to started game');
  } else {
    realtime.enterLobby(socket, lobbyRooms!);
    realtime.broadcastPresence();
    logger.info(realtime.logContext(socket), 'socket connected to lobby');
  }
}
