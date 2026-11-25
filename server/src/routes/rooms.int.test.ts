import request from 'supertest';
import { randomUUID } from 'crypto';
import { db } from '../db/knex';
import { createUser, resetDb, sleep, startServer, type TestUser } from '../test/helpers';

let server: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server.close();
  await db.destroy();
});
beforeEach(async () => {
  server.rooms.stop();
  await resetDb();
});

const api = () => request(server.app);

async function openRoom(host: TestUser, body?: object) {
  const res = await api().post('/api/v1/rooms').set('Cookie', host.cookie).send(body ?? {});
  expect(res.status).toBe(201);
  return res.body as { id: string; config: { roundCount: number; bidRule: string }; hostUserId: string };
}

async function join(user: TestUser, roomId: string, role: 'player' | 'spectator' = 'player') {
  return api().post(`/api/v1/rooms/${roomId}/join`).set('Cookie', user.cookie).send({ role });
}

async function users(n: number, prefix = 'P'): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => createUser(`${prefix}${i + 1}`)));
}

async function setRoomState(roomId: string, state: string) {
  await db('rooms').where({ id: roomId }).update({ state });
}

describe('authentication', () => {
  it.each([
    ['get', '/api/v1/lobby/rooms'],
    ['get', '/api/v1/lobby/presence'],
    ['post', '/api/v1/rooms'],
    ['get', `/api/v1/rooms/${randomUUID()}`],
    ['delete', `/api/v1/rooms/${randomUUID()}`],
    ['patch', `/api/v1/rooms/${randomUUID()}/config`],
    ['post', `/api/v1/rooms/${randomUUID()}/join`],
    ['post', `/api/v1/rooms/${randomUUID()}/leave`],
    ['post', `/api/v1/rooms/${randomUUID()}/start`],
  ] as const)('%s %s returns 401 UNAUTHORIZED without a session', async (method, path) => {
    const res = await api()[method](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('POST /rooms, /join and /start return 401 REAUTH_REQUIRED in the re-auth window', async () => {
    const host = await createUser('Host');
    const room = await openRoom(host);
    const late = await createUser('Late', { inReauthWindow: true });

    // The host's session enters the window after the room exists.
    const lateHost = await createUser('LateHost', { inReauthWindow: true });
    const [{ id: lateRoomId }] = await db('rooms').insert({ host_user_id: lateHost.id }).returning('id');
    await db('room_members').insert({ room_id: lateRoomId, user_id: lateHost.id, role: 'player', join_order: 1 });
    const start = await api().post(`/api/v1/rooms/${lateRoomId}/start`).set('Cookie', lateHost.cookie);
    expect(start.status).toBe(401);
    expect(start.body.code).toBe('REAUTH_REQUIRED');

    const create = await api().post('/api/v1/rooms').set('Cookie', late.cookie).send({});
    expect(create.status).toBe(401);
    expect(create.body.code).toBe('REAUTH_REQUIRED');

    const joined = await join(late, room.id);
    expect(joined.status).toBe(401);
    expect(joined.body.code).toBe('REAUTH_REQUIRED');
  });
});

describe('POST /rooms', () => {
  it('creates an open room with the creator as host and default config', async () => {
    const host = await createUser('Host');
    const res = await api().post('/api/v1/rooms').set('Cookie', host.cookie);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      state: 'open',
      hostUserId: host.id,
      config: { roundCount: 60, bidRule: 'open', deckType: 'standard' },
      closedAt: null,
      members: [
        { userId: host.id, displayName: 'Host', role: 'player', joinOrder: 1, isHost: true, connected: false },
      ],
    });

    const lobby = await api().get('/api/v1/lobby/rooms').set('Cookie', host.cookie);
    expect(lobby.status).toBe(200);
    expect(lobby.body).toEqual([
      expect.objectContaining({
        id: res.body.id,
        state: 'open',
        hostUserId: host.id,
        playerCount: 1,
        spectatorCount: 0,
        maxPlayers: 10,
        maxSpectators: 5,
        config: { roundCount: 60, bidRule: 'open', deckType: 'standard' },
      }),
    ]);
  });

  it('accepts an initial config', async () => {
    const host = await createUser('Host');
    const room = await openRoom(host, { config: { roundCount: 7, bidRule: 'uneven' } });
    expect(room.config).toEqual({ roundCount: 7, bidRule: 'uneven', deckType: 'standard' });
  });

  it('rejects an invalid config', async () => {
    const host = await createUser('Host');
    const tooMany = await api().post('/api/v1/rooms').set('Cookie', host.cookie).send({ config: { roundCount: 61 } });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('ROUND_COUNT_EXCEEDS_MAX');

    const bad = await api()
      .post('/api/v1/rooms')
      .set('Cookie', host.cookie)
      .send({ config: { roundCount: 0, bidRule: 'sometimes', deckType: 'camelot' } });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(bad.body.details.fields).sort()).toEqual(['bidRule', 'deckType', 'roundCount']);
  });

  it('returns 409 ALREADY_IN_ROOM for a user already in a room', async () => {
    const host = await createUser('Host');
    await openRoom(host);
    const again = await api().post('/api/v1/rooms').set('Cookie', host.cookie);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_IN_ROOM');

    const [p] = await users(1);
    const other = await openRoom(p);
    const joinOther = await join(host, other.id, 'spectator');
    expect(joinOther.status).toBe(409);
    expect(joinOther.body.code).toBe('ALREADY_IN_ROOM');
  });

  it('allows only one room when the same user creates two concurrently', async () => {
    const host = await createUser('Host');
    const results = await Promise.all([1, 2].map(() => api().post('/api/v1/rooms').set('Cookie', host.cookie)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('GET /rooms/{roomId}', () => {
  it('returns the room, and 404 for an unknown or malformed id', async () => {
    const host = await createUser('Host');
    const room = await openRoom(host);
    const res = await api().get(`/api/v1/rooms/${room.id}`).set('Cookie', host.cookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(room.id);

    for (const id of [randomUUID(), 'not-a-uuid']) {
      const missing = await api().get(`/api/v1/rooms/${id}`).set('Cookie', host.cookie);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('NOT_FOUND');
    }
  });
});

describe('POST /rooms/{roomId}/join', () => {
  it('joins as player or spectator with sequential join order', async () => {
    const [host, p2, s1] = await users(3);
    const room = await openRoom(host);

    const asPlayer = await join(p2, room.id);
    expect(asPlayer.status).toBe(200);
    const asSpectator = await join(s1, room.id, 'spectator');
    expect(asSpectator.status).toBe(200);
    expect(asSpectator.body.members.map((m: { userId: string; role: string; joinOrder: number }) => [m.userId, m.role, m.joinOrder])).toEqual([
      [host.id, 'player', 1],
      [p2.id, 'player', 2],
      [s1.id, 'spectator', 3],
    ]);
  });

  it('validates the role and the room id', async () => {
    const [host, p2] = await users(2);
    const room = await openRoom(host);
    for (const body of [{}, { role: 'host' }]) {
      const res = await api().post(`/api/v1/rooms/${room.id}/join`).set('Cookie', p2.cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    const missing = await join(p2, randomUUID());
    expect(missing.status).toBe(404);
  });

  it('lowers the round count to the new maximum as players join', async () => {
    const [host, ...others] = await users(5);
    const room = await openRoom(host);
    expect(room.config.roundCount).toBe(60);

    const expected = [30, 20, 15, 12];
    for (const [i, p] of others.entries()) {
      const res = await join(p, room.id);
      expect(res.body.config.roundCount).toBe(expected[i]);
    }
    // Spectators do not count toward the maximum.
    const [spec] = await users(1, 'S');
    const res = await join(spec, room.id, 'spectator');
    expect(res.body.config.roundCount).toBe(12);
  });

  it('keeps a round count already under the new maximum', async () => {
    const [host, p2] = await users(2);
    const room = await openRoom(host, { config: { roundCount: 5 } });
    const res = await join(p2, room.id);
    expect(res.body.config.roundCount).toBe(5);
  });

  it('returns 409 ROOM_FULL at 10 players and at 5 spectators', async () => {
    const [host, ...players] = await users(11);
    const room = await openRoom(host);
    for (const p of players.slice(0, 9)) expect((await join(p, room.id)).status).toBe(200);
    const eleventh = await join(players[9], room.id);
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.code).toBe('ROOM_FULL');

    const spectators = await users(6, 'S');
    for (const s of spectators.slice(0, 5)) expect((await join(s, room.id, 'spectator')).status).toBe(200);
    const sixth = await join(spectators[5], room.id, 'spectator');
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('ROOM_FULL');
  });

  it('allows spectators but not players into a game in progress', async () => {
    const [host, p2, s1] = await users(3);
    const room = await openRoom(host);
    await setRoomState(room.id, 'in_progress');

    const asPlayer = await join(p2, room.id);
    expect(asPlayer.status).toBe(403);
    expect(asPlayer.body.code).toBe('ROOM_NOT_JOINABLE');
    expect((await join(s1, room.id, 'spectator')).status).toBe(200);
  });

  it.each(['completing', 'closed'])('returns 403 ROOM_NOT_JOINABLE for a %s room', async (state) => {
    const [host, p2] = await users(2);
    const room = await openRoom(host);
    await setRoomState(room.id, state);
    for (const role of ['player', 'spectator'] as const) {
      const res = await join(p2, room.id, role);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROOM_NOT_JOINABLE');
    }
  });

  it('lets a user who left rejoin in either role, reusing their row with a new join order', async () => {
    const [host, p2, p3] = await users(3);
    const room = await openRoom(host);
    await join(p2, room.id);
    await join(p3, room.id);
    await api().post(`/api/v1/rooms/${room.id}/leave`).set('Cookie', p2.cookie).expect(204);

    const rejoined = await join(p2, room.id, 'spectator');
    expect(rejoined.status).toBe(200);
    const rows = await db('room_members').where({ room_id: room.id, user_id: p2.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'spectator', join_order: 4, left_at: null });
  });
});

describe('POST /rooms/{roomId}/leave', () => {
  it('removes a member', async () => {
    const [host, p2] = await users(2);
    const room = await openRoom(host);
    await join(p2, room.id);
    await api().post(`/api/v1/rooms/${room.id}/leave`).set('Cookie', p2.cookie).expect(204);

    const res = await api().get(`/api/v1/rooms/${room.id}`).set('Cookie', host.cookie);
    expect(res.body.members.map((m: { userId: string }) => m.userId)).toEqual([host.id]);
  });

  it('returns 404 when the user is not in the room', async () => {
    const [host, p2] = await users(2);
    const room = await openRoom(host);
    const res = await api().post(`/api/v1/rooms/${room.id}/leave`).set('Cookie', p2.cookie);
    expect(res.status).toBe(404);
    expect((await api().post(`/api/v1/rooms/${randomUUID()}/leave`).set('Cookie', p2.cookie)).status).toBe(404);
  });

  it('promotes the remaining player with the lowest join order, never a spectator', async () => {
    const [host, spec, p3, p4] = await users(4);
    const room = await openRoom(host);
    await join(spec, room.id, 'spectator');
    await join(p3, room.id);
    await join(p4, room.id);

    await api().post(`/api/v1/rooms/${room.id}/leave`).set('Cookie', host.cookie).expect(204);
    const res = await api().get(`/api/v1/rooms/${room.id}`).set('Cookie', p3.cookie);
    expect(res.body.hostUserId).toBe(p3.id);
    expect(res.body.members.find((m: { userId: string }) => m.userId === p3.id).isHost).toBe(true);
  });

  it('closes the room when the last player leaves, returning spectators to the lobby', async () => {
    const [host, spec] = await users(2);
    const room = await openRoom(host);
    await join(spec, room.id, 'spectator');

    await api().post(`/api/v1/rooms/${room.id}/leave`).set('Cookie', host.cookie).expect(204);
    const row = await db('rooms').where({ id: room.id }).first();
    expect(row.state).toBe('closed');
    expect(row.closed_at).not.toBeNull();
    const specRow = await db('room_members').where({ room_id: room.id, user_id: spec.id }).first();
    expect(specRow.left_at).not.toBeNull();
    expect(server.rooms.hasTimeout(room.id)).toBe(false);

    const lobby = await api().get('/api/v1/lobby/rooms').set('Cookie', spec.cookie);
    expect(lobby.body).toEqual([]);
    // The spectator is free to open a room of their own.
    await openRoom(spec);
  });
});

describe('PATCH /rooms/{roomId}/config', () => {
  it('lets the host change roundCount and bidRule', async () => {
    const [host, p2, p3] = await users(3);
    const room = await openRoom(host);
    await join(p2, room.id);
    await join(p3, room.id);

    const res = await api()
      .patch(`/api/v1/rooms/${room.id}/config`)
      .set('Cookie', host.cookie)
      .send({ roundCount: 20, bidRule: 'uneven' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ roundCount: 20, bidRule: 'uneven', deckType: 'standard' });

    const bidOnly = await api().patch(`/api/v1/rooms/${room.id}/config`).set('Cookie', host.cookie).send({ bidRule: 'open' });
    expect(bidOnly.body).toEqual({ roundCount: 20, bidRule: 'open', deckType: 'standard' });
  });

  it('returns 400 ROUND_COUNT_EXCEEDS_MAX above floor(60 / players)', async () => {
    const [host, ...others] = await users(5);
    const room = await openRoom(host);
    for (const p of others) await join(p, room.id);
    const res = await api().patch(`/api/v1/rooms/${room.id}/config`).set('Cookie', host.cookie).send({ roundCount: 13 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ROUND_COUNT_EXCEEDS_MAX', message: 'Maximum rounds for 5 players is 12.' });
  });

  it('returns 400 VALIDATION_ERROR for a bad or empty body', async () => {
    const host = await createUser('Host');
    const room = await openRoom(host);
    for (const body of [{}, { roundCount: 0 }, { roundCount: 2.5 }, { bidRule: 'none' }]) {
      const res = await api().patch(`/api/v1/rooms/${room.id}/config`).set('Cookie', host.cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('returns 403 NOT_HOST for anyone but the host', async () => {
    const [host, p2] = await users(2);
    const room = await openRoom(host);
    await join(p2, room.id);
    const res = await api().patch(`/api/v1/rooms/${room.id}/config`).set('Cookie', p2.cookie).send({ roundCount: 3 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HOST');
  });

  it('returns 403 GAME_ALREADY_STARTED once the game has started, and 404 for a closed room', async () => {
    const host = await createUser('Host');
    const room = await openRoom(host);
    await setRoomState(room.id, 'in_progress');
    const started = await api().patch(`/api/v1/rooms/${room.id}/config`).set('Cookie', host.cookie).send({ roundCount: 3 });
    expect(started.status).toBe(403);
    expect(started.body.code).toBe('GAME_ALREADY_STARTED');

    await setRoomState(room.id, 'closed');
    const closed = await api().patch(`/api/v1/rooms/${room.id}/config`).set('Cookie', host.cookie).send({ roundCount: 3 });
    expect(closed.status).toBe(404);
  });
});

describe('DELETE /rooms/{roomId}', () => {
  it('lets the host close an open room', async () => {
    const [host, p2] = await users(2);
    const room = await openRoom(host);
    await join(p2, room.id);

    const forbidden = await api().delete(`/api/v1/rooms/${room.id}`).set('Cookie', p2.cookie);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('NOT_HOST');

    await api().delete(`/api/v1/rooms/${room.id}`).set('Cookie', host.cookie).expect(204);
    const row = await db('rooms').where({ id: room.id }).first();
    expect(row.state).toBe('closed');
    expect(row.closed_at).not.toBeNull();
    expect(server.rooms.hasTimeout(room.id)).toBe(false);

    const again = await api().delete(`/api/v1/rooms/${room.id}`).set('Cookie', host.cookie);
    expect(again.status).toBe(404);
    // Both members are back in the lobby and may open rooms.
    await openRoom(p2);
  });

  it('returns 403 GAME_ALREADY_STARTED once the game has started', async () => {
    const host = await createUser('Host');
    const room = await openRoom(host);
    await setRoomState(room.id, 'in_progress');
    const res = await api().delete(`/api/v1/rooms/${room.id}`).set('Cookie', host.cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GAME_ALREADY_STARTED');
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

  it('closes an unstarted room when the timer fires', async () => {
    const host = await createUser('Host');
    const res = await request(fast.app).post('/api/v1/rooms').set('Cookie', host.cookie).expect(201);
    expect(fast.rooms.hasTimeout(res.body.id)).toBe(true);
    await sleep(600);
    const row = await db('rooms').where({ id: res.body.id }).first();
    expect(row.state).toBe('closed');
    expect(row.closed_at).not.toBeNull();
    expect(fast.rooms.hasTimeout(res.body.id)).toBe(false);
  });

  it('leaves a room alone if its game started before the timer fired', async () => {
    const host = await createUser('Host');
    const res = await request(fast.app).post('/api/v1/rooms').set('Cookie', host.cookie).expect(201);
    await setRoomState(res.body.id, 'in_progress');
    await sleep(600);
    const row = await db('rooms').where({ id: res.body.id }).first();
    expect(row.state).toBe('in_progress');
    expect(row.closed_at).toBeNull();
  });

  it('re-arms timers after a restart, closing rooms already past the timeout', async () => {
    const [stale, fresh] = await users(2);
    const old = await openRoom(stale);
    const recent = await openRoom(fresh);
    await db('rooms').where({ id: old.id }).update({ created_at: new Date(Date.now() - 11 * 60 * 1000) });
    server.rooms.stop(); // as if the process restarted

    await server.rooms.restoreTimeouts();
    await sleep(100);
    expect((await db('rooms').where({ id: old.id }).first()).state).toBe('closed');
    expect((await db('rooms').where({ id: recent.id }).first()).state).toBe('open');
    expect(server.rooms.hasTimeout(recent.id)).toBe(true);
  });
});

describe('POST /rooms/{roomId}/start', () => {
  const start = (user: TestUser, roomId: string) => api().post(`/api/v1/rooms/${roomId}/start`).set('Cookie', user.cookie);

  it('returns 400 NOT_ENOUGH_PLAYERS below 3 players, counting only players', async () => {
    const [host, p2, s1, s2] = await users(4);
    const room = await openRoom(host);
    await join(p2, room.id);
    await join(s1, room.id, 'spectator');
    await join(s2, room.id, 'spectator');
    const res = await start(host, room.id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_ENOUGH_PLAYERS');
  });

  it('returns 403 NOT_HOST for anyone but the host', async () => {
    const [host, p2, p3] = await users(3);
    const room = await openRoom(host);
    await join(p2, room.id);
    await join(p3, room.id);
    const res = await start(p2, room.id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_HOST');
  });

  it('returns 403 GAME_ALREADY_STARTED once started, and 404 for unknown or closed rooms', async () => {
    const [host] = await users(1);
    const room = await openRoom(host);
    await setRoomState(room.id, 'in_progress');
    expect((await start(host, room.id)).body.code).toBe('GAME_ALREADY_STARTED');
    await setRoomState(room.id, 'closed');
    expect((await start(host, room.id)).status).toBe(404);
    expect((await start(host, randomUUID())).status).toBe(404);
    expect((await start(host, 'not-a-uuid')).status).toBe(404);
  });

  it('with 3+ players, passes every guard but returns 501 and leaves the room open (engine not wired)', async () => {
    const [host, p2, p3] = await users(3);
    const room = await openRoom(host);
    await join(p2, room.id);
    await join(p3, room.id);
    const res = await start(host, room.id);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
    expect((await db('rooms').where({ id: room.id }).first()).state).toBe('open');
    expect(await db('games').where({ room_id: room.id })).toHaveLength(0);
    expect(server.rooms.hasTimeout(room.id)).toBe(true);
  });
});
