# Runbook

> It is 3am. Something is wrong. Start here.

## The outbox is backing up

**Symptom:** `outbox_pending` climbing. `outbox_oldest_pending_seconds > 60`.

**What it means:** state changes are landing fine — the API is returning 200s, drivers are happy — but **events are not reaching Kafka**. Notifications and analytics are silently going stale while everything *looks* healthy.

> This is the class of failure that is invisible without observability. The API is *lying to you by being fine*.

```bash
# Is the publisher even alive?
kubectl get pods -n sanad -l app=sanad-outbox

# Is Kafka reachable from inside the cluster?
kubectl exec -it deploy/sanad-api -n sanad -- nc -zv sanad-kafka 9092

# How bad?
psql -c "SELECT status, count(*), min(created_at) FROM outbox GROUP BY status"
```

**Nothing is lost.** The events are in Postgres. When the publisher comes back it drains them. That is the entire point of the pattern — **the outbox turns a Kafka outage into a delay instead of a data-loss event.**

**Fix:** restart the publisher. If Kafka is genuinely down, wait. Do not "clear" the outbox.

---

## Sync latency spiking during the 17:00 storm

**Symptom:** `sync_batch_duration_ms` p95 climbing past 3s. Drivers timing out.

**The death spiral, in order:**

```
pg pool exhausts (20 connections)
  → requests QUEUE waiting for a connection
    → latency climbs
      → devices TIME OUT
        → devices RETRY
          → MORE LOAD
            → back to the top, but worse
```

```bash
# Is the pool the bottleneck?
psql -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state"

# Did the HPA actually scale?
kubectl get hpa sanad-api -n sanad
```

**Fixes, in order of preference:**
1. The HPA should already be scaling on `sync_batch_size` — a **leading** indicator. If it did not, the metric is not reaching the metrics server.
2. Raise `PG_POOL_MAX`. But **check Postgres's own `max_connections` first** — 30 pods × 20 connections = 600, and the database will refuse them.
3. Add a **PgBouncer**. This is the real answer at scale.

---

## Escalations climbing

**Symptom:** `sync_conflicts_total{resolution="escalated"}` rising.

**This is not a bug.** It is the system telling you, honestly, that **reality contains a case the rules do not cover.**

```sql
SELECT type, count(*), array_agg(DISTINCT resolution_reason)
  FROM mutations
 WHERE resolution = 'escalated' AND received_at > now() - interval '1 day'
 GROUP BY type;
```

Read the reasons. If the same shape recurs, **the doctrine needs a new rule** — that is a design conversation, not an incident.

> The failure mode to fear is an escalation rate of **zero**, achieved by guessing.

---

## A device is stuck retrying forever

**Symptom:** one `device_id` hammering `/sync/push`, always 429 or always rejected.

```sql
SELECT outcome, error, count(*) FROM mutations
 WHERE device_id = '<id>' AND received_at > now() - interval '1 hour'
 GROUP BY outcome, error;
```

**If `rejected` with `retryable: false`** — the device is ignoring the flag. That is a **client bug**, and it is a serious one: the device is burning battery and bandwidth on work that will never be accepted.

**If 429** — check the token bucket. A device dark for a *very* long time may legitimately exceed even the 500-mutation burst. Raise its capacity or have the client split the batch.

---

## Cash does not reconcile

**Symptom:** a driver's `outstanding` looks wrong.

**First, rule out the thing that would be catastrophic** — a double-count:

```sql
-- This MUST return zero rows. mutation_id is UNIQUE on cash_entries.
SELECT mutation_id, count(*) FROM cash_entries
 GROUP BY mutation_id HAVING count(*) > 1;
```

If that returns rows, **stop everything.** The idempotency guarantee has failed and the fleet's numbers cannot be trusted.

If it returns nothing (it will), the discrepancy is **operational, not technical** — a driver collected cash and did not remit it. The ledger is right. Go and look at the audit trail:

```sql
SELECT * FROM mutations WHERE user_id = '<driver>' AND type = 'cash.collect'
 ORDER BY client_ts;
```

**The system will tell you exactly what he recorded, when he recorded it, from which device, and when it reached you.** That is what the ledger is *for*.

---

## Rolling back a bad deploy

```bash
kubectl rollout undo deployment/sanad-api -n sanad
kubectl rollout status deployment/sanad-api -n sanad
```

Every image is tagged by **commit SHA**, never `latest` — so *"roll back to what was working"* is a deterministic operation rather than an archaeology exercise.

**Migrations are the dangerous part.** A rollback of the code does **not** roll back the schema. Never write a migration that drops a column in the same release that stops using it — **two releases**, always:

1. stop writing to the column
2. *(next release)* drop it
