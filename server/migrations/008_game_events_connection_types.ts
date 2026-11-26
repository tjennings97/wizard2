import type { Knex } from 'knex';

/**
 * Widens game_events.event_type to the broadcasts added with disconnects, player drops and the
 * game time limit, so they are numbered and logged like every other event broadcast to a game's
 * room (a reconnect replays them):
 * - player_disconnected, player_reconnected: the 30-second seat hold.
 * - continue_or_end_request: a drop left two players.
 * - game_time_warning, game_abandoned: the 3-hour game time limit.
 * An incomplete game's game_over is still game_completed (its payload says status incomplete).
 * See docs/architecture/data-model.md (game_events).
 */
const OLD_TYPES = [
  'bid_placed',
  'card_played',
  'trump_declared',
  'trick_completed',
  'round_completed',
  'game_completed',
  'game_starting',
  'game_started',
  'round_started',
  'trump_revealed',
  'all_bids_placed',
  'user_joined',
  'user_left',
];
const NEW_TYPES = [...OLD_TYPES, 'player_disconnected', 'player_reconnected', 'continue_or_end_request', 'game_time_warning', 'game_abandoned'];

async function setTypes(knex: Knex, values: string[]): Promise<void> {
  const list = values.map((v) => `'${v}'`).join(', ');
  await knex.raw('ALTER TABLE game_events DROP CONSTRAINT game_events_event_type_check');
  await knex.raw(`ALTER TABLE game_events ADD CONSTRAINT game_events_event_type_check CHECK (event_type IN (${list}))`);
}

export async function up(knex: Knex): Promise<void> {
  await setTypes(knex, NEW_TYPES);
}

export async function down(knex: Knex): Promise<void> {
  // game_events is append-only, so rolling back never deletes rows: refuse if any would break.
  const newRows = await knex('game_events').whereNotIn('event_type', OLD_TYPES).first(knex.raw('1'));
  if (newRows) throw new Error('game_events has rows of event types added by 008; cannot roll back without deleting them');
  await setTypes(knex, OLD_TYPES);
}
