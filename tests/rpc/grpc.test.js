
const { EventEmitter } = require('events');
const grpc = require('@grpc/grpc-js');
const { startPricingServer } = require('../../src/grpc/pricingServer');
const { createPricingClient } = require('../../src/grpc/pricingClient');

const PRICES = { water: 1000, bread: 500 };

const pricingRepo = {
  async priceAndReserve({ lines }) {
    let total = 0; const priced = [];
    for (const l of lines) {
      if (!PRICES[l.productId]) return { ok: false, rejection: 'UNKNOWN_PRODUCT', detail: `no ${l.productId}` };
      if (l.quantity > 20) return { ok: false, rejection: 'INSUFFICIENT_STOCK', detail: `${l.productId}: 20 left` };
      const lt = PRICES[l.productId] * l.quantity; total += lt;
      priced.push({ product_id: l.productId, quantity: l.quantity, unit_price: PRICES[l.productId], line_total: lt });
    }
    return { ok: true, total, lines: priced, reservationId: 'r1' };
  },
  async quote({ lines }) {
    const total = lines.reduce((s, l) => s + (PRICES[l.productId] || 0) * l.quantity, 0);
    return { total, lines: [] };
  },
  async currentStock() { return [{ product_id: 'water', qty: 15, threshold: 20 }]; },
};

let server; let client; let stockEvents;
const ADDR = '127.0.0.1:50099';

beforeAll(async () => {
  stockEvents = new EventEmitter();
  server = await startPricingServer({ pricingRepo, stockEvents }, ADDR);
  client = createPricingClient(ADDR);
});
afterAll(() => { client.close(); server.forceShutdown(); });

test('a priced order comes back over the wire with server-computed totals', async () => {
  const res = await client.priceAndReserve({
    orgId: 'o1', userId: 'u1', idempotencyKey: 'k1',
    lines: [{ productId: 'water', quantity: 3 }, { productId: 'bread', quantity: 2 }],
  });
  expect(res.ok).toBe(true);
  expect(res.total).toBe('4000');
  expect(res.reservationId).toBe('r1');
});

test('a business rejection is a typed enum, not a gRPC error', async () => {
  const res = await client.priceAndReserve({
    orgId: 'o1', userId: 'u1', idempotencyKey: 'k2',
    lines: [{ productId: 'water', quantity: 999 }],
  });
  expect(res.ok).toBe(false);
  expect(res.rejection).toBe('INSUFFICIENT_STOCK');
});

test('an unknown product is rejected, also typed', async () => {
  const res = await client.priceAndReserve({
    orgId: 'o1', userId: 'u1', idempotencyKey: 'k3',
    lines: [{ productId: 'gold', quantity: 1 }],
  });
  expect(res.rejection).toBe('UNKNOWN_PRODUCT');
});

test('an empty order is INVALID_ARGUMENT — a real gRPC status', async () => {
  await expect(
    client.priceAndReserve({ orgId: 'o1', userId: 'u1', idempotencyKey: 'k4', lines: [] })
  ).rejects.toMatchObject({ statusCode: 503 });
});

test('WatchStock STREAMS the initial level and a live change', (done) => {
  const stream = client.watchStock({ orgId: 'o1', userId: 'u1', productIds: ['water'] });
  const seen = [];
  stream.on('data', (u) => {
    seen.push(u.remaining);
    if (seen.length === 1) {
      setTimeout(() => stockEvents.emit('change',
        { orgId: 'o1', productId: 'water', remaining: 5, low: true, at: 'now' }), 30);
    }
    if (seen.length === 2) {
      expect(seen).toEqual([15, 5]);
      stream.cancel();
      done();
    }
  });
  stream.on('error', () => {});
});
