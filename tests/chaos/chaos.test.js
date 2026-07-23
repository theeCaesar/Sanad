
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

const db = require('../../src/db/pool');
const repo = require('../../src/repositories/syncRepository');
const { createSyncService } = require('../../src/services/syncService');
const { MUTATION_TYPES, JOB_STATUS } = require('../../src/constants');

jest.setTimeout(180_000);

const noop = { info() {}, warn() {}, error() {}, debug() {}, child() { return noop; } };

let container; let pool; let sync;
let orgId; let driverId; let deviceId; let customerId; let productId;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sanad').withUsername('sanad').withPassword('sanad').start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  execSync('npx node-pg-migrate up -m src/db/migrations', {
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    cwd: path.resolve(__dirname, '../..'), stdio: 'pipe',
  });

  db.setPool(pool);
  sync = createSyncService({ db, repo, logger: noop, uuid: randomUUID });
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE orgs, users, devices, customers, jobs, products, van_stock,
                    orders, order_lines, cash_entries, mutations, outbox, sagas,
                    notifications, processed_events RESTART IDENTITY CASCADE`);

  const org = await pool.query(`INSERT INTO orgs (name,slug) VALUES ('C','c') RETURNING id`);
  orgId = org.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (org_id,name,phone,role) VALUES ($1,'Ali','1','driver') RETURNING id`, [orgId]
  );
  driverId = u.rows[0].id;
  const d = await pool.query(
    `INSERT INTO devices (org_id,user_id) VALUES ($1,$2) RETURNING id`, [orgId, driverId]
  );
  deviceId = d.rows[0].id;
  const c = await pool.query(
    `INSERT INTO customers (org_id,name) VALUES ($1,'Um Ahmed') RETURNING id`, [orgId]
  );
  customerId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO products (org_id,sku,name,unit_price) VALUES ($1,'S','Water',1000) RETURNING id`, [orgId]
  );
  productId = p.rows[0].id;
});

const ctx = () => ({ orgId, userId: driverId, deviceId, role: 'driver' });
const mut = (o) => ({
  mutation_id: randomUUID(), seq: 1,
  client_ts: new Date().toISOString(), payload: {}, ...o,
});

async function makeJob(status = JOB_STATUS.PICKED_UP, cod = 25000) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (org_id,ref,customer_id,assigned_to,status,cod_amount)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [orgId, `J-${Math.random().toString(36).slice(2, 7)}`, customerId, driverId, status, cod]
  );
  return rows[0];
}

describe('CHAOS: the process dies mid-transaction', () => {
  test('a crash between the entity write and the outbox write leaves NOTHING', async () => {
    const job = await makeJob();

    const brokenRepo = {
      ...repo,
      enqueueEvent: async () => { throw new Error('SIGKILL mid-transaction'); },
    };
    const brokenSync = createSyncService({
      db, repo: brokenRepo, logger: noop, uuid: randomUUID,
    });

    const res = await brokenSync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_DELIVER,
      entity_id: job.id,
      base_version: job.version,
    })]);

    expect(res.results[0].outcome).toBe('rejected');

    const after = await pool.query(`SELECT status, version FROM jobs WHERE id=$1`, [job.id]);
    expect(after.rows[0].status).toBe(JOB_STATUS.PICKED_UP);
    expect(after.rows[0].version).toBe(job.version);

    const outbox = await pool.query(`SELECT count(*)::int n FROM outbox`);
    expect(outbox.rows[0].n).toBe(0);
  });

  test('and the device can RETRY successfully afterwards — no phantom dedupe', async () => {
    const job = await makeJob();
    const m = mut({
      type: MUTATION_TYPES.JOB_DELIVER,
      entity_id: job.id,
      base_version: job.version,
    });

    const brokenSync = createSyncService({
      db,
      repo: { ...repo, enqueueEvent: async () => { throw new Error('crash'); } },
      logger: noop, uuid: randomUUID,
    });
    await brokenSync.push(ctx(), [m]);

    const ledger1 = await pool.query(`SELECT count(*)::int n FROM mutations`);
    expect(ledger1.rows[0].n).toBe(0);

    const res = await sync.push(ctx(), [m]);

    expect(res.results[0].outcome).toBe('applied');

    const after = await pool.query(`SELECT status FROM jobs WHERE id=$1`, [job.id]);
    expect(after.rows[0].status).toBe(JOB_STATUS.DELIVERED);
  });
});

describe('CHAOS: the publisher dies after Kafka accepted, before marking published', () => {
  test('the event is republished — AT-LEAST-ONCE, never lost', async () => {
    const job = await makeJob();
    await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_DELIVER, entity_id: job.id, base_version: job.version,
    })]);

    const claimed = await db.withTransaction((c) => repo.claimPendingEvents(c, 10));
    expect(claimed).toHaveLength(1);

    const still = await pool.query(`SELECT status FROM outbox`);
    expect(still.rows[0].status).toBe('pending');

    const second = await db.withTransaction(async (c) => {
      const rows = await repo.claimPendingEvents(c, 10);
      await repo.markPublished(c, rows.map((r) => r.id));
      return rows;
    });
    expect(second).toHaveLength(1);

    const final = await pool.query(`SELECT status FROM outbox`);
    expect(final.rows[0].status).toBe('published');
  });
});

describe('CHAOS: the consumer receives a duplicate (which CHAOS 2 guarantees)', () => {
  test('the second sighting is absorbed — the customer is NOT told twice', async () => {
    const { claimEvent } = require('../../src/workers/notificationConsumer');

    const first = await db.withTransaction(async (c) => {
      const ok = await claimEvent(c, { eventId: 'evt-1', group: 'notifications' });
      if (ok) {
        await c.query(
          `INSERT INTO notifications (org_id,user_id,key,params) VALUES ($1,$2,'JOB_DELIVERED','{}')`,
          [orgId, driverId]
        );
      }
      return ok;
    });
    expect(first).toBe(true);

    const second = await db.withTransaction(async (c) => {
      const ok = await claimEvent(c, { eventId: 'evt-1', group: 'notifications' });
      if (ok) {
        await c.query(
          `INSERT INTO notifications (org_id,user_id,key,params) VALUES ($1,$2,'JOB_DELIVERED','{}')`,
          [orgId, driverId]
        );
      }
      return ok;
    });

    expect(second).toBe(false);

    const n = await pool.query(`SELECT count(*)::int n FROM notifications`);
    expect(n.rows[0].n).toBe(1);
  });

  test('but a DIFFERENT consumer group still gets it — fan-out is not broken', async () => {
    const { claimEvent } = require('../../src/workers/notificationConsumer');

    const notif = await db.withTransaction((c) =>
      claimEvent(c, { eventId: 'evt-2', group: 'notifications' }));
    const analytics = await db.withTransaction((c) =>
      claimEvent(c, { eventId: 'evt-2', group: 'analytics' }));

    expect(notif).toBe(true);
    expect(analytics).toBe(true);
  });
});

describe('CHAOS: Kafka is completely down', () => {
  test('drivers can STILL WORK. Nothing is lost. This is why the publisher is separate.', async () => {
    const job = await makeJob();

    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_DELIVER, entity_id: job.id, base_version: job.version,
    })]);

    expect(res.results[0].outcome).toBe('applied');

    const after = await pool.query(`SELECT status FROM jobs WHERE id=$1`, [job.id]);
    expect(after.rows[0].status).toBe(JOB_STATUS.DELIVERED);

    const outbox = await pool.query(`SELECT status FROM outbox`);
    expect(outbox.rows[0].status).toBe('pending');

  });

  test('a poison event dead-letters after N attempts instead of blocking the queue', async () => {
    const job = await makeJob();
    await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.JOB_DELIVER, entity_id: job.id, base_version: job.version,
    })]);

    const { rows } = await pool.query(`SELECT id FROM outbox`);
    const id = rows[0].id;

    let status;
    for (let i = 0; i < 5; i++) {
      status = await db.withTransaction((c) => repo.markFailed(c, id, 'kafka unreachable', 5));
    }

    expect(status.status).toBe('failed');

    const pending = await db.withTransaction((c) => repo.claimPendingEvents(c, 10));
    expect(pending).toHaveLength(0);
  });
});

describe('CHAOS: concurrent syncs for the same job', () => {
  test('a device retrying while its first request is still in flight does not double-apply', async () => {
    const job = await makeJob();
    const m = mut({
      type: MUTATION_TYPES.JOB_DELIVER,
      entity_id: job.id,
      base_version: job.version,
    });

    const [a, b] = await Promise.all([
      sync.push(ctx(), [m]),
      sync.push(ctx(), [m]),
    ]);

    const outcomes = [a.results[0].outcome, b.results[0].outcome].sort();

    expect(outcomes).toEqual(['applied', 'duplicate']);

    const ledger = await pool.query(`SELECT count(*)::int n FROM mutations`);
    expect(ledger.rows[0].n).toBe(1);

    const version = await pool.query(`SELECT version FROM jobs WHERE id=$1`, [job.id]);
    expect(version.rows[0].version).toBe(job.version + 1);
  });

  test('and concurrent CASH collections do not double-count the money', async () => {
    const job = await makeJob(JOB_STATUS.PICKED_UP, 25000);
    const m = mut({
      type: MUTATION_TYPES.CASH_COLLECT,
      entity_id: job.id,
      base_version: job.version,
      payload: { amount: 25000 },
    });

    await Promise.all([
      sync.push(ctx(), [m]),
      sync.push(ctx(), [m]),
      sync.push(ctx(), [m]),
    ]);

    const cash = await pool.query(
      `SELECT count(*)::int n, COALESCE(SUM(amount),0)::int total FROM cash_entries`
    );
    expect(cash.rows[0].n).toBe(1);
    expect(cash.rows[0].total).toBe(25000);
  });
});

describe('CHAOS: an order fails on its LAST line', () => {
  test('every earlier stock decrement is rolled back', async () => {
    const p2 = await pool.query(
      `INSERT INTO products (org_id,sku,name,unit_price) VALUES ($1,'S2','Bread',500) RETURNING id`,
      [orgId]
    );
    await pool.query(
      `INSERT INTO van_stock (org_id,user_id,product_id,qty) VALUES ($1,$2,$3,10),($1,$2,$4,2)`,
      [orgId, driverId, productId, p2.rows[0].id]
    );

    const res = await sync.push(ctx(), [mut({
      type: MUTATION_TYPES.ORDER_CREATE,
      entity_id: null,
      base_version: null,
      payload: {
        customer_id: customerId,
        lines: [
          { product_id: productId, qty: 5 },
          { product_id: p2.rows[0].id, qty: 99 },
        ],
        paid: 10000,
      },
    })]);

    expect(res.results[0].outcome).toBe('rejected');

    const stock = await pool.query(
      `SELECT product_id, qty FROM van_stock WHERE user_id=$1`, [driverId]
    );
    expect(stock.rows.find((r) => r.product_id === productId).qty).toBe(10);
    expect(stock.rows.find((r) => r.product_id === p2.rows[0].id).qty).toBe(2);

    const counts = await pool.query(`
      SELECT (SELECT count(*)::int FROM orders)      AS o,
             (SELECT count(*)::int FROM order_lines) AS l,
             (SELECT count(*)::int FROM cash_entries) AS c,
             (SELECT count(*)::int FROM outbox)      AS e`);
    expect(counts.rows[0]).toEqual({ o: 0, l: 0, c: 0, e: 0 });
  });
});
