# Running Sanad

Every step lists the command, the output you should see, and what to check if it differs.

---

## Requirements

| Tool | Version | Verify |
|---|---|---|
| Node | 20+ | `node --version` |
| Docker + Compose | any recent | `docker compose version` |
| k6 | optional, for load tests | `k6 version` |

---

## The frontends, with no setup at all

Both progressive web apps are self-contained. Open `web/driver/index.html` in a browser.

1. Toggle the amber switch labelled **جرّب: اقطع الإنترنت** (try: cut the internet)
2. Mark a couple of jobs delivered — they save locally with an amber confirmation
3. Toggle connectivity back on

The queue drains, and the conflict on the first job resolves in the driver's favour. No backend required; the offline behaviour, the local queue, and the arbitration outcome are all real.

`web/dispatch/index.html` is the office view — the conflict inbox, presented as a timeline.

---

## 1. Install

```bash
npm install
```

Expect roughly 800 packages. Deprecation warnings from transitive dependencies are normal.

---

## 2. Tests that need no infrastructure

```bash
npm run test:unit
```

```
Test Suites: 2 passed, 2 total
Tests:       62 passed, 62 total
Time:        ~2s
```

These cover the conflict resolver and the sync pipeline using in-memory fakes — no database, no network. The resolver is deliberately import-free so its tests stay this fast.

```bash
npm run test:rpc
```

```
Tests:       9 passed, 9 total
```

This one starts a real gRPC server on a loopback port and calls it with a real client, and separately asserts that GraphQL's DataLoader batches related lookups (3 queries where a naive resolver would issue 10).

---

## 3. Start the stack

```bash
docker compose up -d --build
```

Eleven services start: Postgres, Redis, Kafka, a one-shot migration job, the API, two outbox publishers, the notification consumer, the pricing service, Prometheus, Grafana, and Jaeger. First run pulls images and takes a few minutes.

Watch for these lines in order:

```
postgres  | database system is ready to accept connections
redis     | Ready to accept connections
kafka     | Kafka Server started
migrate   | Migrations complete
api       | sanad: listening on port 4000
pricing   | pricing: gRPC server listening
```

Check everything is up, including anything that exited:

```bash
docker compose ps -a
```

**If a service is missing from that list**, it crashed on boot. `docker compose logs --tail=50 <service>` will say why. The `-a` flag matters — without it, exited containers are hidden and a crashed service looks like it was never defined.

---

## 4. Confirm it is alive

```bash
curl localhost:4000/health
```

```json
{"status":"ok","uptime":9.04}
```

That is the liveness check — it only asks whether the process is running.

```bash
curl localhost:4000/ready
```

```json
{"status":"ready"}
```

Readiness is the stronger signal: it verifies Postgres and Redis are actually reachable. The distinction matters in Kubernetes, where a failed liveness probe kills a pod while a failed readiness probe merely stops routing traffic to it. A dependency check in the wrong probe turns a brief database blip into a restart of every replica at once.

---

## 5. The conflict scenario

```bash
curl -X POST localhost:4000/demo/scenario/conflict
```

Pipe through `jq` if available. The response contains a narrated transcript:

```
13:40  driver loses signal
14:02  driver marks the parcel delivered — offline, queued locally
14:30  dispatcher reassigns the job, assuming the driver is stuck
17:00  the device reconnects and syncs against a changed row
```

and the outcome:

```json
{
  "resolution": "field_wins",
  "job_status_now": "delivered"
}
```

Nothing here is scripted. The real sync service ran the real conflict resolver inside a real Postgres transaction, and the delivery won because a physical event outranks an administrative one.

---

## 6. Inspect the underlying rows

```bash
curl "localhost:4000/demo/curtain/<SESSION_ID>" | jq
```

`SESSION_ID` comes from the previous response. This returns the mutation ledger with the offline duration computed per row, the outbox rows and their published state, and the arbitration decision with its reason string.

To query the database directly:

```bash
docker compose exec postgres psql -U sanad -d sanad -c '\dt'
docker compose exec postgres psql -U sanad -d sanad -c 'SELECT ref, status, version FROM jobs;'
```

---

## 7. Point the driver app at the running backend

Edit `web/driver/index.html` and find, near the top of the script block:

```js
const BACKEND = null;
```

Change it to:

```js
const BACKEND = 'http://localhost:4000';
```

Reload. The status line changes to **متصل بسيرفر حقيقي** and the jobs shown are now real rows seeded in Postgres. Going offline, delivering, and reconnecting pushes real mutations to `/sync/push`, and the verdicts displayed come from the sync engine.

**If the status does not change**, the app silently falls back to standalone mode by design. Confirm the API responds, and note that opening a page over `file://` can trip CORS — serving the folder avoids it:

```bash
npx serve web/driver
```

---

## 8. Dashboards

| Service | URL | Notes |
|---|---|---|
| Grafana | `localhost:3001` | `admin` / `admin`. Dashboard: *Sanad — Field Operations* |
| Prometheus | `localhost:9090` | Try the query `sync_dark_seconds_sum` |
| Jaeger | `localhost:16686` | Select service `sanad` |
| Raw metrics | `localhost:4000/metrics` | Prometheus exposition format |

The headline panel is **dark time** — the gap between `client_ts` (when an action happened in the field) and `received_at` (when the server heard about it). A driver whose p95 dark time is six hours is working a route with no coverage, which is a fact about the physical world derived from two database timestamps. An API that discards the first timestamp cannot produce this number.

Traces cover the HTTP and Express layers. There are no database spans — see the limitations section in the README.

---

## 9. Tests that need Docker

These start their own throwaway Postgres via Testcontainers, independent of the Compose stack.

```bash
npm run test:integration    # real SQL, real transactions
npm run test:api            # real HTTP through the whole middleware stack
npm run test:chaos          # processes killed mid-operation
npm run test:contract       # producer/consumer event shapes (Pact)
```

Expected: 11, 19, 10, and 4 passing respectively. Full output in [TEST_RESULTS.md](TEST_RESULTS.md).

Each layer proves something the others cannot. Rename a database column and the unit tests still pass, because a mock does not know the column exists — the integration tests fail immediately. The API tests are the only ones that prove middleware is actually wired into the request path rather than merely correct in isolation. The chaos tests kill a process between the entity write and the outbox write, then assert that nothing at all persisted.

**If these fail to start**, Docker is not running. They do not need `docker compose up`, but they do need the daemon.

---

## 10. Load test

Requires k6 and a running stack.

```bash
k6 run tests/load/reconnect-storm.js
```

This models 300 devices returning from offline periods simultaneously, each pushing 20 to 120 queued mutations, with 15% resubmitting an identical batch to exercise idempotency under concurrency.

Expect it to break. The measured numbers, the diagnosis, and the fix are in [TEST_RESULTS.md](TEST_RESULTS.md).

A second scenario exists to establish the hard ceiling and is designed to fail its own thresholds:

```bash
k6 run --env SCENARIO=breaking_point tests/load/reconnect-storm.js
```

---

## 11. Standalone protocol demos

No Docker required.

```bash
npm run demo:grpc
```

```
PriceAndReserve OK: total=4000 reservation=resv-123
Rejection is typed: INSUFFICIENT_STOCK — water: 20 left, 999 asked
Stream update: water remaining=15 low=true
Stream update: water remaining=8  low=true
```

The last two lines arrive over a single long-lived connection — the initial stock level, then a pushed change.

```bash
npm run demo:graphql
```

```
Query returned 3 jobs, each with driver and customer
Total DB queries: 3   (naive resolution would issue ~10)
```

---

## 12. Shut down

```bash
docker compose down        # keep the database volume
docker compose down -v     # discard it, start clean next time
```

---

## Checklist

```
[ ] open web/driver/index.html, toggle offline           no setup
[ ] npm install
[ ] npm run test:unit                → 62 passed         no Docker
[ ] npm run test:rpc                 →  9 passed         no Docker
[ ] docker compose up -d --build     → api on 4000
[ ] curl localhost:4000/health       → ok
[ ] curl -X POST .../demo/scenario/conflict → field_wins
[ ] set BACKEND in the driver app, reload
[ ] open localhost:3001              → dark-time panel
[ ] npm run test:integration / api / chaos / contract
[ ] k6 run tests/load/reconnect-storm.js
[ ] npm run demo:grpc / demo:graphql
```
