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

/**
 * One playing card, drawn in CSS and text only (docs/design/ui-foundation.md, "Card"): cream stock,
 * the suit in the top-left and bottom-right corners, the rank large in the centre. Wizards have a
 * gold border and Jesters a violet one, each labelled in Cinzel (the label drops on small cards).
 */
export function Card({ card, size = 'normal' }: { card: CardData; size?: 'normal' | 'small' }) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  const cls = ['playing-card', size, card.type, red ? 'red' : ''].filter(Boolean).join(' ');
  let corner: string;
  let centre: JSX.Element;
  if (card.type === 'suited') {
    corner = SUIT_SYMBOLS[card.suit!];
    centre = <span className="pc-rank">{RANKS[card.rank!] ?? card.rank}</span>;
  } else {
    const name = card.type === 'wizard' ? 'Wizard' : 'Jester';
    corner = name[0];
    centre = (
      <>
        <span className="pc-special">{name[0]}</span>
        <span className="pc-label">{name}</span>
      </>
    );
  }
  return (
    <span className={cls} role="img" aria-label={cardLabel(card)}>
      <span className="pc-corner tl" aria-hidden="true">
        {corner}
      </span>
      <span className="pc-centre" aria-hidden="true">
        {centre}
      </span>
      <span className="pc-corner br" aria-hidden="true">
        {corner}
      </span>
    </span>
  );
}

/** The back of a card (dark green CSS pattern, no image). */
export function CardBack({ size = 'normal' }: { size?: 'normal' | 'small' }) {
  return <span className={`playing-card back ${size}`} aria-hidden="true" />;
}
