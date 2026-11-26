/**
 * Socket payloads for game events, built from engine results. Pure: no I/O.
 * Names and fields follow docs/api/websocket-events.md (snake_case on the wire).
 */
import type { CardData, Game, RoundStarted, Suit, TrumpSource } from '../engine';

export interface PlayerSummary {
  user_id: string;
  display_name: string;
  /** 0-based seat, as in user_joined. Seat 0 deals round 1. */
  seat_index: number;
}

export interface BidEntry {
  player_id: string;
  bid: number;
}

export function playerSummaries(game: Game): PlayerSummary[] {
  return game.activePlayers.map((p, i) => ({ user_id: p.id, display_name: p.displayName, seat_index: i }));
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
