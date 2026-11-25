import { Card } from './Card';
import { EngineError } from './errors';
import { Trick } from './Trick';

const S = Card.suited;
const W = Card.wizard;
const J = Card.jester;

function trickOf(...plays: [string, Card][]): Trick {
  const t = new Trick(1, plays[0][0]);
  for (const [id, card] of plays) t.playCard(id, card);
  return t;
}

describe('Trick.resolve — priority 1: first Wizard', () => {
  it('a Wizard beats trump and led suit', () => {
    const t = trickOf(['a', S('hearts', 14)], ['b', W()], ['c', S('spades', 14)]);
    expect(t.resolve('spades')).toBe('b');
    expect(t.winner!.winningCardType).toBe('wizard');
  });

  it('the first of several Wizards wins', () => {
    const t = trickOf(['a', S('hearts', 2)], ['b', W()], ['c', W()], ['d', W()]);
    expect(t.resolve('hearts')).toBe('b');
  });

  it('a led Wizard wins', () => {
    const t = trickOf(['a', W()], ['b', S('clubs', 14)], ['c', W()]);
    expect(t.resolve('clubs')).toBe('a');
  });
});

describe('Trick.resolve — priority 2: highest trump', () => {
  it('lowest trump beats highest led suit', () => {
    const t = trickOf(['a', S('hearts', 14)], ['b', S('spades', 2)], ['c', S('hearts', 13)]);
    expect(t.resolve('spades')).toBe('b');
    expect(t.winner!.winningCardType).toBe('trump');
  });

  it('highest of several trumps wins', () => {
    const t = trickOf(['a', S('hearts', 5)], ['b', S('spades', 9)], ['c', S('spades', 12)], ['d', S('spades', 3)]);
    expect(t.resolve('spades')).toBe('c');
  });

  it('when trump is the led suit, highest trump wins', () => {
    const t = trickOf(['a', S('diamonds', 4)], ['b', S('diamonds', 11)], ['c', S('clubs', 14)]);
    expect(t.resolve('diamonds')).toBe('b');
    expect(t.winner!.winningCardType).toBe('trump');
  });
});

describe('Trick.resolve — priority 3: highest card of led suit', () => {
  it('highest led-suit card wins when no Wizard or trump is played', () => {
    const t = trickOf(['a', S('hearts', 7)], ['b', S('hearts', 12)], ['c', S('clubs', 14)]);
    expect(t.resolve('spades')).toBe('b');
    expect(t.winner!.winningCardType).toBe('suited');
  });

  it('off-suit cards never win, even when higher', () => {
    const t = trickOf(['a', S('hearts', 2)], ['b', S('clubs', 14)], ['c', S('diamonds', 14)]);
    expect(t.resolve(null)).toBe('a');
  });

  it('with no trump, led suit decides', () => {
    const t = trickOf(['a', S('spades', 10)], ['b', S('spades', 11)], ['c', J()]);
    expect(t.resolve(null)).toBe('b');
  });

  it('after a Jester lead, the first suited card sets the led suit', () => {
    const t = trickOf(['a', J()], ['b', S('clubs', 3)], ['c', S('hearts', 14)], ['d', S('clubs', 9)]);
    expect(t.ledSuit).toBe('clubs');
    expect(t.resolve(null)).toBe('d');
  });
});

describe('Trick.resolve — priority 4: first Jester', () => {
  it('first Jester wins when all cards are Jesters', () => {
    const t = trickOf(['a', J()], ['b', J()], ['c', J()]);
    expect(t.resolve('hearts')).toBe('a');
    expect(t.winner!.winningCardType).toBe('jester');
  });

  it('a Jester never wins if any non-Jester is played', () => {
    const t = trickOf(['a', J()], ['b', J()], ['c', S('hearts', 2)]);
    expect(t.resolve('spades')).toBe('c');
  });
});

describe('Trick follow-suit legality', () => {
  it('must follow the led suit when able', () => {
    const t = trickOf(['a', S('hearts', 7)]);
    const hand = [S('hearts', 2), S('spades', 14)];
    expect(t.isLegalPlay(hand, S('hearts', 2))).toBe(true);
    expect(t.isLegalPlay(hand, S('spades', 14))).toBe(false);
  });

  it('may play any card when unable to follow suit', () => {
    const t = trickOf(['a', S('hearts', 7)]);
    const hand = [S('clubs', 2), S('spades', 14)];
    expect(t.isLegalPlay(hand, S('spades', 14))).toBe(true);
    expect(t.isLegalPlay(hand, S('clubs', 2))).toBe(true);
  });

  it('Wizards and Jesters may always be played', () => {
    const t = trickOf(['a', S('hearts', 7)]);
    const hand = [S('hearts', 2), W(), J()];
    expect(t.isLegalPlay(hand, W())).toBe(true);
    expect(t.isLegalPlay(hand, J())).toBe(true);
  });

  it('a Wizard lead imposes no suit obligation, even after a suited card', () => {
    const t = trickOf(['a', W()], ['b', S('hearts', 5)]);
    expect(t.suitToFollow).toBeNull();
    expect(t.isLegalPlay([S('hearts', 9), S('clubs', 3)], S('clubs', 3))).toBe(true);
  });

  it('a Jester lead imposes no suit obligation until a suited card is played', () => {
    const t = trickOf(['a', J()]);
    expect(t.suitToFollow).toBeNull();
    expect(t.isLegalPlay([S('hearts', 9), S('clubs', 3)], S('clubs', 3))).toBe(true);
  });

  it('after a Jester lead, the first suited card sets the suit to follow', () => {
    const t = trickOf(['a', J()], ['b', S('hearts', 5)]);
    expect(t.suitToFollow).toBe('hearts');
    const hand = [S('hearts', 9), S('clubs', 3)];
    expect(t.isLegalPlay(hand, S('clubs', 3))).toBe(false);
    expect(t.isLegalPlay(hand, S('hearts', 9))).toBe(true);
  });

  it('after several Jesters, the first suited card still sets the suit', () => {
    const t = trickOf(['a', J()], ['b', J()], ['c', S('spades', 4)], ['d', S('hearts', 14)]);
    expect(t.suitToFollow).toBe('spades');
    expect(t.isLegalPlay([S('spades', 2), S('hearts', 3)], S('hearts', 3))).toBe(false);
  });

  it('a Wizard played after a suited lead does not cancel the obligation', () => {
    const t = trickOf(['a', S('hearts', 7)], ['b', W()]);
    expect(t.suitToFollow).toBe('hearts');
    const hand = [S('hearts', 2), S('spades', 14)];
    expect(t.isLegalPlay(hand, S('spades', 14))).toBe(false);
    expect(t.isLegalPlay(hand, S('hearts', 2))).toBe(true);
  });

  it('a Jester lead followed immediately by a Wizard imposes no suit obligation', () => {
    const t = trickOf(['a', J()], ['b', W()], ['c', S('clubs', 6)]);
    expect(t.suitToFollow).toBeNull();
    expect(t.isLegalPlay([S('clubs', 2), S('hearts', 3)], S('hearts', 3))).toBe(true);
  });

  it('several Jesters then a Wizard impose no suit obligation', () => {
    const t = trickOf(['a', J()], ['b', J()], ['c', W()], ['d', S('clubs', 6)]);
    expect(t.suitToFollow).toBeNull();
    expect(t.isLegalPlay([S('clubs', 2), S('hearts', 3)], S('hearts', 3))).toBe(true);
  });

  it('after a Jester lead sets a suit, a later Wizard does not cancel it', () => {
    const t = trickOf(['a', J()], ['b', S('clubs', 6)], ['c', W()]);
    expect(t.suitToFollow).toBe('clubs');
    const hand = [S('clubs', 2), S('hearts', 3)];
    expect(t.isLegalPlay(hand, S('hearts', 3))).toBe(false);
    expect(t.isLegalPlay(hand, S('clubs', 2))).toBe(true);
  });

  it('an all-Jester trick never sets a suit', () => {
    const t = trickOf(['a', J()], ['b', J()]);
    expect(t.suitToFollow).toBeNull();
  });

  it('the leader may play anything', () => {
    const t = new Trick(1, 'a');
    expect(t.isLegalPlay([S('hearts', 9), S('clubs', 3)], S('clubs', 3))).toBe(true);
  });
});

describe('Trick bookkeeping', () => {
  it('rejects a second card from the same player', () => {
    const t = trickOf(['a', S('hearts', 7)]);
    expect(() => t.playCard('a', S('hearts', 8))).toThrow(EngineError);
  });

  it('rejects plays after resolution and resolving an empty trick', () => {
    const t = trickOf(['a', S('hearts', 7)]);
    t.resolve(null);
    expect(() => t.playCard('b', S('hearts', 8))).toThrow(EngineError);
    expect(() => new Trick(1, 'a').resolve(null)).toThrow(EngineError);
  });

  it('serializes to plain data', () => {
    const t = trickOf(['a', S('hearts', 7)], ['b', W()]);
    t.resolve(null);
    expect(JSON.parse(JSON.stringify(t.toData()))).toEqual({
      trickNumber: 1,
      leaderId: 'a',
      cards: [
        { playerId: 'a', card: { suit: 'hearts', rank: 7, type: 'suited' } },
        { playerId: 'b', card: { suit: null, rank: null, type: 'wizard' } },
      ],
      winnerId: 'b',
      winningCardType: 'wizard',
    });
  });
});
