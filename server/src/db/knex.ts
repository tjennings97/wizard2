import knex, { Knex } from 'knex';
import path from 'path';
import { config } from '../config';

export const knexConfig: Knex.Config = {
  client: 'pg',
  connection: config.databaseUrl,
  pool: { min: 0, max: 10 },
  migrations: {
    directory: path.resolve(__dirname, '../../migrations'),
    tableName: 'knex_migrations',
  },
};

export const db = knex(knexConfig);

/** Verifies the database is reachable. Throws if not. */
export async function checkDbConnection(): Promise<void> {
  await db.raw('select 1');
}
