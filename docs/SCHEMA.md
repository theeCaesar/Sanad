# Schema

Every table, and why it is shaped that way.

## The columns that carry the design

### `version INTEGER` — on every mutable entity

**The single most important column in the schema.**

Every write bumps it. Every device echoes back the one it last saw. Mismatch = somebody moved the row while the device was dark.

```sql
UPDATE jobs SET ... WHERE id = $1 AND version = $2
-- rowCount = 0 → conflict. That is the ENTIRE detection mechanism.
```

Optimistic concurrency control. No locks held across nine dark hours. One integer.

### `client_ts` **and** `received_at` — on every mutation

When it **happened** vs when we **heard**.

A normal API stores one timestamp, because it assumes they are the same moment. **They are not, and the gap between them is the most interesting number this system produces** — it is a direct measurement of field connectivity, derived from database columns.

### Money is `BIGINT`. Always.

Never `FLOAT`. `0.1 + 0.2 !== 0.3`, and a rounding error in a cash ledger is not a rounding error, it is a discrepancy that someone has to explain.

Integer minor units, with `CHECK (amount >= 0)` where it applies.

---

## `mutations` — the ledger

**Append-only. Three jobs at once:**

1. **Idempotency store** — `mutation_id` is the `PRIMARY KEY`, and it is **client-generated**. A retried batch collides here and the `INSERT` fails harmlessly instead of applying the effect twice.
2. **Audit trail** — every field action: who, which device, when it happened, when it arrived, what the system decided, **and why**.
3. **Replay log** — reprocess a device's entire day against fixed code.

```sql
mutation_id  uuid PRIMARY KEY   -- the client's own id
seq          bigint             -- per-device monotonic
client_ts    timestamptz        -- when it HAPPENED
received_at  timestamptz        -- when it ARRIVED
outcome      text               -- applied | duplicate | conflict | rejected
resolution   text               -- field_wins | server_wins | merged | escalated
resolution_reason text          -- the human-readable WHY

UNIQUE (device_id, seq)         -- a device must never reuse a sequence number
```

`resolution_reason` is not decoration. **A conflict engine nobody can follow is a conflict engine nobody trusts** — and an untrusted automatic decision is worse than no automatic decision at all.

---

## `outbox` — the event, in the same transaction as the state

```sql
partition_key  text    -- Kafka partition key. Keying by entity_id guarantees
                       --   all events for ONE job land in ONE partition and are
                       --   therefore consumed IN ORDER. Get this wrong and a
                       --   consumer sees 'delivered' before 'picked_up'.
trace_id       text    -- threaded from the driver's phone to the consumer
status         text    -- pending | published | failed
```

```sql
-- The worker's hot query. A partial index keeps it tiny even when the table
-- has millions of published rows.
CREATE INDEX outbox_pending ON outbox (id) WHERE status = 'pending';
```

The worker claims batches with `FOR UPDATE SKIP LOCKED` — which is what lets N replicas run without fighting. **Without `SKIP LOCKED`, worker 2 blocks on worker 1's rows and the whole publisher serialises into a single thread no matter how many you run.**

---

## `van_stock` — the table that makes the Postgres argument undeniable

```sql
qty      integer NOT NULL
CHECK (qty >= 0)              -- the backstop
UNIQUE (user_id, product_id)
```

The decrement is **one atomic statement**:

```sql
UPDATE van_stock SET qty = qty - $1 WHERE ... AND qty >= $1
```

Read and write in one statement, so two concurrent orders cannot both see `qty = 5` and both take 3. `rowCount = 0` → insufficient stock → **the whole order rolls back with it.**

And the `CHECK` is the last line of defence: **even if the application logic has a bug, the database will not let a van carry −3 units.** There is an integration test asserting exactly that, because you test the backstop, not just the thing in front of it.

---

## `processed_events` — consumer-side idempotency

```sql
PRIMARY KEY (event_id, consumer_group)
```

Keyed by **both**, not by `event_id` alone. Every consumer group processes every event independently — notifications *and* analytics both need to see `job.delivered`.

**Deduping globally would mean the second group never sees anything the first consumed** — silently breaking fan-out, which is the entire reason for using Kafka.

---

## `sagas` — orchestration that survives a crash

```sql
completed_steps    text[]     -- what has been done — so we know what to compensate
compensated_steps  text[]
context            jsonb      -- enriched by each step, so a recovery has what it needs
state              text       -- running | completed | compensating | compensated | FAILED
```

`state = 'failed'` means **the compensation itself failed**. Money moved and could not be moved back. There is no clever code that fixes that — a human must look, and they must be given a complete record of exactly which steps ran and which compensations succeeded.

---

## Multi-tenancy

**Every table has `org_id`. Every query filters by it. It always comes from the verified token, never from a parameter.**

That is BOLA at the tenant level, closed at the data layer rather than trusted to a middleware someone can forget to attach — and it is why the public demo can share a database with real data without being a vulnerability.
