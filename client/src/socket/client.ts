import { io, Socket } from 'socket.io-client';

/**
 * Creates the app's single Socket.io client. Same origin (Vite proxies /socket.io in dev); the
 * browser sends the HTTP-only session cookie with the handshake. Created on login and
 * disconnected on logout by SocketContext.
 */
export function createSocket(): Socket {
  return io({ withCredentials: true });
}

/** Server→client message envelope (docs/api/websocket-events.md, Envelope Schema). */
export interface Envelope<P> {
  event: string;
  seq: number;
  timestamp: string;
  payload: P;
}
