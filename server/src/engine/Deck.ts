import { Card } from './Card';
import { EngineError } from './errors';
import { DeckType, getRuleset } from './rulesets';

/** Returns a float in [0, 1). Injectable so shuffles are deterministic in tests. */
export type RandomSource = () => number;

/**
 * A stateful pile of cards for one round. Index 0 is the top of the deck:
 * `deal` and `flip` both draw from the top. The deck type's ruleset decides
 * which cards it contains.
 */
export class Deck {
  readonly deckSize: number;
  private cards: Card[];
  private readonly random: RandomSource;

  constructor(deckType: DeckType = 'standard', random: RandomSource = Math.random) {
    const ruleset = getRuleset(deckType);
    const cards = ruleset.buildDeck();
    if (cards.length !== ruleset.deckSize) {
      // Guards against a ruleset whose deckSize disagrees with its deck.
      throw new EngineError(
        'INVALID_CONFIG',
        `Deck type "${deckType}" declares ${ruleset.deckSize} cards but builds ${cards.length}`,
      );
    }
    this.deckSize = ruleset.deckSize;
    this.random = random;
    this.cards = cards;
  }

  /** Builds a deck in an exact order (top first). Intended for tests and replay. */
  static fromCards(cards: readonly Card[], random: RandomSource = Math.random): Deck {
    const deck = Object.create(Deck.prototype) as Deck;
    Object.assign(deck, { deckSize: cards.length, random, cards: [...cards] });
    return deck;
  }

  get remaining(): number {
    return this.cards.length;
  }

  /** Fisher–Yates shuffle in place. */
  shuffle(): this {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
    return this;
  }

  /** Removes and returns the top `n` cards. */
  deal(n: number): Card[] {
    if (!Number.isInteger(n) || n < 0) {
      throw new EngineError('INVALID_CONFIG', `Cannot deal ${n} cards`);
    }
    if (n > this.cards.length) {
      throw new EngineError('DECK_EXHAUSTED', `Cannot deal ${n} cards; ${this.cards.length} remain`);
    }
    return this.cards.splice(0, n);
  }

  /** Removes and returns the top card for trump, or null if the deck is empty. */
  flip(): Card | null {
    return this.cards.shift() ?? null;
  }

  /** Copy of the remaining cards, top first. */
  peekAll(): Card[] {
    return [...this.cards];
  }
}
