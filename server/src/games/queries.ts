import type { Knex } from 'knex';
import { db } from '../db/knex';
import type { GameState, Suit, TrumpSource } from '../engine';

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
  | 'card_played'
  | 'trick_completed'
  | 'round_completed'
  | 'game_completed'
  | 'user_joined'
  | 'user_left'
  | 'player_disconnected'
  | 'player_reconnected'
  | 'continue_or_end_request'
  | 'game_time_warning'
  | 'game_abandoned';

/** Why a game, or one player's part in it, ended early (games / game_results.drop_reason). */
export type DropReason = 'player_quit' | 'player_timeout' | 'mutual_end' | 'server_restart' | 'time_limit';

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

/** A scored round: one rounds row and a round_players row per player. */
export interface RoundRecord {
  gameId: string;
  roundNumber: number;
  dealerUserId: string;
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  startedAt: Date;
  players: { userId: string; bid: number; tricksWon: number; scoreDelta: number; bidPosition: number }[];
}

/**
 * Writes a scored round (rounds + round_players) and the games.state checkpoint taken at its
 * end. The checkpoint is a record only; no game is rebuilt from it.
 */
export async function recordRound(conn: Conn, round: RoundRecord, state: GameState): Promise<void> {
  const [{ id }]: { id: string }[] = await conn('rounds')
    .insert({
      game_id: round.gameId,
      round_number: round.roundNumber,
      dealer_user_id: round.dealerUserId,
      trump_suit: round.trumpSuit,
      trump_source: round.trumpSource,
      started_at: round.startedAt,
      ended_at: conn.fn.now(),
    })
    .returning('id');
  await conn('round_players').insert(
    round.players.map((p) => ({
      round_id: id,
      user_id: p.userId,
      bid: p.bid,
      tricks_won: p.tricksWon,
      score_delta: p.scoreDelta,
      bid_position: p.bidPosition,
    })),
  );
  await conn('games').where({ id: round.gameId }).update({ state: JSON.stringify(state) });
}

/** One game_results row. A player who quit or timed out is `incomplete` with their own reason. */
export interface GameResultRow {
  userId: string;
  finalScore: number;
  outcome: 'win' | 'loss' | 'incomplete';
  dropReason: DropReason | null;
  roundsPlayed: number;
}

export interface GameEnd {
  gameId: string;
  roomId: string;
  state: GameState;
  results: GameResultRow[];
}

async function insertResults(conn: Conn, gameId: string, results: GameResultRow[]): Promise<void> {
  if (results.length === 0) return;
  await conn('game_results').insert(
    results.map((r) => ({
      game_id: gameId,
      user_id: r.userId,
      final_score: r.finalScore,
      outcome: r.outcome,
      drop_reason: r.dropReason,
      rounds_played: r.roundsPlayed,
    })),
  );
}

/**
 * Records a game that ran to its final round: games.status = complete with the final checkpoint,
 * a game_results row per player, and the room moved from in_progress to completing.
 */
export async function recordGameComplete(conn: Conn, end: GameEnd): Promise<void> {
  await conn('games')
    .where({ id: end.gameId })
    .update({ status: 'complete', ended_at: conn.fn.now(), state: JSON.stringify(end.state) });
  await insertResults(conn, end.gameId, end.results);
  await conn('rooms').where({ id: end.roomId, state: 'in_progress' }).update({ state: 'completing' });
}

/**
 * Records a game that ended early (players dropped, a mutual end, or the time limit):
 * games.status = incomplete with its drop reason, the player count left and the final checkpoint,
 * a game_results row per player, and the room moved from in_progress to completing.
 */
export async function recordGameIncomplete(
  conn: Conn,
  end: GameEnd & { dropReason: DropReason; playerCountAtDrop: number },
): Promise<void> {
  await conn('games').where({ id: end.gameId }).update({
    status: 'incomplete',
    drop_reason: end.dropReason,
    player_count_at_drop: end.playerCountAtDrop,
    ended_at: conn.fn.now(),
    state: JSON.stringify(end.state),
  });
  await insertResults(conn, end.gameId, end.results);
  await conn('rooms').where({ id: end.roomId, state: 'in_progress' }).update({ state: 'completing' });
}

/** A logged broadcast as a reconnect replays it: the event name, seq and sent payload. */
export interface ReplayedEvent {
  seq: number;
  event: string;
  payload: unknown;
}

/** The game's logged broadcasts with `after < seq <= upTo`, in seq order. */
export async function eventsBetween(gameId: string, after: number, upTo: number, conn: Conn = db): Promise<ReplayedEvent[]> {
  const rows: { seq: number; event: string; sent_payload: unknown }[] = await conn('game_events')
    .where({ game_id: gameId })
    .where('seq', '>', after)
    .where('seq', '<=', upTo)
    .orderBy('seq', 'asc')
    .select('seq', 'event', 'sent_payload');
  return rows.map((r) => ({ seq: r.seq, event: r.event, payload: r.sent_payload }));
}

/** Drop reasons a client is told about with game_abandoned (rather than game_over). */
export const ABANDON_REASONS = ['server_restart', 'time_limit'] as const;
export type AbandonReason = (typeof ABANDON_REASONS)[number];

/**
 * The latest game the user was seated in (as a player), if it was abandoned (server restart or
 * time limit): what a client still showing that game is told.
 */
export async function abandonedGameFor(userId: string, conn: Conn = db): Promise<{ gameId: string; reason: AbandonReason } | null> {
  const row: { id: string; status: string; drop_reason: string | null } | undefined = await conn('games as g')
    .whereIn('g.room_id', conn('room_members').where({ user_id: userId, role: 'player' }).select('room_id'))
    .orderBy('g.started_at', 'desc')
    .first('g.id', 'g.status', 'g.drop_reason');
  if (!row || row.status !== 'incomplete' || !(ABANDON_REASONS as readonly string[]).includes(row.drop_reason ?? '')) return null;
  return { gameId: row.id, reason: row.drop_reason as AbandonReason };
}

/**
 * Startup cleanup after a restart (docs/operations/backup-recovery.md): the in-memory games are
 * gone, so every in_progress game is abandoned. In one transaction: the game is set incomplete
 * with drop_reason server_restart; each player still seated gets a game_results row (outcome
 * incomplete, their score at the last checkpoint); the room is closed and its members marked
 * left. rounds and round_players are kept as they are. Idempotent: a second run finds nothing.
 * Returns the games it closed.
 */
export async function abandonInProgressGames(conn: Knex = db): Promise<{ gameId: string; roomId: string; players: number }[]> {
  return conn.transaction(async (trx) => {
    const games: { id: string; room_id: string; state: GameState | null }[] = await trx('games')
      .where({ status: 'in_progress' })
      .forUpdate()
      .select('id', 'room_id', 'state');
    const closed: { gameId: string; roomId: string; players: number }[] = [];
    for (const g of games) {
      const seated: { user_id: string }[] = await trx('room_members')
        .where({ room_id: g.room_id, role: 'player' })
        .whereNull('left_at')
        .select('user_id');
      const { n } = (await trx('rounds').where({ game_id: g.id }).count('* as n').first()) as { n: string };
      await trx('games').where({ id: g.id }).update({
        status: 'incomplete',
        drop_reason: 'server_restart',
        player_count_at_drop: seated.length,
        ended_at: trx.fn.now(),
      });
      await insertResults(
        trx,
        g.id,
        seated.map((m) => ({
          userId: m.user_id,
          finalScore: g.state?.scores?.[m.user_id] ?? 0,
          outcome: 'incomplete',
          dropReason: 'server_restart',
          roundsPlayed: Number(n),
        })),
      );
      await trx('rooms').where({ id: g.room_id, state: 'in_progress' }).update({ state: 'closed', closed_at: trx.fn.now() });
      await trx('room_members').where({ room_id: g.room_id }).whereNull('left_at').update({ left_at: trx.fn.now() });
      closed.push({ gameId: g.id, roomId: g.room_id, players: seated.length });
    }
    return closed;
  });
}
