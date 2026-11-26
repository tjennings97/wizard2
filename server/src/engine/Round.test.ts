import { Card } from './Card';
import { EngineError } from './errors';
import { Round, RoundOptions } from './Round';
import type { Ruleset } from './rulesets';
import { STANDARD_RULESET } from './rulesets/standard';

const SEATS = ['a', 'b', 'c'];

function makeRound(overrides: Partial<RoundOptions> = {}): Round {
  return new Round({
    roundNumber: 3,
    seatOrder: SEATS,
    dealerId: 'a',
    bidRule: 'open',
    trumpCard: Card.suited('hearts', 4),
    ...overrides,
  });
}

/** Bids in bid order (b, c, a when a deals), then awards tricks. */
function play(round: Round, bids: Record<string, number>, won: Record<string, number>) {
  for (const id of round.bidOrder) round.recordBid(id, bids[id]);
  for (const [id, n] of Object.entries(won)) {
    for (let i = 0; i < n; i++) round.recordTrickWon(id);
  }
}

describe('Round bidding', () => {
  it('bids start left of the dealer; the dealer bids last', () => {
    expect(makeRound({ dealerId: 'a' }).bidOrder).toEqual(['b', 'c', 'a']);
    expect(makeRound({ dealerId: 'c' }).bidOrder).toEqual(['a', 'b', 'c']);
  });

  it('enforces bid order', () => {
    const r = makeRound();
    expect(() => r.recordBid('a', 1)).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    r.recordBid('b', 1);
    expect(r.currentBidderId).toBe('c');
  });

  it('rejects bids outside 0..roundNumber and non-integers', () => {
    const r = makeRound();
    expect(() => r.recordBid('b', -1)).toThrow(expect.objectContaining({ code: 'INVALID_BID' }));
    expect(() => r.recordBid('b', 4)).toThrow(expect.objectContaining({ code: 'INVALID_BID' }));
    expect(() => r.recordBid('b', 1.5)).toThrow(expect.objectContaining({ code: 'INVALID_BID' }));
    r.recordBid('b', 0);
    r.recordBid('c', 3);
  });

  it('bids are locked once placed', () => {
    const r = makeRound();
    r.recordBid('b', 1);
    expect(() => r.recordBid('b', 2)).toThrow(expect.objectContaining({ code: 'ALREADY_BID' }));
  });

  it('open rule lets the dealer make the total equal the trick count', () => {
    const r = makeRound({ bidRule: 'open' });
    r.recordBid('b', 1);
    r.recordBid('c', 1);
    expect(r.allowedBids('a')).toEqual([0, 1, 2, 3]);
    r.recordBid('a', 1);
    expect(r.bidTotal).toBe(3);
  });

  it('uneven rule blocks the dealer from making the total equal the trick count', () => {
    const r = makeRound({ bidRule: 'uneven' });
    r.recordBid('b', 1);
    r.recordBid('c', 1);
    expect(r.allowedBids('a')).toEqual([0, 2, 3]);
    expect(() => r.recordBid('a', 1)).toThrow(expect.objectContaining({ code: 'INVALID_BID' }));
    r.recordBid('a', 2);
  });

  it('uneven rule does not apply in round 1', () => {
    const r = makeRound({ bidRule: 'uneven', roundNumber: 1 });
    r.recordBid('b', 0);
    r.recordBid('c', 0);
    expect(r.allowedBids('a')).toEqual([0, 1]);
    r.recordBid('a', 1);
    expect(r.bidTotal).toBe(1);
  });

  it('uneven rule does not restrict non-dealers', () => {
    const r = makeRound({ bidRule: 'uneven' });
    r.recordBid('b', 3);
    expect(r.allowedBids('c')).toEqual([0, 1, 2, 3]);
    r.recordBid('c', 0);
  });

  it('records bid position', () => {
    const r = makeRound({ dealerId: 'b' });
    expect(r.bidPosition('c')).toBe(1);
    expect(r.bidPosition('b')).toBe(3);
  });
});

describe('Round trump', () => {
  it('suited flip sets trump from the card', () => {
    const r = makeRound({ trumpCard: Card.suited('spades', 10) });
    expect(r.trumpSuit).toBe('spades');
    expect(r.trumpSource).toBe('flip');
  });

  it('Jester flip means no trump', () => {
    const r = makeRound({ trumpCard: Card.jester() });
    expect(r.trumpSuit).toBeNull();
    expect(r.awaitingDeclaration).toBe(false);
  });

  it('null trump card (all cards dealt) means no trump', () => {
    const r = makeRound({ trumpCard: null });
    expect(r.trumpSuit).toBeNull();
    expect(r.trumpSource).toBeNull();
    expect(r.awaitingDeclaration).toBe(false);
  });

  it('Wizard flip waits for the dealer to declare before bidding', () => {
    const r = makeRound({ trumpCard: Card.wizard(), dealerId: 'a' });
    expect(r.awaitingDeclaration).toBe(true);
    expect(() => r.recordBid('b', 1)).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    expect(() => r.declareTrump('b', 'clubs')).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    expect(() => r.declareTrump('a', 'blue' as never)).toThrow(expect.objectContaining({ code: 'INVALID_SUIT' }));
    r.declareTrump('a', 'clubs');
    expect(r.trumpSuit).toBe('clubs');
    expect(r.trumpSource).toBe('declaration');
    expect(() => r.declareTrump('a', 'hearts')).toThrow(EngineError);
    r.recordBid('b', 1);
  });
});

describe('Round.computeScores', () => {
  it('exact bid: 20 + 10 × tricks won', () => {
    const r = makeRound();
    play(r, { a: 0, b: 2, c: 1 }, { b: 2, c: 1 });
    expect(r.computeScores()).toEqual({ a: 20, b: 40, c: 30 });
  });

  it('overbid: −10 per trick over the bid', () => {
    const r = makeRound();
    play(r, { a: 0, b: 1, c: 0 }, { a: 1, b: 2 });
    // a bid 0 won 1; b bid 1 won 2; c bid 0 won 0
    expect(r.computeScores()).toEqual({ a: -10, b: -10, c: 20 });
  });

  it('underbid: −10 per trick under the bid', () => {
    const r = makeRound();
    play(r, { a: 3, b: 0, c: 0 }, { a: 1, b: 1, c: 1 });
    // a bid 3 won 1; b, c bid 0 won 1
    expect(r.computeScores()).toEqual({ a: -20, b: -10, c: -10 });
  });

  it('every player can score negative in the same round', () => {
    const r = makeRound();
    play(r, { a: 2, b: 2, c: 2 }, { a: 3 });
    expect(r.computeScores()).toEqual({ a: -10, b: -20, c: -20 });
  });

  it('requires all bids and all tricks', () => {
    const r = makeRound();
    r.recordBid('b', 1);
    expect(() => r.computeScores()).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    r.recordBid('c', 1);
    r.recordBid('a', 1);
    r.recordTrickWon('a');
    expect(() => r.computeScores()).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
  });

  it('cannot award more tricks than the round has', () => {
    const r = makeRound();
    play(r, { a: 0, b: 0, c: 0 }, { a: 3 });
    expect(() => r.recordTrickWon('b')).toThrow(EngineError);
  });

  it('is immutable after scoring', () => {
    const r = makeRound();
    play(r, { a: 1, b: 1, c: 1 }, { a: 1, b: 1, c: 1 });
    const first = r.computeScores();
    expect(r.computeScores()).toEqual(first);
    expect(() => r.recordTrickWon('a')).toThrow(expect.objectContaining({ code: 'ROUND_CLOSED' }));
    expect(r.results()).toEqual([
      { playerId: 'b', bid: 1, tricksWon: 1, scoreDelta: 30 },
      { playerId: 'c', bid: 1, tricksWon: 1, scoreDelta: 30 },
      { playerId: 'a', bid: 1, tricksWon: 1, scoreDelta: 30 },
    ]);
  });

  it('rejects unknown players', () => {
    expect(() => makeRound().recordTrickWon('zed')).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLAYER' }));
  });
});

describe('Round construction', () => {
  it('rejects a dealer who is not seated', () => {
    expect(() => makeRound({ dealerId: 'zed' })).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLAYER' }));
  });

  it('stores dealt hands as plain CardData snapshots', () => {
    const r = makeRound({ dealtHands: { a: [Card.wizard()], b: [Card.suited('clubs', 7)] } });
    expect(r.dealtHands).toEqual({
      a: [Card.wizard().toData()],
      b: [Card.suited('clubs', 7).toData()],
    });
    expect(r.dealtHands.a[0]).not.toBeInstanceOf(Card);
    expect(makeRound().dealtHands).toEqual({});
  });

  it('getBid is null until the player bids', () => {
    const r = makeRound();
    expect(r.getBid('b')).toBeNull();
    r.recordBid('b', 2);
    expect(r.getBid('b')).toBe(2);
  });

  it('getTricksWon starts at zero and rejects unknown players', () => {
    const r = makeRound();
    expect(r.getTricksWon('a')).toBe(0);
    play(r, { a: 1, b: 0, c: 0 }, { a: 1 });
    expect(r.getTricksWon('a')).toBe(1);
    expect(() => r.getTricksWon('zed')).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLAYER' }));
  });
});

describe('Round.startTrick', () => {
  const bidAll = (r: Round) => {
    for (const id of r.bidOrder) r.recordBid(id, 0);
  };

  it('requires all bids first', () => {
    const r = makeRound();
    r.recordBid('b', 0);
    expect(() => r.startTrick('b')).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
  });

  it('rejects an unknown leader', () => {
    const r = makeRound();
    bidAll(r);
    expect(() => r.startTrick('zed')).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLAYER' }));
  });

  it('numbers tricks, tracks the current one, and waits for it to resolve', () => {
    const r = makeRound();
    bidAll(r);
    expect(r.currentTrick).toBeNull();
    expect(r.tricks).toEqual([]);

    const t1 = r.startTrick('b');
    expect(t1).toMatchObject({ trickNumber: 1, leaderId: 'b' });
    expect(r.currentTrick).toBe(t1);
    expect(() => r.startTrick('b')).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));

    t1.playCard('b', Card.suited('hearts', 2));
    t1.resolve(r.trumpSuit);
    const t2 = r.startTrick('c');
    expect(t2).toMatchObject({ trickNumber: 2, leaderId: 'c' });
    expect(r.tricks).toEqual([t1, t2]);
    expect(r.currentTrick).toBe(t2);
  });

  it('stops after roundNumber tricks', () => {
    const r = makeRound({ roundNumber: 1 });
    bidAll(r);
    const t = r.startTrick('b');
    t.playCard('b', Card.jester());
    t.resolve(r.trumpSuit);
    expect(() => r.startTrick('b')).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
  });

  it('cannot start a trick once the round is scored', () => {
    const r = makeRound({ roundNumber: 1 });
    play(r, { a: 0, b: 1, c: 0 }, { b: 1 });
    r.computeScores();
    expect(() => r.startTrick('b')).toThrow(expect.objectContaining({ code: 'ROUND_CLOSED' }));
  });
});

describe('Round ruleset', () => {
  it('defaults to the standard ruleset', () => {
    expect(makeRound().ruleset).toBe(STANDARD_RULESET);
  });

  it('uses an injected ruleset for trump and for its tricks', () => {
    const ruleset: Ruleset = {
      ...STANDARD_RULESET,
      determineTrump: jest.fn(() => ({ trumpSuit: 'spades' as const, trumpSource: 'flip' as const, requiresDeclaration: false })),
      resolveTrick: jest.fn(() => ({ winnerIndex: 1, winningCardType: 'suited' as const })),
    };
    const flipped = Card.suited('hearts', 4);
    const r = makeRound({ roundNumber: 1, trumpCard: flipped, ruleset });

    expect(ruleset.determineTrump).toHaveBeenCalledWith(flipped);
    expect(r.trumpSuit).toBe('spades');

    for (const id of r.bidOrder) r.recordBid(id, 0);
    const t = r.startTrick('b');
    t.playCard('b', Card.suited('hearts', 14));
    t.playCard('c', Card.suited('hearts', 2));
    // Standard rules would pick b's ace; the stub picks index 1.
    expect(t.resolve(r.trumpSuit)).toBe('c');
    expect(ruleset.resolveTrick).toHaveBeenCalledTimes(1);
  });
});
