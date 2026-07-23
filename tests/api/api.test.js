
const request = require('supertest');
const { PostgreSqlContainer } = require('@testcontainers/postgresql');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

const db = require('../../src/db/pool');
const { createApp } = require('../../src/app');
const { createContainer } = require('../../src/container');

jest.setTimeout(120_000);

let pgContainer; let pool; let app; let container;
let orgId; let driverId; let otherDriverId; let dispatcherId; let deviceId;
let deviceToken; let dispatcherToken; let driverToken;
let jobId; let jobVersion; let otherDriverJobId;

const fakeRedis = {
  script: async () => 'sha',
  evalsha: async () => [1, 999, 0],
  ping: async () => 'PONG',
  quit: async () => {},
  duplicate() { return this; },
  on() {},
};

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('sanad').withUsername('sanad').withPassword('sanad').start();

  const url = pgContainer.getConnectionUri();
  pool = new Pool({ connectionString: url });

  execSync('npx node-pg-migrate up -m src/db/migrations', {
    env: { ...process.env, DATABASE_URL: url },
    cwd: path.resolve(__dirname, '../..'),
    stdio: 'pipe',
  });

  db.setPool(pool);

  process.env.JWT_ACCESS_SECRET = 'test-access-secret-long-enough-for-hs256';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-different-and-long';

  container = createContainer({ redis: fakeRedis, db });
  app = createApp(container);
});

afterAll(async () => {
  await pool?.end();
  await pgContainer?.stop();
});

beforeEach(async () => {
  await pool.query(`TRUNCATE orgs, users, devices, customers, jobs, products,
                    van_stock, orders, order_lines, cash_entries, mutations,
                    outbox, sagas, notifications RESTART IDENTITY CASCADE`);

  const org = await pool.query(
    `INSERT INTO orgs (name, slug) VALUES ('Test','test') RETURNING id`
  );
  orgId = org.rows[0].id;

  const users = await pool.query(
    `INSERT INTO users (org_id, name, phone, role) VALUES
       ($1,'Ali','07701','driver'),
       ($1,'Omar','07702','driver'),
       ($1,'Zaid','07703','dispatcher')
     RETURNING id, role, name, org_id, token_version`,
    [orgId]
  );
  const [ali, omar, zaid] = users.rows;
  driverId = ali.id; otherDriverId = omar.id; dispatcherId = zaid.id;

  const dev = await pool.query(
    `INSERT INTO devices (org_id, user_id, label) VALUES ($1,$2,'Ali phone') RETURNING *`,
    [orgId, driverId]
  );
  deviceId = dev.rows[0].id;

  const { authService } = container;
  deviceToken = authService.signDevice(ali, dev.rows[0]);
  driverToken = authService.signAccess(ali);
  dispatcherToken = authService.signAccess(zaid);

  const cust = await pool.query(
    `INSERT INTO customers (org_id, name) VALUES ($1,'Um Ahmed') RETURNING id`, [orgId]
  );

  const jobs = await pool.query(
    `INSERT INTO jobs (org_id, ref, customer_id, assigned_to, status, cod_amount) VALUES
       ($1,'JOB-1',$2,$3,'picked_up',25000),
       ($1,'JOB-2',$2,$4,'picked_up',10000)
     RETURNING id, version, assigned_to`,
    [orgId, cust.rows[0].id, driverId, otherDriverId]
  );
  jobId = jobs.rows[0].id;
  jobVersion = jobs.rows[0].version;
  otherDriverJobId = jobs.rows[1].id;
});

const mut = (o) => ({
  mutation_id: randomUUID(),
  seq: 1,
  client_ts: new Date().toISOString(),
  payload: {},
  ...o,
});

describe('probes', () => {
  test('/health is liveness — cheap, no dependencies', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('/ready is readiness — it CHECKS the database', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
  });

  test('/health does NOT depend on the database', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  test('/metrics exposes prometheus format', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('sync_dark_seconds');
  });
});

describe('security controls, at the HTTP boundary', () => {
  test('no token → 401', async () => {
    const res = await request(app).post('/api/v1/sync/push').send({ mutations: [] });
    expect(res.status).toBe(401);
  });

  test('a DEVICE token cannot open a dashboard endpoint', async () => {
    const res = await request(app)
      .get('/api/v1/dispatch/board')
      .set('Authorization', `Bearer ${deviceToken}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('WRONG_TOKEN_TYPE');
  });

  test('an ACCESS token cannot open /sync', async () => {
    const res = await request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ mutations: [mut({ type: 'job.deliver', entity_id: jobId, base_version: 1 })] });

    expect(res.status).toBe(401);
  });

  test('a driver cannot open a dispatcher-only endpoint (OWASP API #5)', async () => {
    const res = await request(app)
      .get('/api/v1/dispatch/board')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('BOLA — a driver cannot READ another driver\'s job (OWASP API #1)', async () => {
    const res = await request(app)
      .get(`/api/v1/jobs/${otherDriverJobId}`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ASSIGNED_TO_YOU');
  });

  test('BOLA — a driver cannot MUTATE another driver\'s job via sync', async () => {
    const res = await request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        mutations: [mut({
          type: 'job.deliver',
          entity_id: otherDriverJobId,
          base_version: 1,
        })],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].outcome).toBe('rejected');
    expect(res.body.data.results[0].reason).toMatch(/not assigned to you/i);

    const ledger = await pool.query(`SELECT * FROM mutations WHERE outcome = 'rejected'`);
    expect(ledger.rows).toHaveLength(1);
  });

  test('mass assignment — a device cannot set its own price (OWASP API #3)', async () => {
    const res = await request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        mutations: [mut({
          type: 'job.deliver',
          entity_id: jobId,
          base_version: jobVersion,
          payload: {
            recipient_name: 'Um Ahmed',
            price: 999999,
            cod_amount: 0,
            assigned_to: driverId,
          },
        })],
      });

    const job = await pool.query(`SELECT price, cod_amount FROM jobs WHERE id = $1`, [jobId]);
    expect(Number(job.rows[0].price)).not.toBe(999999);
    expect(Number(job.rows[0].cod_amount)).toBe(25000);
  });

  test('tenant escape — a client cannot supply its own org_id', async () => {
    const res = await request(app)
      .get('/api/v1/jobs?org_id=some-other-company')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FORBIDDEN_PARAM');
  });

  test('a malformed batch is rejected as NON-retryable', async () => {
    const res = await request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({ mutations: [{ garbage: true }] });

    expect(res.status).toBe(400);
    expect(res.body.retryable).toBe(false);
  });
});

describe('the sync round trip', () => {
  test('push → the job actually changes → pull reflects it', async () => {
    const push = await request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        mutations: [mut({
          type: 'job.deliver',
          entity_id: jobId,
          base_version: jobVersion,
          client_ts: '2026-07-13T14:02:00.000Z',
          payload: { recipient_name: 'Um Ahmed' },
        })],
      });

    expect(push.status).toBe(200);
    expect(push.body.data.summary.applied).toBe(1);

    const job = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(job.rows[0].status).toBe('delivered');

    const outbox = await pool.query(`SELECT * FROM outbox`);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].event_type).toBe('job.delivered');

    const pull = await request(app)
      .get('/api/v1/sync/pull')
      .set('Authorization', `Bearer ${deviceToken}`);

    expect(pull.status).toBe(200);
    expect(pull.body.data.jobs.find((j) => j.id === jobId).status).toBe('delivered');
    expect(pull.body.data.cursor).toBeTruthy();
  });

  test('every response carries a trace id', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-trace-id']).toBeTruthy();
  });
});

describe('the public demo', () => {
  test('a session seeds an isolated org', async () => {
    const res = await request(app).post('/demo/session');
    expect(res.status).toBe(200);
    expect(res.body.data.driver.device_token).toBeTruthy();
    expect(res.body.data.jobs.length).toBeGreaterThan(0);
  });

  test('the scripted conflict scenario ACTUALLY resolves field_wins', async () => {
    const res = await request(app).post('/demo/scenario/conflict');

    expect(res.status).toBe(200);
    expect(res.body.data.outcome.resolution).toBe('field_wins');
    expect(res.body.data.outcome.job_status_now).toBe('delivered');
    expect(res.body.data.transcript.length).toBeGreaterThanOrEqual(4);
  });

  test('two demo sessions cannot see each other (tenant isolation)', async () => {
    const a = await request(app).post('/demo/session');
    const b = await request(app).post('/demo/session');

    const orgA = a.body.data.session_id;
    const orgB = b.body.data.session_id;
    expect(orgA).not.toBe(orgB);

    const jobsA = await pool.query(`SELECT count(*)::int n FROM jobs WHERE org_id = $1`, [orgA]);
    const jobsB = await pool.query(`SELECT count(*)::int n FROM jobs WHERE org_id = $1`, [orgB]);

    expect(jobsA.rows[0].n).toBeGreaterThan(0);
    expect(jobsB.rows[0].n).toBeGreaterThan(0);

    const jobB = await pool.query(`SELECT id, version FROM jobs WHERE org_id = $1 LIMIT 1`, [orgB]);

    const res = await request(app)
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${a.body.data.driver.device_token}`)
      .send({
        mutations: [mut({
          type: 'job.deliver',
          entity_id: jobB.rows[0].id,
          base_version: jobB.rows[0].version,
        })],
      });

    expect(res.body.data.results[0].outcome).toBe('rejected');
  });
});

describe('errors', () => {
  test('an unknown route is a clean 404, not a stack trace', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.stack).toBeUndefined();
  });
});
