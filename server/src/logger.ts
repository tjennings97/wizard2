import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.isProduction ? 'info' : 'debug'),
  messageKey: 'message',
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.sessionToken', '*.password'],
  ...(config.isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { messageKey: 'message' } } }),
});
