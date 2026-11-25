import { maxRounds, scoreRound } from './rules';

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

  it('works for any deck size', () => {
    expect(maxRounds(68, 3)).toBe(22);
    expect(maxRounds(68, 4)).toBe(17);
    expect(maxRounds(68, 6)).toBe(11);
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
