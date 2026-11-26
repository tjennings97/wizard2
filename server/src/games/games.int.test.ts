import request from 'supertest';
import { db } from '../db/knex';
import { Card, Deck, Game, type DeckFactory } from '../engine';
import * as socketAuth from '../socket/auth';
import { connect, connectReady, createUser, resetDb, sleep, startServer, type TestClient, type TestUser } from '../test/helpers';

/**
 * The next test's decks, by round number. Unset rounds get a fixed deck whose flip is a suited
 * card: a shuffled deck turns up a Wizard 1 time in 15, and the round then waits for the dealer.
 */
let decks: Record<number, Deck> = {};
/** Makes the next deal throw, as an engine or deck failure would. */
let failDeal = false;
const deckFactory: DeckFactory = (_ruleset, round) => {
  if (failDeal) throw new Error('deck failure');
  return decks[round] ?? new Deck();
};

/** The game-over countdown, shortened. */
const COUNTDOWN_MS = 1500;

let server: Awaited<ReturnType<typeof startServer>>;
let clients: TestClient[] = [];

beforeAll(async () => {
  // Re-check the session on every game action, so the refresh is observable.
  server = await startServer({ deckFactory, sessionRecheckMs: 0, countdownMs: COUNTDOWN_MS });
});
afterAll(async () => {
  await server.close();
  await db.destroy();
});
beforeEach(async () => {
  server.rooms.stop();
  server.games.stop();
  decks = {};
  failDeal = false;
  await resetDb();
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const c of clients) c.close();
  clients = [];
});

const api = () => request(server.app);
const S = (suit: 'hearts' | 'diamonds' | 'spades' | 'clubs', rank: number) => Card.suited(suit, rank);
const W = () => Card.wizard();
const J = () => Card.jester();

/** A standard deck with `top` first, in order. Round 1 deals one card each from seat 2, then flips. */
function stacked(top: Card[]): Deck {
  const rest = new Deck().peekAll();
  for (const c of top) rest.splice(rest.findIndex((r) => r.equals(c)), 1);
  return Deck.fromCards([...top, ...rest]);
}

async function online(user: TestUser): Promise<TestClient> {
  const c = await connectReady(server.url, user.cookie);
  clients.push(c);
  return c;
}

function emit(c: TestClient, event: string, payload: object): void {
  c.socket.emit(event, { event, seq: 0, timestamp: new Date().toISOString(), payload });
}

interface Table {
  roomId: string;
  gameId: string;
  /** Seat order: host (dealer of round 1) first. */
  players: TestUser[];
  pc: TestClient[];
  spectators: TestUser[];
  sc: TestClient[];
}

/** Opens a room, seats the players (and spectators), connects everyone and starts the game. */
async function startTable({
  players = 3,
  spectators = 0,
  config = {},
}: { players?: number; spectators?: number; config?: object } = {}): Promise<Table> {
  const ps = await Promise.all(Array.from({ length: players }, (_, i) => createUser(`P${i + 1}`)));
  const ss = await Promise.all(Array.from({ length: spectators }, (_, i) => createUser(`S${i + 1}`)));
  const created = await api().post('/api/v1/rooms').set('Cookie', ps[0].cookie).send({ config }).expect(201);
  const roomId: string = created.body.id;
  for (const p of ps.slice(1)) await api().post(`/api/v1/rooms/${roomId}/join`).set('Cookie', p.cookie).send({ role: 'player' }).expect(200);
  for (const s of ss) await api().post(`/api/v1/rooms/${roomId}/join`).set('Cookie', s.cookie).send({ role: 'spectator' }).expect(200);
  const pc = await Promise.all(ps.map(online));
  const sc = await Promise.all(ss.map(online));
  await api().post(`/api/v1/rooms/${roomId}/start`).set('Cookie', ps[0].cookie).expect(200);
  for (const c of [...pc, ...sc]) await c.waitFor('round_started');
  return { roomId, gameId: server.games.gameIdFor(roomId)!, players: ps, pc, spectators: ss, sc };
}

const GAME_EVENTS = [
  'game_starting',
  'game_started',
  'round_started',
  'hand_dealt',
  'trump_revealed',
  'trump_selection_request',
  'bid_request',
  'bid_placed',
  'all_bids_placed',
  'invalid_bid_error',
  'invalid_trump_error',
  'play_request',
  'card_played',
  'trick_complete',
  'round_complete',
  'invalid_play_error',
  'game_over',
  'state_snapshot',
];
const gameLog = (c: TestClient) => c.log.filter((e) => GAME_EVENTS.includes(e.event));
const names = (c: TestClient) => gameLog(c).map((e) => e.event);

describe('starting a game', () => {
  it('announces the game and deals round 1: hands only to their owner, the first bid_request to seat 2', async () => {
    decks[1] = stacked([S('hearts', 5), S('spades', 9), W(), S('clubs', 12)]);
    const t = await startTable({ spectators: 1 });
    const [host, p2, p3] = t.pc;
    await p2.waitFor('bid_request');

    expect(names(p2)).toEqual(['game_starting', 'game_started', 'round_started', 'hand_dealt', 'trump_revealed', 'bid_request']);
    expect(names(host)).toEqual(['game_starting', 'game_started', 'round_started', 'hand_dealt', 'trump_revealed']);
    // Spectators get every broadcast and nothing addressed to a player.
    await t.sc[0].waitFor('trump_revealed');
    expect(names(t.sc[0])).toEqual(['game_starting', 'game_started', 'round_started', 'trump_revealed']);

    const ids = t.players.map((p) => p.id);
    expect((await p2.waitFor('game_starting')).payload).toEqual({ game_id: t.gameId, countdown_seconds: 0, player_order: ids });
    expect((await p2.waitFor('game_started')).payload).toEqual({
      game_id: t.gameId,
      room_id: t.roomId,
      round_count: 20,
      bid_rule: 'open',
      players: t.players.map((p, i) => ({ user_id: p.id, display_name: p.displayName, seat_index: i })),
    });
    expect((await p2.waitFor('round_started')).payload).toEqual({
      round_number: 1,
      dealer_id: ids[0],
      trump_suit: 'clubs',
      trump_card: { suit: 'clubs', rank: 12, type: 'suited' },
    });
    expect((await p2.waitFor('trump_revealed')).payload).toEqual({
      round_number: 1,
      trump_suit: 'clubs',
      trump_card: { suit: 'clubs', rank: 12, type: 'suited' },
      trump_source: 'flip',
    });
    expect((await p2.waitFor('hand_dealt')).payload).toEqual({ hand: [{ suit: 'hearts', rank: 5, type: 'suited' }], round_number: 1 });
    expect((await p3.waitFor('hand_dealt')).payload.hand).toEqual([{ suit: 'spades', rank: 9, type: 'suited' }]);
    expect((await host.waitFor('hand_dealt')).payload.hand).toEqual([{ suit: null, rank: null, type: 'wizard' }]);
    expect((await p2.waitFor('bid_request')).payload).toEqual({
      player_id: ids[1],
      round_number: 1,
      bids_so_far: [],
      hand_size: 1,
      allowed_bids: [0, 1],
    });
    expect(p3.events('bid_request')).toHaveLength(0);

    // No hand data reaches anyone else, in any event.
    const wizard = JSON.stringify({ suit: null, rank: null, type: 'wizard' });
    for (const c of [p2, p3, t.sc[0]]) expect(JSON.stringify(c.log.map((e) => e.payload))).not.toContain(wizard);
  });

  it('numbers broadcasts with one game seq; unicasts carry the current seq without advancing it', async () => {
    const t = await startTable({ spectators: 1 });
    const [, p2] = t.pc;
    await p2.waitFor('bid_request');
    await t.sc[0].waitFor('trump_revealed');

    const seqs = (c: TestClient) => gameLog(c).map((e) => [e.event, e.seq]);
    expect(seqs(p2)).toEqual([
      ['game_starting', 1],
      ['game_started', 2],
      ['round_started', 3],
      ['hand_dealt', 3],
      ['trump_revealed', 4],
      ['bid_request', 4],
    ]);
    expect(seqs(t.sc[0])).toEqual([
      ['game_starting', 1],
      ['game_started', 2],
      ['round_started', 3],
      ['trump_revealed', 4],
    ]);
  });

  it('logs every broadcast to game_events with its seq; the sent payload never holds hands', async () => {
    decks[1] = stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), J()]);
    const t = await startTable();
    await t.pc[1].waitFor('bid_request');

    const rows = await db('game_events').where({ game_id: t.gameId }).orderBy('seq');
    expect(rows.map((r) => [r.seq, r.event, r.event_type, r.round_number])).toEqual([
      [1, 'game_starting', 'game_starting', 0],
      [2, 'game_started', 'game_started', 0],
      [3, 'round_started', 'round_started', 1],
      [4, 'trump_revealed', 'trump_revealed', 1],
    ]);
    const roundStarted = rows[2];
    expect(roundStarted.sent_payload).toEqual((await t.pc[0].waitFor('round_started')).payload);
    // The full-context payload keeps the dealt hands for training; the sent payload does not.
    expect(roundStarted.payload.dealtHands[t.players[1].id]).toEqual([{ suit: 'hearts', rank: 5, type: 'suited' }]);
    expect(JSON.stringify(rows.map((r) => r.sent_payload))).not.toContain('hearts');
    // games.state is a per-round record (written at round end), not written per event.
    expect((await db('games').where({ id: t.gameId }).first()).state).toBeNull();
  });

  it('a failed deal rolls the start back: no game, the room stays open, nobody is stuck', async () => {
    const ps = await Promise.all([createUser('A'), createUser('B'), createUser('C')]);
    const { body } = await api().post('/api/v1/rooms').set('Cookie', ps[0].cookie).send({}).expect(201);
    for (const p of ps.slice(1)) await api().post(`/api/v1/rooms/${body.id}/join`).set('Cookie', p.cookie).send({ role: 'player' }).expect(200);
    failDeal = true;

    await api().post(`/api/v1/rooms/${body.id}/start`).set('Cookie', ps[0].cookie).expect(500);
    expect(server.games.isLive(body.id)).toBe(false);
    expect(await db('games').where({ room_id: body.id })).toHaveLength(0);
    expect((await db('rooms').where({ id: body.id }).first()).state).toBe('open');

    // The host can try again once the fault is gone, and players can still leave.
    failDeal = false;
    await api().post(`/api/v1/rooms/${body.id}/start`).set('Cookie', ps[0].cookie).expect(200);
    expect(server.games.isLive(body.id)).toBe(true);
  });
});

describe('trump', () => {
  it('Jester flipped: no trump', async () => {
    decks[1] = stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), J()]);
    const t = await startTable();
    const jester = { suit: null, rank: null, type: 'jester' };
    expect((await t.pc[0].waitFor('round_started')).payload).toMatchObject({ trump_suit: null, trump_card: jester });
    expect((await t.pc[0].waitFor('trump_revealed')).payload).toEqual({ round_number: 1, trump_suit: null, trump_card: jester, trump_source: null });
    await t.pc[1].waitFor('bid_request');
  });

  it('no card left to flip: no trump, no flip', async () => {
    // Exactly one card per player: the deck is empty after the deal.
    decks[1] = Deck.fromCards([S('hearts', 5), S('spades', 9), S('diamonds', 2)]);
    const t = await startTable();
    expect((await t.pc[0].waitFor('round_started')).payload).toMatchObject({ trump_suit: null, trump_card: null });
    expect((await t.pc[0].waitFor('trump_revealed')).payload).toEqual({ round_number: 1, trump_suit: null, trump_card: null, trump_source: null });
    await t.pc[1].waitFor('bid_request');
  });

  it('Wizard flipped: only the dealer is asked; select_trump is validated; then bidding starts', async () => {
    decks[1] = stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), W()]);
    const t = await startTable({ spectators: 1 });
    const [dealer, p2, p3] = t.pc;
    const ids = t.players.map((p) => p.id);

    expect((await dealer.waitFor('trump_selection_request')).payload).toEqual({ player_id: ids[0], round_number: 1 });
    expect((await p2.waitFor('round_started')).payload).toMatchObject({ trump_suit: null, trump_card: { type: 'wizard' } });
    await sleep(100);
    for (const c of [p2, p3, t.sc[0]]) {
      expect(c.events('trump_selection_request')).toHaveLength(0);
      expect(c.events('trump_revealed')).toHaveLength(0);
      expect(c.events('bid_request')).toHaveLength(0);
    }

    // Not the dealer, and not a suit.
    emit(p2, 'select_trump', { player_id: ids[1], suit: 'hearts' });
    expect((await p2.waitFor('invalid_trump_error')).payload).toMatchObject({ player_id: ids[1], code: 'NOT_YOUR_TURN' });
    emit(dealer, 'select_trump', { player_id: ids[0], suit: 'stars' });
    expect((await dealer.waitFor('invalid_trump_error')).payload).toMatchObject({ code: 'INVALID_SUIT' });
    // A bid before trump is declared.
    emit(p2, 'place_bid', { player_id: ids[1], bid: 0 });
    expect((await p2.waitFor('invalid_bid_error')).payload).toMatchObject({ code: 'INVALID_PHASE' });

    emit(dealer, 'select_trump', { player_id: ids[0], suit: 'spades' });
    const revealed = { round_number: 1, trump_suit: 'spades', trump_card: { suit: null, rank: null, type: 'wizard' }, trump_source: 'declaration' };
    for (const c of [dealer, p2, p3, t.sc[0]]) expect((await c.waitFor('trump_revealed')).payload).toEqual(revealed);
    await p2.waitFor('bid_request');

    const row = await db('game_events').where({ game_id: t.gameId, event_type: 'trump_declared' }).first();
    expect(row).toMatchObject({ event: 'trump_revealed', actor_user_id: ids[0], round_number: 1 });
    expect(row.payload).toMatchObject({
      dealerUserId: ids[0],
      declaredSuit: 'spades',
      dealerHand: [{ suit: 'diamonds', rank: 2, type: 'suited' }],
      roundNumber: 1,
    });
    // Declared once; a second declaration is refused.
    emit(dealer, 'select_trump', { suit: 'hearts' });
    expect((await dealer.waitFor('invalid_trump_error', () => true, { from: dealer.length - 1 })).payload.code).toBe('INVALID_PHASE');
  });
});

describe('bidding', () => {
  it('takes bids clockwise from left of the dealer, rejects bad bids, then broadcasts all_bids_placed', async () => {
    const t = await startTable({ spectators: 1 });
    const [dealer, p2, p3] = t.pc;
    const ids = t.players.map((p) => p.id);
    await p2.waitFor('bid_request');

    // Out of turn, out of range, not an integer.
    emit(p3, 'place_bid', { player_id: ids[2], bid: 0 });
    expect((await p3.waitFor('invalid_bid_error')).payload).toEqual({
      player_id: ids[2],
      code: 'NOT_YOUR_TURN',
      reason: expect.any(String),
      min_bid: 0,
      max_bid: 1,
      allowed_bids: [],
    });
    emit(p2, 'place_bid', { bid: 2 });
    expect((await p2.waitFor('invalid_bid_error')).payload).toMatchObject({ code: 'INVALID_BID', allowed_bids: [0, 1] });
    emit(p2, 'place_bid', { bid: '1' });
    await p2.waitFor('invalid_bid_error', (p) => p.code === 'INVALID_BID', { from: p2.events('invalid_bid_error')[0].index + 1 });
    // The acting player is the socket's user, whatever player_id says.
    emit(p3, 'place_bid', { player_id: ids[1], bid: 1 });
    await p3.waitFor('invalid_bid_error', (p) => p.player_id === ids[2], { from: p3.events('invalid_bid_error')[0].index + 1 });
    expect(t.sc[0].events('bid_placed')).toHaveLength(0);

    emit(p2, 'place_bid', { player_id: ids[1], bid: 1 });
    expect((await t.sc[0].waitFor('bid_placed')).payload).toEqual({ player_id: ids[1], bid: 1 });
    expect((await p3.waitFor('bid_request')).payload).toMatchObject({ bids_so_far: [{ player_id: ids[1], bid: 1 }] });
    emit(p3, 'place_bid', { bid: 0 });
    expect((await dealer.waitFor('bid_request')).payload).toMatchObject({
      player_id: ids[0],
      bids_so_far: [
        { player_id: ids[1], bid: 1 },
        { player_id: ids[2], bid: 0 },
      ],
      allowed_bids: [0, 1],
    });
    emit(dealer, 'place_bid', { bid: 1 });

    const bids = [
      { player_id: ids[1], bid: 1 },
      { player_id: ids[2], bid: 0 },
      { player_id: ids[0], bid: 1 },
    ];
    for (const c of [dealer, p2, p3, t.sc[0]]) {
      expect((await c.waitFor('all_bids_placed')).payload).toEqual({ bids });
      expect(c.events('bid_placed').map((e) => e.payload)).toEqual(bids);
    }
    expect(names(t.sc[0]).slice(-4)).toEqual(['bid_placed', 'bid_placed', 'bid_placed', 'all_bids_placed']);
    // Bidding is over; a late bid is refused. Seat 2, left of the dealer, leads the first trick.
    emit(dealer, 'place_bid', { bid: 0 });
    await dealer.waitFor('invalid_bid_error', (p) => p.code === 'INVALID_PHASE');
    expect((await p2.waitFor('play_request')).payload).toMatchObject({ player_id: ids[1], trick_number: 1, trick_so_far: [] });
    expect(dealer.events('play_request')).toHaveLength(0);
    expect(t.sc[0].events('play_request')).toHaveLength(0);

    const rows = await db('game_events').where({ game_id: t.gameId }).whereIn('event', ['bid_placed', 'all_bids_placed']).orderBy('seq');
    expect(rows.map((r) => r.event)).toEqual(['bid_placed', 'bid_placed', 'bid_placed', 'all_bids_placed']);
    expect(rows.map((r) => r.seq)).toEqual([5, 6, 7, 8]);
    expect(rows[1].payload).toMatchObject({
      playerId: ids[2],
      bid: 0,
      bidPosition: 2,
      handAtBid: [expect.objectContaining({ type: expect.any(String) })],
      priorBids: [{ playerId: ids[1], bid: 1 }],
      roundNumber: 1,
    });
    expect(rows[3].payload).toMatchObject({ bidTotal: 2, trickCount: 1 });
  });

  it('uneven rule: the dealer cannot make the total equal the trick count', async () => {
    const t = await startTable({ config: { bidRule: 'uneven' } });
    const [dealer, p2, p3] = t.pc;
    await p2.waitFor('bid_request');
    emit(p2, 'place_bid', { bid: 0 });
    await p3.waitFor('bid_request');
    emit(p3, 'place_bid', { bid: 0 });
    expect((await dealer.waitFor('bid_request')).payload.allowed_bids).toEqual([0]);

    emit(dealer, 'place_bid', { bid: 1 });
    expect((await dealer.waitFor('invalid_bid_error')).payload).toMatchObject({ code: 'INVALID_BID', allowed_bids: [0] });
    emit(dealer, 'place_bid', { bid: 0 });
    await p2.waitFor('all_bids_placed');
  });

  it('ignores a repeated idempotency key within the window', async () => {
    const t = await startTable();
    const [, p2, p3] = t.pc;
    await p2.waitFor('bid_request');
    emit(p2, 'place_bid', { bid: 1, idempotency_key: 'k-1' });
    await p3.waitFor('bid_request');
    emit(p2, 'place_bid', { bid: 1, idempotency_key: 'k-1' });
    await sleep(150);
    // A reprocessed duplicate would have been answered with NOT_YOUR_TURN.
    expect(p2.events('invalid_bid_error')).toHaveLength(0);
    expect(p2.events('bid_placed')).toHaveLength(1);
  });

  it('a failed action answers ACTION_FAILED and does not use up its idempotency key', async () => {
    const t = await startTable();
    const [host, p2] = t.pc;
    await p2.waitFor('bid_request');
    jest.spyOn(Game.prototype, 'placeBid').mockImplementationOnce(() => {
      throw new Error('boom');
    });

    emit(p2, 'place_bid', { bid: 1, idempotency_key: 'k-retry' });
    expect((await p2.waitFor('session_error')).payload).toEqual({ code: 'ACTION_FAILED', message: expect.any(String), fatal: false });
    expect(p2.socket.connected).toBe(true);

    emit(p2, 'place_bid', { bid: 1, idempotency_key: 'k-retry' });
    expect((await host.waitFor('bid_placed')).payload).toEqual({ player_id: t.players[1].id, bid: 1 });
  });

  it('refuses actions from spectators with a non-fatal SPECTATOR_ACTION_FORBIDDEN', async () => {
    const t = await startTable({ spectators: 1 });
    await t.pc[1].waitFor('bid_request');
    emit(t.sc[0], 'place_bid', { bid: 0 });
    emit(t.sc[0], 'select_trump', { suit: 'hearts' });
    await t.sc[0].waitFor('session_error');
    await sleep(100);
    expect(t.sc[0].events('session_error').map((e) => e.payload)).toEqual([
      { code: 'SPECTATOR_ACTION_FORBIDDEN', message: expect.any(String), fatal: false },
      { code: 'SPECTATOR_ACTION_FORBIDDEN', message: expect.any(String), fatal: false },
    ]);
    expect(t.sc[0].socket.connected).toBe(true);
    expect(t.pc[0].events('bid_placed')).toHaveLength(0);
  });
});

describe('session refresh on game actions', () => {
  it('a bid slides sessions.expires_at forward', async () => {
    const t = await startTable();
    const p2 = t.players[1];
    await t.pc[1].waitFor('bid_request');
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await db('sessions').where({ user_id: p2.id }).whereNull('invalidated_at').update({ expires_at: soon });

    emit(t.pc[1], 'place_bid', { bid: 0 });
    await t.pc[0].waitFor('bid_placed');
    const row = await db('sessions').where({ user_id: p2.id }).whereNull('invalidated_at').first();
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(soon.getTime() + 60 * 60 * 1000);
  });

  it('an action on an ended session is refused with session_error and a disconnect', async () => {
    const t = await startTable();
    await t.pc[1].waitFor('bid_request');
    await db('sessions').where({ user_id: t.players[1].id }).update({ invalidated_at: db.fn.now() });

    emit(t.pc[1], 'place_bid', { bid: 0 });
    expect((await t.pc[1].waitFor('session_error')).payload).toMatchObject({ code: 'SESSION_INVALIDATED', fatal: true });
    await t.pc[1].waitForDisconnect();
    await sleep(100);
    expect(t.pc[0].events('bid_placed')).toHaveLength(0);
  });

  it('a session check that fails to run is answered with ACTION_FAILED and the action is not applied', async () => {
    const t = await startTable();
    await t.pc[1].waitFor('bid_request');
    jest.spyOn(socketAuth, 'recheckSocketSession').mockRejectedValueOnce(new Error('db down'));

    emit(t.pc[1], 'place_bid', { bid: 0 });
    expect((await t.pc[1].waitFor('session_error')).payload).toMatchObject({ code: 'ACTION_FAILED', fatal: false });
    await sleep(100);
    expect(t.pc[0].events('bid_placed')).toHaveLength(0);
    expect(t.pc[1].socket.connected).toBe(true);

    emit(t.pc[1], 'place_bid', { bid: 0 });
    await t.pc[0].waitFor('bid_placed');
  });

  it('a repeat action within the re-check interval does not query the session again', async () => {
    const throttled = await startServer({ deckFactory, sessionRecheckMs: 60_000 });
    try {
      const ps = await Promise.all([createUser('A'), createUser('B'), createUser('C')]);
      const local = request(throttled.app);
      const { body } = await local.post('/api/v1/rooms').set('Cookie', ps[0].cookie).send({}).expect(201);
      for (const p of ps.slice(1)) await local.post(`/api/v1/rooms/${body.id}/join`).set('Cookie', p.cookie).send({ role: 'player' });
      const cs = await Promise.all(ps.map((p) => connectReady(throttled.url, p.cookie)));
      clients.push(...cs);
      await local.post(`/api/v1/rooms/${body.id}/start`).set('Cookie', ps[0].cookie).expect(200);
      await cs[1].waitFor('bid_request');
      // Ended after connect: within the interval the action is not re-checked, so it goes through.
      await db('sessions').where({ user_id: ps[1].id }).update({ invalidated_at: db.fn.now() });
      emit(cs[1], 'place_bid', { bid: 0 });
      await cs[0].waitFor('bid_placed');
    } finally {
      await throttled.close();
    }
  });
});

describe('joining a game in progress', () => {
  it('a reconnecting player gets state_snapshot with only their own hand, then their pending bid_request', async () => {
    decks[1] = stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), S('clubs', 3)]);
    const t = await startTable();
    await t.pc[1].waitFor('bid_request');
    t.pc[1].close();
    // The seat is held (seq 5); see drops.int.test.ts for the window itself.
    expect((await t.pc[0].waitFor('player_disconnected')).seq).toBe(5);

    // A started game sends state_snapshot on connect, not lobby_snapshot or room_snapshot.
    const again = connect(server.url, t.players[1].cookie);
    clients.push(again);
    const snap = (await again.waitFor('state_snapshot')).payload;
    expect(snap.seq).toBe(5);
    const view = snap.game_state;
    expect(view.viewerUserId).toBe(t.players[1].id);
    expect(view.phase).toBe('bidding');
    expect(view.currentTurnUserId).toBe(t.players[1].id);
    const mine = view.players.find((p: { userId: string }) => p.userId === t.players[1].id);
    expect(mine.hand).toEqual([{ suit: 'hearts', rank: 5, type: 'suited' }]);
    for (const p of view.players.filter((x: { userId: string }) => x.userId !== t.players[1].id)) {
      expect(p.hand).toBeNull();
      expect(p.handCount).toBe(1);
    }
    expect((await again.waitFor('bid_request')).payload).toMatchObject({ player_id: t.players[1].id, allowed_bids: [0, 1] });
    expect((await t.pc[0].waitFor('player_reconnected')).payload).toEqual({ player_id: t.players[1].id });
    // And can carry on bidding.
    emit(again, 'place_bid', { bid: 1 });
    await t.pc[2].waitFor('bid_request');
  });

  it('a spectator joining mid-game gets the spectator view (no hands), and user_joined is in the game sequence', async () => {
    const t = await startTable();
    await t.pc[1].waitFor('bid_request');
    const late = await createUser('Late');
    const lc = await online(late);
    await api().post(`/api/v1/rooms/${t.roomId}/join`).set('Cookie', late.cookie).send({ role: 'spectator' }).expect(200);

    const snap = await lc.waitFor('state_snapshot');
    expect(lc.events('room_snapshot')).toHaveLength(0);
    expect(snap.payload.game_state.viewerUserId).toBeNull();
    for (const p of snap.payload.game_state.players) expect(p.hand).toBeNull();
    expect(lc.events('bid_request')).toHaveLength(0);

    const joined = await t.pc[0].waitFor('user_joined', (p) => p.user_id === late.id);
    expect(joined.seq).toBe(5);
    expect(joined.payload).toMatchObject({ role: 'spectator', seat_index: null, spectator_count: 1 });
    expect((await lc.waitFor('user_joined')).seq).toBe(5);
    const row = await db('game_events').where({ game_id: t.gameId, seq: 5 }).first();
    expect(row).toMatchObject({ event: 'user_joined', event_type: 'user_joined', actor_user_id: late.id });

    // Spectators see later broadcasts too.
    emit(t.pc[1], 'place_bid', { bid: 0 });
    expect((await lc.waitFor('bid_placed')).seq).toBe(6);
  });
});

// --- trick play, scoring and game end ----------------------------------------------------------

const card = (c: Card) => c.toData();

/**
 * Two rounds, three seats (P1 deals round 1, P2 round 2). Round 1: P2 ♥10, P3 ♥A, P1 ♠2, clubs
 * trump; P3 wins the trick. Round 2: P3 ♥3 ♣3, P1 ♥A W, P2 ♠5 ♣5, diamonds trump; P2 wins trick 1
 * with ♣5 (P1 has no club), P1's Wizard wins trick 2. With the bids below, the totals are
 * P1 50, P2 10, P3 50: P1 and P3 are co-winners.
 */
function stackTwoRounds(): void {
  decks[1] = stacked([S('hearts', 10), S('hearts', 14), S('spades', 2), S('clubs', 5)]);
  decks[2] = stacked([S('hearts', 3), S('clubs', 3), S('hearts', 14), W(), S('spades', 5), S('clubs', 5), S('diamonds', 2)]);
}

/** Bids in bidding order, each after that player's bid_request. */
async function bidAll(t: Table, order: number[], bids: number[], from = 0): Promise<void> {
  for (let i = 0; i < order.length; i++) {
    const c = t.pc[order[i]];
    await c.waitFor('bid_request', () => true, { from });
    emit(c, 'place_bid', { bid: bids[i] });
    await t.pc[0].waitFor('bid_placed', (p) => p.player_id === t.players[order[i]].id, { from: 0 });
  }
}

/** Plays `c` for seat `seat` once it has been asked, and waits for the room to see it. */
async function play(t: Table, seat: number, c: Card, from = 0): Promise<void> {
  await t.pc[seat].waitFor('play_request', () => true, { from });
  emit(t.pc[seat], 'play_card', { card: card(c) });
  await t.pc[0].waitFor('card_played', (p) => p.player_id === t.players[seat].id && JSON.stringify(p.card) === JSON.stringify(card(c)), { from });
}

/** Round 1 of stackTwoRounds: bids P2 0, P3 1, P1 0; one trick, won by P3. */
async function playRound1(t: Table): Promise<void> {
  await bidAll(t, [1, 2, 0], [0, 1, 0]);
  await play(t, 1, S('hearts', 10));
  await play(t, 2, S('hearts', 14));
  await play(t, 0, S('spades', 2));
  await t.pc[0].waitFor('round_complete');
}

/** Round 2 of stackTwoRounds: bids P3 0, P1 1, P2 0. Ends the game. */
async function playRound2(t: Table): Promise<void> {
  const from = (await t.pc[0].waitFor('round_started', (p) => p.round_number === 2)).index;
  await bidAll(t, [2, 0, 1], [0, 1, 0], from);
  const at = (c: TestClient) => c.events('round_started').at(-1)!.index;
  await play(t, 2, S('clubs', 3), at(t.pc[2]));
  await play(t, 0, S('hearts', 14), at(t.pc[0]));
  await play(t, 1, S('clubs', 5), at(t.pc[1]));
  const trick1 = (await t.pc[1].waitFor('trick_complete', (p) => p.trick_number === 1, { from: at(t.pc[1]) })).index;
  await play(t, 1, S('spades', 5), trick1);
  await play(t, 2, S('hearts', 3), at(t.pc[2]));
  await play(t, 0, W(), at(t.pc[0]));
  await t.pc[0].waitFor('game_over');
}

describe('trick play', () => {
  it('asks the leader with legal_cards, validates play_card, broadcasts card_played and trick_complete', async () => {
    stackTwoRounds();
    const t = await startTable({ spectators: 1, config: { roundCount: 2 } });
    const [p1, p2, p3] = t.pc;
    const ids = t.players.map((p) => p.id);
    await bidAll(t, [1, 2, 0], [0, 1, 0]);

    expect((await p2.waitFor('play_request')).payload).toEqual({
      player_id: ids[1],
      round_number: 1,
      trick_number: 1,
      trick_so_far: [],
      legal_cards: [card(S('hearts', 10))],
    });
    // Out of turn; a card not held; not a card at all.
    emit(p3, 'play_card', { card: card(S('hearts', 14)) });
    expect((await p3.waitFor('invalid_play_error')).payload).toEqual({
      player_id: ids[2],
      code: 'NOT_YOUR_TURN',
      reason: expect.any(String),
      legal_cards: [],
    });
    emit(p2, 'play_card', { card: card(S('hearts', 9)) });
    expect((await p2.waitFor('invalid_play_error')).payload).toMatchObject({ code: 'CARD_NOT_IN_HAND', legal_cards: [card(S('hearts', 10))] });
    const n = p2.events('invalid_play_error').length;
    emit(p2, 'play_card', { card: 'hearts 10' });
    await p2.waitFor('invalid_play_error', (p) => p.code === 'CARD_NOT_IN_HAND', { from: p2.events('invalid_play_error')[n - 1].index + 1 });
    expect(t.sc[0].events('card_played')).toHaveLength(0);

    emit(p2, 'play_card', { card: card(S('hearts', 10)) });
    for (const c of [p1, p2, p3, t.sc[0]]) {
      expect((await c.waitFor('card_played')).payload).toEqual({ player_id: ids[1], card: card(S('hearts', 10)), trick_number: 1 });
    }
    expect((await p3.waitFor('play_request')).payload).toMatchObject({
      player_id: ids[2],
      trick_so_far: [{ player_id: ids[1], card: card(S('hearts', 10)) }],
      legal_cards: [card(S('hearts', 14))],
    });
    await play(t, 2, S('hearts', 14));
    await play(t, 0, S('spades', 2));

    const cardsPlayed = [
      { player_id: ids[1], card: card(S('hearts', 10)) },
      { player_id: ids[2], card: card(S('hearts', 14)) },
      { player_id: ids[0], card: card(S('spades', 2)) },
    ];
    for (const c of [p1, p2, p3, t.sc[0]]) {
      expect((await c.waitFor('trick_complete')).payload).toEqual({ winner_id: ids[2], cards_played: cardsPlayed, trick_number: 1 });
    }
    // Spectators never get a prompt or a hand.
    expect(t.sc[0].events('play_request')).toHaveLength(0);
    expect(t.sc[0].events('hand_dealt')).toHaveLength(0);
  });

  it('enforces follow-suit and the trick winner leads the next trick', async () => {
    stackTwoRounds();
    const t = await startTable({ config: { roundCount: 2 } });
    const ids = t.players.map((p) => p.id);
    await playRound1(t);
    const from = (await t.pc[0].waitFor('round_started', (p) => p.round_number === 2)).index;
    expect((await t.pc[0].waitFor('round_started', (p) => p.round_number === 2)).payload).toMatchObject({ dealer_id: ids[1] });
    await bidAll(t, [2, 0, 1], [0, 1, 0], from);
    const at = (c: TestClient) => c.events('round_started').at(-1)!.index;

    await play(t, 2, S('clubs', 3), at(t.pc[2]));
    // P1 holds no club: anything goes.
    expect((await t.pc[0].waitFor('play_request', () => true, { from: at(t.pc[0]) })).payload.legal_cards).toEqual([card(S('hearts', 14)), card(W())]);
    await play(t, 0, S('hearts', 14), at(t.pc[0]));
    // P2 must follow clubs.
    const req = await t.pc[1].waitFor('play_request', () => true, { from: at(t.pc[1]) });
    expect(req.payload.legal_cards).toEqual([card(S('clubs', 5))]);
    emit(t.pc[1], 'play_card', { card: card(S('spades', 5)) });
    expect((await t.pc[1].waitFor('invalid_play_error', () => true, { from: req.index })).payload).toMatchObject({
      code: 'ILLEGAL_CARD',
      legal_cards: [card(S('clubs', 5))],
    });
    await play(t, 1, S('clubs', 5), at(t.pc[1]));

    const done = await t.pc[0].waitFor('trick_complete', (p) => p.trick_number === 1, { from: at(t.pc[0]) });
    expect(done.payload.winner_id).toBe(ids[1]);
    // The winner leads trick 2, with whatever is left.
    expect((await t.pc[1].waitFor('play_request', (p) => p.trick_number === 2)).payload).toMatchObject({
      player_id: ids[1],
      trick_so_far: [],
      legal_cards: [card(S('spades', 5))],
    });
  });

  it('a reconnecting player in trick play gets state_snapshot (with the trick so far), then play_request', async () => {
    stackTwoRounds();
    const t = await startTable({ config: { roundCount: 2 } });
    await bidAll(t, [1, 2, 0], [0, 1, 0]);
    await play(t, 1, S('hearts', 10));
    t.pc[2].close();

    const again = connect(server.url, t.players[2].cookie);
    clients.push(again);
    const view = (await again.waitFor('state_snapshot')).payload.game_state;
    expect(view.phase).toBe('trick');
    expect(view.currentTurnUserId).toBe(t.players[2].id);
    expect(view.tricksSoFar).toEqual([
      expect.objectContaining({ trickNumber: 1, cards: [{ userId: t.players[1].id, card: card(S('hearts', 10)) }] }),
    ]);
    expect((await again.waitFor('play_request')).payload).toMatchObject({ legal_cards: [card(S('hearts', 14))] });
    emit(again, 'play_card', { card: card(S('hearts', 14)) });
    await t.pc[0].waitFor('play_request');
  });

  it('play_card refreshes the session; on an ended session it is refused and not applied', async () => {
    stackTwoRounds();
    const t = await startTable({ config: { roundCount: 2 } });
    await bidAll(t, [1, 2, 0], [0, 1, 0]);
    await t.pc[1].waitFor('play_request');
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await db('sessions').where({ user_id: t.players[1].id }).whereNull('invalidated_at').update({ expires_at: soon });
    await play(t, 1, S('hearts', 10));
    const row = await db('sessions').where({ user_id: t.players[1].id }).whereNull('invalidated_at').first();
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(soon.getTime() + 60 * 60 * 1000);

    await t.pc[2].waitFor('play_request');
    await db('sessions').where({ user_id: t.players[2].id }).update({ invalidated_at: db.fn.now() });
    emit(t.pc[2], 'play_card', { card: card(S('hearts', 14)) });
    expect((await t.pc[2].waitFor('session_error')).payload).toMatchObject({ code: 'SESSION_INVALIDATED', fatal: true });
    await sleep(100);
    expect(t.pc[0].events('card_played')).toHaveLength(1);
  });

  it('refuses play_card from a spectator', async () => {
    stackTwoRounds();
    const t = await startTable({ spectators: 1, config: { roundCount: 2 } });
    await bidAll(t, [1, 2, 0], [0, 1, 0]);
    emit(t.sc[0], 'play_card', { card: card(S('hearts', 10)) });
    expect((await t.sc[0].waitFor('session_error')).payload).toMatchObject({ code: 'SPECTATOR_ACTION_FORBIDDEN', fatal: false });
  });
});

describe('round end', () => {
  it('broadcasts round_complete, writes rounds, round_players and the checkpoint, then deals the next round', async () => {
    stackTwoRounds();
    const t = await startTable({ spectators: 1, config: { roundCount: 2 } });
    const ids = t.players.map((p) => p.id);
    await playRound1(t);

    const expected = {
      round_number: 1,
      // Seat order. P2 and P1 made 0 (+20); P3 made 1 (+30).
      scores_this_round: [
        { player_id: ids[0], bid: 0, tricks_won: 0, score: 20 },
        { player_id: ids[1], bid: 0, tricks_won: 0, score: 20 },
        { player_id: ids[2], bid: 1, tricks_won: 1, score: 30 },
      ],
      cumulative_scores: [
        { player_id: ids[0], score: 20 },
        { player_id: ids[1], score: 20 },
        { player_id: ids[2], score: 30 },
      ],
      is_final_round: false,
    };
    for (const c of [...t.pc, t.sc[0]]) expect((await c.waitFor('round_complete')).payload).toEqual(expected);

    // The next round follows straight away: seat 2 deals, two cards each, seat 3 bids first.
    await t.sc[0].waitFor('trump_revealed', (p) => p.round_number === 2);
    expect(names(t.sc[0]).slice(-7)).toEqual([
      'card_played',
      'card_played',
      'card_played',
      'trick_complete',
      'round_complete',
      'round_started',
      'trump_revealed',
    ]);
    expect((await t.pc[2].waitFor('hand_dealt', (p) => p.round_number === 2)).payload.hand).toHaveLength(2);
    expect((await t.pc[2].waitFor('bid_request', (p) => p.round_number === 2)).payload).toMatchObject({ allowed_bids: [0, 1, 2] });

    const rounds = await db('rounds').where({ game_id: t.gameId });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round_number: 1, dealer_user_id: ids[0], trump_suit: 'clubs', trump_source: 'flip' });
    expect(rounds[0].ended_at).not.toBeNull();
    const rp = await db('round_players').where({ round_id: rounds[0].id }).orderBy('bid_position');
    expect(rp.map((r) => [r.user_id, r.bid, r.tricks_won, r.score_delta, r.bid_position])).toEqual([
      [ids[1], 0, 0, 20, 1],
      [ids[2], 1, 1, 30, 2],
      [ids[0], 0, 0, 20, 3],
    ]);
    const game = await db('games').where({ id: t.gameId }).first();
    expect(game.status).toBe('in_progress');
    expect(game.state).toMatchObject({ phase: 'round_end', currentRound: 1, scores: { [ids[0]]: 20, [ids[1]]: 20, [ids[2]]: 30 } });
    expect(game.state.roundHistory).toHaveLength(1);
  });

  it('logs card plays, the trick and the round with their own round and trick numbers', async () => {
    stackTwoRounds();
    const t = await startTable({ config: { roundCount: 2 } });
    const ids = t.players.map((p) => p.id);
    await playRound1(t);
    await t.pc[2].waitFor('bid_request', (p) => p.round_number === 2);

    const rows = await db('game_events').where({ game_id: t.gameId }).where('seq', '>', 8).orderBy('seq');
    expect(rows.map((r) => [r.seq, r.event, r.event_type, r.round_number, r.trick_number])).toEqual([
      [9, 'card_played', 'card_played', 1, 1],
      [10, 'card_played', 'card_played', 1, 1],
      [11, 'card_played', 'card_played', 1, 1],
      [12, 'trick_complete', 'trick_completed', 1, 1],
      [13, 'round_complete', 'round_completed', 1, null],
      [14, 'round_started', 'round_started', 2, null],
      [15, 'trump_revealed', 'trump_revealed', 2, null],
    ]);
    expect(rows[1].payload).toMatchObject({
      playerId: ids[2],
      card: card(S('hearts', 14)),
      playPosition: 2,
      handBeforePlay: [card(S('hearts', 14))],
      ledSuit: 'hearts',
      trumpSuit: 'clubs',
      cardsPlayedInTrick: [{ playerId: ids[1], card: card(S('hearts', 10)) }],
      bidsThisRound: { [ids[0]]: 0, [ids[1]]: 0, [ids[2]]: 1 },
    });
    expect(rows[3].payload).toMatchObject({ winnerUserId: ids[2], winningCardType: 'suited', tricksWonPerPlayer: { [ids[2]]: 1 } });
    expect(rows[4].payload.results).toContainEqual({ userId: ids[2], bid: 1, tricksWon: 1, scoreDelta: 30, cumulativeScore: 30 });
    // The broadcast copies never carry a hand.
    for (const r of rows) expect(JSON.stringify(r.sent_payload)).not.toContain('hand');
  });
});

describe('game end', () => {
  it('writes the results, broadcasts game_over, holds the room COMPLETING, then closes it', async () => {
    stackTwoRounds();
    const t = await startTable({ spectators: 1, config: { roundCount: 2 } });
    const ids = t.players.map((p) => p.id);
    await playRound1(t);
    await playRound2(t);

    const lastRound = await t.pc[0].waitFor('round_complete', (p) => p.round_number === 2);
    expect(lastRound.payload).toMatchObject({ is_final_round: true });
    for (const c of [...t.pc, t.sc[0]]) {
      const over = await c.waitFor('game_over');
      expect(over.payload).toEqual({
        game_id: t.gameId,
        status: 'complete',
        final_scores: [
          { player_id: ids[0], score: 50 },
          { player_id: ids[1], score: 10 },
          { player_id: ids[2], score: 50 },
        ],
        winner_ids: [ids[0], ids[2]],
        closes_at: expect.any(String),
        countdown_seconds: 2,
      });
      expect(over.seq).toBe(lastRound.seq + 1);
    }
    // No next round.
    expect(t.pc[0].events('round_started')).toHaveLength(2);

    const game = await db('games').where({ id: t.gameId }).first();
    expect(game).toMatchObject({ status: 'complete', drop_reason: null });
    expect(game.ended_at).not.toBeNull();
    expect(game.state).toMatchObject({ phase: 'completed', winnerUserIds: [ids[0], ids[2]] });
    const results = await db('game_results').where({ game_id: t.gameId });
    expect(results.map((r) => [r.user_id, r.final_score, r.outcome, r.rounds_played]).sort()).toEqual(
      [
        [ids[0], 50, 'win', 2],
        [ids[1], 10, 'loss', 2],
        [ids[2], 50, 'win', 2],
      ].sort(),
    );
    expect(await db('rounds').where({ game_id: t.gameId }).count('* as n').first()).toEqual({ n: '2' });
    expect((await db('rooms').where({ id: t.roomId }).first()).state).toBe('completing');
    const logged = await db('game_events').where({ game_id: t.gameId, event: 'game_over' }).first();
    expect(logged).toMatchObject({ event_type: 'game_completed', round_number: 2, seq: lastRound.seq + 1 });
    expect(logged.payload).toMatchObject({ status: 'complete', winners: [ids[0], ids[2]], roundCount: 2, playerCount: 3 });
    expect(server.rooms.hasCloseTimer(t.roomId)).toBe(true);
    // A game action now is refused as out of phase.
    emit(t.pc[0], 'play_card', { card: card(W()) });
    expect((await t.pc[0].waitFor('invalid_play_error')).payload).toMatchObject({ code: 'INVALID_PHASE' });

    // The countdown runs out: room_closed, everyone back to the lobby, the room closed.
    for (const c of [...t.pc, t.sc[0]]) {
      expect((await c.waitFor('room_closed', () => true, { timeoutMs: COUNTDOWN_MS + 3000 })).payload).toEqual({
        room_id: t.roomId,
        reason: 'game_finished',
      });
      await c.waitFor('lobby_snapshot');
    }
    const room = await db('rooms').where({ id: t.roomId }).first();
    expect(room.state).toBe('closed');
    expect(room.closed_at).not.toBeNull();
    expect(await db('room_members').where({ room_id: t.roomId }).whereNull('left_at')).toHaveLength(0);
    expect(server.games.isLive(t.roomId)).toBe(false);
  });

  it('a player reconnecting during the countdown gets state_snapshot, then game_over', async () => {
    stackTwoRounds();
    const t = await startTable({ config: { roundCount: 2 } });
    await playRound1(t);
    await playRound2(t);
    t.pc[1].close();

    const again = connect(server.url, t.players[1].cookie);
    clients.push(again);
    expect((await again.waitFor('state_snapshot')).payload.game_state.phase).toBe('completed');
    expect((await again.waitFor('game_over')).payload).toMatchObject({ winner_ids: [t.players[0].id, t.players[2].id] });
  });

  it('players may leave during the countdown; once everyone has left the room closes at once', async () => {
    stackTwoRounds();
    const t = await startTable({ spectators: 1, config: { roundCount: 2 } });
    await playRound1(t);
    await playRound2(t);

    for (const u of [...t.players, ...t.spectators].slice(0, -1)) {
      await api().post(`/api/v1/rooms/${t.roomId}/leave`).set('Cookie', u.cookie).expect(204);
    }
    await t.pc[0].waitFor('lobby_snapshot');
    expect((await db('rooms').where({ id: t.roomId }).first()).state).toBe('completing');
    // The spectator, still there, saw them go.
    expect(t.sc[0].events('user_left')).toHaveLength(3);

    await api().post(`/api/v1/rooms/${t.roomId}/leave`).set('Cookie', t.spectators[0].cookie).expect(204);
    const room = await db('rooms').where({ id: t.roomId }).first();
    expect(room.state).toBe('closed');
    expect(server.rooms.hasCloseTimer(t.roomId)).toBe(false);
    expect(server.games.isLive(t.roomId)).toBe(false);
    // Everyone can go straight into another room.
    await api().post('/api/v1/rooms').set('Cookie', t.players[0].cookie).send({}).expect(201);
  });

  it('a player reconnecting during the countdown is not announced as disconnected or reconnected', async () => {
    stackTwoRounds();
    const t = await startTable({ config: { roundCount: 2 } });
    await playRound1(t);
    await playRound2(t);
    t.pc[1].close();
    const again = connect(server.url, t.players[1].cookie);
    clients.push(again);
    await again.waitFor('game_over');
    await sleep(150);
    expect(t.pc[0].events('player_disconnected')).toHaveLength(0);
    expect(t.pc[0].events('player_reconnected')).toHaveLength(0);
  });
});

describe('a whole game', () => {
  it('plays a shuffled 20-round game to game_over with players answering every prompt; the records add up', async () => {
    // Seeded shuffles, the same every run. Round 20 deals all 60 cards: no flip, no trump.
    let seed = 42;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let r = 1; r <= 20; r++) decks[r] = new Deck('standard', random).shuffle();
    const t = await startTable({ spectators: 1 });

    for (const c of t.pc) {
      c.socket.on('trump_selection_request', () => emit(c, 'select_trump', { suit: 'spades' }));
      c.socket.on('bid_request', (env: { payload: { allowed_bids: number[] } }) => emit(c, 'place_bid', { bid: env.payload.allowed_bids.at(-1) }));
      c.socket.on('play_request', (env: { payload: { legal_cards: unknown[] } }) => emit(c, 'play_card', { card: env.payload.legal_cards[0] }));
    }
    // round_started for round 1 was already seen: answer the prompts that arrived before the handlers.
    for (const c of t.pc) {
      if (c.events('bid_request').length > 0) emit(c, 'place_bid', { bid: c.events('bid_request')[0].payload.allowed_bids.at(-1) });
      if (c.events('trump_selection_request').length > 0) emit(c, 'select_trump', { suit: 'spades' });
    }

    const over = await t.sc[0].waitFor('game_over', () => true, { timeoutMs: 20000 });
    for (const c of [...t.pc, t.sc[0]]) {
      expect(c.events('round_complete')).toHaveLength(20);
      // No gaps: every broadcast this client saw has the next seq.
      const start = c.events('game_starting')[0].index;
      const unicasts = ['hand_dealt', 'bid_request', 'play_request', 'trump_selection_request'];
      const seqs = c.log.filter((e) => e.index >= start && !unicasts.includes(e.event)).map((e) => e.seq);
      expect(seqs[0]).toBe(1);
      expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
    }
    expect(t.pc.flatMap((c) => c.events('invalid_play_error'))).toHaveLength(0);
    expect(t.pc.flatMap((c) => c.events('invalid_bid_error'))).toHaveLength(0);
    const last = t.sc[0].events('round_started').at(-1)!.payload;
    expect(last).toMatchObject({ round_number: 20, trump_card: null, trump_suit: null });

    const results = await db('game_results').where({ game_id: t.gameId });
    const sums: { user_id: string; total: string }[] = await db('round_players as rp')
      .join('rounds as r', 'r.id', 'rp.round_id')
      .where('r.game_id', t.gameId)
      .groupBy('rp.user_id')
      .select('rp.user_id', db.raw('sum(rp.score_delta) as total'));
    expect(sums).toHaveLength(3);
    for (const s of sums) expect(results.find((r) => r.user_id === s.user_id)!.final_score).toBe(Number(s.total));
    for (const e of over.payload.final_scores) expect(results.find((r) => r.user_id === e.player_id)!.final_score).toBe(e.score);
    expect(await db('game_events').where({ game_id: t.gameId }).count('* as n').first()).toEqual({ n: String(over.seq) });
  });
});
