import { config } from './config';
import { logger } from './logger';
import { db, checkDbConnection } from './db/knex';
import { buildServer } from './server';

async function main() {
  const { httpServer, io, rooms, detachSocket } = buildServer();

  try {
    await checkDbConnection();
    logger.info('database connection ok');
    // Room inactivity timers are in memory; re-arm them for rooms left open by the last process.
    await rooms.restoreTimeouts();
  } catch (err) {
    logger.warn({ err }, 'database not reachable at startup');
  }

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'server listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    rooms.stop();
    detachSocket();
    io.close();
    httpServer.close(() => {
      db.destroy().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
