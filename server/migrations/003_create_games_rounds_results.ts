import type { Knex } from 'knex';

const DROP_REASONS = ['player_quit', 'player_timeout', 'mutual_end'];

/**
 * Games, rounds, per-player round records, and per-player game results.
 * See docs/architecture/data-model.md.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('games', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('room_id').notNullable().references('id').inTable('rooms');
    // Latest GameState snapshot, checkpointed after each round. Null before first round completes.
    t.jsonb('state').nullable();
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('ended_at', { useTz: true }).nullable();
    t.string('status', 16)
      .notNullable()
      .defaultTo('in_progress')
      .checkIn(['in_progress', 'complete', 'incomplete'], 'games_status_check');
    // Populated only when status = 'incomplete'.
    t.string('drop_reason', 32).nullable().checkIn(DROP_REASONS, 'games_drop_reason_check');
    t.smallint('player_count_at_drop').nullable();

    t.index(['room_id'], 'games_room_id_idx');
  });

  // No unique (game_id, round_number): a voided round (player drop) is re-dealt
  // under the same round number.
  await knex.schema.createTable('rounds', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('game_id').notNullable().references('id').inTable('games');
    t.smallint('round_number').notNullable();
    t.uuid('dealer_user_id').notNullable().references('id').inTable('users');
    // Null = no trump (Jester flipped, or final round with deck fully dealt).
    t.string('trump_suit', 16)
      .nullable()
      .checkIn(['hearts', 'diamonds', 'spades', 'clubs'], 'rounds_trump_suit_check');
    t.string('trump_source', 16)
      .nullable()
      .checkIn(['flip', 'declaration'], 'rounds_trump_source_check');
    t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('ended_at', { useTz: true }).nullable();

    t.index(['game_id'], 'rounds_game_id_idx');
  });

  await knex.schema.createTable('round_players', (t) => {
    t.uuid('round_id').notNullable().references('id').inTable('rounds');
    t.uuid('user_id').notNullable().references('id').inTable('users');
    t.smallint('bid').notNullable();
    t.smallint('tricks_won').notNullable();
    // May be negative per scoring rules.
    t.smallint('score_delta').notNullable();
    t.smallint('bid_position').notNullable();

    t.primary(['round_id', 'user_id'], { constraintName: 'round_players_pkey' });
    t.index(['user_id'], 'round_players_user_idx');
  });

  await knex.schema.createTable('game_results', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('game_id').notNullable().references('id').inTable('games');
    t.uuid('user_id').notNullable().references('id').inTable('users');
    // Denormalised sum of round_players.score_delta for this player.
    t.integer('final_score').notNullable();
    t.string('outcome', 16)
      .notNullable()
      .checkIn(['win', 'loss', 'incomplete'], 'game_results_outcome_check');
    t.string('drop_reason', 32).nullable().checkIn(DROP_REASONS, 'game_results_drop_reason_check');
    t.smallint('rounds_played').notNullable();

    t.unique(['game_id', 'user_id'], { indexName: 'game_results_game_user_idx' });
    t.index(['user_id'], 'game_results_user_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('game_results');
  await knex.schema.dropTable('round_players');
  await knex.schema.dropTable('rounds');
  await knex.schema.dropTable('games');
}
