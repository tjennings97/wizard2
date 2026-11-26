import type { Knex } from 'knex';

/**
 * Makes game_events the replay log for reconnects as well as the training log.
 *
 * - seq: the game's sequence number for the event. Every event broadcast to a game's room takes
 *   the game's next seq, which is also the envelope seq the clients saw. Unique per game.
 * - event: the socket event name that was broadcast (event_type is the log classification, which
 *   differs for some events: a Wizard-flip declaration is logged as trump_declared but broadcast
 *   as trump_revealed).
 * - sent_payload: the payload exactly as broadcast. Replay sends this, never `payload`, which is
 *   the full-context snapshot and may contain hands.
 * - event_type: widened to the broadcast events that have no training classification of their own.
 *
 * No game has been started before this migration (POST /rooms/{roomId}/start returned 501), so
 * the table is empty and the new columns can be NOT NULL without a default.
 * See docs/architecture/data-model.md (game_events).
 */
const OLD_TYPES = ['bid_placed', 'card_played', 'trump_declared', 'trick_completed', 'round_completed', 'game_completed'];
const NEW_TYPES = [
  ...OLD_TYPES,
  'game_starting',
  'game_started',
  'round_started',
  'trump_revealed',
  'all_bids_placed',
  'user_joined',
  'user_left',
];

async function setTypes(knex: Knex, values: string[]): Promise<void> {
  const list = values.map((v) => `'${v}'`).join(', ');
  await knex.raw('ALTER TABLE game_events DROP CONSTRAINT game_events_event_type_check');
  await knex.raw(`ALTER TABLE game_events ADD CONSTRAINT game_events_event_type_check CHECK (event_type IN (${list}))`);
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('game_events', (t) => {
    t.integer('seq').notNullable();
    t.string('event', 32).notNullable();
    t.jsonb('sent_payload').notNullable();
    t.unique(['game_id', 'seq'], { indexName: 'game_events_game_seq_idx' });
  });
  await setTypes(knex, NEW_TYPES);
}

export async function down(knex: Knex): Promise<void> {
  // game_events is append-only, so rolling back never deletes rows. Rows of the new types would
  // violate the old constraint: refuse instead.
  const newRows = await knex('game_events').whereNotIn('event_type', OLD_TYPES).first(knex.raw('1'));
  if (newRows) throw new Error('game_events has rows of event types added by 007; cannot roll back without deleting them');
  await setTypes(knex, OLD_TYPES);
  await knex.schema.alterTable('game_events', (t) => {
    t.dropUnique(['game_id', 'seq'], 'game_events_game_seq_idx');
    t.dropColumn('sent_payload');
    t.dropColumn('event');
    t.dropColumn('seq');
  });
}
