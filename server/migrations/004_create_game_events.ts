import type { Knex } from 'knex';

/**
 * game_events — APPEND-ONLY event log.
 *
 * Rows in this table are NEVER updated or deleted. Application code must only
 * INSERT into game_events; there is no UPDATE or DELETE path. This table is the
 * audit trail and the primary source of bot training data, so every row must
 * remain exactly as written. (Not enforced by a DB trigger in this migration.)
 *
 * payload is a JSONB full-context snapshot whose schema varies by event_type —
 * see "JSONB Payload Schemas" in docs/architecture/data-model.md.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('game_events', (t) => {
    t.comment('Append-only event log. Never UPDATE or DELETE rows.');

    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('game_id').notNullable().references('id').inTable('games');
    t.smallint('round_number').notNullable();
    // Null for round-level and game-level events.
    t.smallint('trick_number').nullable();
    t.string('event_type', 32)
      .notNullable()
      .checkIn(
        [
          'bid_placed',
          'card_played',
          'trump_declared',
          'trick_completed',
          'round_completed',
          'game_completed',
        ],
        'game_events_event_type_check',
      );
    // Null for system events (round/game completion).
    t.uuid('actor_user_id').nullable().references('id').inTable('users');
    t.jsonb('payload').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.index(['game_id'], 'game_events_game_id_idx');
    t.index(['game_id', 'round_number'], 'game_events_game_round_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('game_events');
}
