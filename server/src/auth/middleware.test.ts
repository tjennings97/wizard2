import type { NextFunction, Request, Response } from 'express';

jest.mock('../logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('./sessions', () => ({
  SESSION_COOKIE: 'wizard_session',
  authenticateToken: jest.fn(),
  isInActiveGame: jest.fn(),
  clearSessionCookie: jest.fn(),
  slideSession: jest.fn(),
}));

import { authenticate, requireSessionRunway } from './middleware';
import { authenticateToken, clearSessionCookie, isInActiveGame, slideSession } from './sessions';
import { DEFAULT_AVATAR } from '../shared/avatar';

const mockAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;
const mockIsInActiveGame = isInActiveGame as jest.MockedFunction<typeof isInActiveGame>;
const mockSlideSession = slideSession as jest.MockedFunction<typeof slideSession>;
const mockClearSessionCookie = clearSessionCookie as jest.MockedFunction<typeof clearSessionCookie>;

function okResult({ requiresCredentialChange = false, inReauthWindow = false } = {}) {
  return {
    ok: true as const,
    user: {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      role: 'player' as const,
      avatarConfig: DEFAULT_AVATAR,
      createdAt: new Date(0).toISOString(),
      requiresCredentialChange,
    },
    session: {
      id: 's1',
      traceId: 't1',
      createdAt: new Date(),
      expiresAt: new Date(),
      capAt: new Date(),
      inReauthWindow,
    },
  };
}

function run(handler: ReturnType<typeof authenticate>, signedCookies: Record<string, unknown> = { wizard_session: 'tok' }) {
  const req = { signedCookies } as unknown as Request;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return Promise.resolve(handler(req, res, next)).then(() => ({ req, res, next }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockIsInActiveGame.mockResolvedValue(false);
  mockSlideSession.mockImplementation(async (session) => session);
});

describe('authenticate: forced credential change', () => {
  it('blocks a flagged user with 403 CREDENTIAL_CHANGE_REQUIRED by default', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult({ requiresCredentialChange: true }));
    const { res, next } = await run(authenticate());
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CREDENTIAL_CHANGE_REQUIRED' }));
  });

  it('lets a flagged user through on routes that opt in', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult({ requiresCredentialChange: true }));
    const { req, next } = await run(authenticate({ allowDuringCredentialChange: true }));
    expect(next).toHaveBeenCalledWith();
    expect(req.user?.requiresCredentialChange).toBe(true);
  });

  it('lets an unflagged user through', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult());
    const { next } = await run(authenticate());
    expect(next).toHaveBeenCalledWith();
  });

  it('applies the re-auth window before the credential-change check', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult({ requiresCredentialChange: true, inReauthWindow: true }));
    const { res } = await run(authenticate());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REAUTH_REQUIRED' }));
  });
});

describe('authenticate: session checks', () => {
  it('rejects a missing or tampered cookie without a database lookup', async () => {
    const { res } = await run(authenticate(), { wizard_session: false });
    expect(mockAuthenticateToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });

  it('passes through the failure code from authenticateToken', async () => {
    mockAuthenticateToken.mockResolvedValue({ ok: false, code: 'SESSION_INVALIDATED' });
    const { res } = await run(authenticate());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SESSION_INVALIDATED' }));
  });

  it('sends the invalidation reason and keeps the cookie for SESSION_INVALIDATED', async () => {
    mockAuthenticateToken.mockResolvedValue({ ok: false, code: 'SESSION_INVALIDATED', reason: 'credential_change' });
    const { res } = await run(authenticate());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SESSION_INVALIDATED', details: { reason: 'credential_change' } }),
    );
    expect(mockClearSessionCookie).not.toHaveBeenCalled();
  });

  it('clears the cookie for UNAUTHORIZED', async () => {
    mockAuthenticateToken.mockResolvedValue({ ok: false, code: 'UNAUTHORIZED' });
    await run(authenticate());
    expect(mockClearSessionCookie).toHaveBeenCalled();
  });

  it('lets an active player in the re-auth window through', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult({ inReauthWindow: true }));
    mockIsInActiveGame.mockResolvedValue(true);
    const { next } = await run(authenticate());
    expect(next).toHaveBeenCalledWith();
  });
});

describe('authenticate: sliding expiry', () => {
  it('validates without sliding, then slides once the request is allowed', async () => {
    const result = okResult();
    mockAuthenticateToken.mockResolvedValue(result);
    const { next } = await run(authenticate());
    expect(mockAuthenticateToken).toHaveBeenCalledWith('tok', { slide: false });
    expect(mockSlideSession).toHaveBeenCalledWith(result.session);
    expect(next).toHaveBeenCalledWith();
  });

  it('does not slide a request blocked by CREDENTIAL_CHANGE_REQUIRED', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult({ requiresCredentialChange: true }));
    await run(authenticate());
    expect(mockSlideSession).not.toHaveBeenCalled();
  });

  it('does not slide a request blocked by REAUTH_REQUIRED', async () => {
    mockAuthenticateToken.mockResolvedValue(okResult({ inReauthWindow: true }));
    await run(authenticate());
    expect(mockSlideSession).not.toHaveBeenCalled();
  });
});

describe('requireSessionRunway', () => {
  const call = (inReauthWindow: boolean | undefined) => {
    const req = { authSession: inReauthWindow === undefined ? undefined : { inReauthWindow } } as unknown as Request;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    const next = jest.fn() as NextFunction;
    requireSessionRunway(req, res, next);
    return { res, next };
  };

  it('allows a session with more than 24h left', () => {
    expect(call(false).next).toHaveBeenCalledWith();
  });

  it('returns 401 REAUTH_REQUIRED in the re-auth window, even mid-game', () => {
    const { res, next } = call(true);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'REAUTH_REQUIRED' }));
  });

  it('fails loudly if mounted without requireAuth', () => {
    expect(call(undefined).next).toHaveBeenCalledWith(expect.any(Error));
  });
});
