import { buildFirstAdmin, firstAdminInsertSql, validateFirstAdmin } from '../auth/firstAdmin';

/**
 * npm run create-admin -w server -- <username> "<display name>" [--sql]
 *
 * Creates an admin with temporary credentials that must be changed at first sign-in
 * (docs/operations/deployment-infrastructure.md, First Admin Account).
 *
 * - Default: inserts the user into DATABASE_URL (local development, or wherever that is reachable).
 * - --sql: connects to nothing and needs no environment; prints the INSERT on stdout, to apply
 *   with psql (production: `railway connect wizard-db`).
 *
 * The temporary password and passphrase are printed on stderr in both modes, so stdout can be
 * redirected to a file that holds only hashes.
 */

const USAGE = 'Usage: npm run create-admin -w server -- <username> "<display name>" [--sql]';
const PG_UNIQUE_VIOLATION = '23505';

async function main(argv: string[]): Promise<void> {
  const sqlOnly = argv.includes('--sql');
  const positional = argv.filter((a) => a !== '--sql');
  if (positional.length !== 2) throw new Error(USAGE);
  const { username, displayName } = validateFirstAdmin(positional[0], positional[1]);

  const admin = await buildFirstAdmin(username, displayName);

  if (sqlOnly) {
    process.stdout.write(firstAdminInsertSql(admin.row) + '\n');
  } else {
    // Imported here so --sql needs no environment (config validates every variable on load).
    const { db } = await import('./knex');
    try {
      await db('users').insert(admin.row);
    } catch (err) {
      if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new Error(`A user named "${username}" already exists. Promote them from the admin panel or pick another name.`);
      }
      throw err;
    } finally {
      await db.destroy();
    }
    process.stderr.write(`Created admin "${username}".\n`);
  }

  process.stderr.write(
    `Temporary password:   ${admin.temporaryPassword}\n` +
      `Temporary passphrase: ${admin.temporaryPassphrase}\n` +
      'Sign in with these; the app then requires a new password and recovery passphrase.\n',
  );
}

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
