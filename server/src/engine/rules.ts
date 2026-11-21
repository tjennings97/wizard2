import { Card, Suit } from './Card';
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

export interface TrumpDetermination {
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  /** True when a Wizard was flipped and the dealer must declare a suit before bidding. */
  requiresDeclaration: boolean;
}

/**
 * Trump from the flipped card. Pass `null` when every card was dealt (final
 * round where deckSize is divisible by the player count): no card to flip, no trump.
 */
export function determineTrump(flipped: Card | null): TrumpDetermination {
  if (flipped === null) {
    return { trumpSuit: null, trumpSource: null, requiresDeclaration: false };
  }
  switch (flipped.type) {
    case 'suited':
      return { trumpSuit: flipped.suit, trumpSource: 'flip', requiresDeclaration: false };
    case 'jester':
      return { trumpSuit: null, trumpSource: null, requiresDeclaration: false };
    case 'wizard':
      return { trumpSuit: null, trumpSource: null, requiresDeclaration: true };
  }
}

/** Exact: 20 + 10 × tricks. Otherwise: −10 × |tricks − bid|. */
export function scoreRound(bid: number, tricksWon: number): number {
  if (bid === tricksWon) return 20 + 10 * tricksWon;
  return -10 * Math.abs(tricksWon - bid);
}
