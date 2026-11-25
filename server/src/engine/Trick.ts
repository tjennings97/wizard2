import { Card, CardData, Suit } from './Card';
import { EngineError } from './errors';
import type { Ruleset } from './rulesets';
import { STANDARD_RULESET } from './rulesets/standard';

export type WinningCardType = 'wizard' | 'trump' | 'suited' | 'jester';

export interface PlayedCard {
  playerId: string;
  card: Card;
}

export interface TrickResult {
  winnerId: string;
  winningCard: Card;
  winningCardType: WinningCardType;
}

export interface TrickData {
  trickNumber: number;
  leaderId: string;
  cards: { playerId: string; card: CardData }[];
  winnerId: string | null;
  winningCardType: WinningCardType | null;
}

/**
 * Cards played in one trick, in play order. Turn order and player count are
 * enforced by Game; Trick records plays and asks the ruleset for legality and
 * the winner.
 */
export class Trick {
  readonly trickNumber: number;
  readonly leaderId: string;
  private readonly ruleset: Ruleset;
  private readonly played: PlayedCard[] = [];
  private result: TrickResult | null = null;

  constructor(trickNumber: number, leaderId: string, ruleset: Ruleset = STANDARD_RULESET) {
    this.trickNumber = trickNumber;
    this.leaderId = leaderId;
    this.ruleset = ruleset;
  }

  get cards(): readonly PlayedCard[] {
    return this.played;
  }

  get size(): number {
    return this.played.length;
  }

  get isResolved(): boolean {
    return this.result !== null;
  }

  get winner(): TrickResult | null {
    return this.result;
  }

  /** Suit of the first suited card played, or null if none has been played. */
  get ledSuit(): Suit | null {
    return this.played.find((p) => p.card.isSuited)?.card.suit ?? null;
  }

  /** Suit players are obliged to follow, per the ruleset. */
  get suitToFollow(): Suit | null {
    return this.ruleset.suitToFollow(this.played);
  }

  /** Whether `card` may legally be played from `hand`, per the ruleset. */
  isLegalPlay(hand: readonly Card[], card: Card): boolean {
    return this.ruleset.isLegalPlay(this.played, hand, card);
  }

  playCard(playerId: string, card: Card): void {
    if (this.result) {
      throw new EngineError('INVALID_PHASE', 'Trick is already resolved');
    }
    if (this.played.some((p) => p.playerId === playerId)) {
      throw new EngineError('NOT_YOUR_TURN', `Player ${playerId} has already played in this trick`);
    }
    this.played.push({ playerId, card });
  }

  /** Determines the winner per the ruleset and returns their player ID. */
  resolve(trump: Suit | null): string {
    if (this.played.length === 0) {
      throw new EngineError('INVALID_PHASE', 'Cannot resolve an empty trick');
    }
    const { winnerIndex, winningCardType } = this.ruleset.resolveTrick(this.played, trump);
    const play = this.played[winnerIndex];
    this.result = { winnerId: play.playerId, winningCard: play.card, winningCardType };
    return play.playerId;
  }

  toData(): TrickData {
    return {
      trickNumber: this.trickNumber,
      leaderId: this.leaderId,
      cards: this.played.map((p) => ({ playerId: p.playerId, card: p.card.toData() })),
      winnerId: this.result?.winnerId ?? null,
      winningCardType: this.result?.winningCardType ?? null,
    };
  }
}
