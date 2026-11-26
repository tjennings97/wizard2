import request from 'supertest';
import { db } from '../db/knex';
import { hashSecret } from '../auth/credentials';
import { connect, connectReady, cookieFor, createUser, resetDb, sleep, startServer, type TestClient, type TestUser } from '../test/helpers';

let server: Awaited<ReturnType<typeof startServer>>;
let clients: TestClient[] = [];

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
  await db.destroy();
});
beforeEach(async () => {
  server.rooms.stop();
  server.games.stop();
  await resetDb();
});
afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
});

async function online(user: TestUser): Promise<TestClient> {
  const c = await connectReady(server.url, user.cookie);
  clients.push(c);
  return c;
}

const api = () => request(server.app);

async function openRoom(host: TestUser): Promise<string> {
  const res = await api().post('/api/v1/rooms').set('Cookie', host.cookie).expect(201);
  return res.body.id;
}

const join = (user: TestUser, roomId: string, role: 'player' | 'spectator' = 'player') =>
  api().post(`/api/v1/rooms/${roomId}/join`).set('Cookie', user.cookie).send({ role }).expect(200);
const leave = (user: TestUser, roomId: string) =>
  api().post(`/api/v1/rooms/${roomId}/leave`).set('Cookie', user.cookie).expect(204);

const ids = (users: { userId: string }[]) => users.map((u) => u.userId).sort();

describe('connection authentication', () => {
  async function expectRejected(cookie: string | undefined, code: string) {
    const c = connect(server.url, cookie);
    clients.push(c);
    const err = await c.waitFor('session_error');
    expect(err.payload).toEqual({ code, message: expect.any(String), fatal: true });
    await c.waitForDisconnect();
    expect(c.socket.connected).toBe(false);
    expect(c.events('lobby_snapshot')).toHaveLength(0);
  }

  it('rejects a handshake without a session cookie', async () => {
    await expectRejected(undefined, 'UNAUTHORIZED');
  });

  it('rejects a cookie with a bad signature', async () => {
    const user = await createUser('Ann');
    await expectRejected(user.cookie.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')), 'UNAUTHORIZED');
    await expectRejected(cookieFor('made-up-token'), 'UNAUTHORIZED');
  });

  it('rejects a session displaced by a newer login with SESSION_INVALIDATED', async () => {
    const user = await createUser('Ann');
    await db('sessions').where({ user_id: user.id }).update({ invalidated_at: db.fn.now() });
    await expectRejected(user.cookie, 'SESSION_INVALIDATED');
  });

  it('says why an already-ended session ended', async () => {
    const user = await createUser('Ann');
    await db('sessions').where({ user_id: user.id }).update({ invalidated_at: db.fn.now(), invalidated_reason: 'credential_change' });
    const c = connect(server.url, user.cookie);
    clients.push(c);
    const err = await c.waitFor('session_error');
    expect(err.payload).toEqual({ code: 'SESSION_INVALIDATED', message: expect.any(String), fatal: true, reason: 'credential_change' });
  });

  it('rejects an expired session with UNAUTHORIZED', async () => {
    const user = await createUser('Ann');
    await db('sessions').where({ user_id: user.id }).update({ expires_at: new Date(Date.now() - 1000) });
    await expectRejected(user.cookie, 'UNAUTHORIZED');
  });

  it('rejects a session in the re-auth window with REAUTH_REQUIRED', async () => {
    const user = await createUser('Ann', { inReauthWindow: true });
    await expectRejected(user.cookie, 'REAUTH_REQUIRED');
  });

  it('allows a connect in the re-auth window for a player in a game in progress', async () => {
    const user = await createUser('Ann', { inReauthWindow: true });
    const [room] = await db('rooms').insert({ host_user_id: user.id, state: 'in_progress' }).returning('id');
    await db('room_members').insert({ room_id: room.id, user_id: user.id, role: 'player', join_order: 1 });
    await db('games').insert({ room_id: room.id, status: 'in_progress' });

    const c = connect(server.url, user.cookie);
    clients.push(c);
    await new Promise<void>((resolve) => c.socket.once('connect', () => resolve()));
    // A started game sends nothing on connect until the engine is wired; give a rejection time to arrive.
    await sleep(300);
    expect(c.events('session_error')).toHaveLength(0);
    expect(c.socket.connected).toBe(true);
    const [sid] = [...(server.io.sockets.adapter.rooms.get(`room:${room.id}`) ?? [])];
    expect(sid).toBeDefined();
  });

  it('rejects a user who must change their credentials', async () => {
    const user = await createUser('Ann');
    await db('users').where({ id: user.id }).update({ requires_credential_change: true });
    await expectRejected(user.cookie, 'CREDENTIAL_CHANGE_REQUIRED');
  });
});

describe('displaced sockets', () => {
  const PASSWORD = 'correct horse battery';
  const PASSPHRASE = 'purple monkey dishwasher';

  /** Gives the user real credentials so the auth routes can be called; returns the username. */
  async function withCredentials(user: TestUser): Promise<string> {
    const [passwordHash, recoveryHash] = await Promise.all([hashSecret(PASSWORD), hashSecret(PASSPHRASE)]);
    const [{ username }] = await db('users')
      .where({ id: user.id })
      .update({ password_hash: passwordHash, recovery_hash: recoveryHash })
      .returning('username');
    return username;
  }

  async function expectDisplaced(c: TestClient, reason: 'displaced' | 'logout' | 'password_reset' | 'credential_change') {
    const err = await c.waitFor('session_error');
    expect(err.payload).toEqual({ code: 'SESSION_INVALIDATED', message: expect.any(String), fatal: true, reason });
    await c.waitForDisconnect();
    expect(c.socket.connected).toBe(false);
  }

  it('disconnects every socket on a session with SESSION_INVALIDATED after a second login', async () => {
    const ann = await createUser('Ann');
    const bob = await createUser('Bob');
    const username = await withCredentials(ann);
    const tab1 = await online(ann);
    const tab2 = await online(ann);
    const other = await online(bob);

    const login = await api().post('/api/v1/auth/login').send({ username, password: PASSWORD }).expect(200);
    await expectDisplaced(tab1, 'displaced');
    await expectDisplaced(tab2, 'displaced');

    // The new session connects normally; another user's socket is untouched.
    const newCookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const fresh = await online({ ...ann, cookie: newCookie });
    await sleep(100);
    expect(fresh.socket.connected).toBe(true);
    expect(other.socket.connected).toBe(true);
    expect(other.events('session_error')).toHaveLength(0);
  });

  it('disconnects the session\'s sockets on logout', async () => {
    const ann = await createUser('Ann');
    const c = await online(ann);
    await api().post('/api/v1/auth/logout').set('Cookie', ann.cookie).expect(204);
    await expectDisplaced(c, 'logout');
  });

  it('disconnects the user\'s sockets on a password reset', async () => {
    const ann = await createUser('Ann');
    const username = await withCredentials(ann);
    const c = await online(ann);
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ username, recoveryPassphrase: PASSPHRASE, newPassword: 'a brand new password' })
      .expect(204);
    await expectDisplaced(c, 'password_reset');
  });

  it('disconnects the old session\'s sockets on a password change; the new session connects', async () => {
    const ann = await createUser('Ann');
    await withCredentials(ann);
    const c = await online(ann);
    const res = await api()
      .patch('/api/v1/users/me')
      .set('Cookie', ann.cookie)
      .send({ currentPassword: PASSWORD, password: 'a brand new password' })
      .expect(200);
    await expectDisplaced(c, 'credential_change');

    const newCookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const fresh = await online({ ...ann, cookie: newCookie });
    await sleep(100);
    expect(fresh.socket.connected).toBe(true);
    expect(fresh.events('session_error')).toHaveLength(0);
  });

  it('keeps sockets on a display name change and shows the new name in lobby presence', async () => {
    const ann = await createUser('Ann');
    const bob = await createUser('Bob');
    const c = await online(ann);
    const watcher = await online(bob);
    const from = watcher.length;
    await api().patch('/api/v1/users/me').set('Cookie', ann.cookie).send({ displayName: 'Annie' }).expect(200);
    const update = await watcher.waitFor(
      'presence_updated',
      (p) => p.online_users.some((u: { userId: string; displayName: string }) => u.userId === ann.id && u.displayName === 'Annie'),
      { from },
    );
    expect(update).toBeDefined();
    expect(c.socket.connected).toBe(true);
    expect(c.events('session_error')).toHaveLength(0);
  });

  it('re-sends room_snapshot with the new name to an open room', async () => {
    const ann = await createUser('Ann');
    const bob = await createUser('Bob');
    await online(ann);
    const bobSocket = await online(bob);
    const roomId = await openRoom(ann);
    await join(bob, roomId);
    await bobSocket.waitFor('room_snapshot');
    const from = bobSocket.length;
    await api().patch('/api/v1/users/me').set('Cookie', ann.cookie).send({ displayName: 'Annie' }).expect(200);
    const snap = await bobSocket.waitFor('room_snapshot', undefined, { from });
    const annMember = snap.payload.members.find((m: { userId: string }) => m.userId === ann.id);
    expect(annMember.displayName).toBe('Annie');
  });

  it('removes a displaced user from lobby presence', async () => {
    const ann = await createUser('Ann');
    const bob = await createUser('Bob');
    await online(ann);
    const watcher = await online(bob);
    const from = watcher.length;
    await api().post('/api/v1/auth/logout').set('Cookie', ann.cookie).expect(204);
    const update = await watcher.waitFor('presence_updated', (p) => !p.online_users.some((u: { userId: string }) => u.userId === ann.id), { from });
    expect(ids(update.payload.online_users)).toEqual([bob.id]);
  });
});

describe('transports', () => {
  // Browsers start on HTTP long-polling. Express must never also answer /socket.io/ requests,
  // or the response is written twice and the process crashes (ERR_HTTP_HEADERS_SENT).
  it('serves a client that starts on long-polling, like a browser', async () => {
    const ann = await createUser('Ann');
    const c = connect(server.url, ann.cookie, { polling: true });
    clients.push(c);
    await c.waitFor('lobby_snapshot');
    await api().post('/api/v1/rooms').set('Cookie', ann.cookie).expect(201);
    await c.waitFor('room_snapshot');
    c.close();
    await sleep(100);
    await request(server.url).get('/api/v1/health').expect(200);
  });

  it('leaves a pending long-poll to Socket.io (Express must not answer it)', async () => {
    const base = `${server.url}/socket.io/?EIO=4&transport=polling`;
    const handshake = await fetch(base);
    expect(handshake.status).toBe(200);
    const { sid } = JSON.parse((await handshake.text()).slice(1));

    // Nothing is queued for this session, so engine.io holds the poll open until its next ping.
    const controller = new AbortController();
    const poll = fetch(`${base}&sid=${sid}`, { signal: controller.signal }).then((r) => r.status, () => 'pending');
    const outcome = await Promise.race([poll, sleep(500).then(() => 'pending')]);
    controller.abort();
    expect(outcome).toBe('pending');
    expect(server.httpServer.listeners('request')).toHaveLength(1);
  });

  it('rejects a long-polling client without a session the same way', async () => {
    const c = connect(server.url, undefined, { polling: true });
    clients.push(c);
    expect((await c.waitFor('session_error')).payload).toMatchObject({ code: 'UNAUTHORIZED', fatal: true });
    await c.waitForDisconnect();
    await sleep(100);
    await request(server.url).get('/api/v1/health').expect(200);
  });
});

describe('lobby', () => {
  it('sends lobby_snapshot on connect and presence_updated to the rest of the lobby', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomHost = await createUser('Host');
    const roomId = await openRoom(roomHost);

    const a = await online(ann);
    const snap = a.events('lobby_snapshot')[0];
    expect(snap.seq).toBe(1);
    expect(snap.payload.rooms).toEqual([expect.objectContaining({ id: roomId, playerCount: 1, state: 'open' })]);
    expect(ids(snap.payload.online_users)).toEqual([ann.id]);
    expect(snap.payload.online_users[0]).toEqual({ userId: ann.id, displayName: 'Ann', avatarConfig: null });

    const b = await online(bob);
    expect(ids(b.events('lobby_snapshot')[0].payload.online_users)).toEqual(ids([{ userId: ann.id }, { userId: bob.id }]));
    await a.waitFor('presence_updated', (p) => p.online_users.length === 2);

    const presence = await api().get('/api/v1/lobby/presence').set('Cookie', ann.cookie).expect(200);
    expect(ids(presence.body)).toEqual(ids([{ userId: ann.id }, { userId: bob.id }]));

    // Leaving the lobby by disconnecting updates presence too.
    b.close();
    await a.waitFor('presence_updated', (p) => p.online_users.length === 1);
  });

  it('keeps a user present while another of their tabs is still connected', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const a = await online(ann);
    const b1 = await online(bob);
    const b2 = await online(bob);
    expect(a.events('presence_updated').at(-1)!.payload.online_users).toHaveLength(2);

    b1.close();
    await sleep(150);
    expect(a.events('presence_updated').at(-1)!.payload.online_users).toHaveLength(2);
    b2.close();
    await a.waitFor('presence_updated', (p) => p.online_users.length === 1);
  });
});

describe('room membership events', () => {
  it('moves the creator into the room and tells the lobby', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const a = await online(ann);
    const b = await online(bob);
    const mark = b.length;

    const roomId = await openRoom(ann);

    const snap = await a.waitFor('room_snapshot');
    expect(snap.payload).toEqual({
      room_id: roomId,
      host_id: ann.id,
      config: { roundCount: 60, bidRule: 'open', deckType: 'standard' },
      members: [expect.objectContaining({ userId: ann.id, role: 'player', joinOrder: 1, isHost: true, connected: true })],
    });
    const joined = await a.waitFor('user_joined');
    expect(joined.payload).toEqual({
      user_id: ann.id,
      display_name: 'Ann',
      role: 'player',
      seat_index: 0,
      player_count: 1,
      spectator_count: 0,
    });

    const rooms = await b.waitFor('rooms_updated', () => true, { from: mark });
    expect(rooms.payload.rooms).toEqual([expect.objectContaining({ id: roomId, playerCount: 1 })]);
    const presence = await b.waitFor('presence_updated', () => true, { from: mark });
    expect(ids(presence.payload.online_users)).toEqual([bob.id]);

    // Ann's socket left the lobby, so later lobby broadcasts skip her.
    const before = a.events('rooms_updated').length;
    await openRoom(await createUser('Cat'));
    await b.waitFor('rooms_updated', (p) => p.rooms.length === 2);
    expect(a.events('rooms_updated')).toHaveLength(before);
  });

  it('broadcasts user_joined, clamps round count, and stamps increasing seq', async () => {
    const [ann, bob, cat] = await Promise.all([createUser('Ann'), createUser('Bob'), createUser('Cat')]);
    const a = await online(ann);
    const roomId = await openRoom(ann);
    await a.waitFor('room_snapshot');
    const b = await online(bob);
    await online(cat);
    const markA = a.length;

    await join(bob, roomId);
    const bSnap = await b.waitFor('room_snapshot');
    expect(ids(bSnap.payload.members)).toEqual(ids([{ userId: ann.id }, { userId: bob.id }]));

    const joined = await a.waitFor('user_joined', (p) => p.user_id === bob.id);
    expect(joined.payload).toMatchObject({ role: 'player', seat_index: 1, player_count: 2, spectator_count: 0 });
    const cfg = await a.waitFor('room_config_updated', () => true, { from: markA });
    expect(cfg.payload).toEqual({ room_id: roomId, config: { roundCount: 30, bidRule: 'open', deckType: 'standard' } });
    expect(cfg.index).toBeGreaterThan(joined.index);

    await join(cat, roomId, 'spectator');
    const spec = await a.waitFor('user_joined', (p) => p.user_id === cat.id);
    expect(spec.payload).toMatchObject({ role: 'spectator', seat_index: null, player_count: 2, spectator_count: 1 });
    // A spectator does not change the maximum.
    expect(a.events('room_config_updated')).toHaveLength(1);

    const seqs = a.log.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('broadcasts room_config_updated to the room and rooms_updated to the lobby', async () => {
    const [ann, bob, cat] = await Promise.all([createUser('Ann'), createUser('Bob'), createUser('Cat')]);
    const roomId = await openRoom(ann);
    await join(bob, roomId);
    const b = await online(bob);
    const c = await online(cat);
    const markB = b.length;
    const markC = c.length;

    await api().patch(`/api/v1/rooms/${roomId}/config`).set('Cookie', ann.cookie).send({ roundCount: 4, bidRule: 'uneven' }).expect(200);

    const cfg = await b.waitFor('room_config_updated', () => true, { from: markB });
    expect(cfg.payload.config).toEqual({ roundCount: 4, bidRule: 'uneven', deckType: 'standard' });
    const lobby = await c.waitFor('rooms_updated', () => true, { from: markC });
    expect(lobby.payload.rooms[0].config).toEqual({ roundCount: 4, bidRule: 'uneven', deckType: 'standard' });
  });

  it('on host leave: user_left, then host_changed, then rooms_updated; the leaver returns to the lobby', async () => {
    const [ann, spec, bob, cat, dan] = await Promise.all(['Ann', 'Spec', 'Bob', 'Cat', 'Dan'].map((n) => createUser(n)));
    const roomId = await openRoom(ann);
    await join(spec, roomId, 'spectator');
    await join(bob, roomId);
    await join(cat, roomId);
    const a = await online(ann);
    const b = await online(bob);
    const s = await online(spec);
    const lobby = await online(dan);
    const markB = b.length;
    const markLobby = lobby.length;

    await leave(ann, roomId);

    const left = await b.waitFor('user_left', () => true, { from: markB });
    expect(left.payload).toEqual({ user_id: ann.id, role: 'player', reason: 'voluntary', player_count: 2, spectator_count: 1 });
    const host = await b.waitFor('host_changed', () => true, { from: markB });
    expect(host.payload).toEqual({ room_id: roomId, host_id: bob.id });
    expect(host.index).toBeGreaterThan(left.index);
    await s.waitFor('host_changed', (p) => p.host_id === bob.id);

    const rooms = await lobby.waitFor('rooms_updated', () => true, { from: markLobby });
    expect(rooms.payload.rooms).toEqual([expect.objectContaining({ id: roomId, hostUserId: bob.id, playerCount: 2 })]);

    const back = await a.waitFor('lobby_snapshot', () => true, { from: 1 });
    expect(back.payload.rooms).toEqual([expect.objectContaining({ id: roomId })]);
    const presence = await lobby.waitFor('presence_updated', (p) => p.online_users.length === 2, { from: markLobby });
    expect(ids(presence.payload.online_users)).toEqual(ids([{ userId: ann.id }, { userId: dan.id }]));
  });

  it('closes the room with reason "empty" when the last player leaves, returning spectators', async () => {
    const [ann, spec] = await Promise.all([createUser('Ann'), createUser('Spec')]);
    const roomId = await openRoom(ann);
    await join(spec, roomId, 'spectator');
    const s = await online(spec);
    const mark = s.length;

    await leave(ann, roomId);

    const left = await s.waitFor('user_left', () => true, { from: mark });
    expect(left.payload).toMatchObject({ user_id: ann.id, player_count: 0, spectator_count: 0 });
    const closed = await s.waitFor('room_closed', () => true, { from: mark });
    expect(closed.payload).toEqual({ room_id: roomId, reason: 'empty' });
    const back = await s.waitFor('lobby_snapshot', () => true, { from: mark });
    expect(back.payload.rooms).toEqual([]);
    expect(left.index).toBeLessThan(closed.index);
    expect(closed.index).toBeLessThan(back.index);
    expect(s.events('host_changed')).toHaveLength(0);
  });

  it('closes the room with reason "host_closed" on DELETE and returns everyone to the lobby', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await openRoom(ann);
    await join(bob, roomId);
    const a = await online(ann);
    const b = await online(bob);

    await api().delete(`/api/v1/rooms/${roomId}`).set('Cookie', ann.cookie).expect(204);

    for (const c of [a, b]) {
      const closed = await c.waitFor('room_closed');
      expect(closed.payload).toEqual({ room_id: roomId, reason: 'host_closed' });
      await c.waitFor('lobby_snapshot', () => true, { from: closed.index });
    }
  });

  it('sends room_snapshot again when a member reconnects to an open room', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await openRoom(ann);
    await join(bob, roomId);

    const first = await online(bob);
    expect(first.events('room_snapshot')).toHaveLength(1);
    expect(first.events('lobby_snapshot')).toHaveLength(0);
    first.close();

    const again = await online(bob);
    const snap = again.events('room_snapshot')[0];
    expect(snap.payload.room_id).toBe(roomId);
    expect(snap.payload.members.find((m: { userId: string }) => m.userId === bob.id).connected).toBe(true);
    expect(again.events('lobby_snapshot')).toHaveLength(0);
  });

  it('moves every tab of a user together', async () => {
    const ann = await createUser('Ann');
    const t1 = await online(ann);
    const t2 = await online(ann);
    await openRoom(ann);
    await t1.waitFor('room_snapshot');
    await t2.waitFor('room_snapshot');
  });
});

describe('room inactivity timeout', () => {
  let fast: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    fast = await startServer({ timeoutMs: 300 });
  });
  afterAll(async () => {
    await fast.close();
  });

  it('broadcasts room_closed with reason "inactivity" and returns members to the lobby', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const a = connect(fast.url, ann.cookie);
    const b = connect(fast.url, bob.cookie);
    clients.push(a, b);
    await a.waitFor('lobby_snapshot');
    await b.waitFor('lobby_snapshot');

    const res = await request(fast.app).post('/api/v1/rooms').set('Cookie', ann.cookie).expect(201);
    const closed = await a.waitFor('room_closed', () => true, { timeoutMs: 2000 });
    expect(closed.payload).toEqual({ room_id: res.body.id, reason: 'inactivity' });
    await a.waitFor('lobby_snapshot', () => true, { from: closed.index });
    await b.waitFor('rooms_updated', (p) => p.rooms.length === 0);
  });
});

describe('host disconnects from an open room', () => {
  const AWAY_MS = 300;
  let fast: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    fast = await startServer({ hostAwayMs: AWAY_MS });
  });
  afterAll(async () => {
    await fast.close();
  });
  beforeEach(() => fast.rooms.stop());

  const fastApi = () => request(fast.app);
  /** The client has its snapshot slightly before the server finishes placing the socket. */
  async function awayTimerCleared(userId: string): Promise<boolean> {
    for (let i = 0; i < 50 && fast.rooms.hasAwayTimer(userId); i++) await sleep(10);
    return !fast.rooms.hasAwayTimer(userId);
  }
  async function room(host: TestUser, ...players: TestUser[]): Promise<string> {
    const res = await fastApi().post('/api/v1/rooms').set('Cookie', host.cookie).expect(201);
    for (const p of players) {
      await fastApi().post(`/api/v1/rooms/${res.body.id}/join`).set('Cookie', p.cookie).send({ role: 'player' }).expect(200);
    }
    return res.body.id;
  }
  async function on(user: TestUser): Promise<TestClient> {
    const c = await connectReady(fast.url, user.cookie);
    clients.push(c);
    return c;
  }
  const hostOf = async (roomId: string) => (await db('rooms').where({ id: roomId }).first()).host_user_id;

  it('passes the host role to the next connected player after the grace period; the old host stays', async () => {
    const [ann, bob, cat, spec] = await Promise.all(['Ann', 'Bob', 'Cat', 'Spec'].map((n) => createUser(n)));
    const roomId = await room(ann, bob, cat);
    await fastApi().post(`/api/v1/rooms/${roomId}/join`).set('Cookie', spec.cookie).send({ role: 'spectator' }).expect(200);
    const a = await on(ann);
    // Bob (next in join order) is offline, so Cat is next in line among connected players.
    const c = await on(cat);
    await on(spec);

    a.close();
    const changed = await c.waitFor('host_changed', () => true, { timeoutMs: 3000 });
    expect(changed.payload).toEqual({ room_id: roomId, host_id: cat.id });
    expect(await hostOf(roomId)).toBe(cat.id);
    expect(ids(await db('room_members').where({ room_id: roomId }).whereNull('left_at').select('user_id as userId'))).toEqual(
      ids([{ userId: ann.id }, { userId: bob.id }, { userId: cat.id }, { userId: spec.id }]),
    );

    // Ann comes back as a regular player.
    const back = await on(ann);
    const snap = back.events('room_snapshot').at(-1)!;
    expect(snap.payload.host_id).toBe(cat.id);
  });

  it('keeps the host if they reconnect within the grace period', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    const a = await on(ann);
    const b = await on(bob);
    a.close();
    await sleep(AWAY_MS / 3);
    await on(ann);
    await sleep(AWAY_MS * 2);
    expect(b.events('host_changed')).toHaveLength(0);
    expect(await hostOf(roomId)).toBe(ann.id);
    expect(await awayTimerCleared(ann.id)).toBe(true);
  });

  it('keeps the host while another of their tabs is still connected', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    const tab1 = await on(ann);
    await on(ann);
    const b = await on(bob);
    tab1.close();
    await sleep(AWAY_MS * 2);
    expect(b.events('host_changed')).toHaveLength(0);
    expect(await hostOf(roomId)).toBe(ann.id);
  });

  it('changes nothing when no other player is connected', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    const a = await on(ann);
    a.close();
    await sleep(AWAY_MS * 2);
    expect(await hostOf(roomId)).toBe(ann.id);
  });

  it('does not touch a non-host who disconnects', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    const a = await on(ann);
    const b = await on(bob);
    b.close();
    await sleep(AWAY_MS * 2);
    expect(a.events('host_changed')).toHaveLength(0);
    expect(await hostOf(roomId)).toBe(ann.id);
  });

  it('when the host leaves, passes the role to the next connected player, skipping a disconnected one', async () => {
    const [ann, bob, cat] = await Promise.all(['Ann', 'Bob', 'Cat'].map((n) => createUser(n)));
    const roomId = await room(ann, bob, cat);
    await on(ann);
    const c = await on(cat);
    await fastApi().post(`/api/v1/rooms/${roomId}/leave`).set('Cookie', ann.cookie).expect(204);
    const changed = await c.waitFor('host_changed');
    expect(changed.payload).toEqual({ room_id: roomId, host_id: cat.id });
    expect(await awayTimerCleared(cat.id)).toBe(true);
  });

  it('when the host leaves and nobody is connected, the first player becomes host with the grace period running', async () => {
    const [ann, bob, cat] = await Promise.all(['Ann', 'Bob', 'Cat'].map((n) => createUser(n)));
    const roomId = await room(ann, bob, cat);
    await fastApi().post(`/api/v1/rooms/${roomId}/leave`).set('Cookie', ann.cookie).expect(204);
    expect(await hostOf(roomId)).toBe(bob.id);
    expect(fast.rooms.hasAwayTimer(bob.id)).toBe(true);
    // Cat comes online; Bob never does, so the role moves on to Cat.
    const c = await on(cat);
    const changed = await c.waitFor('host_changed', () => true, { timeoutMs: 3000 });
    expect(changed.payload).toEqual({ room_id: roomId, host_id: cat.id });
  });

  it('starts the grace period for a host who created the room with no socket open', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    expect(fast.rooms.hasAwayTimer(ann.id)).toBe(true);
    const b = await on(bob);
    const changed = await b.waitFor('host_changed', () => true, { timeoutMs: 3000 });
    expect(changed.payload).toEqual({ room_id: roomId, host_id: bob.id });
  });

  it('after a restart, passes the role on from a host who never reconnects', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    fast.rooms.stop(); // the restart loses every in-memory timer
    expect(fast.rooms.hasAwayTimer(ann.id)).toBe(false);
    await fast.rooms.restoreTimeouts();
    expect(fast.rooms.hasAwayTimer(ann.id)).toBe(true);
    const b = await on(bob);
    const changed = await b.waitFor('host_changed', () => true, { timeoutMs: 3000 });
    expect(changed.payload).toEqual({ room_id: roomId, host_id: bob.id });
  });

  it('after a restart, keeps the host who reconnects', async () => {
    const [ann, bob] = await Promise.all([createUser('Ann'), createUser('Bob')]);
    const roomId = await room(ann, bob);
    fast.rooms.stop();
    await fast.rooms.restoreTimeouts();
    await on(ann);
    expect(await awayTimerCleared(ann.id)).toBe(true);
    const b = await on(bob);
    await sleep(AWAY_MS * 2);
    expect(b.events('host_changed')).toHaveLength(0);
    expect(await hostOf(roomId)).toBe(ann.id);
  });
});

describe('connect racing a room change in another tab', () => {
  it('ends in the room when the user creates one while a tab is connecting', async () => {
    for (let i = 0; i < 10; i++) {
      await resetDb();
      const ann = await createUser('Ann');
      const tab = connect(server.url, ann.cookie);
      clients.push(tab);
      const res = await api().post('/api/v1/rooms').set('Cookie', ann.cookie).expect(201);
      await tab.waitFor('room_snapshot', (p) => p.room_id === res.body.id);
      await sleep(100);
      const snapshots = tab.log.filter((e) => e.event === 'room_snapshot' || e.event === 'lobby_snapshot');
      expect(snapshots.at(-1)!.event).toBe('room_snapshot');
      const serverSocket = [...server.io.sockets.sockets.values()].find((s) => s.data.userId === ann.id)!;
      expect(serverSocket.data.roomId).toBe(res.body.id);
      expect(serverSocket.rooms.has(`room:${res.body.id}`)).toBe(true);
      tab.close();
    }
  });

  it('ends in the lobby when the user leaves their room while a tab is connecting', async () => {
    for (let i = 0; i < 10; i++) {
      await resetDb();
      const ann = await createUser('Ann');
      const roomId = await openRoom(ann);
      const tab = connect(server.url, ann.cookie);
      clients.push(tab);
      await leave(ann, roomId);
      await tab.waitFor('lobby_snapshot');
      await sleep(100);
      const snapshots = tab.log.filter((e) => e.event === 'room_snapshot' || e.event === 'lobby_snapshot');
      expect(snapshots.at(-1)!.event).toBe('lobby_snapshot');
      const serverSocket = [...server.io.sockets.sockets.values()].find((s) => s.data.userId === ann.id)!;
      expect(serverSocket.data.roomId).toBeNull();
      expect(serverSocket.rooms.has('lobby')).toBe(true);
      tab.close();
    }
  });
});
