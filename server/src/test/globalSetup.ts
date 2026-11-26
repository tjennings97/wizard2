import { execFileSync } from 'child_process';
import knex from 'knex';
import path from 'path';
import { testDatabaseUrl } from './dbUrl';

/** Creates the integration-test database if needed and migrates it to the latest schema. */
export default async function globalSetup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.replace(/^\//, '');

  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const adminDb = knex({ client: 'pg', connection: admin.toString() });
  try {
    const { rows } = await adminDb.raw('select 1 from pg_database where datname = ?', [name]);
    if (rows.length === 0) await adminDb.raw('create database ??', [name]);
  } finally {
    await adminDb.destroy();
  }

  // Same path as `npm run migrate:latest`, pointed at the test database.
  execFileSync('npx', ['tsx', 'src/db/migrate.ts', 'latest'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: 'test', LOG_LEVEL: 'warn' },
    stdio: 'inherit',
  });
}
