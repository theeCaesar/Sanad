
const AppError = require('../utils/appError');

function createPaymentGateway({ http, logger, baseUrl = process.env.PAYMENT_URL }) {
  return {
    async charge({ customerId, amount, idempotencyKey }) {
      const res = await http.post(`${baseUrl}/charges`, {
        customer_id: customerId,
        amount,
      }, {
        headers: { 'Idempotency-Key': idempotencyKey },
        timeout: 10_000,
      });

      if (!res.data?.id) {
        throw new AppError('Payment gateway returned no charge id', 502, { retryable: true });
      }
      return { id: res.data.id };
    },

    async refund({ chargeId, idempotencyKey }) {
      await http.post(`${baseUrl}/refunds`, { charge_id: chargeId }, {
        headers: { 'Idempotency-Key': idempotencyKey },
        timeout: 10_000,
      });
      logger.info({ chargeId }, 'payment: refunded (saga compensation)');
    },
  };
}

function createLogisticsPartner({ http, logger, baseUrl = process.env.LOGISTICS_URL }) {
  return {
    async book({ userId, items, idempotencyKey }) {
      const res = await http.post(`${baseUrl}/bookings`, { user_id: userId, items }, {
        headers: { 'Idempotency-Key': idempotencyKey },
        timeout: 10_000,
      });
      return { id: res.data.id };
    },

    async cancel(bookingId) {
      await http.delete(`${baseUrl}/bookings/${bookingId}`, { timeout: 10_000 });
      logger.info({ bookingId }, 'logistics: booking cancelled (saga compensation)');
    },
  };
}

function createNotifier({ db, logger }) {
  return {
    async send({ orgId, customerId, userId, key, params, severity = 'info' }) {
      await db.query(
        `INSERT INTO notifications (org_id, user_id, key, params, severity)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId || null, key, params || {}, severity]
      );
      logger.debug({ key, orgId }, 'notifier: queued');
    },
  };
}

function createOrderService({ db, repo, logger }) {
  return {
    async createFromVisit({ orgId, visitId, lines, userId, mutationId }) {
      return db.withTransaction(async (client) => {
        const products = await repo.getProducts(client, orgId, lines.map((l) => l.product_id));
        const byId = new Map(products.map((p) => [p.id, p]));

        let subtotal = 0;
        const priced = lines.map((l) => {
          const p = byId.get(l.product_id);
          if (!p) throw new AppError(`Unknown product ${l.product_id}`, 400);
          const total = p.unit_price * l.qty;
          subtotal += total;
          return { product_id: p.id, qty: l.qty, unit_price: p.unit_price, line_total: total };
        });

        for (const l of priced) {
          const { ok } = await repo.decrementVanStock(client, {
            orgId, userId, productId: l.product_id, qty: l.qty,
          });
          if (!ok) throw new AppError('Insufficient van stock', 409);
        }

        const order = await repo.insertOrder(client, {
          org_id: orgId, visit_id: visitId, customer_id: null,
          created_by: userId, subtotal, discount: 0, total: subtotal, paid: 0,
          client_ts: new Date(), last_mutation_id: mutationId,
        });
        await repo.insertOrderLines(client, order.id, priced);

        return order;
      });
    },

    async voidOrder({ orgId, orderId, reason }) {
      return db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT * FROM order_lines WHERE order_id = $1`, [orderId]
        );
        const order = await client.query(
          `SELECT created_by FROM orders WHERE id = $1 AND org_id = $2`, [orderId, orgId]
        );
        if (!order.rows[0]) return;

        for (const l of rows) {
          await client.query(
            `UPDATE van_stock SET qty = qty + $3, version = version + 1
              WHERE org_id = $1 AND user_id = $2 AND product_id = $4`,
            [orgId, order.rows[0].created_by, l.qty, l.product_id]
          );
        }

        await client.query(
          `UPDATE orders SET total = 0, paid = 0 WHERE id = $1 AND org_id = $2`,
          [orderId, orgId]
        );

        logger.warn({ orderId, reason }, 'order: VOIDED (saga compensation) — stock restored');
      });
    },
  };
}

module.exports = {
  createPaymentGateway,
  createLogisticsPartner,
  createNotifier,
  createOrderService,
};
