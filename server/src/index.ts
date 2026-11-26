import { config } from './config';
import { logger } from './logger';
import { db, checkDbConnection } from './db/knex';
import { buildServer } from './server';
import { abandonInProgressGames } from './games/queries';

async function main() {
  const { httpServer, io, rooms, detachSocket } = buildServer();

  try {
    await checkDbConnection();
    logger.info('database connection ok');
  } catch (err) {
    logger.warn({ err }, 'database not reachable at startup');
  }

  try {
    // Games live in memory, so a game in progress when the last process stopped cannot go on:
    // abandon it (incomplete, server_restart) and close its room. Clients that reconnect are
    // told with game_abandoned. See docs/operations/backup-recovery.md.
    const abandoned = await abandonInProgressGames();
    for (const g of abandoned) {
      logger.info({ gameId: g.gameId, roomId: g.roomId, dropReason: 'server_restart', players: g.players }, 'game abandoned at startup');
    }
    logger.info({ count: abandoned.length }, 'startup cleanup done');
  } catch (err) {
    logger.error({ err }, 'startup cleanup of games in progress failed');
  }

  try {
    // Room inactivity timers are in memory; re-arm them for rooms left open by the last process.
    await rooms.restoreTimeouts();
  } catch (err) {
    logger.warn({ err }, 'could not restore room timers at startup');
  }

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'server listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    rooms.stop();
    rooms.games.stop();
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
