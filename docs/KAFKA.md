# Kafka — from zero

> You've never used Kafka. This builds it up from nothing: what it is, why it's different from a normal queue, and exactly how this project uses it. Read this before the code.

---

## Start with the problem Kafka solves

When a delivery lands in Sanad, several *different* things need to happen next:

- the customer should get an SMS ("your parcel arrived")
- the analytics system should count it
- if stock ran low, a reorder alert should fire

The sync engine that recorded the delivery **should not do all of that itself.** If it did, then a slow SMS gateway would slow down every delivery, and an analytics bug could break the sync path. You want the delivery to be recorded *fast*, and all the reactions to happen *separately, later, independently.*

That's what Kafka is for: the sync engine announces **"a delivery happened"** once, and any number of other systems react to it on their own time, without the sync engine knowing or caring who's listening.

This pattern is **event-driven architecture**. The sync engine *produces an event*; other services *consume* it.

---

## What Kafka actually is

Kafka is a **distributed, append-only log.**

That phrase is the whole thing, so unpack it:

- **Log** — not a fancy word here. Literally a list of messages, in order, that you only ever add to the end of. Like a chat history: message 1, message 2, message 3... You never edit or delete; you only append.
- **Append-only** — once a message is written, it stays. This is the key difference from a normal queue (below).
- **Distributed** — it runs across multiple machines for scale and reliability.

### Kafka vs a normal queue — the critical difference

A normal message queue (like RabbitMQ, or a to-do list) works like this: you take an item off, you process it, **it's gone.** Consume = delete.

Kafka does NOT delete when you read. The message stays in the log. Instead, each reader keeps track of **its own position** (called an *offset*) — "I've read up to message #47." Different readers can be at different positions in the same log.

**Why this matters, concretely:** because messages aren't deleted, a *brand-new* service you build **next year** can start reading from message #1 and replay the entire history — every delivery that ever happened — to build up its own view of the world. A normal queue can't do this; the messages are long gone. This is Kafka's superpower, called **replay**, and it's the main reason to choose Kafka over a simpler queue.

**The mental model:** a normal queue is a stack of papers in an inbox — you take one, deal with it, throw it away. Kafka is a newspaper archive — every issue is kept forever, and any number of readers can each read at their own pace, and a new reader can start from any old issue.

---

## The four Kafka words you need

### 1. Topic
A named stream of messages. Sanad has topics like `jobs`, `sales`, `inventory`, `notifications`. A "delivery happened" event goes on the `jobs` topic. Think of a topic as a channel or a category.

### 2. Partition
A topic is split into **partitions** so it can be processed in parallel (different partitions on different machines). This gives you throughput.

**The one rule that matters:** ordering is guaranteed **only within a single partition**, never across the whole topic. Messages in partition 0 are strictly in order; but message in partition 0 vs message in partition 1 — no ordering guarantee between them.

### 3. Partition key — the thing you must get right
When you write a message, you give it a **key**, and Kafka uses that key to decide which partition it goes to. **Same key → same partition → guaranteed order.**

Sanad keys every event by `entity_id` (the job's ID). So *all events for one specific job* — picked_up, then delivered — land in the *same* partition and are therefore read **in the right order.**

Get this wrong (say, use a random key) and a consumer could see `delivered` *before* `picked_up` for the same job, and its logic falls apart. **The partition key is how you control ordering in Kafka, and it's the thing juniors miss.**

### 4. Consumer group — how scaling and fan-out work
This is the cleverest concept, and it does two opposite things depending on how you use it:

- **Same group = split the work.** If you run 5 copies of the notification service all in the group `notifications`, Kafka *divides the partitions among them* — each copy handles a share. That's how you scale up processing.

- **Different group = everyone gets everything.** The `notifications` group and the `analytics` group are two *different* groups. Each group gets its **own independent copy of every message**, with its own position. Notifications and analytics both see every delivery, independently.

**One sentence to remember:** *same group splits the work; different groups each get the full stream.* That's the entire power of Kafka's consumer model.

---

## How Sanad uses it — the flow

```
1. A delivery syncs. The sync engine writes it to Postgres AND writes an
   event to the "outbox" table — in the SAME transaction (see below, this is
   the important part).

2. A separate worker (the "outbox publisher") reads new outbox rows and
   PUBLISHES them to Kafka, on the "jobs" topic, keyed by the job id.

3. Kafka holds the event. It's now durable and ordered.

4. Consumers react:
     - the notification consumer (group "notifications") sends the SMS
     - an analytics consumer (group "analytics") counts it
   Each on its own time, independently. If notifications is slow, analytics
   doesn't care.
```

### Why the publisher is separate (the outbox pattern)

This is the part worth understanding in detail.

You cannot **atomically** write to Postgres and write to Kafka. They're two different systems — there's no single transaction that covers both. So if you did them one after the other:

- write to Postgres, then crash before writing to Kafka → the delivery exists but nobody's ever told. Customer never gets their SMS.
- write to Kafka, then crash before Postgres commits → you announced a delivery that didn't actually happen.

Either way you're broken. This is called the **dual-write problem.**

**The fix (the outbox pattern):** don't write to Kafka during the request at all. Instead, write the event into an `outbox` **table in Postgres, inside the same transaction as the delivery.** Now they're atomic — both save or neither does. Then a *separate* worker reads the outbox table and relays events to Kafka afterward.

The guarantee: it's **impossible for a delivery to exist without its event**, because they were written in the same transaction. The event might reach Kafka a second later, but it *will* reach it.

**Bonus:** because the publisher is separate, **Kafka can be completely down and drivers can still work.** Deliveries land in Postgres, events pile up safely in the outbox, and they drain to Kafka when it comes back. The outbox pattern turns a Kafka *outage* into a Kafka *delay*.

---

## At-least-once, and why you must handle duplicates

The outbox publisher can crash *after* sending to Kafka but *before* marking the outbox row as "done." On restart, it re-sends. So **Kafka can receive the same event twice.**

This is deliberate. The choice is between:
- **at-least-once** (might send twice, never zero times) ← Sanad chooses this
- **at-most-once** (might send zero times, never twice)

A duplicate "delivered" SMS is annoying. A *lost* "delivered" event means a customer is never told and nothing ever recovers it. So duplicates are the safer failure.

**But** that means every consumer must be **idempotent** — able to receive the same event twice and do the right thing once. Sanad does this with a `processed_events` table: before acting, the consumer records the event's ID; if it's already there, it skips. (Keyed by `(event_id, consumer_group)` so that notifications and analytics — different groups — both still get to process it independently.)

**"Exactly-once delivery" doesn't really exist.** What you build is at-least-once delivery + idempotent consumers, which together give **exactly-once effects.** That's the honest, senior framing — say it exactly that way.

---

## The dead letter queue (DLQ)

What if an event is malformed and *can never* be processed successfully? If you just kept retrying it, it would **block every message behind it** in its partition (remember: strict order within a partition). One poison message freezes the whole stream.

So after N failed attempts, the event is moved to a **dead letter queue** — a separate holding area — the position is advanced, and the pipeline moves on. The event isn't lost; it's quarantined for a human to look at, without holding the live pipeline hostage.

---

## What's real vs. simplified in this project

- The Kafka code (`outboxPublisher.js`, `notificationConsumer.js`) is **real** — it uses the actual `kafkajs` library, real topics, real consumer groups, real partition keys, a real DLQ.
- In `docker compose up`, a real Kafka broker starts and the events actually flow.
- In production (AWS), this would be MSK (managed Kafka). The AWS doc honestly notes MSK is arguably overkill at this scale and SQS+SNS would do 90% of the job for a fraction of the cost — the 10% you'd lose being *replay*.

---

## Where it is in the code

- `src/workers/outboxPublisher.js` — reads the outbox table, publishes to Kafka.
- `src/workers/notificationConsumer.js` — consumes events, sends notifications, idempotent.
- `src/services/eventPayloads.js` — the exact shape of each event (contract-tested).
- `src/db/migrations/*_outbox*` — the outbox table.
- `docker-compose.yml` — the `kafka` service.

---
