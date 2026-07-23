# Architecture

## The shape

```
   ┌─────────────────┐         ┌──────────────────┐
   │  DRIVER PWA     │         │  SALESMAN PWA    │
   │  (delivery)     │         │  (field sales)   │
   │                 │         │                  │
   │  IndexedDB      │         │  IndexedDB       │
   │  local queue    │         │  local queue     │
   └────────┬────────┘         └────────┬─────────┘
            │                            │
            │   POST /sync/push  (a batch, when there is signal)
            │   GET  /sync/pull  (what changed while I was dark)
            └──────────────┬─────────────┘
                           ▼
              ┌────────────────────────┐
              │      SYNC CORE         │   ← the only interesting part
              │                        │
              │  order → dedupe →      │
              │  lock → detect →       │
              │  RESOLVE → apply →     │
              │  ledger → outbox       │
              │                        │
              │  ALL IN ONE POSTGRES   │
              │  TRANSACTION           │
              └────────┬───────────────┘
                       │
         ┌─────────────┴──────────────┐
         ▼                            ▼
   ┌──────────┐              ┌─────────────────┐
   │ POSTGRES │              │ OUTBOX PUBLISHER│  (separate process)
   │          │◄─────────────│  drains outbox  │
   │ · entity │   polls      │  → Kafka        │
   │ · ledger │              └────────┬────────┘
   │ · outbox │                       │
   │ · cash   │                       ▼
   └──────────┘                  ┌─────────┐
                                 │  KAFKA  │
                                 └────┬────┘
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
              notifications      analytics          (a service you
              (consumer grp)    (consumer grp)       build next year —
                                                     replay the log and
                                                     it catches up)
```

## Why the sync core is the whole system

Everything else is a consequence of one requirement: **a device is offline for nine hours and everything it did must be true when it comes back**.

That single requirement forces:

| forces | because |
|---|---|
| **local-first writes** | the UI cannot wait for a network that is not there |
| **client-generated IDs** | only the device knows two uploads are the same act |
| **idempotency** | a dropped ACK on a bad link means the device retries |
| **per-device sequencing** | the order the human acted ≠ the order packets arrived |
| **optimistic concurrency** | you cannot hold a lock across nine dark hours |
| **conflict resolution** | the office moved the row while the device was gone |
| **an event log** | you need to answer "why does this row look like this?" months later |
| **the outbox** | the state change and its event must commit together |
| **at-least-once + idempotent consumers** | because exactly-once is a fantasy |

Not one of those is decoration. Remove the offline requirement and most of this system collapses into a CRUD API.

## The one transaction that justifies Postgres

Applying **one** synced mutation:

```
BEGIN
  SELECT ... FOR UPDATE              -- lock the row
  UPDATE jobs SET ... WHERE version = $n   -- optimistic check; rowCount IS the detector
  UPDATE van_stock SET qty = qty - $x WHERE qty >= $x   -- refuse to go negative
  INSERT INTO cash_entries ...       -- mutation_id UNIQUE → cannot double-count
  INSERT INTO mutations ...          -- the ledger. PK on mutation_id → idempotent
  INSERT INTO outbox ...             -- the event, in the SAME transaction
COMMIT
```

Six writes across five tables. Either all of it lands or none of it does.

**In Mongo this was a hand-rolled conditional `findOneAndUpdate` with a manual rollback in a `catch` block.** That code works. It is also me re-implementing, badly, a thing the database was built to do.

## One transaction per mutation, not per batch

A 200-mutation batch from a device dark all afternoon will contain some that succeed and some that conflict. One giant transaction means **a single stale mutation rolls back a whole day of legitimate field work**.

So: per-mutation atomicity, batch-level **partial success**. The device is told, item by item, exactly what landed.

## Why the outbox publisher is a separate process

If the API published to Kafka inline, a **Kafka outage would mean drivers cannot record deliveries** — the most critical path in the system taken down by a dependency it does not need in order to be *correct*.

Decoupled, Kafka can be down for an hour and the field never notices. Events pile up safely in Postgres and drain when it returns.

## Sockets are a VIEW, never the write path

A socket is ephemeral: if nobody is listening, the message is gone. Fine for "show this driver moving on a map." **Unacceptable for "this parcel was delivered."**

> If every socket in the system dropped simultaneously, **not one delivery would be lost.**

That property is not an accident. It is the architecture.
