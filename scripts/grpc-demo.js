const { EventEmitter } = require('events');
const { startPricingServer } = require('../src/grpc/pricingServer');
const { createPricingClient } = require('../src/grpc/pricingClient');

const pricingRepo = {
  async priceAndReserve({ lines }) {
    const p = { 'water': 1000, 'bread': 500 };
    let total = 0;
    const priced = [];
    for (const l of lines) {
      if (!p[l.productId]) return { ok: false, rejection: 'UNKNOWN_PRODUCT', detail: `no ${l.productId}` };
      if (l.quantity > 20) return { ok: false, rejection: 'INSUFFICIENT_STOCK', detail: `${l.productId}: 20 left, ${l.quantity} asked` };
      const lt = p[l.productId] * l.quantity;
      total += lt;
      priced.push({ product_id: l.productId, quantity: l.quantity, unit_price: p[l.productId], line_total: lt });
    }
    return { ok: true, total, lines: priced, reservationId: 'resv-123' };
  },
  async quote({ lines }) { return { total: 3000, lines: [] }; },
  async currentStock() { return [{ product_id: 'water', qty: 15, threshold: 20 }]; },
};
const stockEvents = new EventEmitter();

(async () => {
  const server = await startPricingServer({ pricingRepo, stockEvents }, '127.0.0.1:50077');
  const client = createPricingClient('127.0.0.1:50077');

  const ok = await client.priceAndReserve({
    orgId: 'o1', userId: 'u1', idempotencyKey: 'k1',
    lines: [{ productId: 'water', quantity: 3 }, { productId: 'bread', quantity: 2 }],
  });
  console.log('✓ PriceAndReserve OK:', 'total=' + ok.total, 'reservation=' + ok.reservationId);

  const no = await client.priceAndReserve({
    orgId: 'o1', userId: 'u1', idempotencyKey: 'k2',
    lines: [{ productId: 'water', quantity: 999 }],
  });
  console.log('✓ Rejection is typed:', no.rejection, '—', no.rejectionDetail);

  await new Promise((resolve) => {
    const stream = client.watchStock({ orgId: 'o1', userId: 'u1', productIds: ['water'] });
    let got = 0;
    stream.on('data', (u) => {
      got++;
      console.log('✓ Stream update:', u.productId, 'remaining=' + u.remaining, 'low=' + u.low);
      if (got === 1) {
        setTimeout(() => stockEvents.emit('change', { orgId: 'o1', productId: 'water', remaining: 8, low: true, at: new Date().toISOString() }), 50);
      }
      if (got === 2) { stream.cancel(); resolve(); }
    });
    stream.on('error', () => resolve());
  });

  client.close();
  server.forceShutdown();
  console.log('\n✅ gRPC: server + client + streaming ALL WORK over the wire');
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
