import type { Knex } from 'knex';

/**
 * Rooms and room membership.
 * See docs/architecture/data-model.md.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('rooms', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('state', 16)
      .notNullable()
      .defaultTo('open')
      .checkIn(['open', 'in_progress', 'completing', 'closed'], 'rooms_state_check');
    t.uuid('host_user_id').notNullable().references('id').inTable('users');
    // {"round_count": 10, "bid_rule": "open", "deck_type": "standard"} — locked on game start.
    t.jsonb('config').notNullable().defaultTo(knex.raw(`'{}'::jsonb`));
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('closed_at', { useTz: true }).nullable();

    t.index(['state'], 'rooms_state_idx');
  });

  await knex.schema.createTable('room_members', (t) => {
    t.uuid('room_id').notNullable().references('id').inTable('rooms');
    t.uuid('user_id').notNullable().references('id').inTable('users');
    t.string('role', 16)
      .notNullable()
      .checkIn(['player', 'spectator'], 'room_members_role_check');
    // Sequential join position (1 = first). Used for host transfer ordering.
    t.integer('join_order').notNullable();
    t.timestamp('joined_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('left_at', { useTz: true }).nullable();

    t.primary(['room_id', 'user_id'], { constraintName: 'room_members_pkey' });
    t.index(['user_id'], 'room_members_user_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('room_members');
  await knex.schema.dropTable('rooms');
}
