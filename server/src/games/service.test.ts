/**
 * GameService timers with Jest fake timers: the 30-second seat hold, the 60-second continue-or-end
 * decision and the 3-hour game time limit. The database is mocked (the writes are asserted as
 * calls); the socket side is a recording notifier. Real sockets and Postgres are covered in
 * drops.int.test.ts.
 */
import { Card, Deck, Game, Player, type DeckFactory } from '../engine';
import * as queries from './queries';
import { GameService, type GameLifecycle } from './service';
import { DEFAULT_AVATAR } from '../shared/avatar';

jest.mock('../logger', () => {
  const noop = () => undefined;
  return { logger: { error: noop, warn: noop, info: noop, debug: noop } };
});
jest.mock('../db/knex', () => ({ db: { transaction: async (fn: (trx: unknown) => Promise<unknown>) => fn({}) } }));
jest.mock('./queries', () => ({
  insertGameEvents: jest.fn(async () => undefined),
  recordRound: jest.fn(async () => undefined),
  recordGameComplete: jest.fn(async () => undefined),
  recordGameIncomplete: jest.fn(async () => undefined),
  eventsBetween: jest.fn(async () => []),
}));

const mocked = queries as jest.Mocked<typeof queries>;

const SEC = 1000;
const MIN = 60 * SEC;

const S = (suit: 'hearts' | 'diamonds' | 'spades' | 'clubs', rank: number) => Card.suited(suit, rank);

/** A standard deck with `top` first. Round 1 deals one card each from seat 2, then flips. */
function stacked(top: Card[]): Deck {
  const rest = new Deck().peekAll();
  for (const c of top) rest.splice(rest.findIndex((r) => r.equals(c)), 1);
  return Deck.fromCards([...top, ...rest]);
}

/** Round 1 with three seats: b ♥5, c ♠9, a ♦2, then ♣3 is flipped (clubs trump). With four, d gets ♣3 and ♣Q is flipped. */
const deckFactory: DeckFactory = () => stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), S('clubs', 3), S('clubs', 12)]);

interface Sent {
  to: 'room' | string;
  event: string;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  seq: number;
}

function setup(ids: string[] = ['a', 'b', 'c'], roundCount = 1) {
  const sent: Sent[] = [];
  const inRoom = new Set(ids);
  const service = new GameService({ deckFactory });
  service.setNotifier({
    deliverToRoom: (_roomId, event, payload, seq) => sent.push({ to: 'room', event, payload, seq }),
    deliverToUser: (_roomId, userId, event, payload, seq) => sent.push({ to: userId, event, payload, seq }),
    isInRoom: (_roomId, userId) => inRoom.has(userId),
  });
  const lifecycle: jest.Mocked<GameLifecycle> = {
    gameFinished: jest.fn(),
    // What RoomService does: mark them left, then user_left (timeout), which drops them.
    playerTimedOut: jest.fn(async (roomId: string, userId: string) => {
      await service.userLeft(roomId, userId, 'timeout', { user_id: userId, role: 'player', reason: 'timeout' });
    }),
  };
  service.setLifecycle(lifecycle);
  const game = new Game({
    gameId: 'g1',
    roomId: 'r1',
    players: ids.map((id) => new Player({ id, username: id, displayName: id.toUpperCase(), avatarConfig: DEFAULT_AVATAR, sessionId: null })),
    config: { roundCount },
    deckFactory,
  });
  const ctx = (userId: string) => ({ userId, traceId: null });
  const room = (event: string) => sent.filter((e) => e.to === 'room' && e.event === event);
  return { service, game, sent, inRoom, lifecycle, ctx, room };
}

/** Lets queued game work (promise chains) run, without moving the clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-11-26T12:00:00Z') });
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('the 30-second seat hold', () => {
  it('player_disconnected carries the deadline; at 30 s the room service is told the player timed out', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    t.inRoom.delete('c');
    await t.service.playerDisconnected('r1', 'c');

    const [disc] = t.room('player_disconnected');
    expect(disc.payload).toEqual({ player_id: 'c', reconnect_deadline: '2026-11-26T12:00:30.000Z' });
    expect(t.service.isHoldingSeat('r1', 'c')).toBe(true);
    expect(t.game.getPlayer('c').connected).toBe(false);

    await jest.advanceTimersByTimeAsync(30 * SEC - 1);
    expect(t.lifecycle.playerTimedOut).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(t.lifecycle.playerTimedOut).toHaveBeenCalledWith('r1', 'c');
    await flush();
    // Three players became two: user_left (timeout), then the continue-or-end prompt.
    expect(t.room('user_left').map((e) => e.payload)).toEqual([{ user_id: 'c', role: 'player', reason: 'timeout' }]);
    expect(t.room('continue_or_end_request')).toHaveLength(1);
    expect(t.service.isHoldingSeat('r1', 'c')).toBe(false);
  });

  it('reconnecting within the window clears the hold: player_reconnected, and no timeout later', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    t.inRoom.delete('c');
    await t.service.playerDisconnected('r1', 'c');
    await jest.advanceTimersByTimeAsync(20 * SEC);

    t.inRoom.add('c');
    await t.service.playerReconnected('r1', 'c');
    expect(t.room('player_reconnected').map((e) => e.payload)).toEqual([{ player_id: 'c' }]);
    expect(t.game.getPlayer('c').connected).toBe(true);

    await jest.advanceTimersByTimeAsync(60 * SEC);
    expect(t.lifecycle.playerTimedOut).not.toHaveBeenCalled();
    expect(t.room('user_left')).toHaveLength(0);
  });

  it('a player with no socket when the game starts gets the hold straight away', async () => {
    const t = setup();
    t.inRoom.delete('b');
    await t.service.launch(t.game, t.game.startRound());
    expect(t.room('player_disconnected').map((e) => e.payload.player_id)).toEqual(['b']);
    await jest.advanceTimersByTimeAsync(30 * SEC);
    expect(t.lifecycle.playerTimedOut).toHaveBeenCalledWith('r1', 'b');
  });

  it('a voluntary quit clears the hold, so the timer never fires', async () => {
    const t = setup(['a', 'b', 'c', 'd']);
    await t.service.launch(t.game, t.game.startRound());
    t.inRoom.delete('d');
    await t.service.playerDisconnected('r1', 'd');
    await t.service.userLeft('r1', 'd', 'voluntary', { user_id: 'd', role: 'player', reason: 'voluntary' });
    // Four became three: round 1 is re-dealt.
    expect(t.room('round_started').map((e) => e.payload.round_number)).toEqual([1, 1]);
    await jest.advanceTimersByTimeAsync(60 * SEC);
    expect(t.lifecycle.playerTimedOut).not.toHaveBeenCalled();
  });
});

describe('the 60-second continue-or-end decision', () => {
  it('no answer within 60 s counts as end: game_over incomplete (mutual_end), results written, room completing', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    await t.service.userLeft('r1', 'c', 'voluntary', { user_id: 'c', role: 'player', reason: 'voluntary' });

    const [req] = t.room('continue_or_end_request');
    expect(req.payload).toEqual({ remaining_player_ids: ['a', 'b'], decision_deadline: '2026-11-26T12:01:00.000Z' });

    await jest.advanceTimersByTimeAsync(60 * SEC - 1);
    expect(t.room('game_over')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);

    const [over] = t.room('game_over');
    expect(over.payload).toMatchObject({ game_id: 'g1', status: 'incomplete', winner_ids: [] });
    expect(mocked.recordGameIncomplete).toHaveBeenCalledTimes(1);
    const end = mocked.recordGameIncomplete.mock.calls[0][1];
    expect(end).toMatchObject({ gameId: 'g1', roomId: 'r1', dropReason: 'mutual_end', playerCountAtDrop: 2 });
    expect(end.results.map((r) => [r.userId, r.outcome, r.dropReason]).sort()).toEqual([
      ['a', 'incomplete', 'mutual_end'],
      ['b', 'incomplete', 'mutual_end'],
      ['c', 'incomplete', 'player_quit'],
    ]);
    expect(t.lifecycle.gameFinished).toHaveBeenCalledWith('r1', expect.any(Date));
  });

  it('both answering continue in time re-deals the round for two; the timer then does nothing', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    await t.service.userLeft('r1', 'c', 'voluntary', { user_id: 'c', role: 'player', reason: 'voluntary' });
    await t.service.chooseContinueOrEnd('r1', t.ctx('a'), 'continue');
    await jest.advanceTimersByTimeAsync(30 * SEC);
    expect(t.room('round_started')).toHaveLength(1);
    await t.service.chooseContinueOrEnd('r1', t.ctx('b'), 'continue');

    expect(t.room('round_started').map((e) => e.payload.round_number)).toEqual([1, 1]);
    expect(t.game.activePlayers.map((p) => p.id)).toEqual(['a', 'b']);
    expect(t.game.phase).toBe('bidding');
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(t.room('game_over')).toHaveLength(0);
  });

  it('either player answering end ends the game at once', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    await t.service.userLeft('r1', 'a', 'voluntary', { user_id: 'a', role: 'player', reason: 'voluntary' });
    await t.service.chooseContinueOrEnd('r1', t.ctx('b'), 'continue');
    await t.service.chooseContinueOrEnd('r1', t.ctx('c'), 'end');
    expect(t.room('game_over').map((e) => e.payload.status)).toEqual(['incomplete']);
    expect(mocked.recordGameIncomplete.mock.calls[0][1]).toMatchObject({ dropReason: 'mutual_end' });
    // The decision timer was cleared with the game.
    await jest.advanceTimersByTimeAsync(2 * MIN);
    expect(t.room('game_over')).toHaveLength(1);
  });
});

describe('the 3-hour game time limit', () => {
  it('warns at 2 h 45 m, then abandons at 3 h: game_abandoned, incomplete with time_limit, room completing', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());

    await jest.advanceTimersByTimeAsync(2 * 60 * MIN + 45 * MIN - 1);
    expect(t.room('game_time_warning')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.room('game_time_warning').map((e) => e.payload)).toEqual([
      { game_id: 'g1', ends_at: '2026-11-26T15:00:00.000Z', minutes_remaining: 15 },
    ]);

    await jest.advanceTimersByTimeAsync(15 * MIN - 1);
    expect(t.room('game_abandoned')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.room('game_abandoned').map((e) => e.payload)).toEqual([{ reason: 'time_limit', game_id: 'g1' }]);
    expect(t.room('game_time_warning')).toHaveLength(1);
    expect(t.game.phase).toBe('incomplete');
    const end = mocked.recordGameIncomplete.mock.calls[0][1];
    expect(end).toMatchObject({ dropReason: 'time_limit', playerCountAtDrop: 3 });
    expect(end.results.every((r) => r.outcome === 'incomplete' && r.dropReason === 'time_limit')).toBe(true);
    // The round in progress was not scored.
    expect(mocked.recordRound).not.toHaveBeenCalled();
    expect(end.state.roundHistory).toHaveLength(0);
    expect(t.lifecycle.gameFinished).toHaveBeenCalledTimes(1);
  });

  const reach: Record<string, (t: ReturnType<typeof setup>) => Promise<void>> = {
    bidding: async () => undefined,
    trick: async (t) => {
      for (const id of ['b', 'c', 'a']) await t.service.placeBid('r1', t.ctx(id), 0);
    },
    // The drop comes 30 s before the limit, inside the 60-second decision window.
    awaiting_continue_decision: async (t) => {
      await jest.advanceTimersByTimeAsync(3 * 60 * MIN - 30 * SEC);
      await t.service.userLeft('r1', 'c', 'voluntary', { user_id: 'c', role: 'player', reason: 'voluntary' });
    },
  };
  it.each(Object.keys(reach))('abandons from the %s phase', async (phase) => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    await reach[phase](t);
    expect(t.game.phase).toBe(phase);
    await jest.advanceTimersByTimeAsync(3 * 60 * MIN);
    expect(t.room('game_abandoned')).toHaveLength(1);
    expect(t.room('game_over')).toHaveLength(0);
    expect(t.game.phase).toBe('incomplete');
  });

  it('abandons while the dealer is declaring trump (Wizard flipped)', async () => {
    const t = setup();
    const wizardFlip: DeckFactory = () => stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), Card.wizard()]);
    const game = new Game({
      gameId: 'g1',
      roomId: 'r1',
      players: ['a', 'b', 'c'].map((id) => new Player({ id, username: id, displayName: id, avatarConfig: DEFAULT_AVATAR, sessionId: null })),
      config: { roundCount: 1 },
      deckFactory: wizardFlip,
    });
    await t.service.launch(game, game.startRound());
    expect(game.phase).toBe('trump_declaration');
    await jest.advanceTimersByTimeAsync(3 * 60 * MIN);
    expect(t.room('game_abandoned')).toHaveLength(1);
  });

  it('a game that finishes normally clears its timers: no warning, no abandonment, no seat holds', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    t.inRoom.delete('a');
    await t.service.playerDisconnected('r1', 'a');
    for (const id of ['b', 'c', 'a']) await t.service.placeBid('r1', t.ctx(id), 0);
    await t.service.playCard('r1', t.ctx('b'), S('hearts', 5).toData());
    await t.service.playCard('r1', t.ctx('c'), S('spades', 9).toData());
    await t.service.playCard('r1', t.ctx('a'), S('diamonds', 2).toData());
    expect(t.room('game_over').map((e) => e.payload.status)).toEqual(['complete']);

    await jest.advanceTimersByTimeAsync(4 * 60 * MIN);
    expect(t.room('game_time_warning')).toHaveLength(0);
    expect(t.room('game_abandoned')).toHaveLength(0);
    expect(t.lifecycle.playerTimedOut).not.toHaveBeenCalled();
    expect(mocked.recordGameIncomplete).not.toHaveBeenCalled();
  });

  it('forgetting the game (its room closed) clears the timers too', async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    t.service.forget('r1');
    await jest.advanceTimersByTimeAsync(4 * 60 * MIN);
    expect(t.room('game_time_warning')).toHaveLength(0);
    expect(t.room('game_abandoned')).toHaveLength(0);
  });
});

describe('playerView (bug report snapshots)', () => {
  it("is the player's own view: their hand only, other hands hidden", async () => {
    const t = setup();
    await t.service.launch(t.game, t.game.startRound());
    const view = t.service.playerView('r1', 'a')!;
    expect(view.viewerUserId).toBe('a');
    const a = view.players.find((p) => p.userId === 'a')!;
    expect(a.hand).toEqual([S('diamonds', 2).toJSON()]);
    for (const p of view.players.filter((p) => p.userId !== 'a')) {
      expect(p.hand).toBeNull();
      expect(p.handCount).toBe(1);
    }
  });

  it('is null for a room with no live game and for someone without a seat', async () => {
    const t = setup(['a', 'b', 'c', 'd']);
    expect(t.service.playerView('r1', 'a')).toBeNull();
    await t.service.launch(t.game, t.game.startRound());
    expect(t.service.playerView('r1', 'spectator')).toBeNull();
    await t.service.userLeft('r1', 'd', 'voluntary', { user_id: 'd', role: 'player', reason: 'voluntary' });
    expect(t.service.playerView('r1', 'd')).toBeNull();
    expect(t.service.playerView('other-room', 'a')).toBeNull();
  });
});
