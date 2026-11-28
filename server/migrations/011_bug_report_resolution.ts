import type { Knex } from 'knex';

/**
 * Lets an admin dismiss a handled bug report (docs/architecture/data-model.md, Data Dictionary —
 * bug_reports). A report is open while `resolution` is null. Dismissing sets all three columns;
 * reopening clears all three, so they are null together or set together.
 *
 * Follows 010_avatar_config_required.ts.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bug_reports', (t) => {
    t.string('resolution', 16)
      .nullable()
      .checkIn(['resolved', 'not_a_bug', 'cannot_reproduce', 'wont_fix'], 'bug_reports_resolution_check');
    t.timestamp('resolved_at', { useTz: true }).nullable();
    t.uuid('resolved_by').nullable().references('id').inTable('users');
  });
  await knex.raw(`
    ALTER TABLE bug_reports ADD CONSTRAINT bug_reports_resolution_set_check CHECK (
      (resolution IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
      OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE bug_reports DROP CONSTRAINT bug_reports_resolution_set_check');
  await knex.schema.alterTable('bug_reports', (t) => {
    t.dropColumn('resolved_by');
    t.dropColumn('resolved_at');
    t.dropColumn('resolution');
  });
}
