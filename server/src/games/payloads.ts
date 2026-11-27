/**
 * Socket payloads for game events, built from engine results. Pure: no I/O.
 * Names and fields follow docs/api/websocket-events.md (snake_case on the wire).
 */
import type { AvatarConfig, CardData, Game, GameResult, RoundCompleted, RoundStarted, Suit, Trick, TrumpSource } from '../engine';

export interface PlayerSummary {
  user_id: string;
  display_name: string;
  avatar_config: AvatarConfig;
  /** 0-based seat, as in user_joined. Seat 0 deals round 1. */
  seat_index: number;
}

export interface BidEntry {
  player_id: string;
  bid: number;
}

/** One card in a trick, in play order. */
export interface PlayEntry {
  player_id: string;
  card: CardData;
}

/** A player's score. In `cumulative_scores` and `final_scores`, the running total. */
export interface ScoreEntry {
  player_id: string;
  score: number;
}

/** One player's round in `scores_this_round`: `score` is the round's score delta. */
export interface RoundScoreEntry extends ScoreEntry {
  bid: number;
  tricks_won: number;
}

export function playerSummaries(game: Game): PlayerSummary[] {
  return game.activePlayers.map((p, i) => ({
    user_id: p.id,
    display_name: p.displayName,
    avatar_config: { ...p.avatarConfig },
    seat_index: i,
  }));
}

export function gameStartingPayload(game: Game) {
  return { game_id: game.gameId, countdown_seconds: 0, player_order: game.activePlayers.map((p) => p.id) };
}

export function gameStartedPayload(game: Game) {
  return {
    game_id: game.gameId,
    room_id: game.roomId,
    round_count: game.config.roundCount,
    bid_rule: game.config.bidRule,
    players: playerSummaries(game),
  };
}

export function roundStartedPayload(r: RoundStarted) {
  return {
    round_number: r.roundNumber,
    dealer_id: r.dealerId,
    trump_suit: r.trumpSuit,
    trump_card: r.trumpCard?.toData() ?? null,
  };
}

export function trumpRevealedPayload(
  roundNumber: number,
  trumpSuit: Suit | null,
  trumpCard: CardData | null,
  trumpSource: TrumpSource,
) {
  return { round_number: roundNumber, trump_suit: trumpSuit, trump_card: trumpCard, trump_source: trumpSource };
}

export function handDealtPayload(game: Game, userId: string) {
  return { hand: game.getPlayer(userId).hand.map((c) => c.toData()), round_number: game.currentRoundNumber };
}

/** Bids placed so far this round, in bidding order. */
export function bidsSoFar(game: Game): BidEntry[] {
  const round = game.currentRound;
  if (!round) return [];
  return round.bidOrder
    .map((id) => ({ player_id: id, bid: round.getBid(id) }))
    .filter((b): b is BidEntry => b.bid !== null);
}

export function bidRequestPayload(game: Game, userId: string) {
  const round = game.currentRound!;
  return {
    player_id: userId,
    round_number: round.roundNumber,
    bids_so_far: bidsSoFar(game),
    hand_size: game.getPlayer(userId).hand.length,
    allowed_bids: round.allowedBids(userId),
  };
}

export function invalidBidPayload(game: Game, userId: string, code: string, reason: string) {
  const round = game.currentRound;
  return {
    player_id: userId,
    code,
    reason,
    min_bid: 0,
    max_bid: round?.roundNumber ?? 0,
    allowed_bids: round ? round.allowedBids(userId) : [],
  };
}

export function invalidTrumpPayload(userId: string, code: string, reason: string) {
  return { player_id: userId, code, reason };
}

export function playEntries(trick: Trick): PlayEntry[] {
  return trick.cards.map((c) => ({ player_id: c.playerId, card: c.card.toData() }));
}

/** Cumulative scores in seat order. */
export function scoreEntries(game: Game, scores: Record<string, number> = game.scores): ScoreEntry[] {
  return game.activePlayers.map((p) => ({ player_id: p.id, score: scores[p.id] }));
}

export function playRequestPayload(game: Game, userId: string) {
  const trick = game.currentRound!.currentTrick!;
  return {
    player_id: userId,
    round_number: game.currentRoundNumber,
    trick_number: trick.trickNumber,
    trick_so_far: playEntries(trick),
    legal_cards: game.legalCards(userId).map((c) => c.toData()),
  };
}

export function invalidPlayPayload(game: Game, userId: string, code: string, reason: string) {
  return { player_id: userId, code, reason, legal_cards: game.legalCards(userId).map((c) => c.toData()) };
}

export function roundCompletePayload(game: Game, r: RoundCompleted) {
  // results() is in bidding order; report in seat order like every other score list.
  const byId = new Map(r.results.map((x) => [x.playerId, x]));
  return {
    round_number: r.roundNumber,
    scores_this_round: game.activePlayers.map((p): RoundScoreEntry => {
      const x = byId.get(p.id)!;
      return { player_id: p.id, bid: x.bid, tricks_won: x.tricksWon, score: x.scoreDelta };
    }),
    cumulative_scores: scoreEntries(game, r.scores),
    is_final_round: r.isFinalRound,
  };
}

/**
 * game_over. `status` is `complete` after the final round, or `incomplete` when the game ended
 * early (a drop left one player, or the last two chose to end): then nobody wins.
 */
export function gameOverPayload(
  game: Game,
  result: GameResult,
  closesAt: Date,
  countdownMs: number,
  status: 'complete' | 'incomplete' = 'complete',
) {
  return {
    game_id: game.gameId,
    status,
    final_scores: scoreEntries(game, result.scores),
    winner_ids: result.winnerIds,
    closes_at: closesAt.toISOString(),
    countdown_seconds: Math.ceil(countdownMs / 1000),
  };
}

export function playerDisconnectedPayload(userId: string, deadline: Date) {
  return { player_id: userId, reconnect_deadline: deadline.toISOString() };
}

export function continueOrEndRequestPayload(game: Game, deadline: Date) {
  return { remaining_player_ids: game.activePlayers.map((p) => p.id), decision_deadline: deadline.toISOString() };
}

export function gameTimeWarningPayload(game: Game, endsAt: Date, minutesRemaining: number) {
  return { game_id: game.gameId, ends_at: endsAt.toISOString(), minutes_remaining: minutesRemaining };
}

export function gameAbandonedPayload(gameId: string, reason: 'server_restart' | 'time_limit') {
  return { reason, game_id: gameId };
}
