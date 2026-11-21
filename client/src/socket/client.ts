import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

/** Single Socket.io client instance. Same origin — Vite proxies /socket.io in dev. */
export function connectSocket(): Socket {
  if (socket) return socket;
  socket = io({ withCredentials: true });
  socket.on('connect', () => console.log('connected', socket?.id));
  socket.on('disconnect', (reason) => console.log('disconnected', reason));
  socket.on('connect_error', (err) => console.warn('socket connect_error', err.message));
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}
