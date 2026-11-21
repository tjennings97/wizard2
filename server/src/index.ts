import http from 'http';
import { config } from './config';
import { logger } from './logger';
import { createApp } from './app';
import { attachSocket } from './socket';
import { db, checkDbConnection } from './db/knex';

async function main() {
  const app = createApp();
  const httpServer = http.createServer(app);
  const io = attachSocket(httpServer);

  checkDbConnection()
    .then(() => logger.info('database connection ok'))
    .catch((err) => logger.warn({ err }, 'database not reachable at startup'));

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'server listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
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
