import { Card, SUITS, MIN_RANK, MAX_RANK, Suit } from '../Card';
import type { Ruleset, TrickOutcome, TrumpDetermination } from '.';
import type { PlayedCard } from '../Trick';

/** 52 suited cards (2–A in four suits) + 4 Wizards + 4 Jesters. */
function buildDeck(): Card[] {
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
 * Suited card → its suit is trump. Jester → no trump. Wizard → the dealer
 * declares. `null` (every card was dealt) → no trump.
 */
function determineTrump(flipped: Card | null): TrumpDetermination {
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

/**
 * Jesters at the start of a trick are skipped; the first non-Jester card
 * decides the obligation for the rest of the trick:
 * - Suited card → its suit must be followed, even if a Wizard comes later.
 * - Wizard (led, or right after the opening Jesters) → no suit to follow.
 * Until a non-Jester card is played, there is no suit to follow.
 */
function suitToFollow(plays: readonly PlayedCard[]): Suit | null {
  const first = plays.find((p) => !p.card.isJester)?.card;
  if (!first || first.isWizard) return null;
  return first.suit;
}

/** Wizards and Jesters are always playable; suited cards must follow if able. */
function isLegalPlay(plays: readonly PlayedCard[], hand: readonly Card[], card: Card): boolean {
  if (!card.isSuited) return true;
  const follow = suitToFollow(plays);
  if (follow === null || card.suit === follow) return true;
  return !hand.some((c) => c.isSuited && c.suit === follow);
}

/** Index of the highest-ranked play whose card has `suit`, or -1. */
function highestOfSuit(plays: readonly PlayedCard[], suit: Suit): number {
  let best = -1;
  plays.forEach((p, i) => {
    if (p.card.suit !== suit) return;
    if (best === -1 || (p.card.rank as number) > (plays[best].card.rank as number)) best = i;
  });
  return best;
}

/**
 * First Wizard → highest trump → highest card of the led suit (the suit of the
 * first suited card) → first Jester (only when every card is a Jester).
 */
function resolveTrick(plays: readonly PlayedCard[], trump: Suit | null): TrickOutcome {
  const wizard = plays.findIndex((p) => p.card.isWizard);
  if (wizard !== -1) return { winnerIndex: wizard, winningCardType: 'wizard' };

  if (trump !== null) {
    const best = highestOfSuit(plays, trump);
    if (best !== -1) return { winnerIndex: best, winningCardType: 'trump' };
  }

  const led = plays.find((p) => p.card.isSuited)?.card.suit ?? null;
  if (led !== null) {
    return { winnerIndex: highestOfSuit(plays, led), winningCardType: 'suited' };
  }

  return { winnerIndex: 0, winningCardType: 'jester' };
}

export const STANDARD_RULESET: Ruleset = Object.freeze({
  deckType: 'standard',
  deckSize: 60,
  buildDeck,
  determineTrump,
  suitToFollow,
  isLegalPlay,
  resolveTrick,
});
