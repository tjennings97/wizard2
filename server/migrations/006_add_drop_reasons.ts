import type { Knex } from 'knex';

/**
 * Adds two values to the drop_reason CHECK constraints on games and game_results:
 * - server_restart: written by the startup cleanup (docs/operations/backup-recovery.md); it
 *   was missing from 003, so that cleanup would have violated the constraint.
 * - time_limit: a game abandoned at the 3-hour game time limit.
 */
const OLD = ['player_quit', 'player_timeout', 'mutual_end'];
const NEW = [...OLD, 'server_restart', 'time_limit'];

const CONSTRAINTS = [
  { table: 'games', name: 'games_drop_reason_check' },
  { table: 'game_results', name: 'game_results_drop_reason_check' },
];

async function setAllowed(knex: Knex, values: string[]): Promise<void> {
  const list = values.map((v) => `'${v}'`).join(', ');
  for (const { table, name } of CONSTRAINTS) {
    await knex.raw(`ALTER TABLE ?? DROP CONSTRAINT ??`, [table, name]);
    await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (drop_reason IN (${list}))`, [table, name]);
  }
}

export async function up(knex: Knex): Promise<void> {
  await setAllowed(knex, NEW);
}

export async function down(knex: Knex): Promise<void> {
  await setAllowed(knex, OLD);
}
