import { BotPlayer } from './BotPlayer';
import { Card } from './Card';
import { Deck } from './Deck';
import { EngineError, NotImplementedError } from './errors';
import { Game, GameOptions } from './Game';
import { Player } from './Player';
import { UserProps } from './User';
import { DEFAULT_AVATAR } from '../shared/avatar';

const S = Card.suited;
const W = Card.wizard;
const J = Card.jester;

const props = (id: string): UserProps => ({
  id,
  username: id,
  displayName: id.toUpperCase(),
  avatarConfig: DEFAULT_AVATAR,
  sessionId: null,
});
const players = (...ids: string[]) => ids.map((id) => new Player(props(id)));

/** Standard deck with `top` placed first (in order) and the rest after. */
function stacked(top: Card[]): Deck {
  const rest = new Deck().peekAll();
  for (const c of top) rest.splice(rest.findIndex((r) => r.equals(c)), 1);
  return Deck.fromCards([...top, ...rest]);
}

/**
 * Deterministic PRNG for reproducible shuffles in tests.
 * Standard mulberry32 (Tommy Ettinger); see github.com/bryc/code/blob/master/jshash/PRNGs.md.
 * Not cryptographically secure — never use outside tests.
 */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGame(overrides: Partial<GameOptions> = {}): Game {
  return new Game({
    gameId: 'g1',
    roomId: 'r1',
    players: players('a', 'b', 'c'),
    config: { roundCount: 3 },
    ...overrides,
  });
}

/**
 * Hands are dealt starting left of the dealer, `n` contiguous cards each, then
 * the next card is flipped. Round 1 dealer is seat 1 ('a'), so order is b, c, a.
 */
function gameWithDecks(decks: Record<number, Deck>, overrides: Partial<GameOptions> = {}): Game {
  return makeGame({ deckFactory: (_ruleset, round) => decks[round], ...overrides });
}

/** Plays the current round to completion: everyone bids their first allowed bid and plays their first legal card. */
function autoPlayRound(game: Game): void {
  if (game.phase === 'trump_declaration') game.declareTrump(game.currentTurnId!, 'hearts');
  while (game.phase === 'bidding') {
    const id = game.currentTurnId!;
    game.placeBid(id, game.currentRound!.allowedBids(id)[0]);
  }
  while (game.phase === 'trick') {
    const id = game.currentTurnId!;
    const hand = game.getPlayer(id).hand;
    const trick = game.currentRound!.currentTrick!;
    game.playCard(id, hand.find((c) => trick.isLegalPlay(hand, c))!);
  }
}

describe('Game construction', () => {
  it('requires 3–10 players', () => {
    expect(() => makeGame({ players: players('a', 'b') })).toThrow(EngineError);
    const eleven = 'abcdefghijk'.split('');
    expect(() => makeGame({ players: players(...eleven), config: { roundCount: 1 } })).toThrow(EngineError);
    expect(() => makeGame({ players: players(...eleven.slice(0, 10)), config: { roundCount: 6 } })).not.toThrow();
  });

  it('limits roundCount to Math.floor(deckSize / playerCount)', () => {
    expect(() => makeGame({ config: { roundCount: 20 } })).not.toThrow();
    expect(() => makeGame({ config: { roundCount: 21 } })).toThrow(EngineError);
    expect(() => makeGame({ players: players('a', 'b', 'c', 'd', 'e', 'f', 'g'), config: { roundCount: 9 } })).toThrow(
      EngineError,
    );
    expect(() => makeGame({ config: { roundCount: 0 } })).toThrow(EngineError);
  });

  it('rejects duplicate players, bad bid rules, and unsupported deck types', () => {
    expect(() => makeGame({ players: players('a', 'a', 'b') })).toThrow(EngineError);
    expect(() => makeGame({ config: { roundCount: 1, bidRule: 'strict' as never } })).toThrow(EngineError);
    expect(() => makeGame({ config: { roundCount: 1, deckType: 'camelot' as never } })).toThrow(EngineError);
  });

  it('starts in not_started with defaults applied', () => {
    const g = makeGame();
    expect(g.phase).toBe('not_started');
    expect(g.config).toEqual({ roundCount: 3, bidRule: 'open', deckType: 'standard', deckSize: 60 });
  });
});

describe('Game trump determination', () => {
  it('suited card flipped → that suit is trump', () => {
    const g = gameWithDecks({ 1: stacked([S('hearts', 2), S('hearts', 3), S('hearts', 4), S('clubs', 9)]) });
    const started = g.startRound();
    expect(started).toMatchObject({ trumpSuit: 'clubs', trumpSource: 'flip', requiresDeclaration: false });
    expect(started.trumpCard!.equals(S('clubs', 9))).toBe(true);
    expect(g.phase).toBe('bidding');
  });

  it('Jester flipped → no trump', () => {
    const g = gameWithDecks({ 1: stacked([S('hearts', 2), S('hearts', 3), S('hearts', 4), J()]) });
    expect(g.startRound()).toMatchObject({ trumpSuit: null, trumpSource: null, requiresDeclaration: false });
    expect(g.phase).toBe('bidding');
  });

  it('Wizard flipped → dealer declares trump before bidding', () => {
    const g = gameWithDecks({ 1: stacked([S('hearts', 2), S('hearts', 3), S('hearts', 4), W()]) });
    const started = g.startRound();
    expect(started).toMatchObject({ requiresDeclaration: true, dealerId: 'a', nextTurnId: 'a' });
    expect(g.phase).toBe('trump_declaration');
    expect(g.currentTurnId).toBe('a');
    expect(() => g.placeBid('b', 0)).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    expect(() => g.declareTrump('b', 'spades')).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));

    g.declareTrump('a', 'spades');
    expect(g.phase).toBe('bidding');
    expect(g.toGameState()).toMatchObject({ trumpSuit: 'spades', trumpSource: 'declaration' });
  });

  it('final round with every card dealt (deckSize % playerCount === 0) → no trump', () => {
    const g = makeGame({ players: players('a', 'b', 'c', 'd'), config: { roundCount: 15 }, random: seeded(1) });
    for (let r = 1; r < 15; r++) {
      g.startRound();
      autoPlayRound(g);
    }
    const last = g.startRound();
    expect(last.roundNumber).toBe(15);
    expect(last).toMatchObject({ trumpCard: null, trumpSuit: null, trumpSource: null, requiresDeclaration: false });
    expect(g.phase).toBe('bidding');
    for (const p of g.activePlayers) expect(p.hand).toHaveLength(15);
  });

  it('final round still flips when deckSize is not divisible by playerCount', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const g = makeGame({ players: players(...ids), config: { roundCount: 8 }, random: seeded(2) });
    for (let r = 1; r < 8; r++) {
      g.startRound();
      autoPlayRound(g);
    }
    expect(g.startRound().trumpCard).not.toBeNull(); // 56 dealt, 4 remain
  });

  it('final round still flips when fewer than the maximum rounds are chosen', () => {
    const g = makeGame({ players: players('a', 'b', 'c', 'd'), config: { roundCount: 2 }, random: seeded(3) });
    g.startRound();
    autoPlayRound(g);
    expect(g.startRound().trumpCard).not.toBeNull();
  });
});

describe('Game round flow', () => {
  // Round 1, dealer a. Deal: b, c, a. Flip: clubs 5 (trump clubs).
  const round1 = () => stacked([S('hearts', 10), S('hearts', 14), S('spades', 2), S('clubs', 5)]);

  it('deals N cards per player, bids left of dealer, plays tricks, and scores', () => {
    const g = gameWithDecks({ 1: round1() });
    const started = g.startRound();
    expect(started).toMatchObject({ roundNumber: 1, dealerId: 'a', nextTurnId: 'b' });
    expect(g.getPlayer('b').hand[0].equals(S('hearts', 10))).toBe(true);

    expect(g.placeBid('b', 0)).toMatchObject({ bidPosition: 1, biddingComplete: false, nextTurnId: 'c' });
    g.placeBid('c', 1);
    expect(g.placeBid('a', 0)).toMatchObject({ bidPosition: 3, biddingComplete: true, nextTurnId: 'b' });
    expect(g.phase).toBe('trick');

    g.playCard('b', S('hearts', 10));
    g.playCard('c', S('hearts', 14));
    const last = g.playCard('a', S('spades', 2));

    expect(last.trickCompleted).toMatchObject({ trickNumber: 1, winnerId: 'c', winningCardType: 'suited' });
    expect(last.roundCompleted).toMatchObject({
      roundNumber: 1,
      scores: { a: 20, b: 20, c: 30 },
      isFinalRound: false,
    });
    expect(last.nextTurnId).toBeNull();
    expect(g.phase).toBe('round_end');
  });

  it('rotates the dealer clockwise each round', () => {
    const g = makeGame({ random: seeded(4) });
    expect(g.startRound().dealerId).toBe('a');
    autoPlayRound(g);
    const r2 = g.startRound();
    expect(r2).toMatchObject({ dealerId: 'b' });
    expect(g.currentRound!.bidOrder).toEqual(['c', 'a', 'b']);
    autoPlayRound(g);
    expect(g.startRound().dealerId).toBe('c');
  });

  it('the trick winner leads the next trick', () => {
    // Round 2, dealer b. Deal: c, a, b (2 each). Flip: diamonds 2.
    const r2 = stacked([
      S('hearts', 3), S('clubs', 3), // c
      S('hearts', 14), S('clubs', 14), // a
      S('hearts', 5), S('clubs', 5), // b
      S('diamonds', 2),
    ]);
    const g = gameWithDecks({ 1: round1(), 2: r2 });
    g.startRound();
    autoPlayRound(g);
    g.startRound();
    for (const id of ['c', 'a', 'b']) g.placeBid(id, 0);
    expect(g.currentTurnId).toBe('c');
    g.playCard('c', S('hearts', 3));
    g.playCard('a', S('hearts', 14));
    const end = g.playCard('b', S('hearts', 5));
    expect(end.trickCompleted!.winnerId).toBe('a');
    expect(end.nextTurnId).toBe('a');
    expect(g.currentRound!.currentTrick!.leaderId).toBe('a');
  });

  it('legalCards: only the current player, only in trick play, filtered by follow-suit', () => {
    // Round 2, dealer b. Deal: c, a, b (2 each). Flip: diamonds 2.
    const r2 = stacked([
      S('hearts', 3), S('clubs', 3), // c
      S('hearts', 14), W(), // a
      S('spades', 5), S('clubs', 5), // b
      S('diamonds', 2),
    ]);
    const g = gameWithDecks({ 1: round1(), 2: r2 });
    g.startRound();
    autoPlayRound(g);
    g.startRound();
    expect(g.legalCards('c')).toEqual([]); // bidding
    for (const id of ['c', 'a', 'b']) g.placeBid(id, 0);
    // c leads: anything goes. Nobody else may play.
    expect(g.legalCards('c').map((c) => c.toData())).toEqual([S('hearts', 3).toData(), S('clubs', 3).toData()]);
    expect(g.legalCards('a')).toEqual([]);
    g.playCard('c', S('clubs', 3));
    // a has no club: every card. b must follow clubs.
    expect(g.legalCards('a')).toHaveLength(2);
    g.playCard('a', S('hearts', 14));
    expect(g.legalCards('b').map((c) => c.toData())).toEqual([S('clubs', 5).toData()]);
  });

  it('enforces turn order, card ownership, and following suit', () => {
    // b: hearts 10, c: hearts 14, a: spades 2 — give a a heart too via round 2 below
    const g = gameWithDecks({ 1: round1() });
    g.startRound();
    expect(() => g.playCard('b', S('hearts', 10))).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    expect(() => g.placeBid('c', 0)).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    for (const id of ['b', 'c', 'a']) g.placeBid(id, 0);

    expect(() => g.playCard('c', S('hearts', 14))).toThrow(expect.objectContaining({ code: 'NOT_YOUR_TURN' }));
    expect(() => g.playCard('b', S('hearts', 9))).toThrow(expect.objectContaining({ code: 'CARD_NOT_IN_HAND' }));
    expect(() => g.playCard('zed', S('hearts', 9))).toThrow(expect.objectContaining({ code: 'UNKNOWN_PLAYER' }));
  });

  it('rejects a card that fails to follow suit', () => {
    // Round 2, dealer b. c leads hearts; a holds a heart and must play it.
    const r2 = stacked([
      S('hearts', 3), S('clubs', 3), // c
      S('hearts', 14), S('clubs', 14), // a
      S('spades', 5), S('spades', 6), // b
      S('diamonds', 2),
    ]);
    const g = gameWithDecks({ 1: round1(), 2: r2 });
    g.startRound();
    autoPlayRound(g);
    g.startRound();
    for (const id of ['c', 'a', 'b']) g.placeBid(id, 0);
    g.playCard('c', S('hearts', 3));
    expect(() => g.playCard('a', S('clubs', 14))).toThrow(expect.objectContaining({ code: 'ILLEGAL_CARD' }));
    g.playCard('a', S('hearts', 14));
    g.playCard('b', S('spades', 5)); // no hearts → anything goes
  });

  it('does not apply the uneven bid rule in round 1', () => {
    const g = gameWithDecks({ 1: round1() }, { config: { roundCount: 3, bidRule: 'uneven' } });
    g.startRound();
    g.placeBid('b', 0);
    g.placeBid('c', 0);
    expect(g.currentRound!.allowedBids('a')).toEqual([0, 1]);
    g.placeBid('a', 1); // total 1 = trick count: allowed in round 1
  });

  it('enforces the uneven bid rule on the dealer from round 2', () => {
    const g = makeGame({ config: { roundCount: 3, bidRule: 'uneven' }, random: seeded(1) });
    g.startRound();
    autoPlayRound(g);
    expect(g.startRound().roundNumber).toBe(2);
    if (g.phase === 'trump_declaration') g.declareTrump(g.currentTurnId!, 'hearts');
    const round = g.currentRound!;
    const [first, second, dealer] = round.bidOrder;
    g.placeBid(first, 1);
    g.placeBid(second, 0);
    expect(round.allowedBids(dealer)).toEqual([0, 2]);
    expect(() => g.placeBid(dealer, 1)).toThrow(expect.objectContaining({ code: 'INVALID_BID' }));
    expect(g.getPlayer(dealer).bid).toBeNull();
    g.placeBid(dealer, 2);
  });

  it('cumulative scores can go negative', () => {
    // Everyone bids 1 in round 1; only one trick exists, so two players miss.
    const g = gameWithDecks({ 1: round1() });
    g.startRound();
    for (const id of ['b', 'c', 'a']) g.placeBid(id, 1);
    g.playCard('b', S('hearts', 10));
    g.playCard('c', S('hearts', 14));
    g.playCard('a', S('spades', 2));
    expect(g.scores).toEqual({ a: -10, b: -10, c: 30 });
    expect(g.toGameState().players.find((p) => p.userId === 'a')!.cumulativeScore).toBe(-10);
  });
});

describe('Game end', () => {
  it('declares the highest score the winner and allows co-winners on a tie', () => {
    const deck = stacked([S('hearts', 10), S('hearts', 14), S('spades', 2), S('clubs', 5)]);
    const g = gameWithDecks({ 1: deck }, { config: { roundCount: 1 } });
    g.startRound();
    for (const id of ['b', 'c', 'a']) g.placeBid(id, 0);
    g.playCard('b', S('hearts', 10));
    g.playCard('c', S('hearts', 14));
    const end = g.playCard('a', S('spades', 2));
    expect(end.roundCompleted!.isFinalRound).toBe(true);
    expect(() => g.startRound()).toThrow(EngineError);

    const result = g.endGame();
    expect(result.winnerIds.sort()).toEqual(['a', 'b']);
    expect(result.scores).toEqual({ a: 20, b: 20, c: -10 });
    expect(g.phase).toBe('completed');
    expect(g.toGameState().winnerUserIds.sort()).toEqual(['a', 'b']);
  });

  it('cannot end the game before the final round is scored', () => {
    const g = makeGame({ random: seeded(5) });
    g.startRound();
    expect(() => g.endGame()).toThrow(EngineError);
    autoPlayRound(g);
    expect(() => g.endGame()).toThrow(EngineError);
  });

  it('plays a full game to completion', () => {
    const g = makeGame({ players: players('a', 'b', 'c', 'd', 'e'), config: { roundCount: 12 }, random: seeded(6) });
    for (let r = 1; r <= 12; r++) {
      g.startRound();
      autoPlayRound(g);
    }
    const result = g.endGame();
    expect(g.toGameState().roundHistory).toHaveLength(12);
    expect(result.winnerIds.length).toBeGreaterThanOrEqual(1);
    const sum = (id: string) =>
      g.toGameState().roundHistory.reduce((s, r) => s + r.players.find((p) => p.userId === id)!.scoreDelta, 0);
    for (const id of ['a', 'b', 'c', 'd', 'e']) expect(result.scores[id]).toBe(sum(id));
  });
});

describe('Game.toGameState', () => {
  it('is a plain, JSON-serializable snapshot including hands', () => {
    const g = makeGame({ random: seeded(7) });
    g.startRound();
    const state = g.toGameState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(state).toMatchObject({
      gameId: 'g1',
      roomId: 'r1',
      currentRound: 1,
      currentTrick: 0,
      dealerUserId: 'a',
      currentTurnUserId: 'b',
    });
    expect(state.players.map((p) => p.seatOrder)).toEqual([1, 2, 3]);
    for (const p of state.players) {
      expect(p.hand).toHaveLength(1);
      expect(Object.getPrototypeOf(p.hand[0])).toBe(Object.prototype);
    }
  });

  it('is a copy: mutating it does not affect the game', () => {
    const g = makeGame({ random: seeded(8) });
    g.startRound();
    const state = g.toGameState();
    state.players[0].hand.length = 0;
    state.config.roundCount = 99;
    expect(g.toGameState().players[0].hand).toHaveLength(1);
    expect(g.config.roundCount).toBe(3);
  });

  it('records tricks in progress and completed', () => {
    const deck = stacked([S('hearts', 10), S('hearts', 14), S('spades', 2), S('clubs', 5)]);
    const g = gameWithDecks({ 1: deck });
    g.startRound();
    for (const id of ['b', 'c', 'a']) g.placeBid(id, 0);
    g.playCard('b', S('hearts', 10));
    expect(g.toGameState().tricksSoFar).toEqual([
      {
        trickNumber: 1,
        leaderUserId: 'b',
        cards: [{ userId: 'b', card: { suit: 'hearts', rank: 10, type: 'suited' } }],
        winnerUserId: null,
        winningCardType: null,
      },
    ]);
  });
});

describe('Game player drops', () => {
  const four = () => makeGame({ players: players('a', 'b', 'c', 'd'), config: { roundCount: 5 }, random: seeded(9) });

  it('voids and re-deals the current round when ≥3 players remain', () => {
    const g = four();
    g.startRound();
    autoPlayRound(g);
    g.startRound(); // round 2, dealer b
    if (g.phase === 'trump_declaration') g.declareTrump('b', 'hearts');
    g.placeBid('c', 1);
    const scoresBefore = g.scores;

    const drop = g.removePlayer('d');
    expect(drop.outcome).toBe('round_redealt');
    expect(drop.roundStarted).toMatchObject({ roundNumber: 2, dealerId: 'b' });
    expect(g.activePlayers.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    for (const p of g.activePlayers) {
      expect(p.hand).toHaveLength(2);
      expect(p.bid).toBeNull();
      expect(p.tricksWon).toBe(0);
    }
    expect(g.currentRound!.bidOrder).toEqual(['c', 'a', 'b']);
    const { d: _d, ...remaining } = scoresBefore;
    expect(g.scores).toEqual(remaining);
    expect(g.toGameState().droppedPlayers).toEqual([
      { userId: 'd', username: 'd', displayName: 'D', avatarConfig: DEFAULT_AVATAR, isBot: false, finalScore: scoresBefore.d },
    ]);
  });

  it('passes the deal to the next seat when the dealer drops mid-round', () => {
    const g = four();
    g.startRound(); // dealer a
    const drop = g.removePlayer('a');
    expect(drop.roundStarted).toMatchObject({ roundNumber: 1, dealerId: 'b' });
  });

  it('keeps rotation correct when the dealer drops between rounds', () => {
    const g = four();
    g.startRound();
    autoPlayRound(g);
    g.startRound(); // dealer b
    autoPlayRound(g);
    expect(g.removePlayer('b').outcome).toBe('removed');
    expect(g.startRound().dealerId).toBe('c'); // left of b
  });

  it('drop to 2 players prompts continue-or-end; continue re-deals', () => {
    const g = makeGame({ random: seeded(10) });
    g.startRound();
    autoPlayRound(g);
    g.startRound();
    expect(g.removePlayer('c').outcome).toBe('continue_or_end');
    expect(g.phase).toBe('awaiting_continue_decision');
    expect(g.toGameState().pendingContinue).toEqual({
      resumePhase: expect.stringMatching(/^(bidding|trump_declaration)$/),
      redeal: true,
    });
    expect(() => g.placeBid('a', 0)).toThrow(EngineError);

    const restarted = g.resolveContinueOrEnd(true);
    expect(restarted).toMatchObject({ roundNumber: 2 });
    expect(g.toGameState().pendingContinue).toBeNull();
    expect(g.phase).toMatch(/bidding|trump_declaration/);
    autoPlayRound(g);
    expect(g.phase).toBe('round_end');
  });

  it('drop to 2 players then end → incomplete with no winner', () => {
    const g = makeGame({ random: seeded(11) });
    g.startRound();
    g.removePlayer('a');
    expect(g.resolveContinueOrEnd(false)).toBeNull();
    expect(g.phase).toBe('incomplete');
    expect(g.toGameState().winnerUserIds).toEqual([]);
    expect(() => g.startRound()).toThrow(EngineError);
  });

  it('abandon() ends the game from any active phase without scoring the round', () => {
    const g = makeGame({ random: seeded(13) });
    g.startRound();
    autoPlayRound(g);
    g.startRound();
    if (g.phase === 'trump_declaration') g.declareTrump('b', 'hearts');
    const scores = g.scores;
    g.abandon();
    expect(g.phase).toBe('incomplete');
    expect(g.scores).toEqual(scores);
    expect(g.toGameState().roundHistory).toHaveLength(1);
    expect(g.toGameState().winnerUserIds).toEqual([]);
    expect(() => g.placeBid('c', 0)).toThrow(EngineError);
    expect(() => g.abandon()).toThrow(EngineError);
  });

  it('abandon() also ends a game waiting on continue-or-end', () => {
    const g = makeGame({ random: seeded(14) });
    g.startRound();
    g.removePlayer('a');
    g.abandon();
    expect(g.phase).toBe('incomplete');
    expect(g.toGameState().pendingContinue).toBeNull();
    expect(() => g.resolveContinueOrEnd(true)).toThrow(EngineError);
  });

  it('drop to 1 player ends the game as incomplete', () => {
    const g = makeGame({ random: seeded(12) });
    g.startRound();
    g.removePlayer('a');
    expect(g.removePlayer('b').outcome).toBe('incomplete');
    expect(g.phase).toBe('incomplete');
  });
});

describe('Game with a BotPlayer', () => {
  it('seats a bot, but its actions throw NotImplementedError without changing state', () => {
    const bot = new BotPlayer(props('bot'));
    const g = makeGame({ players: [new Player(props('a')), bot, new Player(props('c'))], random: seeded(13) });
    g.startRound();
    if (g.phase === 'trump_declaration') g.declareTrump('a', 'hearts');
    expect(g.currentTurnId).toBe('bot');
    expect(() => g.placeBid('bot', 0)).toThrow(NotImplementedError);
    expect(g.currentTurnId).toBe('bot');
    expect(g.currentRound!.getBid('bot')).toBeNull();
    expect(g.toGameState().players[1].isBot).toBe(true);
  });
});

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return (e as EngineError).code ?? null;
  }
  return null;
}

describe('Game.toPlayerView / toSpectatorView', () => {
  it("includes only the viewer's own hand; others show a card count", () => {
    const g = makeGame({ random: seeded(21) });
    g.startRound();
    const full = g.toGameState();
    const view = g.toPlayerView('b');
    expect(view.viewerUserId).toBe('b');
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    for (const p of view.players) {
      expect(p.handCount).toBe(1);
      expect(p.hand).toEqual(p.userId === 'b' ? full.players.find((f) => f.userId === 'b')!.hand : null);
    }
  });

  it('gives spectators no hands', () => {
    const g = makeGame({ random: seeded(22) });
    g.startRound();
    const view = g.toSpectatorView();
    expect(view.viewerUserId).toBeNull();
    expect(view.players.every((p) => p.hand === null && p.handCount === 1)).toBe(true);
  });

  it('refuses a view for someone who is not an active player', () => {
    const g = makeGame({ players: players('a', 'b', 'c', 'd'), random: seeded(23) });
    g.startRound();
    g.removePlayer('d');
    expect(errorCode(() => g.toPlayerView('nobody'))).toBe('UNKNOWN_PLAYER');
    expect(errorCode(() => g.toPlayerView('d'))).toBe('UNKNOWN_PLAYER');
  });
});
