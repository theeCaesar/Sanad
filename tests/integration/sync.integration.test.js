
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const path = require('path');
const { execSync } = require('child_process');

const db = require('../../src/db/pool');
const repo = require('../../src/repositories/syncRepository');
const { createSyncService } = require('../../src/services/syncService');
const { MUTATION_TYPES, JOB_STATUS } = require('../../src/constants');

jest.setTimeout(120_000);

let container;
let pool;
let sync;

let orgId; let driverId; let otherDriverId; let dispatcherId;
let deviceId; let customerId; let productId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sanad')
    .withUsername('sanad')
    .withPassword('sanad')
    .start();

  const url = container.getConnectionUri();
  pool = new Pool({ connectionString: url });

  execSync(`npx node-pg-migrate up -m src/db/migrations`, {
    env: { ...process.env, DATABASE_URL: url },
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'pipe',
  });

  db.setPool(pool);

  sync = createSyncService({
    db,
    repo,
    logger: { info() {}, warn() {}, error() {}, debug() {}, child: () => ({ info() {}, warn() {}, error() {} }) },
    uuid: randomUUID,
  });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE orgs, users, devices, customers, jobs, products,
                    van_stock, orders, order_lines, cash_entries, mutations,
                    outbox, sagas, notifications RESTART IDENTITY CASCADE`);

  const org = await pool.query(
    `INSERT INTO orgs (name, slug, modules) VALUES ('Demo','demo', ARRAY['delivery','field_sales']) RETURNING id`
  );
  orgId = org.rows[0].id;

  const users = await pool.query(
    `INSERT INTO users (org_id, name, phone, role) VALUES
       ($1,'Ali','07701','driver'),
       ($1,'Omar','07702','driver'),
       ($1,'Zaid','07703','dispatcher')
     RETURNING id, role, name`,
    [orgId]
  );
  driverId = users.rows[0].id;
  otherDriverId = users.rows[1].id;
  dispatcherId = users.rows[2].id;

  const dev = await pool.query(
    `INSERT INTO devices (org_id, user_id, label) VALUES ($1,$2,'Ali phone') RETURNING id`,
    [orgId, driverId]
  );
  deviceId = dev.rows[0].id;

  const cust = await pool.query(
    `INSERT INTO customers (org_id, name, phone) VALUES ($1,'Um Ahmed','07800') RETURNING id`,
    [orgId]
  );
  customerId = cust.rows[0].id;

  const prod = await pool.query(
    `INSERT INTO products (org_id, sku, name, unit_price) VALUES ($1,'SKU1','Water 1L',1000) RETURNING id`,
    [orgId]
  );
  productId = prod.rows[0].id;
});

const ctx = () => ({ orgId, userId: driverId, deviceId, role: 'driver' });

async function makeJob(overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (org_id, ref, customer_id, assigned_to, status, cod_amount)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [orgId, overrides.ref || `JOB-${Math.random().toString(36).slice(2, 7)}`,
     customerId, overrides.assigned_to ?? driverId,
     overrides.status || JOB_STATUS.PICKED_UP, overrides.cod_amount ?? 0]
  );
  return rows[0];
}

const mut = (o) => ({
  mutation_id: randomUUID(),
  seq: 1,
  client_ts: new Date().toISOString(),
  payload: {},
  ...o,
});

describe('the Abu Ghraib scenario, for real', () => {
  test('a delivery synced 3 hours late beats a reassignment made in between', async () => {
    const job = await makeJob({ status: JOB_STATUS.PICKED_UP });
    const baseVersion = job.version;

    await pool.query(
      `UPDATE jobs SET previous_assigned_to = assigned_to, assigned_to = $2,
              status = 'assigned', version = version + 1
        WHERE id = $1`,
      [job.id, otherDriverId]
    );

    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_DELIVER,
      entity_id: job.id,
      base_version: baseVersion,
      client_ts: '2026-07-13T14:02:00.000Z',
      payload: { recipient_name: 'Um Ahmed' },
    })]);

    const verdict = res.results[0];
    expect(verdict.outcome).toBe('conflict');
    expect(verdict.resolution).toBe('field_wins');

    const after = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [job.id]);
    expect(after.rows[0].status).toBe(JOB_STATUS.DELIVERED);
    expect(after.rows[0].recipient_name).toBe('Um Ahmed');
    expect(after.rows[0].delivered_at.toISOString()).toBe('2026-07-13T14:02:00.000Z');

    const ledger = await pool.query(
      `SELECT * FROM mutations WHERE entity_id = $1`, [job.id]
    );
    expect(ledger.rows[0].resolution).toBe('field_wins');
    expect(ledger.rows[0].resolution_reason).toMatch(/physical truth/i);
    const dark = (ledger.rows[0].received_at - ledger.rows[0].client_ts) / 1000;
    expect(dark).toBeGreaterThan(3600);
  });
});

describe('idempotency against a real UNIQUE constraint', () => {
  test('syncing the SAME batch twice applies it ONCE', async () => {
    const job = await makeJob({ status: JOB_STATUS.PICKED_UP, cod_amount: 25000 });

    const batch = [mut({
      type: MUTATION_TYPES.JOB_DELIVER,
      entity_id: job.id,
      base_version: job.version,
    })];

    const first = await sync.push(ctx(), batch);
    expect(first.results[0].outcome).toBe('applied');

    const second = await sync.push(ctx(), batch);
    expect(second.results[0].outcome).toBe('duplicate');

    const ledger = await pool.query(`SELECT count(*)::int AS n FROM mutations`);
    expect(ledger.rows[0].n).toBe(1);

    const after = await pool.query(`SELECT version FROM jobs WHERE id = $1`, [job.id]);
    expect(after.rows[0].version).toBe(job.version + 1);
  });

  test('a retried CASH COLLECTION does not double-count the money', async () => {
    const job = await makeJob({ status: JOB_STATUS.PICKED_UP, cod_amount: 25000 });

    const batch = [mut({
      type: MUTATION_TYPES.CASH_COLLECT,
      entity_id: job.id,
      base_version: job.version,
      payload: { amount: 25000 },
    })];

    await sync.push(ctx(), batch);
    await sync.push(ctx(), batch);
    await sync.push(ctx(), batch);

    const cash = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(amount),0)::int AS total FROM cash_entries`
    );
    expect(cash.rows[0].n).toBe(1);
    expect(cash.rows[0].total).toBe(25000);
  });
});

describe('atomicity: a failed order leaves NO partial state', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO van_stock (org_id, user_id, product_id, qty) VALUES ($1,$2,$3,10)`,
      [orgId, driverId, productId]
    );
  });

  test('an order that exceeds van stock rolls back COMPLETELY', async () => {
    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      entity_id: null,
      base_version: null,
      payload: {
        customer_id: customerId,
        lines: [{ product_id: productId, qty: 50 }],
        paid: 50000,
      },
    })]);

    expect(res.results[0].outcome).toBe('rejected');
    expect(res.results[0].reason).toMatch(/insufficient van stock/i);

    const [orders, lines, cash, stock] = await Promise.all([
      pool.query(`SELECT count(*)::int AS n FROM orders`),
      pool.query(`SELECT count(*)::int AS n FROM order_lines`),
      pool.query(`SELECT count(*)::int AS n FROM cash_entries`),
      pool.query(`SELECT qty FROM van_stock WHERE user_id = $1`, [driverId]),
    ]);

    expect(orders.rows[0].n).toBe(0);
    expect(lines.rows[0].n).toBe(0);
    expect(cash.rows[0].n).toBe(0);
    expect(stock.rows[0].qty).toBe(10);
  });

  test('a MULTI-LINE order where the SECOND line fails rolls back the FIRST', async () => {
    const p2 = await pool.query(
      `INSERT INTO products (org_id, sku, name, unit_price) VALUES ($1,'SKU2','Bread',500) RETURNING id`,
      [orgId]
    );
    await pool.query(
      `INSERT INTO van_stock (org_id, user_id, product_id, qty) VALUES ($1,$2,$3,2)`,
      [orgId, driverId, p2.rows[0].id]
    );

    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      payload: {
        customer_id: customerId,
        lines: [
          { product_id: productId, qty: 5 },
          { product_id: p2.rows[0].id, qty: 99 },
        ],
      },
    })]);

    expect(res.results[0].outcome).toBe('rejected');

    const stock = await pool.query(
      `SELECT product_id, qty FROM van_stock WHERE user_id = $1 ORDER BY qty DESC`,
      [driverId]
    );
    expect(stock.rows.find((r) => r.product_id === productId).qty).toBe(10);
    expect(stock.rows.find((r) => r.product_id === p2.rows[0].id).qty).toBe(2);
  });

  test('a SUCCESSFUL order writes the order, the lines, the cash AND the outbox event — atomically', async () => {
    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      payload: {
        customer_id: customerId,
        lines: [{ product_id: productId, qty: 3 }],
        paid: 3000,
      },
    })]);

    expect(res.results[0].outcome).toBe('applied');

    const [orders, lines, cash, stock, outbox] = await Promise.all([
      pool.query(`SELECT * FROM orders`),
      pool.query(`SELECT * FROM order_lines`),
      pool.query(`SELECT * FROM cash_entries`),
      pool.query(`SELECT qty FROM van_stock WHERE user_id = $1`, [driverId]),
      pool.query(`SELECT * FROM outbox`),
    ]);

    expect(orders.rows).toHaveLength(1);
    expect(Number(orders.rows[0].total)).toBe(3000);
    expect(lines.rows).toHaveLength(1);
    expect(cash.rows).toHaveLength(1);
    expect(stock.rows[0].qty).toBe(7);

    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].event_type).toBe('order.created');
    expect(outbox.rows[0].status).toBe('pending');
  });

  test('the DB refuses negative stock even if the application logic is bypassed', async () => {
    await expect(
      pool.query(`UPDATE van_stock SET qty = -1 WHERE user_id = $1`, [driverId])
    ).rejects.toThrow(/van_stock_qty_nonneg/);
  });
});

describe('optimistic locking', () => {
  test('a stale write is DETECTED, not silently applied', async () => {
    const job = await makeJob({ status: JOB_STATUS.ACCEPTED });
    const stale = job.version;

    await pool.query(`UPDATE jobs SET version = version + 1, priority = 9 WHERE id = $1`, [job.id]);

    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_PICKUP,
      entity_id: job.id,
      base_version: stale,
    })]);

    expect(res.results[0].outcome).toBe('conflict');
    expect(res.results[0].resolution).toBe('merged');
  });
});

describe('security: a driver cannot mutate another driver\'s job', () => {
  test('BOLA is refused at the row, and RECORDED', async () => {
    const job = await makeJob({ assigned_to: otherDriverId, status: JOB_STATUS.PICKED_UP });

    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_DELIVER,
      entity_id: job.id,
      base_version: job.version,
    })]);

    expect(res.results[0].outcome).toBe('rejected');
    expect(res.results[0].reason).toMatch(/not assigned to you/i);

    const after = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [job.id]);
    expect(after.rows[0].status).toBe(JOB_STATUS.PICKED_UP);

    const ledger = await pool.query(`SELECT * FROM mutations WHERE outcome = 'rejected'`);
    expect(ledger.rows).toHaveLength(1);
  });
});

describe('ordering within a batch', () => {
  test('accept → pickup → deliver applies correctly even when sent out of order', async () => {
    const job = await makeJob({ status: JOB_STATUS.ASSIGNED });

    const res = await sync.push(ctx(), [
      mut({ seq: 3, type: MUTATION_TYPES.JOB_DELIVER, entity_id: job.id, base_version: 3 }),
      mut({ seq: 1, type: MUTATION_TYPES.JOB_ACCEPT, entity_id: job.id, base_version: 1 }),
      mut({ seq: 2, type: MUTATION_TYPES.JOB_PICKUP, entity_id: job.id, base_version: 2 }),
    ]);

    expect(res.summary.applied).toBe(3);
    expect(res.summary.rejected).toBe(0);

    const after = await pool.query(`SELECT status, version FROM jobs WHERE id = $1`, [job.id]);
    expect(after.rows[0].status).toBe(JOB_STATUS.DELIVERED);
    expect(after.rows[0].version).toBe(4);
  });
});

describe('partial success', () => {
  test('a rejected mutation does not roll back the good ones', async () => {
    const good1 = await makeJob({ status: JOB_STATUS.PICKED_UP });
    const good2 = await makeJob({ status: JOB_STATUS.PICKED_UP });
    const cancelled = await makeJob({ status: JOB_STATUS.CANCELLED });

    const res = await sync.push(ctx(), [
      mut({ seq: 1, type: MUTATION_TYPES.JOB_DELIVER, entity_id: good1.id, base_version: good1.version }),
      mut({ seq: 2, type: MUTATION_TYPES.JOB_ACCEPT, entity_id: cancelled.id, base_version: cancelled.version }),
      mut({ seq: 3, type: MUTATION_TYPES.JOB_DELIVER, entity_id: good2.id, base_version: good2.version }),
    ]);

    expect(res.summary.applied).toBe(2);
    expect(res.summary.rejected).toBe(1);

    const delivered = await pool.query(
      `SELECT count(*)::int AS n FROM jobs WHERE status = 'delivered'`
    );
    expect(delivered.rows[0].n).toBe(2);
  });
});
