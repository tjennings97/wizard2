import pino from 'pino';
import { config } from './config';
import { logContext } from './logContext';

/** docs/operations/observability-alerting.md, "Log entry structure". */
export const LOG_FIELD_DEFAULTS = { traceId: null, userId: null, roomId: null, gameId: null, event: null } as const;

/** The log call's fields over the mixin's, except those passed as undefined. */
export function mergeLogFields(mergeObject: object, mixinObject: object): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...mixinObject };
  for (const [key, value] of Object.entries(mergeObject)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/** Everything but the transport, so a test can write lines to its own stream. */
export const loggerOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  messageKey: 'message',
  // ISO 8601, under the name the log entry structure uses (pino's default key is "time").
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  // Every line carries the CLAUDE.md fields (null when not known), then the request's traceId and
  // userId from logContext; fields passed to a log call take precedence over both.
  mixin: () => ({ ...LOG_FIELD_DEFAULTS, ...logContext.getStore() }),
  // A field passed as undefined (say `userId: socket.data.userId` before auth) keeps the default
  // rather than dropping out of the line.
  mixinMergeStrategy: mergeLogFields,
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
};

export const logger = pino({
  ...loggerOptions,
  ...(config.isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { messageKey: 'message', timestampKey: 'timestamp' } } }),
});
