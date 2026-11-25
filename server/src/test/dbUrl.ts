import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const TEST_DB_SUFFIX = '_jest';

/**
 * The database the integration tests use: TEST_DATABASE_URL, or DATABASE_URL with the database
 * renamed to `wizard_jest`. The tests truncate every table, so the name must end in `_jest`
 * (it is kept apart from `wizard_test`, which the pytest API suite uses).
 */
export function testDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) to run the integration tests.');
  const url = new URL(base);
  if (!process.env.TEST_DATABASE_URL) url.pathname = `/wizard${TEST_DB_SUFFIX}`;
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith(TEST_DB_SUFFIX)) {
    throw new Error(`Refusing to run integration tests against "${name}": the database name must end in ${TEST_DB_SUFFIX}.`);
  }
  return url.toString();
}
