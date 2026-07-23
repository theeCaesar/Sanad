const pino = require('pino');

const redact = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'password_hash',
  '*.password',
  'token',
  'refresh_token',
  'otp',
];

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: redact, censor: '[REDACTED]' },
  base: { service: 'sanad' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});

module.exports = logger;
