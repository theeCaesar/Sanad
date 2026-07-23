require('dotenv').config();
require('./tracing');

const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const IORedis = require('ioredis');

const { createContainer } = require('./container');
const { createApp } = require('./app');
const logger = require('./utils/logger');
const { createRealtime } = require('./realtime/gateway');

async function main() {
  const required = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    logger.fatal({ missing }, 'boot: missing required environment variables');
    process.exit(1);
  }

  const container = createContainer();
  const app = createApp(container);

  try {
    const { mountGraphQL } = require('./graphql/server');
    await mountGraphQL(app, container);
  } catch (err) {
    logger.warn({ err: err.message }, 'graphql: not mounted (optional dep missing?)');
  }

  const server = http.createServer(app);

  const io = new Server(server, {
    cors: { origin: (process.env.ALLOWED_ORIGINS || '*').split(','), credentials: true },
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  const pub = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  const sub = pub.duplicate();
  pub.on('error', (err) => logger.error({ err: err.message }, 'socket.io pub redis error'));
  sub.on('error', (err) => logger.error({ err: err.message }, 'socket.io sub redis error'));
  io.adapter(createAdapter(pub, sub));

  createRealtime(io, container);

  const port = Number(process.env.PORT || 4000);
  server.listen(port, () => {
    logger.info(
      { port, env: process.env.NODE_ENV, pid: process.pid },
      'sanad: listening'
    );
  });

  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'sanad: shutting down — draining in-flight requests');

    server.close(async () => {
      logger.info('sanad: http closed');
      io.close();
      await container.close();
      logger.info('sanad: clean exit');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('sanad: drain timed out — forcing exit');
      process.exit(1);
    }, 25000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => {
    logger.fatal({ err }, 'sanad: unhandled rejection');
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'sanad: uncaught exception');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'sanad: boot failed');
  process.exit(1);
});
