import type { Card as CardData, Suit } from '../api/types';

export const SUIT_SYMBOLS: Record<Suit, string> = { hearts: '♥', diamonds: '♦', spades: '♠', clubs: '♣' };
export const SUIT_NAMES: Record<Suit, string> = { hearts: 'Hearts', diamonds: 'Diamonds', spades: 'Spades', clubs: 'Clubs' };
const RANKS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RANK_NAMES: Record<number, string> = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };

export function cardLabel(card: CardData): string {
  if (card.type === 'wizard') return 'Wizard';
  if (card.type === 'jester') return 'Jester';
  return `${RANK_NAMES[card.rank!] ?? card.rank} of ${SUIT_NAMES[card.suit!]}`;
}

export function cardKey(card: CardData, i: number): string {
  return `${card.type}-${card.suit ?? ''}-${card.rank ?? ''}-${i}`;
}

/** One playing card, drawn with text only (no images). */
export function Card({ card, size = 'normal' }: { card: CardData; size?: 'normal' | 'small' }) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  const cls = ['playing-card', size, card.type, red ? 'red' : ''].filter(Boolean).join(' ');
  let face: JSX.Element;
  if (card.type === 'wizard') face = <span className="pc-special">W</span>;
  else if (card.type === 'jester') face = <span className="pc-special">J</span>;
  else {
    face = (
      <>
        <span className="pc-rank">{RANKS[card.rank!] ?? card.rank}</span>
        <span className="pc-suit">{SUIT_SYMBOLS[card.suit!]}</span>
      </>
    );
  }
  return (
    <span className={cls} role="img" aria-label={cardLabel(card)}>
      {face}
    </span>
  );
}
