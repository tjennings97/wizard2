import { Card, CardData } from './Card';
import { EngineError } from './errors';
import { User } from './User';

/**
 * A seated participant. Holds per-round state (hand, bid, tricks won) and the
 * cumulative score. Game validates turn order and legality before calling the
 * action methods; Player validates only what it can see itself.
 */
export class Player extends User {
  readonly isBot: boolean = false;
  /** Set by the socket layer; informational only, the engine never reads it. */
  connected = true;

  private _hand: Card[] = [];
  private _bid: number | null = null;
  private _tricksWon = 0;
  private _score = 0;

  get hand(): readonly Card[] {
    return this._hand;
  }

  get bid(): number | null {
    return this._bid;
  }

  get tricksWon(): number {
    return this._tricksWon;
  }

  get score(): number {
    return this._score;
  }

  hasCard(card: CardData): boolean {
    return this._hand.some((c) => c.equals(card));
  }

  placeBid(bid: number): void {
    if (this._bid !== null) {
      throw new EngineError('ALREADY_BID', `Player ${this.id} has already bid`);
    }
    if (!Number.isInteger(bid) || bid < 0 || bid > this._hand.length) {
      throw new EngineError('INVALID_BID', `Bid must be an integer from 0 to ${this._hand.length}`);
    }
    this._bid = bid;
  }

  /** Removes the card from hand and returns it. */
  playCard(card: CardData): Card {
    const index = this._hand.findIndex((c) => c.equals(card));
    if (index === -1) {
      throw new EngineError('CARD_NOT_IN_HAND', `Player ${this.id} does not hold that card`);
    }
    return this._hand.splice(index, 1)[0];
  }

  // --- Engine-internal mutators (called by Game) ---------------------------

  /** Clears round state and takes a new hand. */
  receiveHand(cards: readonly Card[]): void {
    this._hand = [...cards];
    this._bid = null;
    this._tricksWon = 0;
  }

  clearRound(): void {
    this.receiveHand([]);
  }

  addTrickWon(): void {
    this._tricksWon++;
  }

  addScore(delta: number): void {
    this._score += delta;
  }
}
