import request from 'supertest';
import { db } from '../db/knex';
import { Card, Deck, type DeckFactory } from '../engine';
import { connect, connectReady, createUser, resetDb, sleep, startServer, type TestClient, type TestUser } from '../test/helpers';

/**
 * The next test's decks, by round number. Unset rounds get a fixed deck whose flip is a suited
 * card: a shuffled deck turns up a Wizard 1 time in 15, and the round then waits for the dealer.
 */
let decks: Record<number, Deck> = {};
const deckFactory: DeckFactory = (_ruleset, round) => decks[round] ?? new Deck();

let server: Awaited<ReturnType<typeof startServer>>;
let clients: TestClient[] = [];

beforeAll(async () => {
  // Re-check the session on every game action, so the refresh is observable.
  server = await startServer({ deckFactory, sessionRecheckMs: 0 });
});
afterAll(async () => {
  await server.close();
  await db.destroy();
});
beforeEach(async () => {
  server.rooms.stop();
  server.games.stop();
  decks = {};
  await resetDb();
});
afterEach(() => {
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
    // Bidding is over; a late bid is refused. Trick play is not wired yet: no play_request.
    emit(dealer, 'place_bid', { bid: 0 });
    await dealer.waitFor('invalid_bid_error', (p) => p.code === 'INVALID_PHASE');
    expect(dealer.events('play_request')).toHaveLength(0);

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

    // A started game sends state_snapshot on connect, not lobby_snapshot or room_snapshot.
    const again = connect(server.url, t.players[1].cookie);
    clients.push(again);
    const snap = (await again.waitFor('state_snapshot')).payload;
    expect(snap.seq).toBe(4);
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
