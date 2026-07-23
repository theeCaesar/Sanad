import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const API = `${BASE}/api/v1`;

const syncLatency = new Trend('sync_batch_latency', true);
const mutationsApplied = new Counter('mutations_applied');
const mutationsConflicted = new Counter('mutations_conflicted');
const mutationsDuplicate = new Counter('mutations_duplicate');
const throttled = new Rate('sync_throttled');
const syncFailed = new Rate('sync_failed');

const SCENARIOS = {
  reconnect_storm: {
    executor: 'ramping-vus',
    stages: [
      { duration: '30s', target: 20 },
      { duration: '60s', target: 300 },
      { duration: '90s', target: 300 },
      { duration: '60s', target: 50 },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '30s',
  },

  breaking_point: {
    executor: 'ramping-arrival-rate',
    startRate: 10,
    timeUnit: '1s',
    preAllocatedVUs: 100,
    maxVUs: 1000,
    stages: [
      { duration: '1m', target: 50 },
      { duration: '1m', target: 150 },
      { duration: '1m', target: 400 },
      { duration: '1m', target: 800 },
      { duration: '1m', target: 1500 },
    ],
  },

  soak: {
    executor: 'constant-vus',
    vus: 40,
    duration: '30m',
  },
};

const chosen = __ENV.SCENARIO || 'reconnect_storm';

export const options = {
  scenarios: { [chosen]: SCENARIOS[chosen] },

  thresholds: {
    sync_batch_latency: ['p(95)<3000', 'p(99)<8000'],

    sync_failed: ['rate<0.01'],

    sync_throttled: ['rate<0.30'],

    http_req_failed: ['rate<0.02'],
  },
};

const DEVICE_POOL_SIZE = Number(__ENV.DEVICE_POOL_SIZE || 300);

export function setup() {
  const sessions = [];
  const batchSize = 20;

  for (let i = 0; i < DEVICE_POOL_SIZE; i += batchSize) {
    const n = Math.min(batchSize, DEVICE_POOL_SIZE - i);
    const reqs = Array.from({ length: n }, () => ['POST', `${BASE}/demo/session`, null, {
      headers: { 'Content-Type': 'application/json' },
    }]);
    const responses = http.batch(reqs);
    for (const res of responses) {
      if (res.status !== 200) {
        throw new Error(`setup failed: ${res.status} ${res.body}`);
      }
      const body = JSON.parse(res.body);
      sessions.push({
        token: body.data.driver.device_token,
        deviceId: body.data.driver.device_id,
        jobs: body.data.jobs,
      });
    }
  }

  return { sessions };
}

export default function (data) {
  const session = data.sessions[__VU % data.sessions.length];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.token}`,
  };

  const batchSize = randInt(20, 120);
  const mutations = [];

  for (let i = 0; i < batchSize; i += 1) {
    const job = session.jobs[randInt(0, session.jobs.length - 1)];

    mutations.push({
      mutation_id: uuidv4(),
      seq: __ITER * 1000 + i,
      type: pick(['job.accept', 'job.pickup', 'job.deliver', 'cash.collect']),
      entity_id: job.id,
      base_version: job.version,
      client_ts: new Date(Date.now() - randInt(600, 28800) * 1000).toISOString(),
      payload: { amount: 25000, recipient_name: 'Load Test' },
    });
  }

  const start = Date.now();
  const res = http.post(`${API}/sync/push`, JSON.stringify({ mutations }), {
    headers,
    timeout: '30s',
    tags: { name: 'sync_push' },
  });
  syncLatency.add(Date.now() - start);

  if (res.status === 429) {
    throttled.add(true);
    syncFailed.add(false);

    check(res, {
      'a 429 tells the device WHEN to come back': (r) => !!r.headers['Retry-After'],
      'and tells it the work is safe': (r) => {
        try { return JSON.parse(r.body).retryable === true; } catch { return false; }
      },
    });

    const wait = Number(res.headers['Retry-After'] || 2);
    sleep(wait);
    return;
  }

  throttled.add(false);

  const ok = check(res, {
    'sync accepted': (r) => r.status === 200,
    'every mutation got a verdict': (r) => {
      try {
        const b = JSON.parse(r.body);
        return b.data.results.length === mutations.length;
      } catch { return false; }
    },
  });

  syncFailed.add(!ok);

  if (ok) {
    const b = JSON.parse(res.body);
    mutationsApplied.add(b.data.summary.applied);
    mutationsConflicted.add(b.data.summary.conflicted);
    mutationsDuplicate.add(b.data.summary.duplicates);
  }

  if (Math.random() < 0.15) {
    const retry = http.post(`${API}/sync/push`, JSON.stringify({ mutations }), {
      headers, timeout: '30s', tags: { name: 'sync_retry' },
    });

    check(retry, {
      'a retried batch is fully DEDUPED (idempotency holds under load)': (r) => {
        if (r.status !== 200) return r.status === 429;
        const b = JSON.parse(r.body);
        return b.data.summary.duplicates === mutations.length
            && b.data.summary.applied === 0;
      },
    });
  }

  http.get(`${API}/sync/pull?since=${new Date(Date.now() - 864e5).toISOString()}`, {
    headers, tags: { name: 'sync_pull' },
  });

  sleep(randInt(1, 4));
}

export function teardown() {
  console.log(`
================================================================================
  RECONNECT STORM — what to actually look at
================================================================================

  Do NOT read the pass/fail. Read these:

  1. sync_batch_latency p95/p99
     Where does it hockey-stick? That inflection IS the breaking point.

  2. sync_throttled rate
     Some throttling under a storm is CORRECT — the limiter absorbing a burst.
     A high rate means the token bucket is sized wrong and we are punishing
     drivers for the crime of finishing their shift.

  3. the "retried batch is fully DEDUPED" check
     If this ever fails, STOP. It means idempotency does not hold under
     concurrency, which means the fleet is double-counting cash under load —
     and it will not show up anywhere until the money fails to reconcile.

  4. sync_failed rate
     A failed sync = a driver's day trapped on his phone.

  5. Then go and look at Grafana, not at k6:
       - outbox_pending          → is the publisher keeping up, or silently
                                   falling behind while the API returns 200s?
       - pg pool saturation      → the usual culprit. Exhausted pool → queued
                                   requests → timeouts → device retries → MORE
                                   load. The death spiral.
       - sync_dark_seconds       → should be enormous here. That is correct.
                                   These mutations "happened" hours ago.

  The number is not the deliverable. The SENTENCE is:

     "Handled N reconnecting devices at p95 Xms. Broke at M because [reason].
      Fixed by [change]. Re-ran: [new number]."

  That sentence is falsifiable, and that is why it is worth something.
================================================================================
  `);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
