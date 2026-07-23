
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const logger = require('../utils/logger');
const AppError = require('../utils/appError');

const PROTO_PATH = path.join(__dirname, 'proto', 'pricing.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false, longs: String, enums: String, defaults: true, oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef).sanad.pricing.v1;

function createPricingClient(addr = process.env.PRICING_ADDR || 'localhost:50051') {
  const options = {
    'grpc.service_config': JSON.stringify({
      methodConfig: [{
        name: [{ service: 'sanad.pricing.v1.PricingService' }],
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '0.1s',
          maxBackoff: '1s',
          backoffMultiplier: 2,
          retryableStatusCodes: ['UNAVAILABLE', 'DEADLINE_EXCEEDED'],
        },
      }],
    }),
    'grpc.keepalive_time_ms': 10_000,
  };

  const stub = new proto.PricingService(
    addr,
    grpc.credentials.createInsecure(),
    options
  );

  const deadline = (ms) => ({ deadline: Date.now() + ms });

  return {
    priceAndReserve(req) {
      return new Promise((resolve, reject) => {
        stub.priceAndReserve(req, deadline(2000), (err, res) => {
          if (err) {
            const retryable = err.code === grpc.status.UNAVAILABLE
                           || err.code === grpc.status.DEADLINE_EXCEEDED;
            logger.error({ code: err.code, msg: err.message }, 'pricing client: call failed');
            return reject(new AppError(
              `Pricing unavailable: ${err.details || err.message}`,
              503,
              { code: 'PRICING_UNAVAILABLE', retryable }
            ));
          }
          resolve(res);
        });
      });
    },

    quote(req) {
      return new Promise((resolve, reject) => {
        stub.quote(req, deadline(1000), (err, res) => {
          if (err) return reject(new AppError('Quote failed', 503, { retryable: true }));
          resolve(res);
        });
      });
    },

    watchStock(req) {
      return stub.watchStock(req, {});
    },

    close() { stub.close(); },
  };
}

module.exports = { createPricingClient };
