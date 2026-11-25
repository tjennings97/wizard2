import { Card, SUITS } from './Card';
import { Deck } from './Deck';
import { DECK_TYPES, getRuleset } from './rulesets';
import { EngineError } from './errors';

/** Deterministic PRNG (mulberry32) for reproducible shuffles. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Deck', () => {
  it('builds the standard 60-card deck by default', () => {
    const deck = new Deck();
    const cards = deck.peekAll();
    expect(deck.deckSize).toBe(60);
    expect(cards).toHaveLength(60);
    expect(cards.filter((c) => c.isWizard)).toHaveLength(4);
    expect(cards.filter((c) => c.isJester)).toHaveLength(4);
    for (const suit of SUITS) {
      const ranks = cards.filter((c) => c.suit === suit).map((c) => c.rank);
      expect(ranks.sort((a, b) => a! - b!)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    }
  });

  it('rejects unsupported deck types', () => {
    expect(() => new Deck('camelot' as never)).toThrow(EngineError);
  });

  it('every supported deck type builds exactly its declared size', () => {
    for (const type of DECK_TYPES) {
      const deck = new Deck(type);
      expect(deck.remaining).toBe(getRuleset(type).deckSize);
      expect(deck.deckSize).toBe(getRuleset(type).deckSize);
    }
  });

  it('shuffle permutes the cards without losing any', () => {
    const deck = new Deck('standard', seeded(42));
    const before = deck.peekAll().map(String);
    deck.shuffle();
    const after = deck.peekAll().map(String);
    expect(after).not.toEqual(before);
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('shuffle is deterministic for a given random source', () => {
    const a = new Deck('standard', seeded(7)).shuffle().peekAll().map(String);
    const b = new Deck('standard', seeded(7)).shuffle().peekAll().map(String);
    expect(a).toEqual(b);
  });

  it('deal(n) removes and returns the top n cards', () => {
    const deck = new Deck();
    const top = deck.peekAll().slice(0, 5);
    const hand = deck.deal(5);
    expect(hand).toEqual(top);
    expect(deck.remaining).toBe(55);
  });

  it('deal throws when not enough cards remain', () => {
    const deck = new Deck();
    deck.deal(58);
    expect(() => deck.deal(3)).toThrow(EngineError);
  });

  it('flip() returns the top card, or null once the deck is empty', () => {
    const deck = Deck.fromCards([Card.suited('hearts', 5), Card.jester()]);
    expect(deck.flip()!.equals(Card.suited('hearts', 5))).toBe(true);
    expect(deck.flip()!.isJester).toBe(true);
    expect(deck.flip()).toBeNull();
  });
});
