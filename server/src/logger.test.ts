import { Writable } from 'stream';
import pino from 'pino';
import { logContext } from './logContext';
import { loggerOptions, mergeLogFields } from './logger';

/** A pino logger with the app's options that collects each JSON line. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { log: pino({ ...loggerOptions, level: 'debug' }, stream), lines };
}

describe('log line structure', () => {
  it('carries timestamp, level, traceId, userId, roomId, gameId, event and message on every line', () => {
    const { log, lines } = capture();
    log.info('plain');
    expect(lines[0]).toEqual(
      expect.objectContaining({ traceId: null, userId: null, roomId: null, gameId: null, event: null, message: 'plain' }),
    );
    expect(new Date(lines[0].timestamp as string).toISOString()).toBe(lines[0].timestamp);
    expect(lines[0]).not.toHaveProperty('time');
  });

  it('uses the request context, with explicit fields taking precedence and undefined ones ignored', () => {
    const { log, lines } = capture();
    logContext.run({ traceId: 't-1', userId: 'u-1' }, () => {
      log.info({ roomId: 'r-1' }, 'in a request');
      log.info({ userId: 'u-2', gameId: undefined }, 'override');
    });
    expect(lines[0]).toEqual(expect.objectContaining({ traceId: 't-1', userId: 'u-1', roomId: 'r-1', gameId: null }));
    expect(lines[1]).toEqual(expect.objectContaining({ traceId: 't-1', userId: 'u-2', gameId: null }));
  });

  it('redacts credentials', () => {
    const { log, lines } = capture();
    log.info({ body: { password: 'hunter2', recoveryPassphrase: 'p', sessionToken: 's' } }, 'x');
    expect(JSON.stringify(lines[0])).not.toMatch(/hunter2|"p"|"s"/);
  });

  it('mergeLogFields keeps defaults for undefined values', () => {
    expect(mergeLogFields({ a: undefined, b: 2 }, { a: null, b: 1, c: 3 })).toEqual({ a: null, b: 2, c: 3 });
  });
});
