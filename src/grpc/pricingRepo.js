

const { EventEmitter } = require('events');

function createStockEvents() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return emitter;
}

function createPricingRepo({ db, stockEvents, logger }) {
  return {
    async quote({ orgId, lines }) {
      if (!lines.length) return { total: 0, lines: [] };
      const ids = lines.map((l) => l.productId);
      const { rows } = await db.query(
        `SELECT id, unit_price FROM products WHERE org_id = $1 AND id = ANY($2)`,
        [orgId, ids]
      );
      const priceById = new Map(rows.map((r) => [r.id, Number(r.unit_price)]));
      let total = 0;
      const priced = [];
      for (const l of lines) {
        const unit = priceById.get(l.productId) || 0;
        const lineTotal = unit * l.quantity;
        total += lineTotal;
        priced.push({ product_id: l.productId, quantity: l.quantity, unit_price: unit, line_total: lineTotal });
      }
      return { total, lines: priced };
    },

    async priceAndReserve({ orgId, userId, idempotencyKey, lines }) {
      let changed = [];
      let prodMap = new Map();

      try {
        const result = await db.withTransaction(async (client) => {
          if (idempotencyKey) {
            const existing = await client.query(
              `SELECT total, lines FROM stock_reservations
                WHERE org_id = $1 AND idempotency_key = $2`,
              [orgId, idempotencyKey]
            );
            if (existing.rowCount > 0) {
              const r = existing.rows[0];
              return { ok: true, total: Number(r.total), lines: r.lines, reservationId: idempotencyKey, replayed: true };
            }
          }

          const ids = lines.map((l) => l.productId);
          const products = await client.query(
            `SELECT id, name, unit_price, low_stock_threshold FROM products WHERE org_id = $1 AND id = ANY($2)`,
            [orgId, ids]
          );
          prodMap = new Map(products.rows.map((r) => [r.id, r]));

          let total = 0;
          const priced = [];
          changed = [];

          for (const l of lines) {
            const p = prodMap.get(l.productId);
            if (!p) {
              const e = new Error(`unknown product ${l.productId}`);
              e.rejection = 'UNKNOWN_PRODUCT';
              throw e;
            }

            const upd = await client.query(
              `UPDATE van_stock
                  SET qty = qty - $3, version = version + 1, updated_at = now()
                WHERE org_id = $1 AND user_id = $2 AND product_id = $4 AND qty >= $3
                RETURNING qty`,
              [orgId, userId, l.quantity, l.productId]
            );

            if (upd.rowCount === 0) {
              const cur = await client.query(
                `SELECT qty FROM van_stock WHERE org_id=$1 AND user_id=$2 AND product_id=$3`,
                [orgId, userId, l.productId]
              );
              const have = cur.rowCount ? cur.rows[0].qty : 0;
              const e = new Error(`${p.name}: ${have} in van, ${l.quantity} requested`);
              e.rejection = 'INSUFFICIENT_STOCK';
              throw e;
            }

            const remaining = upd.rows[0].qty;
            const unit = Number(p.unit_price);
            const lineTotal = unit * l.quantity;
            total += lineTotal;
            priced.push({ product_id: l.productId, quantity: l.quantity, unit_price: unit, line_total: lineTotal });
            changed.push({ productId: l.productId, remaining });
          }

          await client.query(
            `INSERT INTO stock_reservations (org_id, user_id, idempotency_key, lines, total)
             VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [orgId, userId, idempotencyKey || `auto-${Date.now()}`, JSON.stringify(priced), total]
          );

          return { ok: true, total, lines: priced, reservationId: idempotencyKey || null };
        });

        for (const c of changed) {
          const p = prodMap.get(c.productId);
          stockEvents.emit('change', {
            orgId, productId: c.productId, remaining: c.remaining,
            low: c.remaining <= (p?.low_stock_threshold ?? 10),
            at: new Date().toISOString(),
          });
        }

        return result;
      } catch (err) {
        if (err.rejection) {
          return { ok: false, rejection: err.rejection, detail: err.message };
        }
        logger?.error?.({ err: err.message }, 'pricingRepo: priceAndReserve failed');
        throw err;
      }
    },

    async currentStock({ orgId, userId, productIds }) {
      const { rows } = await db.query(
        `SELECT vs.product_id, vs.qty, p.low_stock_threshold AS threshold
           FROM van_stock vs
           JOIN products p ON p.id = vs.product_id
          WHERE vs.org_id = $1 AND vs.user_id = $2
            AND ($3::uuid[] IS NULL OR vs.product_id = ANY($3))`,
        [orgId, userId, productIds && productIds.length ? productIds : null]
      );
      return rows;
    },
  };
}

module.exports = { createPricingRepo, createStockEvents };
