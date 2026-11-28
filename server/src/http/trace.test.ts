import type { Request } from 'express';
import { requestTraceId, useIssuedTraceId } from './trace';

const req = (authSession?: { traceId: string }) => ({ authSession }) as unknown as Request;

describe('requestTraceId', () => {
  it("is the session's traceId when authenticated, else one UUID per request", () => {
    expect(requestTraceId(req({ traceId: 'session-trace' }))).toBe('session-trace');
    const anon = req();
    expect(requestTraceId(anon)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestTraceId(anon)).toBe(requestTraceId(anon));
  });

  it('switches to the traceId of a session the request issued (login, register, credential change)', () => {
    const anon = req();
    requestTraceId(anon);
    useIssuedTraceId(anon, 'new-session-trace');
    expect(requestTraceId(anon)).toBe('new-session-trace');

    const changing = req({ traceId: 'old-session-trace' });
    useIssuedTraceId(changing, 'rotated-trace');
    expect(requestTraceId(changing)).toBe('rotated-trace');
  });
});
