import http from 'http';
import { createApp } from './app';
import { RoomService, type RoomServiceOptions } from './rooms/service';
import { attachSocket } from './socket';

/**
 * Wires the HTTP app, Socket.io and the room service onto one HTTP server. Shared by index.ts
 * and the integration tests. Call `rooms.restoreTimeouts()` before accepting traffic.
 */
export function buildServer(options: Pick<RoomServiceOptions, 'timeoutMs'> = {}) {
  // The request handler must be on the server before Socket.io attaches: Socket.io wraps the
  // listeners present at attach time so that /socket.io/ requests never reach them. A listener
  // added afterwards also sees those requests, and Express answering a pending long-poll with a
  // 404 crashes engine.io's later write (ERR_HTTP_HEADERS_SENT). The app needs the socket layer
  // (presence), so the handler forwards to it once it exists.
  let app: ReturnType<typeof createApp> | null = null;
  const httpServer = http.createServer((req, res) => app!(req, res));
  const rooms = new RoomService(options);
  const { io, realtime, detach } = attachSocket(httpServer, rooms);
  app = createApp({ rooms, presence: realtime });
  return { httpServer, io, realtime, rooms, app, detachSocket: detach };
}
