import pino from 'pino';
import { config } from './config';
import { logContext } from './logContext';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  // The request's traceId and userId; fields passed to a log call take precedence.
  mixin: () => ({ ...logContext.getStore() }),
  redact: [
    'req.headers.cookie',
    'req.headers.authorization',
    'req.body',
    '*.sessionToken',
    '*.password',
    '*.newPassword',
    '*.recoveryPassphrase',
    '*.inviteCode',
    '*.temporaryPassword',
    '*.temporaryPassphrase',
  ],
  ...(config.isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { messageKey: 'message' } } }),
});
