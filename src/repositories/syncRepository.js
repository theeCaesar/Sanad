
const TABLE = { job: 'jobs', visit: 'visits' };

async function findSeenMutationIds(client, ids) {
  if (ids.length === 0) return new Set();
  const { rows } = await client.query(
    `SELECT mutation_id FROM mutations WHERE mutation_id = ANY($1::uuid[])`,
    [ids]
  );
  return new Set(rows.map((r) => r.mutation_id));
}

async function getMutationResults(client, ids) {
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `SELECT mutation_id, outcome, resolution, resolution_reason,
            server_version_after, entity, entity_id, error
       FROM mutations
      WHERE mutation_id = ANY($1::uuid[])`,
    [ids]
  );
  return rows;
}

async function lockEntity(client, entity, orgId, id) {
  const table = TABLE[entity];
  if (!table) throw new Error(`lockEntity: unknown entity "${entity}"`);
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [id, orgId]
  );
  return rows[0] || null;
}

async function fieldsChangedSince(client, entity, entityId, baseVersion) {
  const { rows } = await client.query(
    `SELECT payload
       FROM mutations
      WHERE entity = $1
        AND entity_id = $2
        AND outcome = 'applied'
        AND server_version_before >= $3
      ORDER BY received_at ASC`,
    [entity, entityId, baseVersion]
  );
  const changed = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r.payload || {})) changed.add(k);
  }
  return [...changed];
}

async function applyEntityUpdate(client, {
  entity, orgId, id, fields, expectedVersion, mutationId, deviceId,
}) {
  const table = TABLE[entity];
  if (!table) throw new Error(`applyEntityUpdate: unknown entity "${entity}"`);

  const keys = Object.keys(fields);
  if (keys.length === 0) return { rowCount: 0, row: null };

  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const values = keys.map((k) => fields[k]);
  let p = keys.length;

  sets.push(`version = version + 1`);
  sets.push(`last_mutation_id = $${++p}`); values.push(mutationId);
  sets.push(`last_device_id = $${++p}`);   values.push(deviceId);

  const where = [`id = $${++p}`]; values.push(id);
  where.push(`org_id = $${++p}`); values.push(orgId);

  if (expectedVersion !== null && expectedVersion !== undefined) {
    where.push(`version = $${++p}`);
    values.push(expectedVersion);
  }

  const { rows, rowCount } = await client.query(
    `UPDATE ${table} SET ${sets.join(', ')}
      WHERE ${where.join(' AND ')}
      RETURNING *`,
    values
  );
  return { rowCount, row: rows[0] || null };
}

async function recordMutation(client, m) {
  await client.query('SAVEPOINT record_mutation');
  try {
    const { rows } = await client.query(
      `INSERT INTO mutations (
         mutation_id, org_id, device_id, user_id, seq, type, entity, entity_id,
         payload, base_version, client_ts, outcome, resolution, resolution_reason,
         server_version_before, server_version_after, error
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        m.mutation_id, m.org_id, m.device_id, m.user_id, m.seq, m.type, m.entity,
        m.entity_id, m.payload, m.base_version, m.client_ts, m.outcome,
        m.resolution || null, m.resolution_reason || null,
        m.server_version_before ?? null, m.server_version_after ?? null,
        m.error || null,
      ]
    );
    await client.query('RELEASE SAVEPOINT record_mutation');
    return { inserted: true, row: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT record_mutation');
    if (err.code === '23505') return { inserted: false, row: null };
    throw err;
  }
}

async function bumpDeviceSeq(client, deviceId, seq) {
  await client.query(
    `UPDATE devices
        SET last_applied_seq = GREATEST(last_applied_seq, $2),
            last_seen_at = now()
      WHERE id = $1`,
    [deviceId, seq]
  );
}

async function enqueueEvent(client, { orgId, topic, eventType, partitionKey, payload, traceId }) {
  const { rows } = await client.query(
    `INSERT INTO outbox (org_id, topic, event_type, partition_key, payload, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, topic, eventType, partitionKey, payload, traceId || null]
  );
  return rows[0].id;
}

async function claimPendingEvents(client, limit = 100) {
  const { rows } = await client.query(
    `SELECT * FROM outbox
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit]
  );
  return rows;
}

async function markPublished(client, ids) {
  if (!ids.length) return;
  await client.query(
    `UPDATE outbox SET status='published', published_at=now() WHERE id = ANY($1::bigint[])`,
    [ids]
  );
}

async function markFailed(client, id, error, maxAttempts = 5) {
  const { rows } = await client.query(
    `UPDATE outbox
        SET attempts = attempts + 1,
            last_error = $2,
            status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
      WHERE id = $1
      RETURNING status, attempts`,
    [id, String(error).slice(0, 500), maxAttempts]
  );
  return rows[0];
}

async function pullChanges(client, { orgId, userId, since, limit = 500 }) {
  const params = [orgId, userId, limit];
  const sinceClause = since ? `AND updated_at >= $4` : '';
  if (since) params.push(since);

  const jobs = await client.query(
    `SELECT * FROM jobs
      WHERE org_id = $1 AND assigned_to = $2 ${sinceClause}
      ORDER BY updated_at ASC LIMIT $3`,
    params
  );
  const visits = await client.query(
    `SELECT * FROM visits
      WHERE org_id = $1 AND assigned_to = $2 ${sinceClause}
      ORDER BY updated_at ASC LIMIT $3`,
    params
  );
  const stock = await client.query(
    `SELECT vs.*, p.sku, p.name, p.unit_price
       FROM van_stock vs JOIN products p ON p.id = vs.product_id
      WHERE vs.org_id = $1 AND vs.user_id = $2`,
    [orgId, userId]
  );
  return { jobs: jobs.rows, visits: visits.rows, stock: stock.rows };
}

async function setPullCursor(client, deviceId, at) {
  await client.query(
    `UPDATE devices SET last_pulled_at = $2, last_seen_at = now() WHERE id = $1`,
    [deviceId, at]
  );
}

async function decrementVanStock(client, { orgId, userId, productId, qty }) {
  const { rowCount, rows } = await client.query(
    `UPDATE van_stock
        SET qty = qty - $4, version = version + 1, updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND product_id = $3 AND qty >= $4
      RETURNING qty, version`,
    [orgId, userId, productId, qty]
  );
  return { ok: rowCount === 1, remaining: rows[0]?.qty ?? null };
}

async function insertOrder(client, o) {
  const { rows } = await client.query(
    `INSERT INTO orders (org_id, visit_id, customer_id, created_by, subtotal,
                         discount, total, paid, client_ts, last_mutation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [o.org_id, o.visit_id, o.customer_id, o.created_by, o.subtotal,
     o.discount, o.total, o.paid, o.client_ts, o.last_mutation_id]
  );
  return rows[0];
}

async function insertOrderLines(client, orderId, lines) {
  for (const l of lines) {
    await client.query(
      `INSERT INTO order_lines (order_id, product_id, qty, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5)`,
      [orderId, l.product_id, l.qty, l.unit_price, l.line_total]
    );
  }
}

async function insertCashEntry(client, c) {
  const { rows } = await client.query(
    `INSERT INTO cash_entries (org_id, user_id, job_id, order_id, amount, kind,
                               mutation_id, client_ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (mutation_id) DO NOTHING
     RETURNING *`,
    [c.org_id, c.user_id, c.job_id || null, c.order_id || null, c.amount,
     c.kind, c.mutation_id, c.client_ts]
  );
  return rows[0] || null;
}

async function getProducts(client, orgId, ids) {
  const { rows } = await client.query(
    `SELECT id, sku, name, unit_price, low_stock_threshold
       FROM products WHERE org_id = $1 AND id = ANY($2::uuid[])`,
    [orgId, ids]
  );
  return rows;
}

async function getLowStock(client, orgId, userId) {
  const { rows } = await client.query(
    `SELECT vs.product_id, p.name, p.sku, vs.qty, p.low_stock_threshold
       FROM van_stock vs JOIN products p ON p.id = vs.product_id
      WHERE vs.org_id = $1 AND vs.user_id = $2 AND vs.qty <= p.low_stock_threshold`,
    [orgId, userId]
  );
  return rows;
}

module.exports = {
  TABLE,
  findSeenMutationIds,
  getMutationResults,
  lockEntity,
  fieldsChangedSince,
  applyEntityUpdate,
  recordMutation,
  bumpDeviceSeq,
  enqueueEvent,
  claimPendingEvents,
  markPublished,
  markFailed,
  pullChanges,
  setPullCursor,
  decrementVanStock,
  insertOrder,
  insertOrderLines,
  insertCashEntry,
  getProducts,
  getLowStock,
};
