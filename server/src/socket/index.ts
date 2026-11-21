import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import { config } from '../config';
import { logger } from '../logger';

export function attachSocket(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: config.isProduction ? undefined : { origin: 'http://localhost:5173', credentials: true },
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'socket connected');
    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return io;
}
