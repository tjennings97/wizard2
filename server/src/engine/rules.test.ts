import { Card } from './Card';
import { determineTrump, maxRounds, scoreRound } from './rules';

describe('maxRounds = Math.floor(deckSize / playerCount)', () => {
  it.each([
    [3, 20],
    [4, 15],
    [5, 12],
    [6, 10],
    [7, 8],
    [8, 7],
    [9, 6],
    [10, 6],
  ])('%i players → %i rounds with a 60-card deck', (players, rounds) => {
    expect(maxRounds(60, players)).toBe(rounds);
  });

  it('uses the configured deck size (68-card extended)', () => {
    expect(maxRounds(68, 3)).toBe(22);
    expect(maxRounds(68, 4)).toBe(17);
    expect(maxRounds(68, 6)).toBe(11);
  });
});

describe('determineTrump', () => {
  it('suited card flipped → that suit is trump', () => {
    expect(determineTrump(Card.suited('clubs', 9))).toEqual({
      trumpSuit: 'clubs',
      trumpSource: 'flip',
      requiresDeclaration: false,
    });
  });

  it('Jester flipped → no trump', () => {
    expect(determineTrump(Card.jester())).toEqual({
      trumpSuit: null,
      trumpSource: null,
      requiresDeclaration: false,
    });
  });

  it('Wizard flipped → dealer must declare', () => {
    expect(determineTrump(Card.wizard())).toEqual({
      trumpSuit: null,
      trumpSource: null,
      requiresDeclaration: true,
    });
  });

  it('no card left to flip (all cards dealt) → no trump', () => {
    expect(determineTrump(null)).toEqual({
      trumpSuit: null,
      trumpSource: null,
      requiresDeclaration: false,
    });
  });
});

describe('scoreRound', () => {
  it('exact bid scores 20 + 10 × tricks', () => {
    expect(scoreRound(3, 3)).toBe(50);
    expect(scoreRound(0, 0)).toBe(20);
    expect(scoreRound(1, 1)).toBe(30);
  });

  it('overbid (won more than bid) loses 10 per extra trick', () => {
    expect(scoreRound(2, 4)).toBe(-20);
    expect(scoreRound(0, 3)).toBe(-30);
  });

  it('underbid (won fewer than bid) loses 10 per missing trick', () => {
    expect(scoreRound(3, 1)).toBe(-20);
    expect(scoreRound(5, 0)).toBe(-50);
  });
});
