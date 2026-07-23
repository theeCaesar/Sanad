const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const hpp = require('hpp');
const xss = require('xss-clean');
const pinoHttp = require('pino-http');

const AppError = require('./utils/appError');
const logger = require('./utils/logger');
const metrics = require('./utils/metrics');
const errorHandler = require('./middleware/errorHandler');
const requestContext = require('./middleware/requestContext');

function createApp(deps) {
  const {
    redis,
    syncController,
    authController,
    jobController,
    dispatchController,
    reportController,
    demoController,
    authMiddleware,
    limiters,
  } = deps;

  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:', 'blob:', process.env.R2_PUBLIC_BASE || ''],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
  app.use(cors({
    origin: allowed.includes('*') ? '*' : [...allowed, 'null'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    exposedHeaders: ['x-trace-id', 'Retry-After', 'X-RateLimit-Remaining'],
  }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(cookieParser());
  app.use(compression());

  app.use(hpp());
  app.use(xss());

  app.use(requestContext);

  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.traceId,
    autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
    customProps: (req) => ({
      trace_id: req.traceId,
      user_id: req.ctx?.userId,
      device_id: req.ctx?.deviceId,
    }),
  }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      metrics.httpDuration.observe(
        {
          method: req.method,
          route: req.route?.path || 'unmatched',
          status: res.statusCode,
        },
        Date.now() - start
      );
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

  app.get('/ready', async (req, res) => {
    try {
      await deps.db.query('SELECT 1');
      await redis.ping();
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', error: err.message });
    }
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  });

  const api = process.env.API_PREFIX || '/api/v1';
  const { protect, protectDevice, requireRole, scopeToOrg } = authMiddleware;

  app.post(`${api}/auth/login`, limiters.auth, authController.login);
  app.post(`${api}/auth/devices`, protect, authController.registerDevice);
  app.delete(`${api}/auth/devices/:id`, protect, requireRole('admin', 'dispatcher'),
    authController.revokeDevice);

  app.post(`${api}/sync/push`, protectDevice, limiters.sync, syncController.push);
  app.get(`${api}/sync/pull`, protectDevice, syncController.pull);

  app.get(`${api}/jobs`, protect, scopeToOrg, limiters.api, jobController.listMine);
  app.get(`${api}/jobs/:id`, protect, scopeToOrg, limiters.api, jobController.getOne);

  app.get(`${api}/dispatch/board`, protect, requireRole('admin', 'dispatcher'),
    limiters.api, dispatchController.board);
  app.post(`${api}/dispatch/jobs`, protect, requireRole('admin', 'dispatcher'),
    dispatchController.createJob);
  app.patch(`${api}/dispatch/jobs/:id`, protect, requireRole('admin', 'dispatcher'),
    dispatchController.updateJob);
  app.get(`${api}/dispatch/conflicts`, protect, requireRole('admin', 'dispatcher'),
    dispatchController.conflicts);
  app.post(`${api}/dispatch/conflicts/:mutationId/resolve`, protect,
    requireRole('admin', 'dispatcher'), dispatchController.resolveConflict);
  app.get(`${api}/dispatch/devices`, protect, requireRole('admin', 'dispatcher'),
    dispatchController.deviceHealth);

  app.get(`${api}/jobs/:id/history`, protect, jobController.history);

  app.get(`${api}/reports/cash`, protect, requireRole('admin', 'dispatcher'),
    reportController.cash);
  app.get(`${api}/reports/dark-time`, protect, requireRole('admin', 'dispatcher'),
    reportController.darkTime);
  app.get(`${api}/reports/conflicts`, protect, requireRole('admin', 'dispatcher'),
    reportController.conflicts);

  app.use('/demo', demoController.router);

  app.all('*', (req, res, next) => {
    next(new AppError(`Cannot ${req.method} ${req.originalUrl}`, 404, { code: 'NOT_FOUND' }));
  });

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
