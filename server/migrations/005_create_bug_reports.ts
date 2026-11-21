import type { Knex } from 'knex';

/**
 * bug_reports — user-submitted reports with auto-captured context.
 * trace_id correlates the report with server log entries.
 * See docs/architecture/data-model.md.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bug_reports', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').nullable().references('id').inTable('users');
    t.uuid('room_id').nullable().references('id').inTable('rooms');
    t.uuid('game_id').nullable().references('id').inTable('games');
    t.uuid('trace_id').notNullable();
    t.text('description').notNullable();
    t.string('severity', 8)
      .nullable()
      .checkIn(['low', 'medium', 'high'], 'bug_reports_severity_check');
    // {"url","page","round_number","trick_number","game_state_summary","user_agent","client_timestamp"}
    t.jsonb('context').notNullable().defaultTo(knex.raw(`'{}'::jsonb`));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['trace_id'], 'bug_reports_trace_id_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('bug_reports');
}
