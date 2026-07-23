# API design: three protocols, each where it belongs

> This system speaks REST, gRPC, and GraphQL — not to collect buzzwords, but because it has three genuinely different kinds of traffic, and using the wrong protocol for each is a category error.

The whole argument in one table:

| protocol | used for | why | where |
|---|---|---|---|
| **REST** | the driver's phone → the edge | universal, cache-friendly, works on any network, offline-friendly | the sync protocol |
| **gRPC** | service → service, internal | typed, binary, fast, streaming; both sides are ours | pricing/inventory |
| **GraphQL** | the dashboard → the read layer | the client picks exactly the shape it needs, in one call | dispatcher reads |

The mistake is thinking one of these is "better". They solve different problems. Putting gRPC on a phone is a fight against the browser; putting REST between hot-path internal services is slow and untyped; using GraphQL for the offline write path throws away everything the sync protocol is for. **The skill is picking per-traffic-type, not having a favourite.**

---

## REST — the edge

The driver's phone talks REST, and it should. REST is universal, every network and proxy understands it, it caches, and the offline-first sync protocol (client-generated IDs, idempotent replay, `retryable` flags) is built on plain `POST /sync/push`. See `docs/SYNC_PROTOCOL.md`. Nothing exotic, because the edge is exactly where you do NOT want exotic — you want the thing that works on a 3G connection in Abu Ghraib through whatever middlebox the carrier runs.

---

## gRPC — the internal pricing service

**Real, running code:** `src/grpc/`. A `.proto` contract, a server, a typed client, and a streaming RPC. Run the proof:

```bash
node scripts/grpc-demo.js
```
```
✓ PriceAndReserve OK: total=4000 reservation=resv-123
✓ Rejection is typed: INSUFFICIENT_STOCK — water: 20 left, 999 asked
✓ Stream update: water remaining=15 low=true
✓ Stream update: water remaining=8 low=true      ← a LIVE change, pushed
✅ gRPC: server + client + streaming ALL WORK over the wire
```

### Why gRPC here specifically

The sync service, while applying a salesman's order **inside a database transaction**, asks the pricing service: "what does this cost, and is there stock?" That call has a very specific profile:

- **Internal** — never touches a phone or browser. gRPC-web is a fight; this is service-to-service, which is gRPC's home turf.
- **Hot path** — asked thousands of times a minute. Protobuf is binary: 3–10× smaller than JSON on the wire and far faster to parse, because there are **no field names in the payload** — just tag numbers and typed bytes.
- **Typed** — the `.proto` file *is* the contract. Client and server are generated from it. You cannot send a field that does not exist; it will not compile. Compare REST, where the contract is a hope and a Postman collection.

### The three things the code shows that prose cannot

**1. The `.proto` is the single source of truth.** [`pricing.proto`](../src/grpc/proto/pricing.proto). Both sides load the same file. The tag numbers (`= 1`, `= 2`), not the field names, are what travel — which is why you can rename a field freely but must never reuse a tag.

**2. Business "no" is not an error.** A sold-out product returns `ok: false` with a typed `rejection` enum — the *call succeeded*, the *answer* is no. A gRPC error status (`INTERNAL`, `UNAVAILABLE`) is reserved for the call actually failing. Confusing "the RPC failed" with "the answer is no" is a classic mistake: the client retries the former and must not retry the latter.

**3. Streaming.** `WatchStock` returns `stream StockUpdate` — one keyword, and now the server pushes stock changes over a single long-lived connection. The proof above shows it delivering the initial level *and* a live change. REST cannot do this without bolting on websockets, i.e. a second transport.

### The two things every gRPC call needs, and everyone forgets

Both are in [`pricingClient.js`](../src/grpc/pricingClient.js):

- **A deadline.** `deadline(2000)`. Without one, a call to a wedged service hangs forever — and because this call is *inside a transaction*, a hung RPC means a held Postgres lock, which means the reconnect storm backs up behind one stuck call. On a hot path a deadline is not optional; it is the difference between "pricing is slow" and "the fleet is down".
- **Retry, for the right codes only.** Retry `UNAVAILABLE` (a pod restarting). Never retry `INVALID_ARGUMENT` (the request is malformed — retrying re-sends the same bad request) or a business rejection (retrying will not restock the product). Same `retryable` discipline as the sync protocol — "should I try again?" is the central question of every distributed call.

---

## GraphQL — the dispatcher's read layer

**Real, running code:** `src/graphql/`. Schema, resolvers, DataLoader. Run the proof:

```bash
node scripts/graphql-demo.js
```
```
✓ Query returned 3 jobs
  JOB-1 [delivered] → سائق d1 (cash: 25000) → زبون c1
  JOB-2 [picked_up] → سائق d1 (cash: 25000) → زبون c2
  JOB-3 [assigned] → سائق d2 (cash: 25000) → زبون c1
✓ Total DB queries: 3 (naive N+1 would be ~10)
✅ GraphQL + DataLoader: batching WORKS — no N+1
```

### The two problems GraphQL actually solves

The dispatcher's job-detail view needs, for one job: the job, its customer, its driver, **every mutation that ever touched it**, the dark time on each, and the device each came from.

- **Over-fetching** (REST hands the list view the whole joined object when it wanted three fields)
- **Under-fetching / N+1** (the detail view makes five more calls to assemble the tree)

GraphQL lets the **client** specify the exact shape in **one** request. The list view asks for `{ref, status, driver{name}}`; the detail view asks for the whole tree including `history`; the server serves both from one schema. A field the query does not request costs nothing — the `history` resolver never runs for a list view that omits it.

### The DataLoader detail — the thing that makes GraphQL viable instead of a trap

GraphQL's default failure mode: a query for 50 jobs, each resolving its driver separately, fires **51 queries**. Invisible with 3 rows of test data; an outage in production. Used naively, GraphQL makes fetching **worse** than the REST it replaced.

[`resolvers.js`](../src/graphql/resolvers.js) fixes it with DataLoader: it collects every driver lookup in one tick and fires **one** `WHERE id = ANY($1)`. The proof above shows it — 3 jobs referencing 2 drivers and 2 customers resolve in **3 queries, not 10**.

Two things the code is careful about:

- **Per-request loaders, never global.** A loader shared across requests would serve one user's cached data to another — a BOLA vuln dressed as an optimisation. New loaders every request, scoped to the authenticated org.
- **The result array must match the input order** with `null` for misses, or DataLoader hands the wrong driver to the wrong job.

### Why only the READ side is GraphQL

Writes still go through the sync protocol and REST. GraphQL mutations here would be a mistake: the write path is idempotent, offline-first, and conflict-resolved — a shape GraphQL's model does not fit. Forcing writes into GraphQL because it is there would be the same category error as putting gRPC on the phone. **GraphQL is a read tool for this system, and knowing that boundary is the point.**

### Same auth as REST

[`server.js`](../src/graphql/server.js) mounts GraphQL behind the *same* `protect` + `requireRole` middleware the REST routes use. GraphQL is a second door into the same house — same locks. A GraphQL endpoint with its own half-considered auth is one of the most common ways teams accidentally expose everything.

---

## What is NOT done, honestly

- **No mTLS between services yet.** The gRPC calls are `createInsecure()` on a private network. Real service-to-service auth (mTLS, or SPIFFE) is the next step and is noted in `SECURITY.md`.
- **No GraphQL depth/complexity limiting.** A malicious client can nest `job → history → actor → jobs → …` and make one request cost a fortune — GraphQL's version of an unbounded request body. The hook is in `server.js`; the limiter is not written.
- **The `.proto` stubs are loaded at runtime, not pre-generated.** Fine for Node; a Go or Rust service in the mix would want `protoc`-generated code checked in.

Three protocols, each doing the one job it is best at. That — not the count — is the actual API-design competence.
