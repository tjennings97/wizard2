import request from 'supertest';
import { db } from '../db/knex';
import { connect, connectReady, createUser, resetDb, sleep, startServer, type TestClient, type TestUser } from '../test/helpers';
import { registry } from './registry';

/**
 * GET /api/v1/metrics and the metric update points (docs/operations/observability-alerting.md),
 * over a real server, Postgres and sockets. Values are read from the registry before and after
 * each action, so the tests do not depend on what other tests in the file counted.
 */

const TOKEN = process.env.PROMETHEUS_TOKEN!;
const RECONNECT_MS = 400;

let server: Awaited<ReturnType<typeof startServer>>;
let clients: TestClient[] = [];

beforeAll(async () => {
  server = await startServer({ sessionRecheckMs: 0, reconnectWindowMs: RECONNECT_MS });
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

const api = () => request(server.app);

/** The current value of one series (labels must match exactly, apart from the default labels). */
async function value(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  const want = Object.entries(labels);
  const series = values.find(
    (v) =>
      !('metricName' in v && v.metricName && v.metricName !== name) &&
      want.every(([k, x]) => String((v.labels as Record<string, unknown>)[k]) === x),
  );
  return series?.value ?? 0;
}

/** Count of observations of a histogram series. */
async function observations(name: string, labels: Record<string, string>): Promise<number> {
  const metric = registry.getSingleMetric(name)!;
  const { values } = await metric.get();
  const want = Object.entries(labels);
  const series = values.find(
    (v) => (v as { metricName?: string }).metricName === `${name}_count` && want.every(([k, x]) => String((v.labels as Record<string, unknown>)[k]) === x),
  );
  return series?.value ?? 0;
}

async function online(user: TestUser): Promise<TestClient> {
  const c = await connectReady(server.url, user.cookie);
  clients.push(c);
  return c;
}

async function startTable(): Promise<{ roomId: string; players: TestUser[]; pc: TestClient[] }> {
  const players = await Promise.all([createUser('P1'), createUser('P2'), createUser('P3')]);
  const created = await api().post('/api/v1/rooms').set('Cookie', players[0].cookie).send({}).expect(201);
  const roomId: string = created.body.id;
  for (const p of players.slice(1)) {
    await api().post(`/api/v1/rooms/${roomId}/join`).set('Cookie', p.cookie).send({ role: 'player' }).expect(200);
  }
  const pc = await Promise.all(players.map(online));
  await api().post(`/api/v1/rooms/${roomId}/start`).set('Cookie', players[0].cookie).expect(200);
  // The game is live once hands are out (a random deck can flip a Wizard, so trump may wait).
  for (const c of pc) await c.waitFor('hand_dealt');
  return { roomId, players, pc };
}

describe('GET /api/v1/metrics', () => {
  it('is 401 without the bearer token or with a wrong one', async () => {
    const none = await api().get('/api/v1/metrics').expect(401);
    expect(none.body.code).toBe('UNAUTHORIZED');
    expect(none.headers['www-authenticate']).toBe('Bearer');
    await api().get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}x`).expect(401);
    await api().get('/api/v1/metrics').set('Authorization', TOKEN).expect(401);
    // A session cookie is not a substitute.
    const user = await createUser('Viewer');
    await api().get('/api/v1/metrics').set('Cookie', user.cookie).expect(401);
  });

  it('returns the Prometheus text format with every registry metric and the env and version labels', async () => {
    const res = await api().get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain;/);
    expect(res.headers['content-type']).toContain('version=0.0.4');
    for (const name of [
      'http_request_duration_seconds',
      'http_requests_total',
      'ws_connections_active',
      'ws_reconnections_total',
      'rooms_active',
      'games_active',
      'games_started_total',
      'games_completed_total',
      'players_connected',
      'bug_reports_total',
      'db_query_duration_seconds',
      'db_queries_total',
      'db_pool_size',
      'db_payload_bytes',
      'auth_login_failures_total',
      'rate_limit_hits_total',
      'auth_password_reset_attempts_total',
      'process_cpu_seconds_total', // a default collector
    ]) {
      expect(res.text).toContain(`# TYPE ${name} `);
    }
    expect(res.text).toMatch(/^db_pool_size\{env="test",version="[^"]+"\} \d+$/m);
  });
});

describe('HTTP and database metrics', () => {
  it('counts requests by route pattern, not raw URL, including error responses', async () => {
    const user = await createUser('Asker');
    const missing = '00000000-0000-4000-8000-000000000000';
    const route = { method: 'GET', route: '/api/v1/rooms/:roomId', status_code: '404' };
    const before = await value('http_requests_total', route);
    const durBefore = await observations('http_request_duration_seconds', route);
    await api().get(`/api/v1/rooms/${missing}`).set('Cookie', user.cookie).expect(404);
    expect(await value('http_requests_total', route)).toBe(before + 1);
    expect(await observations('http_request_duration_seconds', route)).toBe(durBefore + 1);

    const unmatched = { method: 'GET', route: 'unmatched', status_code: '404' };
    const u = await value('http_requests_total', unmatched);
    await api().get('/api/v1/no-such-thing/123').expect(404);
    expect(await value('http_requests_total', unmatched)).toBe(u + 1);

    const health = { method: 'GET', route: '/health', status_code: '200' };
    const h = await value('http_requests_total', health);
    await api().get('/health').expect(200);
    expect(await value('http_requests_total', health)).toBe(h + 1);
  });

  it('counts queries by operation, table and status, and payload sizes for games and game_events', async () => {
    const sel = { operation: 'select', table: 'users', status: 'success' };
    const s = await value('db_queries_total', sel);
    await db('users').select('id');
    expect(await value('db_queries_total', sel)).toBe(s + 1);

    // Inside a transaction too.
    const ins = { operation: 'insert', table: 'users', status: 'success' };
    const i = await value('db_queries_total', ins);
    await createUser('Counted');
    expect(await value('db_queries_total', ins)).toBe(i + 1);

    const err = { operation: 'select', table: 'other', status: 'error' };
    const e = await value('db_queries_total', err);
    await expect(db.raw('select * from no_such_table')).rejects.toThrow();
    expect(await value('db_queries_total', err)).toBe(e + 1);

    const payload = { operation: 'insert', table: 'game_events' };
    const p = await observations('db_payload_bytes', payload);
    await startTable();
    expect(await observations('db_payload_bytes', payload)).toBeGreaterThan(p);
  });
});

describe('security events', () => {
  it('counts login failures by reason and rate-limit hits', async () => {
    const user = await createUser('Target');
    const username = (await db('users').where({ id: user.id }).first('username')).username as string;
    const unknown = await value('auth_login_failures_total', { reason: 'unknown_user' });
    const bad = await value('auth_login_failures_total', { reason: 'bad_password' });
    const limited = await value('rate_limit_hits_total', { endpoint: 'login' });

    await api().post('/api/v1/auth/login').send({ username: 'nobody-here', password: 'whatever-123' }).expect(401);
    await api().post('/api/v1/auth/login').send({ username, password: 'wrong-password-1' }).expect(401);
    expect(await value('auth_login_failures_total', { reason: 'unknown_user' })).toBe(unknown + 1);
    expect(await value('auth_login_failures_total', { reason: 'bad_password' })).toBe(bad + 1);

    // The login limit is 10 per 15 minutes per IP; two are used above.
    for (let n = 0; n < 8; n++) await api().post('/api/v1/auth/login').send({ username, password: 'wrong-password-1' }).expect(401);
    await api().post('/api/v1/auth/login').send({ username, password: 'wrong-password-1' }).expect(429);
    expect(await value('rate_limit_hits_total', { endpoint: 'login' })).toBe(limited + 1);
  });

  it('counts password reset attempts by outcome', async () => {
    const before = await value('auth_password_reset_attempts_total', { outcome: 'unknown_user' });
    await api()
      .post('/api/v1/auth/reset-password')
      .send({ username: 'nobody-here', recoveryPassphrase: 'some passphrase', newPassword: 'a-new-password-1' })
      .expect(401);
    expect(await value('auth_password_reset_attempts_total', { outcome: 'unknown_user' })).toBe(before + 1);
  });
});

describe('game, room, socket and bug report metrics', () => {
  it('tracks connections, connected players, rooms and games', async () => {
    const [a, b] = await Promise.all([createUser('A'), createUser('B')]);
    const ws = await value('ws_connections_active');
    const players = await value('players_connected');
    await online(a);
    await online(a); // a second tab: one more connection, same player
    await online(b);
    expect(await value('ws_connections_active')).toBe(ws + 3);
    expect(await value('players_connected')).toBe(players + 2);

    for (const c of clients) c.close();
    clients = [];
    await sleep(100);
    expect(await value('ws_connections_active')).toBe(ws);
    expect(await value('players_connected')).toBe(players);

    expect(await value('rooms_active')).toBe(0);
    const started = await value('games_started_total');
    const t = await startTable();
    expect(await value('rooms_active')).toBe(1);
    expect(await value('games_active')).toBe(1);
    expect(await value('games_started_total')).toBe(started + 1);

    // Two players quit: the game ends incomplete.
    const incomplete = await value('games_completed_total', { status: 'incomplete' });
    await api().post(`/api/v1/rooms/${t.roomId}/leave`).set('Cookie', t.players[1].cookie).expect(204);
    await api().post(`/api/v1/rooms/${t.roomId}/leave`).set('Cookie', t.players[2].cookie).expect(204);
    await t.pc[0].waitFor('game_over');
    expect(await value('games_completed_total', { status: 'incomplete' })).toBe(incomplete + 1);
    expect(await value('games_active')).toBe(0);
  });

  it('counts reconnections that made it back in the window and ones that timed out', async () => {
    const t = await startTable();
    const success = await value('ws_reconnections_total', { outcome: 'success' });
    const timeout = await value('ws_reconnections_total', { outcome: 'timeout' });

    t.pc[2].close();
    await t.pc[0].waitFor('player_disconnected');
    const back = connect(server.url, t.players[2].cookie);
    clients.push(back);
    await t.pc[0].waitFor('player_reconnected');
    expect(await value('ws_reconnections_total', { outcome: 'success' })).toBe(success + 1);

    back.close();
    await t.pc[0].waitFor('player_disconnected', () => true, { from: t.pc[0].length });
    await t.pc[0].waitFor('user_left');
    expect(await value('ws_reconnections_total', { outcome: 'timeout' })).toBe(timeout + 1);
  });

  it('counts bug reports by severity', async () => {
    const user = await createUser('Reporter');
    const high = await value('bug_reports_total', { severity: 'high' });
    const none = await value('bug_reports_total', { severity: 'none' });
    const context = { url: 'http://localhost:5173/', clientTimestamp: new Date().toISOString() };
    await api().post('/api/v1/bug-reports').set('Cookie', user.cookie).send({ description: 'Broken', severity: 'high', context }).expect(201);
    await api().post('/api/v1/bug-reports').set('Cookie', user.cookie).send({ description: 'Odd', context }).expect(201);
    expect(await value('bug_reports_total', { severity: 'high' })).toBe(high + 1);
    expect(await value('bug_reports_total', { severity: 'none' })).toBe(none + 1);
  });
});
