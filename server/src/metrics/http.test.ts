import express, { Router } from 'express';
import request from 'supertest';
import { asyncHandler } from '../http/asyncHandler';
import { ApiError, errorHandler } from '../http/errors';
import { logger } from '../logger';
import { markRouteBase, requestMetrics } from './http';
import { httpRequestsTotal } from './registry';

jest.mock('../logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/** A small app with the same wiring as createApp: middleware first, routers with markRouteBase. */
function app() {
  const a = express();
  a.use(requestMetrics());
  a.use(express.json());
  const api = Router();
  api.use(markRouteBase);
  const rooms = Router();
  rooms.param('roomId', (req, _res, next, id: string) => {
    req.logRoomId = id;
    next();
  });
  rooms.get('/:roomId', (_req, res) => res.json({ ok: true }));
  rooms.post(
    '/:roomId/fail',
    asyncHandler(async () => {
      throw new ApiError(409, 'CONFLICT', 'No.');
    }),
  );
  api.use('/rooms', markRouteBase, rooms);
  api.get('/metrics', (_req, res) => res.send('ok'));
  a.use('/api/v1', api);
  a.get('/health', (_req, res) => res.json({ status: 'ok' }));
  a.get('/assets/app.js', (_req, res) => res.send('js'));
  a.use(errorHandler);
  return a;
}

async function count(labels: Record<string, string>): Promise<number> {
  const { values } = await httpRequestsTotal.get();
  return values.find((v) => Object.entries(labels).every(([k, x]) => String(v.labels[k as 'route']) === x))?.value ?? 0;
}

const info = logger.info as jest.Mock;
const debug = logger.debug as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('requestMetrics', () => {
  it('logs one line per request with the log fields, the route pattern and no body or query string', async () => {
    await request(app()).get('/api/v1/rooms/abc?token=secret').expect(200);
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0];
    expect(message).toBe('request completed');
    expect(fields).toEqual({
      event: 'http.request',
      traceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      userId: null,
      roomId: 'abc',
      gameId: null,
      method: 'GET',
      route: '/api/v1/rooms/:roomId',
      path: '/api/v1/rooms/abc',
      statusCode: 200,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret');
  });

  it('keeps the route pattern when an error falls out of the router to the app error handler', async () => {
    const labels = { method: 'POST', route: '/api/v1/rooms/:roomId/fail', status_code: '409' };
    const before = await count(labels);
    await request(app()).post('/api/v1/rooms/r1/fail').send({ password: 'hunter2' }).expect(409);
    expect(await count(labels)).toBe(before + 1);
    expect(JSON.stringify(info.mock.calls)).not.toContain('hunter2');
  });

  it('labels unmatched API paths "unmatched" and ignores the static client', async () => {
    const before = await count({ route: 'unmatched', status_code: '404' });
    await request(app()).get('/api/v1/nothing/here').expect(404);
    expect(await count({ route: 'unmatched', status_code: '404' })).toBe(before + 1);

    await request(app()).get('/assets/app.js').expect(200);
    expect(info).toHaveBeenCalledTimes(1);
    expect(await count({ route: '/assets/app.js' })).toBe(0);
  });

  it('logs the health check and metrics scrapes at debug', async () => {
    await request(app()).get('/health').expect(200);
    await request(app()).get('/api/v1/metrics').expect(200);
    expect(info).not.toHaveBeenCalled();
    expect(debug.mock.calls.map(([f]) => f.route)).toEqual(['/health', '/api/v1/metrics']);
  });
});
