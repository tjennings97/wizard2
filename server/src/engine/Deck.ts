import { Card, SUITS, MIN_RANK, MAX_RANK } from './Card';
import { EngineError } from './errors';

export const STANDARD_DECK_SIZE = 60;
/**
 * Deck sizes the engine can currently build. The 68-card extended edition is
 * a planned variant; add its composition to `buildCards` and list it here.
 */
export const SUPPORTED_DECK_SIZES: readonly number[] = [STANDARD_DECK_SIZE];

/** Returns a float in [0, 1). Injectable so shuffles are deterministic in tests. */
export type RandomSource = () => number;

function buildCards(deckSize: number): Card[] {
  if (deckSize !== STANDARD_DECK_SIZE) {
    throw new EngineError(
      'INVALID_CONFIG',
      `Unsupported deck size ${deckSize}; supported: ${SUPPORTED_DECK_SIZES.join(', ')}`,
    );
  }
  const cards: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = MIN_RANK; rank <= MAX_RANK; rank++) {
      cards.push(Card.suited(suit, rank));
    }
  }
  for (let i = 0; i < 4; i++) cards.push(Card.wizard());
  for (let i = 0; i < 4; i++) cards.push(Card.jester());
  return cards;
}

/**
 * A stateful pile of cards for one round. Index 0 is the top of the deck:
 * `deal` and `flip` both draw from the top.
 */
export class Deck {
  readonly deckSize: number;
  private cards: Card[];
  private readonly random: RandomSource;

  constructor(deckSize: number = STANDARD_DECK_SIZE, random: RandomSource = Math.random) {
    this.deckSize = deckSize;
    this.random = random;
    this.cards = buildCards(deckSize);
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
