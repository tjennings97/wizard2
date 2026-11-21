import { EngineError } from './errors';

export const SUITS = ['hearts', 'diamonds', 'spades', 'clubs'] as const;
export type Suit = (typeof SUITS)[number];

export type CardType = 'suited' | 'wizard' | 'jester';

/** 2–10 numeric, 11 = J, 12 = Q, 13 = K, 14 = A (Ace high). */
export const MIN_RANK = 2;
export const MAX_RANK = 14;

/** Plain, JSON-safe representation of a card (used in GameState). */
export interface CardData {
  suit: Suit | null;
  rank: number | null;
  type: CardType;
}

export function isSuit(value: unknown): value is Suit {
  return typeof value === 'string' && (SUITS as readonly string[]).includes(value);
}

/**
 * Immutable value object. Wizards and Jesters have no suit or rank; all
 * Wizards are interchangeable, as are all Jesters.
 */
export class Card implements CardData {
  readonly suit: Suit | null;
  readonly rank: number | null;
  readonly type: CardType;

  private constructor(type: CardType, suit: Suit | null, rank: number | null) {
    this.type = type;
    this.suit = suit;
    this.rank = rank;
    Object.freeze(this);
  }

  static suited(suit: Suit, rank: number): Card {
    if (!isSuit(suit)) {
      throw new EngineError('INVALID_CONFIG', `Invalid suit: ${String(suit)}`);
    }
    if (!Number.isInteger(rank) || rank < MIN_RANK || rank > MAX_RANK) {
      throw new EngineError('INVALID_CONFIG', `Invalid rank: ${rank}`);
    }
    return new Card('suited', suit, rank);
  }

  static wizard(): Card {
    return new Card('wizard', null, null);
  }

  static jester(): Card {
    return new Card('jester', null, null);
  }

  static fromData(data: CardData): Card {
    switch (data.type) {
      case 'suited':
        return Card.suited(data.suit as Suit, data.rank as number);
      case 'wizard':
        return Card.wizard();
      case 'jester':
        return Card.jester();
      default:
        throw new EngineError('INVALID_CONFIG', `Invalid card type: ${String((data as CardData).type)}`);
    }
  }

  get isWizard(): boolean {
    return this.type === 'wizard';
  }

  get isJester(): boolean {
    return this.type === 'jester';
  }

  get isSuited(): boolean {
    return this.type === 'suited';
  }

  equals(other: CardData): boolean {
    return this.type === other.type && this.suit === other.suit && this.rank === other.rank;
  }

  toData(): CardData {
    return { suit: this.suit, rank: this.rank, type: this.type };
  }

  toJSON(): CardData {
    return this.toData();
  }

  toString(): string {
    if (this.type === 'wizard') return 'Wizard';
    if (this.type === 'jester') return 'Jester';
    const names: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
    return `${names[this.rank as number] ?? this.rank} of ${this.suit}`;
  }
}
