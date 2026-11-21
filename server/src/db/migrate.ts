import { db } from './knex';
import { logger } from '../logger';

async function run(command: string | undefined) {
  if (command === 'latest') {
    const [batch, files] = await db.migrate.latest();
    logger.info({ batch, files }, 'migrations applied');
  } else if (command === 'rollback') {
    const [batch, files] = await db.migrate.rollback();
    logger.info({ batch, files }, 'migrations rolled back');
  } else {
    throw new Error(`Unknown migrate command "${command}". Use "latest" or "rollback".`);
  }
}

run(process.argv[2])
  .catch((err) => {
    logger.error({ err }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
