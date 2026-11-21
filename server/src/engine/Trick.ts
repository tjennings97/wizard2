import { Card, CardData, Suit } from './Card';
import { EngineError } from './errors';

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
 * enforced by Game; Trick only records plays and determines the winner.
 */
export class Trick {
  readonly trickNumber: number;
  readonly leaderId: string;
  private readonly played: PlayedCard[] = [];
  private result: TrickResult | null = null;

  constructor(trickNumber: number, leaderId: string) {
    this.trickNumber = trickNumber;
    this.leaderId = leaderId;
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

  /**
   * Suit that "highest of led suit" is judged against: the suit of the first
   * suited card played. Null if no suited card has been played.
   */
  get ledSuit(): Suit | null {
    return this.played.find((p) => p.card.isSuited)?.card.suit ?? null;
  }

  /**
   * Suit players are obliged to follow. Set only when the lead card is a
   * suited card; a Wizard or Jester lead frees everyone to play any card.
   */
  get suitToFollow(): Suit | null {
    const lead = this.played[0]?.card;
    return lead && lead.isSuited ? lead.suit : null;
  }

  /**
   * Whether `card` may legally be played from `hand`. Wizards and Jesters may
   * always be played. A suited card must match the suit to follow unless the
   * hand holds no card of that suit.
   */
  isLegalPlay(hand: readonly Card[], card: Card): boolean {
    if (!card.isSuited) return true;
    const follow = this.suitToFollow;
    if (follow === null || card.suit === follow) return true;
    return !hand.some((c) => c.isSuited && c.suit === follow);
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

  /**
   * Winner priority: first Wizard → highest trump → highest card of the led
   * suit → first Jester (only when every card is a Jester).
   */
  resolve(trump: Suit | null): string {
    if (this.played.length === 0) {
      throw new EngineError('INVALID_PHASE', 'Cannot resolve an empty trick');
    }

    const wizard = this.played.find((p) => p.card.isWizard);
    if (wizard) return this.finish(wizard, 'wizard');

    if (trump !== null) {
      const best = highest(this.played.filter((p) => p.card.suit === trump));
      if (best) return this.finish(best, 'trump');
    }

    const led = this.ledSuit;
    if (led !== null) {
      const best = highest(this.played.filter((p) => p.card.suit === led));
      if (best) return this.finish(best, 'suited');
    }

    // Only Jesters remain: the first one played wins.
    return this.finish(this.played[0], 'jester');
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

  private finish(play: PlayedCard, type: WinningCardType): string {
    this.result = { winnerId: play.playerId, winningCard: play.card, winningCardType: type };
    return play.playerId;
  }
}

function highest(plays: PlayedCard[]): PlayedCard | undefined {
  return plays.reduce<PlayedCard | undefined>(
    (best, p) => (!best || (p.card.rank as number) > (best.card.rank as number) ? p : best),
    undefined,
  );
}
