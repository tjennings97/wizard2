import type { Knex } from 'knex';
import { db } from '../db/knex';

type Conn = Knex | Knex.Transaction;

/** Log classifications allowed by game_events_event_type_check (migration 007). */
export type GameEventType =
  | 'game_starting'
  | 'game_started'
  | 'round_started'
  | 'trump_revealed'
  | 'trump_declared'
  | 'bid_placed'
  | 'all_bids_placed'
  | 'user_joined'
  | 'user_left';

/** One game_events row. See docs/architecture/data-model.md (game_events). */
export interface GameEventRow {
  gameId: string;
  seq: number;
  /** The socket event name that was broadcast. */
  event: string;
  eventType: GameEventType;
  /** 0 for events before round 1 starts. */
  roundNumber: number;
  trickNumber: number | null;
  actorUserId: string | null;
  /** Full-context snapshot for training and audit. Server-side only: may contain hands. */
  payload: unknown;
  /** The payload exactly as broadcast; what a reconnect replays. */
  sentPayload: unknown;
}

/** Appends rows to the event log. game_events is append-only: never update or delete. */
export async function insertGameEvents(rows: GameEventRow[], conn: Conn = db): Promise<void> {
  if (rows.length === 0) return;
  await conn('game_events').insert(
    rows.map((r) => ({
      game_id: r.gameId,
      seq: r.seq,
      event: r.event,
      event_type: r.eventType,
      round_number: r.roundNumber,
      trick_number: r.trickNumber,
      actor_user_id: r.actorUserId,
      payload: JSON.stringify(r.payload),
      sent_payload: JSON.stringify(r.sentPayload),
    })),
  );
}

export interface GamePlayerRow {
  id: string;
  username: string;
  displayName: string;
  avatarConfig: { head: string; skin: string; face: string; hair: string } | null;
}

/** The room's active players in join order (seat order), with the fields the engine needs. */
export async function seatedPlayers(conn: Conn, roomId: string): Promise<GamePlayerRow[]> {
  const rows: { user_id: string; username: string; display_name: string; avatar_config: GamePlayerRow['avatarConfig'] }[] =
    await conn('room_members as rm')
      .join('users as u', 'u.id', 'rm.user_id')
      .where({ 'rm.room_id': roomId, 'rm.role': 'player' })
      .whereNull('rm.left_at')
      .orderBy('rm.join_order', 'asc')
      .select('rm.user_id', 'u.username', 'u.display_name', 'u.avatar_config');
  return rows.map((r) => ({ id: r.user_id, username: r.username, displayName: r.display_name, avatarConfig: r.avatar_config }));
}
