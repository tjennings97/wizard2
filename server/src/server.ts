import http from 'http';
import { createApp } from './app';
import { GameService, type GameServiceOptions } from './games/service';
import { RoomService, type RoomServiceOptions } from './rooms/service';
import { attachSocket, type SocketOptions } from './socket';

/**
 * Wires the HTTP app, Socket.io and the room service onto one HTTP server. Shared by index.ts
 * and the integration tests. Before accepting traffic, run the startup cleanup
 * (`abandonInProgressGames()`), then `rooms.restoreTimeouts()`.
 */
export type BuildServerOptions = Pick<RoomServiceOptions, 'timeoutMs' | 'hostAwayMs'> & GameServiceOptions & SocketOptions;

export function buildServer(options: BuildServerOptions = {}) {
  // The request handler must be on the server before Socket.io attaches: Socket.io wraps the
  // listeners present at attach time so that /socket.io/ requests never reach them. A listener
  // added afterwards also sees those requests, and Express answering a pending long-poll with a
  // 404 crashes engine.io's later write (ERR_HTTP_HEADERS_SENT). The app needs the socket layer
  // (presence), so the handler forwards to it once it exists.
  let app: ReturnType<typeof createApp> | null = null;
  const httpServer = http.createServer((req, res) => app!(req, res));
  const games = new GameService({
    deckFactory: options.deckFactory,
    random: options.random,
    countdownMs: options.countdownMs,
    reconnectWindowMs: options.reconnectWindowMs,
    continueDecisionMs: options.continueDecisionMs,
    timeLimitMs: options.timeLimitMs,
    timeWarningLeadMs: options.timeWarningLeadMs,
  });
  const rooms = new RoomService({ timeoutMs: options.timeoutMs, hostAwayMs: options.hostAwayMs, games });
  const { io, realtime, detach } = attachSocket(httpServer, rooms, {
    sessionRecheckMs: options.sessionRecheckMs,
    pingTimeoutMs: options.pingTimeoutMs,
  });
  app = createApp({ rooms, presence: realtime, games });
  return { httpServer, io, realtime, rooms, games, app, detachSocket: detach };
}
