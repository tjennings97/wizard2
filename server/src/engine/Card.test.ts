import { Card } from './Card';
import { EngineError } from './errors';

describe('Card', () => {
  it('creates suited cards with suit and rank', () => {
    const c = Card.suited('hearts', 14);
    expect(c.type).toBe('suited');
    expect(c.suit).toBe('hearts');
    expect(c.rank).toBe(14);
    expect(c.isSuited).toBe(true);
  });

  it('creates Wizards and Jesters with no suit or rank', () => {
    expect(Card.wizard().toData()).toEqual({ suit: null, rank: null, type: 'wizard' });
    expect(Card.jester().toData()).toEqual({ suit: null, rank: null, type: 'jester' });
    expect(Card.wizard().isWizard).toBe(true);
    expect(Card.jester().isJester).toBe(true);
  });

  it('is immutable', () => {
    const c = Card.suited('spades', 7);
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => {
      (c as unknown as { rank: number }).rank = 9;
    }).toThrow(TypeError);
  });

  it('rejects invalid ranks and suits', () => {
    expect(() => Card.suited('hearts', 1)).toThrow(EngineError);
    expect(() => Card.suited('hearts', 15)).toThrow(EngineError);
    expect(() => Card.suited('hearts', 2.5)).toThrow(EngineError);
    expect(() => Card.suited('blue' as never, 5)).toThrow(EngineError);
  });

  it('compares by value', () => {
    expect(Card.suited('clubs', 10).equals(Card.suited('clubs', 10))).toBe(true);
    expect(Card.suited('clubs', 10).equals(Card.suited('clubs', 11))).toBe(false);
    expect(Card.suited('clubs', 10).equals(Card.suited('hearts', 10))).toBe(false);
    expect(Card.wizard().equals(Card.wizard())).toBe(true);
    expect(Card.wizard().equals(Card.jester())).toBe(false);
  });

  it('round-trips through JSON', () => {
    for (const c of [Card.suited('diamonds', 12), Card.wizard(), Card.jester()]) {
      const restored = Card.fromData(JSON.parse(JSON.stringify(c)));
      expect(restored.equals(c)).toBe(true);
    }
  });
});
