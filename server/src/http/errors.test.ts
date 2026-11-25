import type { NextFunction, Request, Response } from 'express';

jest.mock('../logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { logger } from '../logger';
import { ApiError, errorHandler } from './errors';

function run(err: unknown, { headersSent = false } = {}) {
  const req = { method: 'POST', path: '/x' } as unknown as Request;
  const res = {
    headersSent,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  errorHandler(err, req, res, next);
  return { res, next };
}

/** Shape of the errors body-parser raises (http-errors). */
const bodyParserError = (status: number, type: string) =>
  Object.assign(new Error(type), { status, statusCode: status, expose: true, type });

beforeEach(() => jest.clearAllMocks());

describe('errorHandler', () => {
  it('maps an ApiError to its status and code', () => {
    const { res } = run(new ApiError(409, 'USERNAME_TAKEN', 'taken'));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USERNAME_TAKEN' }));
  });

  it('maps malformed JSON to 400 VALIDATION_ERROR', () => {
    const { res } = run(bodyParserError(400, 'entity.parse.failed'));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it.each([
    [413, 'entity.too.large', 'PAYLOAD_TOO_LARGE'],
    [415, 'encoding.unsupported', 'UNSUPPORTED_MEDIA_TYPE'],
    [415, 'charset.unsupported', 'UNSUPPORTED_MEDIA_TYPE'],
    [400, 'request.size.invalid', 'VALIDATION_ERROR'],
  ])('maps body-parser %i %s to %s without logging an error', (status, type, code) => {
    const { res } = run(bodyParserError(status, type));
    expect(res.status).toHaveBeenCalledWith(status);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('treats a 4xx error that is not marked expose as a 500', () => {
    const { res } = run(Object.assign(new Error('x'), { status: 404, expose: false }));
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 500 INTERNAL_ERROR with a traceId for unknown errors, and logs it', () => {
    const { res } = run(new Error('boom'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL_ERROR', details: { traceId: expect.any(String) } }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: expect.any(String) }),
      'unhandled request error',
    );
  });

  it('hands off to Express when headers were already sent', () => {
    const err = new Error('mid-stream');
    const { res, next } = run(err, { headersSent: true });
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
