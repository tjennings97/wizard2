import type { Card, Suit } from '../Card';
import { EngineError } from '../errors';
import type { TrumpSource } from '../rules';
import { STANDARD_RULESET } from './standard';
import type { PlayedCard, WinningCardType } from '../Trick';

/**
 * Deck editions the engine can play. Each maps to one Ruleset.
 * Planned: 'camelot' (Wizard Camelot Edition; see docs/product/game-rules.md).
 *
 * To add an edition: implement `Ruleset` in a new file in this folder, add its
 * name to `DeckType`, and register it in `RULESETS` below.
 */
export type DeckType = 'standard';

/** Result of `Ruleset.determineTrump`; the same shape for every edition. */
export interface TrumpDetermination {
  trumpSuit: Suit | null;
  trumpSource: TrumpSource;
  /** True when the dealer must declare a suit before bidding. */
  requiresDeclaration: boolean;
}

export interface TrickOutcome {
  /** Index into the plays array of the winning play. */
  winnerIndex: number;
  winningCardType: WinningCardType;
}

/**
 * Everything that differs between deck editions. Trick, Round, and Game
 * delegate to the ruleset instead of hard-coding card behaviour, so a new
 * edition is a new Ruleset (plus any new card types), not changes to them.
 */
export interface Ruleset {
  readonly deckType: DeckType;
  readonly deckSize: number;

  /** All cards in the edition, in a fixed (unshuffled) order. */
  buildDeck(): Card[];

  /** Trump from the flipped card; `null` means every card was dealt. */
  determineTrump(flipped: Card | null): TrumpDetermination;

  /** Suit players must follow given the plays so far, or null if none. */
  suitToFollow(plays: readonly PlayedCard[]): Suit | null;

  /** Whether `card` may be played from `hand` given the plays so far. */
  isLegalPlay(plays: readonly PlayedCard[], hand: readonly Card[], card: Card): boolean;

  /**
   * Winner of a non-empty trick. Receives plays in order, so position-dependent
   * rules (such as Camelot's Holy Grail) can be expressed here.
   */
  resolveTrick(plays: readonly PlayedCard[], trump: Suit | null): TrickOutcome;
}

const RULESETS: Readonly<Record<DeckType, Ruleset>> = {
  standard: STANDARD_RULESET,
};

export const DECK_TYPES: readonly DeckType[] = Object.keys(RULESETS) as DeckType[];

export function getRuleset(deckType: string): Ruleset {
  const ruleset = (RULESETS as Record<string, Ruleset | undefined>)[deckType];
  if (!ruleset) {
    throw new EngineError(
      'INVALID_CONFIG',
      `Unsupported deck type "${deckType}"; supported: ${DECK_TYPES.join(', ')}`,
    );
  }
  return ruleset;
}
