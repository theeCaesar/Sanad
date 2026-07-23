
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const logger = require('../utils/logger');

const PROTO_PATH = path.join(__dirname, 'proto', 'pricing.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).sanad.pricing.v1;

function createPricingImpl(deps) {
  const { pricingRepo, stockEvents, logger: log = logger } = deps;

  return {
    async priceAndReserve(call, callback) {
      const req = call.request;

      try {
        if (!req.lines?.length) {
          return callback({
            code: grpc.status.INVALID_ARGUMENT,
            message: 'An order must have at least one line.',
          });
        }

        const result = await pricingRepo.priceAndReserve({
          orgId: req.orgId,
          userId: req.userId,
          idempotencyKey: req.idempotencyKey,
          lines: req.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        });

        if (!result.ok) {
          return callback(null, {
            ok: false,
            total: 0,
            lines: [],
            rejection: result.rejection,
            rejectionDetail: result.detail,
            reservationId: '',
          });
        }

        return callback(null, {
          ok: true,
          total: String(result.total),
          lines: result.lines.map((l) => ({
            productId: l.product_id,
            quantity: l.quantity,
            unitPrice: String(l.unit_price),
            lineTotal: String(l.line_total),
          })),
          rejection: 'REJECTION_UNSPECIFIED',
          reservationId: result.reservationId,
        });
      } catch (err) {
        log.error({ err: err.message }, 'pricing: priceAndReserve failed');
        return callback({ code: grpc.status.INTERNAL, message: 'Pricing failed.' });
      }
    },

    async quote(call, callback) {
      try {
        const q = await pricingRepo.quote({
          orgId: call.request.orgId,
          lines: call.request.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        });
        callback(null, {
          total: String(q.total),
          lines: q.lines.map((l) => ({
            productId: l.product_id, quantity: l.quantity,
            unitPrice: String(l.unit_price), lineTotal: String(l.line_total),
          })),
        });
      } catch (err) {
        callback({ code: grpc.status.INTERNAL, message: err.message });
      }
    },

    watchStock(call) {
      const { orgId, userId, productIds } = call.request;
      log.info({ orgId, productIds }, 'pricing: stock watch opened');

      pricingRepo.currentStock({ orgId, userId, productIds })
        .then((rows) => {
          for (const r of rows) {
            call.write({
              productId: r.product_id,
              remaining: r.qty,
              low: r.qty <= r.threshold,
              at: new Date().toISOString(),
            });
          }
        })
        .catch((err) => log.error({ err: err.message }, 'pricing: initial stock read failed'));

      const onChange = (update) => {
        if (update.orgId === orgId && productIds.includes(update.productId)) {
          call.write({
            productId: update.productId,
            remaining: update.remaining,
            low: update.low,
            at: update.at,
          });
        }
      };
      stockEvents.on('change', onChange);

      call.on('cancelled', () => {
        stockEvents.off('change', onChange);
        log.info({ orgId }, 'pricing: stock watch closed (client cancelled)');
      });
      call.on('end', () => {
        stockEvents.off('change', onChange);
        call.end();
      });
    },
  };
}

function startPricingServer(deps, addr = process.env.PRICING_ADDR || '0.0.0.0:50051') {
  const server = new grpc.Server();
  server.addService(proto.PricingService.service, createPricingImpl(deps));

  return new Promise((resolve, reject) => {
    server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      logger.info({ addr, port }, 'pricing: gRPC server listening');
      resolve(server);
    });
  });
}

module.exports = { createPricingImpl, startPricingServer, proto };

if (require.main === module) {
  const db = require('../db/pool');
  const { createPricingRepo, createStockEvents } = require('./pricingRepo');
  const { startMetricsServer } = require('../utils/metricsServer');

  const METRICS_PORT = Number(process.env.METRICS_PORT || 9101);

  const stockEvents = createStockEvents();
  const pricingRepo = createPricingRepo({ db, stockEvents, logger });

  startPricingServer({ pricingRepo, stockEvents, logger })
    .then((server) => {
      startMetricsServer(METRICS_PORT, 'pricing');
      const shutdown = (sig) => {
        logger.info({ sig }, 'pricing: shutting down');
        server.tryShutdown((err) => {
          if (err) { logger.error({ err: err.message }, 'pricing: forced shutdown'); server.forceShutdown(); }
          process.exit(0);
        });
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err) => {
      logger.error({ err: err.message }, 'pricing: failed to start');
      process.exit(1);
    });
}
