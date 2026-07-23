# Test results

Full output from running every suite, plus load test measurements and the defects found by exercising the system end to end.

Environment: Docker Desktop (20 CPU / 15.4 GiB allocated), Node 22.15.0, Docker 29.6.1, k6 v2.0.0-rc1.

---

## Summary

| Suite | Tests | Infrastructure | Runtime |
|---|---|---|---|
| unit | 62 | none | ~2s |
| contract (Pact) | 4 | none | ~3s |
| rpc (gRPC + GraphQL) | 9 | none | ~3s |
| integration | 11 | Postgres via Testcontainers | ~60s |
| api | 19 | Postgres + full Express stack | ~45s |
| chaos | 10 | Postgres via Testcontainers | ~90s |
| **total** | **115** | | |

```
npm run test:unit         → 62/62
npm run test:contract     →  4/4
npm run test:rpc          →  9/9
npm run test:integration  → 11/11
npm run test:api          → 19/19
npm run test:chaos        → 10/10
```

No skipped tests.

---

## What each layer proves

The layers differ along one axis: how much of the system is real versus faked.

**unit** — the conflict resolver and sync pipeline against in-memory fakes. No database, no network. The resolver has no imports at all, which is what keeps 62 tests under two seconds. That speed is the reason there are 62 rather than 10, and one of them caught a real ordering defect in arbitration before it ever ran.

**contract** — verifies that the event shapes the sync service produces still match what the notification consumer expects. This closes a gap both other layers miss: rename a field in the producer and the producer's own tests still pass (its code is internally consistent) while the consumer's tests also pass (its mock still has the old name). Both green, production broken. Pact makes the consumer's expectation fail the producer's build instead.

**integration** — real SQL against a real Postgres. Proves a rollback genuinely undoes a stock decrement, and a unique constraint genuinely prevents a double cash entry. A mock cannot prove either. Rename a column and unit tests still pass while these fail immediately.

**api** — real HTTP requests through the entire middleware stack, including every OWASP probe the threat model calls out. The only layer that proves middleware is actually wired into the request path rather than merely correct in isolation.

**chaos** — processes killed at the worst possible moments: mid-transaction, after a Kafka publish but before the outbox row is marked, during a concurrent race for the same row, and on the final line of a multi-line order. Each asserts that nothing partial persisted.

**load** — the reconnect storm. Measurements below.

---

## Load test: reconnect storm

300 devices returning from offline periods simultaneously, each pushing 20–120 queued mutations, with 15% resubmitting an identical batch to exercise idempotency under concurrency.

### The harness was wrong first

The initial run seeded a single device session in `setup()` and shared its token across all 300 virtual users. The sync rate limiter is keyed by `device_id`, so all 300 spent from one bucket:

```
sync_throttled       98.30%
http_req_failed      96.61%   (predominantly 429)
sync_batch_latency   p95 22ms
```

Those numbers describe one device being hammered 300 times, not 300 devices reconnecting. Fixed to seed one real session per device and have each virtual user select its own by index.

### Then it broke properly

```
sync_failed          44.66%
sync_throttled        1.18%
sync_batch_latency   p95 30s, p99 30s      pinned at the client HTTP timeout
http_req_failed      20.76%
iterations           ~2,000 of a possible ~3,600
```

`docker stats` during the run: Postgres 286% CPU, API 117% CPU.

### Diagnosis

The API logged **6,616** slow-query warnings on `findSeenMutationIds`, a lookup that is normally under 5ms — and **zero** pg errors or connection timeouts. That absence is the useful signal.

Every service inherits `src/db/pool.js`'s default of `max: 20`, and none set `PG_POOL_MAX`. Five pools — API, two outbox publishers, notification consumer, pricing — against `postgres:16-alpine`'s default `max_connections = 100` is exactly 100, with no headroom for migrations, admin connections, or monitoring.

The reason it produced no errors: `pg`'s `connectionTimeoutMillis` bounds the initial TCP connect, not time spent waiting for a client to free up in the pool's internal queue. Exhaustion therefore never throws. It queues silently, latency climbs with nothing logged, clients eventually give up at their own timeout, and their retries add further work to a queue that is already the bottleneck.

### Fix

Pools rebalanced to match actual demand — the API handles fan-out HTTP under the storm, the background workers are single-purpose pollers that never needed 20 connections each.

| Service | Before | After |
|---|---|---|
| api | 20 | 60 |
| outbox-publisher (×2) | 20 each | 5 each |
| notification-consumer | 20 | 5 |
| pricing | 20 | 5 |
| **worst case total** | **100** | **80** |

### Re-run, identical scenario

| Metric | Before | After |
|---|---|---|
| `sync_failed` | 44.66% | **20.15%** |
| `http_req_failed` | 20.76% | **10.53%** |
| iterations completed | ~2,000 | **~2,765** |

Failure rate roughly halved, completed throughput up about 38%.

### Residual ceiling

p95 remains pinned at the client timeout under the full 300-device storm, and `docker stats` still shows Postgres above 200% CPU. With connections no longer scarce, Postgres itself is the constraint — contended row locks from `FOR UPDATE`, WAL flushes, and lock waits across a sequential per-mutation-transaction design, all on a single container serving a single API replica.

The next lever is horizontal API replicas behind a load balancer, which `k8s/` already configures. That is a larger change than pool tuning and has not been exercised.

### Breaking point scenario

A separate arrival-rate scenario pushed to 1,500 req/s, designed to fail its own thresholds and establish that a hard ceiling exists:

```
sync_failed          78.25%
http_req_failed      53.34%
dropped_iterations   121,076    (k6 could not schedule these at all)
```

### Summary

> Handled roughly 20 reconnecting devices cleanly at p95 ~500ms. Broke as the storm ramped past ~150 concurrent devices — p95 reached the 30s client timeout and `sync_failed` hit 44.7% — because every service defaulted to a 20-connection pool against Postgres's `max_connections=100`, and `pg`'s pool queues silently rather than erroring when exhausted. Fixed by rebalancing pool sizes. Re-ran: `sync_failed` 44.7% → 20.2%, completed iterations 2,000 → 2,765. Not fully resolved; the residual ceiling is single-instance Postgres and API, which needs horizontal scaling rather than further pool tuning.

---

## Defects found by running it end to end

Six suites passing in isolation did not mean the system worked. Executing every documented step surfaced seven defects, all since fixed.

### 1. Authorization check ran before conflict arbitration

The flagship scenario returned `resolution: null, job_status_now: "assigned"`, with the mutation rejected as *"This item is not assigned to you."*

The ownership check compared `row.assigned_to` against the calling user **before** conflict detection. In the scenario the office reassigns the job away at 14:30, so by the time the driver's 17:00 delivery arrived, the row belonged to a different driver and the mutation was rejected outright — never reaching the resolver that should have awarded it `field_wins`. The exact case the system exists to handle.

The naive fix — skip the ownership check whenever a conflict exists — would let anyone claim any job by lying about `base_version` to manufacture a conflict, then riding the arbitration result past authorization. The resolver has no concept of identity by design, so the authorization boundary has to stay in the sync service and needs real information rather than an assumption.

Fixed in three parts: a migration adding `jobs.previous_assigned_to`; `officeUpdate` recording the outgoing assignee atomically in the same statement as the reassignment; and the ownership gate deferring to arbitration only when both the device's view is genuinely stale *and* `previous_assigned_to` matches the caller. A device never assigned the job is still rejected exactly as before.

**Fixing it exposed a second defect no test had reached.** With authorization corrected, the scenario still failed — now with *"Illegal transition assigned → delivered."* The transition-legality check validates against the row's **current** status, which is what the office's conflicting reassignment had just set. A second, independent check was silently reimposing administrative precedence one step after the resolver had ruled the opposite. Nothing had previously reached that far down the pipeline. Fixed by skipping legality validation when arbitration has already ruled the device's physical claim authoritative.

### 2. Multi-line order rollback left earlier decrements applied

An order whose second line failed on insufficient stock left the first line's stock decrement in place — expected 10, observed 5.

Root cause: the insufficient-stock branch used `return` rather than `throw`. `withTransaction` only rolls back on a thrown error, so a plain return looked like success and the transaction **committed**, permanently applying every earlier decrement while reporting the order as rejected.

Fixed with a savepoint around the decrement-through-insert block: insufficient stock now throws, the handler rolls back to the savepoint, and the rejection is still written to the mutation ledger as part of the outer transaction.

### 3. Wrong error code for a device token on a dashboard route

`authService.verify(token, kind)` selected the signing secret and audience from the *caller's expectation* rather than from the token itself. A device token verified as an access token failed signature verification outright, falling through to a generic `TOKEN_INVALID` before reaching the check that reports the specific `WRONG_TOKEN_TYPE`.

Fixed by decoding the token's claimed type first, verifying the signature against the secret and audience that type actually uses, and only then checking whether it matches what the caller required. Decoding first is not a trust decision — a forged type claim still cannot pass signature verification.

### 4. Pact metadata key mismatch

Provider-side message stubs returned the bare payload with no metadata, while the consumer declared `content-type`. Fixed using the library's `providerWithMetadata` wrapper.

### 5. Flagship metric was structurally unreachable

`sync_dark_seconds` and `jobs_delivered_total` were observed only inside the notification consumer — a separate process with its own private registry, no HTTP server, and no Prometheus scrape target. Confirmed by pushing a real delivery through the pipeline, watching it publish, and observing the metric stay at zero on the scraped endpoint. The panel could never show data regardless of traffic.

Fixed by adding a metrics server to all three background workers and registering them as scrape targets. Prometheus now has four healthy targets.

### 6. Notification consumer died silently on every start

`docker compose ps -a` showed it exited roughly 30 seconds after every stack start, on a transient Kafka coordinator race at cold start. With no restart policy on any background worker, it stayed dead for the remainder of each session — meaning the outbox-to-consumer half of the pipeline had been offline since the first run, with no crash loop and no failing healthcheck to indicate it.

Fixed by adding restart policies.

### 7. Tracing instrumentation caused silent write loss

After adding OpenTelemetry, the API reported `"outcome":"applied"` with an incremented version while the row in Postgres never changed. Verified three times against a side-by-side uninstrumented container on a second port, sharing the same database: identical mutation, correct write.

This is worse than a crash — the API confidently reporting that a driver's delivery was recorded when it was not. Disabling `@opentelemetry/instrumentation-pg` specifically, while retaining HTTP and Express instrumentation, resolved it. Suspected interaction between the patched `pg.Client.query` and `withTransaction`, which holds a single checked-out client across BEGIN through COMMIT, but the root cause is not diagnosed.

Shipped with pg instrumentation disabled. Traces therefore cover HTTP and Express but not database spans. Documented rather than re-enabled.

---

## Verification after all fixes

```
npm run test:unit         → 62/62
npm run test:integration  → 11/11   (was 9/11)
npm run test:api          → 19/19   (was 17/19)
npm run test:chaos        → 10/10   (was 9/10)
npm run test:contract     →  4/4    (was 3/4)
npm run test:rpc          →  9/9
```

End to end against the running stack:

```bash
curl -X POST localhost:4000/demo/scenario/conflict
```

```json
{
  "resolution": "field_wins",
  "job_status_now": "delivered"
}
```

Observability, verified by API rather than by eye:

```
grafana  /api/datasources                    → Prometheus datasource present
grafana  /api/search?query=Sanad             → dashboard present
prom     /api/v1/targets                     → 4/4 up
prom     /api/v1/query?query=sync_dark_seconds_sum
                                             → non-empty, 4800.254s across 2 deliveries
jaeger   /api/services                       → ["jaeger-all-in-one","sanad"]
jaeger   /api/traces?service=sanad           → 5 traces with full Express span trees
```
