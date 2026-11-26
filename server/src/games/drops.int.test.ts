import request from 'supertest';
import { db } from '../db/knex';
import { Card, Deck, type DeckFactory } from '../engine';
import { abandonInProgressGames } from './queries';
import { connect, connectReady, createUser, resetDb, sleep, startServer, type TestClient, type TestUser } from '../test/helpers';

/**
 * Disconnects, reconnects with replay, quits, timeouts, player drops, the game time limit and the
 * startup cleanup, over real sockets and Postgres. The windows are shortened; the full-length
 * timers are covered with fake timers in service.test.ts.
 */

const RECONNECT_MS = 500;
const DECISION_MS = 700;
const COUNTDOWN_MS = 1200;
const PING_TIMEOUT_MS = 400;

let decks: Record<number, Deck> = {};
const deckFactory: DeckFactory = (_ruleset, round) => decks[round] ?? new Deck();

let server: Awaited<ReturnType<typeof startServer>>;
let clients: TestClient[] = [];

beforeAll(async () => {
  server = await startServer({
    deckFactory,
    sessionRecheckMs: 0,
    countdownMs: COUNTDOWN_MS,
    reconnectWindowMs: RECONNECT_MS,
    continueDecisionMs: DECISION_MS,
    pingTimeoutMs: PING_TIMEOUT_MS,
  });
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

const S = (suit: 'hearts' | 'diamonds' | 'spades' | 'clubs', rank: number) => Card.suited(suit, rank);

function stacked(top: Card[]): Deck {
  const rest = new Deck().peekAll();
  for (const c of top) rest.splice(rest.findIndex((r) => r.equals(c)), 1);
  return Deck.fromCards([...top, ...rest]);
}

function emit(c: TestClient, event: string, payload: object): void {
  c.socket.emit(event, { event, seq: 0, timestamp: new Date().toISOString(), payload });
}

async function online(url: string, user: TestUser): Promise<TestClient> {
  const c = await connectReady(url, user.cookie);
  clients.push(c);
  return c;
}

function reconnect(url: string, user: TestUser): TestClient {
  const c = connect(url, user.cookie);
  clients.push(c);
  return c;
}

interface Table {
  roomId: string;
  gameId: string;
  players: TestUser[];
  pc: TestClient[];
  spectators: TestUser[];
  sc: TestClient[];
}

async function startTable(
  srv: typeof server,
  { players = 3, spectators = 0, config = {} }: { players?: number; spectators?: number; config?: object } = {},
): Promise<Table> {
  const api = request(srv.app);
  const ps = await Promise.all(Array.from({ length: players }, (_, i) => createUser(`P${i + 1}`)));
  const ss = await Promise.all(Array.from({ length: spectators }, (_, i) => createUser(`S${i + 1}`)));
  const created = await api.post('/api/v1/rooms').set('Cookie', ps[0].cookie).send({ config }).expect(201);
  const roomId: string = created.body.id;
  for (const p of ps.slice(1)) await api.post(`/api/v1/rooms/${roomId}/join`).set('Cookie', p.cookie).send({ role: 'player' }).expect(200);
  for (const s of ss) await api.post(`/api/v1/rooms/${roomId}/join`).set('Cookie', s.cookie).send({ role: 'spectator' }).expect(200);
  const pc = await Promise.all(ps.map((p) => online(srv.url, p)));
  const sc = await Promise.all(ss.map((s) => online(srv.url, s)));
  await api.post(`/api/v1/rooms/${roomId}/start`).set('Cookie', ps[0].cookie).expect(200);
  for (const c of [...pc, ...sc]) await c.waitFor('trump_revealed');
  return { roomId, gameId: srv.games.gameIdFor(roomId)!, players: ps, pc, spectators: ss, sc };
}

const api = () => request(server.app);
const leave = (t: Table, i: number) => api().post(`/api/v1/rooms/${t.roomId}/leave`).set('Cookie', t.players[i].cookie).expect(204);
const after = (c: TestClient, from: number) => c.log.filter((e) => e.index >= from).map((e) => [e.event, e.seq]);

describe('disconnect and reconnect', () => {
  it('holds the seat; join_game with last_seq_seen gets state_snapshot, the missed events, then the prompt', async () => {
    // Seat 2 bids first, then seat 3.
    decks[1] = stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), S('clubs', 3)]);
    const t = await startTable(server);
    const [host, p2, p3] = t.pc;
    await p2.waitFor('bid_request');
    const lastSeen = (await p3.waitFor('trump_revealed')).seq; // 4
    p3.close();

    const disc = await host.waitFor('player_disconnected');
    expect(disc.seq).toBe(5);
    expect(disc.payload).toEqual({ player_id: t.players[2].id, reconnect_deadline: expect.any(String) });
    const deadline = Date.parse(disc.payload.reconnect_deadline);
    expect(deadline - Date.now()).toBeGreaterThan(0);
    expect(deadline - Date.now()).toBeLessThanOrEqual(RECONNECT_MS);
    expect(server.games.isHoldingSeat(t.roomId, t.players[2].id)).toBe(true);

    // Play goes on while they are away.
    emit(p2, 'place_bid', { bid: 1 });
    await host.waitFor('bid_placed');

    // Connecting puts them straight back: snapshot, their bid_request, then player_reconnected.
    const back = reconnect(server.url, t.players[2]);
    const snap = await back.waitFor('state_snapshot');
    expect(snap.payload.seq).toBe(6);
    expect(snap.payload.game_state.players.find((p: { userId: string }) => p.userId === t.players[2].id).hand).toEqual([
      { suit: 'spades', rank: 9, type: 'suited' },
    ]);
    await back.waitFor('bid_request');
    expect((await host.waitFor('player_reconnected')).payload).toEqual({ player_id: t.players[2].id });
    expect(server.games.isHoldingSeat(t.roomId, t.players[2].id)).toBe(false);
    await back.waitFor('player_reconnected');

    // join_game with what they had seen: snapshot, then every broadcast after it, then the prompt.
    const from = back.length;
    emit(back, 'join_game', { player_id: t.players[2].id, display_name: 'P3', last_seq_seen: lastSeen });
    await back.waitFor('bid_request', () => true, { from });
    expect(after(back, from)).toEqual([
      ['state_snapshot', 7],
      ['player_disconnected', 5],
      ['bid_placed', 6],
      ['player_reconnected', 7],
      ['bid_request', 7],
    ]);
    const replayed = back.log.filter((e) => e.index >= from);
    expect(replayed[2].payload).toEqual({ player_id: t.players[1].id, bid: 1 });
    // Nothing replayed carries a hand.
    expect(JSON.stringify(replayed.slice(1, 4).map((e) => e.payload))).not.toContain('"hand"');

    const rows = await db('game_events').where({ game_id: t.gameId }).whereIn('seq', [5, 7]).orderBy('seq');
    expect(rows.map((r) => [r.event, r.event_type, r.actor_user_id])).toEqual([
      ['player_disconnected', 'player_disconnected', t.players[2].id],
      ['player_reconnected', 'player_reconnected', t.players[2].id],
    ]);

    // The window has passed: they were back in time, so nobody was dropped.
    await sleep(RECONNECT_MS + 200);
    expect(host.events('user_left')).toHaveLength(0);
    emit(back, 'place_bid', { bid: 0 });
    await host.waitFor('bid_placed', (p) => p.player_id === t.players[2].id);
  });

  it('sync_request is answered like join_game; ping gets pong', async () => {
    const t = await startTable(server);
    const [, p2] = t.pc;
    await p2.waitFor('bid_request');
    const from = p2.length;
    emit(p2, 'sync_request', { player_id: t.players[1].id, last_seq_seen: 2 });
    await p2.waitFor('bid_request', () => true, { from });
    expect(after(p2, from)).toEqual([
      ['state_snapshot', 4],
      ['round_started', 3],
      ['trump_revealed', 4],
      ['bid_request', 4],
    ]);

    emit(p2, 'ping', { client_time: new Date().toISOString() });
    const pong = await p2.waitFor('pong');
    expect(pong.payload).toEqual({ server_time: expect.any(String) });
    // A unicast in a game: the current seq.
    expect(pong.seq).toBe(4);
  });

  it('a client that pings and then goes quiet is disconnected, which holds its seat', async () => {
    const t = await startTable(server);
    const [host, p2] = t.pc;
    emit(p2, 'ping', { client_time: new Date().toISOString() });
    await p2.waitFor('pong');
    await p2.waitForDisconnect(PING_TIMEOUT_MS + 1000);
    expect((await host.waitFor('player_disconnected')).payload.player_id).toBe(t.players[1].id);
  });

  it('a player with no socket when the game starts is treated as disconnected', async () => {
    const ps = await Promise.all([createUser('A'), createUser('B'), createUser('C'), createUser('D')]);
    const { body } = await api().post('/api/v1/rooms').set('Cookie', ps[0].cookie).send({}).expect(201);
    for (const p of ps.slice(1)) await api().post(`/api/v1/rooms/${body.id}/join`).set('Cookie', p.cookie).send({ role: 'player' });
    const cs = await Promise.all(ps.slice(0, 3).map((p) => online(server.url, p)));
    await api().post(`/api/v1/rooms/${body.id}/start`).set('Cookie', ps[0].cookie).expect(200);
    expect((await cs[0].waitFor('player_disconnected')).payload.player_id).toBe(ps[3].id);
    // Never shows up: dropped at the deadline, and the round is re-dealt for the three.
    expect((await cs[0].waitFor('user_left', () => true, { timeoutMs: RECONNECT_MS + 2000 })).payload).toMatchObject({
      user_id: ps[3].id,
      reason: 'timeout',
    });
    await cs[0].waitFor('round_started', (p) => p.round_number === 1, { from: (await cs[0].waitFor('user_left')).index });
  });
});

describe('quits and timeouts', () => {
  it('the window running out drops the player: user_left (timeout), round re-dealt to the rest; they cannot come back as a player', async () => {
    const t = await startTable(server, { players: 4 });
    const [host] = t.pc;
    await t.pc[1].waitFor('bid_request');
    t.pc[3].close();
    await host.waitFor('player_disconnected');

    const left = await host.waitFor('user_left', () => true, { timeoutMs: RECONNECT_MS + 2000 });
    expect(left.payload).toEqual({
      user_id: t.players[3].id,
      role: 'player',
      reason: 'timeout',
      player_count: 3,
      spectator_count: 0,
    });
    // The voided round 1 is dealt again to the three left, same dealer.
    const redeal = await host.waitFor('round_started', () => true, { from: left.index });
    expect(redeal.seq).toBe(left.seq + 1);
    expect(redeal.payload).toMatchObject({ round_number: 1, dealer_id: t.players[0].id });
    for (const c of t.pc.slice(0, 3)) await c.waitFor('hand_dealt', () => true, { from: (await c.waitFor('user_left')).index });
    await t.pc[1].waitFor('bid_request', () => true, { from: (await t.pc[1].waitFor('user_left')).index });

    const member = await db('room_members').where({ room_id: t.roomId, user_id: t.players[3].id }).first();
    expect(member.left_at).not.toBeNull();

    // Back too late: the lobby. They may watch, not play.
    const late = reconnect(server.url, t.players[3]);
    await late.waitFor('lobby_snapshot');
    const asPlayer = await api().post(`/api/v1/rooms/${t.roomId}/join`).set('Cookie', t.players[3].cookie).send({ role: 'player' });
    expect(asPlayer.status).toBe(403);
    expect(asPlayer.body.code).toBe('ROOM_NOT_JOINABLE');
    await api().post(`/api/v1/rooms/${t.roomId}/join`).set('Cookie', t.players[3].cookie).send({ role: 'spectator' }).expect(200);
    const snap = await late.waitFor('state_snapshot');
    expect(snap.payload.game_state.viewerUserId).toBeNull();
    expect(snap.payload.game_state.players.map((p: { userId: string }) => p.userId)).toEqual(t.players.slice(0, 3).map((p) => p.id));
    emit(late, 'place_bid', { bid: 0 });
    expect((await late.waitFor('session_error')).payload.code).toBe('SPECTATOR_ACTION_FORBIDDEN');
  });

  it('leave_game is a quit: user_left (voluntary), the quitter goes to the lobby, the round is re-dealt', async () => {
    const t = await startTable(server, { players: 4, spectators: 1 });
    const [host, p2] = t.pc;
    await p2.waitFor('bid_request');
    emit(p2, 'place_bid', { bid: 1 });
    await host.waitFor('bid_placed');

    const quitter = t.pc[2];
    emit(quitter, 'leave_game', { player_id: t.players[2].id });
    await quitter.waitFor('lobby_snapshot');
    const left = await t.sc[0].waitFor('user_left');
    expect(left.payload).toMatchObject({ user_id: t.players[2].id, role: 'player', reason: 'voluntary', player_count: 3, spectator_count: 1 });
    const redeal = await t.sc[0].waitFor('round_started', () => true, { from: left.index });
    expect(redeal.payload.round_number).toBe(1);
    // Bids are cleared with the voided round: seat 2 is asked again.
    await p2.waitFor('bid_request', () => true, { from: (await p2.waitFor('user_left')).index });
    expect(server.games.isSeated(t.roomId, t.players[2].id)).toBe(false);

    const logged = await db('game_events').where({ game_id: t.gameId, seq: left.seq }).first();
    expect(logged).toMatchObject({ event: 'user_left', event_type: 'user_left', actor_user_id: t.players[2].id });
  });

  it('a spectator leaving is not a drop', async () => {
    const t = await startTable(server, { spectators: 1 });
    await t.pc[1].waitFor('bid_request');
    await api().post(`/api/v1/rooms/${t.roomId}/leave`).set('Cookie', t.spectators[0].cookie).expect(204);
    const left = await t.pc[0].waitFor('user_left');
    expect(left.payload).toMatchObject({ role: 'spectator', reason: 'voluntary' });
    await sleep(100);
    expect(t.pc[0].events('round_started')).toHaveLength(1);
    expect(t.pc[0].events('continue_or_end_request')).toHaveLength(0);
  });
});

describe('a drop to two players', () => {
  it('asks both; when both continue, the round is re-dealt for two', async () => {
    const t = await startTable(server, { spectators: 1 });
    const [host] = t.pc;
    await leave(t, 2);

    const req = await t.sc[0].waitFor('continue_or_end_request');
    expect(req.payload).toEqual({
      remaining_player_ids: [t.players[0].id, t.players[1].id],
      decision_deadline: expect.any(String),
    });
    await host.waitFor('continue_or_end_request');

    // Reconnecting meanwhile: the snapshot, then the pending request (same deadline).
    t.pc[1].close();
    const back = reconnect(server.url, t.players[1]);
    expect((await back.waitFor('state_snapshot')).payload.game_state.phase).toBe('awaiting_continue_decision');
    expect((await back.waitFor('continue_or_end_request')).payload).toEqual(req.payload);

    // A spectator has no say.
    emit(t.sc[0], 'choose_continue_or_end', { choice: 'end' });
    expect((await t.sc[0].waitFor('session_error')).payload.code).toBe('SPECTATOR_ACTION_FORBIDDEN');

    emit(host, 'choose_continue_or_end', { player_id: t.players[0].id, choice: 'continue' });
    emit(back, 'choose_continue_or_end', { player_id: t.players[1].id, choice: 'continue' });
    const redeal = await t.sc[0].waitFor('round_started', () => true, { from: req.index });
    expect(redeal.payload).toMatchObject({ round_number: 1 });
    expect((await back.waitFor('hand_dealt')).payload.hand).toHaveLength(1);

    // The decision window passes without ending anything.
    await sleep(DECISION_MS + 200);
    expect(t.sc[0].events('game_over')).toHaveLength(0);
    expect((await db('games').where({ id: t.gameId }).first()).status).toBe('in_progress');
  });

  it('one answering end ends the game incomplete: game_over, results, room COMPLETING, then closed', async () => {
    const t = await startTable(server);
    const [host, p2] = t.pc;
    const ids = t.players.map((p) => p.id);
    await leave(t, 1);
    await host.waitFor('continue_or_end_request');
    emit(p2, 'choose_continue_or_end', { choice: 'end' });

    for (const c of [host, t.pc[2]]) {
      const over = await c.waitFor('game_over');
      expect(over.payload).toEqual({
        game_id: t.gameId,
        status: 'incomplete',
        final_scores: [
          { player_id: ids[0], score: 0 },
          { player_id: ids[2], score: 0 },
        ],
        winner_ids: [],
        closes_at: expect.any(String),
        countdown_seconds: 2,
      });
    }
    const game = await db('games').where({ id: t.gameId }).first();
    expect(game).toMatchObject({ status: 'incomplete', drop_reason: 'mutual_end', player_count_at_drop: 2 });
    expect(game.ended_at).not.toBeNull();
    expect(game.state).toMatchObject({ phase: 'incomplete', winnerUserIds: [] });
    const results = await db('game_results').where({ game_id: t.gameId });
    expect(results.map((r) => [r.user_id, r.outcome, r.drop_reason, r.final_score]).sort()).toEqual(
      [
        [ids[0], 'incomplete', 'mutual_end', 0],
        [ids[1], 'incomplete', 'player_quit', 0],
        [ids[2], 'incomplete', 'mutual_end', 0],
      ].sort(),
    );
    expect((await db('rooms').where({ id: t.roomId }).first()).state).toBe('completing');
    const logged = await db('game_events').where({ game_id: t.gameId, event: 'game_over' }).first();
    expect(logged).toMatchObject({ event_type: 'game_completed' });
    expect(logged.payload).toMatchObject({ status: 'incomplete', dropReason: 'mutual_end', winners: [] });

    // A reconnect during the countdown: snapshot, then game_over.
    t.pc[2].close();
    const back = reconnect(server.url, t.players[2]);
    expect((await back.waitFor('state_snapshot')).payload.game_state.phase).toBe('incomplete');
    expect((await back.waitFor('game_over')).payload.status).toBe('incomplete');

    expect((await host.waitFor('room_closed', () => true, { timeoutMs: COUNTDOWN_MS + 2000 })).payload).toEqual({
      room_id: t.roomId,
      reason: 'game_finished',
    });
    expect((await db('rooms').where({ id: t.roomId }).first()).state).toBe('closed');
  });

  it('no answer within the window counts as end', async () => {
    const t = await startTable(server);
    await leave(t, 0);
    const req = await t.pc[1].waitFor('continue_or_end_request');
    emit(t.pc[1], 'choose_continue_or_end', { choice: 'continue' });
    const over = await t.pc[1].waitFor('game_over', () => true, { timeoutMs: DECISION_MS + 2000 });
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(req.payload.decision_deadline) - 50);
    expect(over.payload).toMatchObject({ status: 'incomplete', winner_ids: [] });
    expect((await db('games').where({ id: t.gameId }).first()).drop_reason).toBe('mutual_end');
  });

  it('a second drop leaves one player: the game ends incomplete with that drop’s reason', async () => {
    const t = await startTable(server);
    await leave(t, 2);
    await t.pc[0].waitFor('continue_or_end_request');
    await leave(t, 1);
    const over = await t.pc[0].waitFor('game_over');
    expect(over.payload).toMatchObject({ status: 'incomplete', final_scores: [{ player_id: t.players[0].id, score: 0 }], winner_ids: [] });
    expect(await db('games').where({ id: t.gameId }).first()).toMatchObject({
      status: 'incomplete',
      drop_reason: 'player_quit',
      player_count_at_drop: 1,
    });
    expect(await db('game_results').where({ game_id: t.gameId })).toHaveLength(3);
  });
});

describe('the game time limit', () => {
  it('warns, then abandons the game: game_abandoned, recorded incomplete, nothing more is played', async () => {
    const limited = await startServer({ deckFactory, timeLimitMs: 1500, timeWarningLeadMs: 1000, countdownMs: COUNTDOWN_MS });
    try {
      const t = await startTable(limited, { spectators: 1 });
      const [host, p2] = t.pc;
      await p2.waitFor('bid_request');

      const warning = await t.sc[0].waitFor('game_time_warning', () => true, { timeoutMs: 3000 });
      expect(warning.payload).toEqual({ game_id: t.gameId, ends_at: expect.any(String), minutes_remaining: expect.any(Number) });
      const abandoned = await t.sc[0].waitFor('game_abandoned', () => true, { timeoutMs: 3000 });
      expect(abandoned.payload).toEqual({ reason: 'time_limit', game_id: t.gameId });
      expect(abandoned.seq).toBe(warning.seq + 1);
      await host.waitFor('game_abandoned');

      const game = await db('games').where({ id: t.gameId }).first();
      expect(game).toMatchObject({ status: 'incomplete', drop_reason: 'time_limit', player_count_at_drop: 3 });
      expect(game.state).toMatchObject({ phase: 'incomplete', currentRound: 1 });
      const results = await db('game_results').where({ game_id: t.gameId });
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.outcome === 'incomplete' && r.drop_reason === 'time_limit')).toBe(true);
      expect(await db('rounds').where({ game_id: t.gameId })).toHaveLength(0);
      expect((await db('rooms').where({ id: t.roomId }).first()).state).toBe('completing');

      emit(p2, 'place_bid', { bid: 0 });
      expect((await p2.waitFor('invalid_bid_error')).payload.code).toBe('INVALID_PHASE');

      p2.close();
      const back = reconnect(limited.url, t.players[1]);
      await back.waitFor('state_snapshot');
      expect((await back.waitFor('game_abandoned')).payload).toEqual({ reason: 'time_limit', game_id: t.gameId });
      await host.waitFor('room_closed', () => true, { timeoutMs: COUNTDOWN_MS + 2000 });
    } finally {
      await limited.close();
    }
  });
});

describe('after a server restart', () => {
  it('startup cleanup abandons games in progress; a client still in the game is told with game_abandoned', async () => {
    decks[1] = stacked([S('hearts', 5), S('spades', 9), S('diamonds', 2), S('clubs', 3)]);
    const t = await startTable(server);
    const ids = t.players.map((p) => p.id);
    await t.pc[1].waitFor('bid_request');
    // The process "restarts": the in-memory game is gone, the rows are not.
    server.games.stop();

    expect(await abandonInProgressGames()).toEqual([{ gameId: t.gameId, roomId: t.roomId, players: 3 }]);
    expect(await abandonInProgressGames()).toEqual([]);
    expect(await db('games').where({ id: t.gameId }).first()).toMatchObject({
      status: 'incomplete',
      drop_reason: 'server_restart',
      player_count_at_drop: 3,
    });
    const results = await db('game_results').where({ game_id: t.gameId });
    expect(results.map((r) => [r.user_id, r.outcome, r.drop_reason, r.rounds_played]).sort()).toEqual(
      ids.map((id) => [id, 'incomplete', 'server_restart', 0]).sort(),
    );
    const room = await db('rooms').where({ id: t.roomId }).first();
    expect(room.state).toBe('closed');
    expect(await db('room_members').where({ room_id: t.roomId }).whereNull('left_at')).toHaveLength(0);

    // A socket left showing the bid panel gets an answer, not silence.
    emit(t.pc[1], 'place_bid', { bid: 0 });
    expect((await t.pc[1].waitFor('game_abandoned')).payload).toEqual({ reason: 'server_restart', game_id: t.gameId });

    // A client reconnecting is put in the lobby, and join_game tells it what happened.
    t.pc[2].close();
    const back = reconnect(server.url, t.players[2]);
    await back.waitFor('lobby_snapshot');
    emit(back, 'join_game', { player_id: ids[2], display_name: 'P3', last_seq_seen: 4 });
    expect((await back.waitFor('game_abandoned')).payload).toEqual({ reason: 'server_restart', game_id: t.gameId });
    // And can play again.
    await api().post('/api/v1/rooms').set('Cookie', t.players[2].cookie).send({}).expect(201);
  });

  it('a game action from a socket with no game, and nothing abandoned, gets the action’s INVALID_PHASE error', async () => {
    const u = await createUser('Lonely');
    const c = await online(server.url, u);
    emit(c, 'place_bid', { bid: 0 });
    emit(c, 'play_card', { card: { type: 'wizard', suit: null, rank: null } });
    emit(c, 'select_trump', { suit: 'hearts' });
    expect((await c.waitFor('invalid_bid_error')).payload).toEqual({
      player_id: u.id,
      code: 'INVALID_PHASE',
      reason: expect.any(String),
      min_bid: 0,
      max_bid: 0,
      allowed_bids: [],
    });
    expect((await c.waitFor('invalid_play_error')).payload).toMatchObject({ code: 'INVALID_PHASE', legal_cards: [] });
    expect((await c.waitFor('invalid_trump_error')).payload).toMatchObject({ code: 'INVALID_PHASE' });
  });
});
