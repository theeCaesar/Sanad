const Redis = require('ioredis');

const db = require('./db/pool');
const logger = require('./utils/logger');
const metrics = require('./utils/metrics');

const syncRepo = require('./repositories/syncRepository');
const { userRepo, deviceRepo, jobRepo, reportRepo } = require('./repositories');

const { createSyncService } = require('./services/syncService');
const { createAuthService } = require('./services/authService');

const { createAuthMiddleware } = require('./middleware/auth');
const {
  createLimiter, createSyncLimiter, createAuthLimiter,
} = require('./middleware/rateLimiter');

const { createSyncController } = require('./controllers/syncController');
const { createAuthController } = require('./controllers/authController');
const { createJobController } = require('./controllers/jobController');
const { createDispatchController } = require('./controllers/dispatchController');
const { createReportController } = require('./controllers/reportController');
const { createDemoController } = require('./controllers/demoController');

const { createDemoSeeder } = require('./db/seeds/demoSeed');

function createContainer(overrides = {}) {
  const redis = overrides.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    lazyConnect: false,
  });

  redis.on('error', (err) => logger.error({ err: err.message }, 'redis: error'));

  const database = overrides.db || db;

  const authService = overrides.authService || createAuthService({
    userRepo, deviceRepo, logger,
  });

  const syncService = overrides.syncService || createSyncService({
    db: database,
    repo: syncRepo,
    logger,
    metrics,
    uuid: require('crypto').randomUUID,
  });

  const authMiddleware = createAuthMiddleware({ authService, userRepo });

  const limiters = {
    api: createLimiter(redis, { name: 'api', capacity: 60, refillPerSec: 1 }),

    sync: createSyncLimiter(redis, { capacity: 500, refillPerSec: 5 }),

    auth: createAuthLimiter(redis),
  };

  const syncController = createSyncController({ syncService });
  const authController = createAuthController({ authService });
  const jobController = createJobController({ jobRepo });
  const dispatchController = createDispatchController({
    jobRepo, deviceRepo, db: database, logger,
  });
  const reportController = createReportController({ reportRepo });

  const seedDemo = createDemoSeeder({ db: database, authService, logger });
  const demoController = createDemoController({
    db: database, syncService, jobRepo, seedDemo, logger,
  });

  return {
    redis,
    db: database,
    logger,
    metrics,
    authService,
    syncService,
    authMiddleware,
    limiters,
    syncController,
    authController,
    jobController,
    dispatchController,
    reportController,
    demoController,
    repos: { userRepo, deviceRepo, jobRepo, reportRepo, syncRepo },
    async close() {
      await redis.quit().catch(() => {});
      await database.close?.();
    },
  };
}

module.exports = { createContainer };
