/**
 * Game rules shared by every deck edition. Rules that differ between editions
 * belong in that edition's Ruleset instead.
 */
import { EngineError } from './errors';

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;

export type BidRule = 'open' | 'uneven';
/** How trump was set. Null when there is no trump this round. */
export type TrumpSource = 'flip' | 'declaration' | null;

export function maxRounds(deckSize: number, playerCount: number): number {
  if (!Number.isInteger(playerCount) || playerCount < 1) {
    throw new EngineError('INVALID_CONFIG', `Invalid player count: ${playerCount}`);
  }
  return Math.floor(deckSize / playerCount);
}

/** Exact: 20 + 10 × tricks. Otherwise: −10 × |tricks − bid|. */
export function scoreRound(bid: number, tricksWon: number): number {
  if (bid === tricksWon) return 20 + 10 * tricksWon;
  return -10 * Math.abs(tricksWon - bid);
}
