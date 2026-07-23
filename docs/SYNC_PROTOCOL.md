# The sync protocol

## The wire format

```jsonc
POST /sync/push
Authorization: Bearer <device token>   // NOT an access token. See SECURITY.md §1.

{
  "mutations": [{
    "mutation_id": "uuid",     // CLIENT-generated. The idempotency key.
    "seq": 42,                 // per-device monotonic. Never reused.
    "type": "job.deliver",
    "entity_id": "uuid",
    "base_version": 3,         // the row version the device LAST SAW
    "client_ts": "2026-07-13T14:02:00Z",   // when it HAPPENED, in the field
    "payload": { "recipient_name": "Um Ahmed" }
  }]
}
```

**Four fields carry the whole design.**

### `mutation_id` — generated on the DEVICE

The server cannot generate it. **Only the device knows that two uploads are the same act.**

On a bad link the device uploads, the server applies it, and the response is lost on the way back. The device concludes it failed and retries. The `mutation_id` is what makes that retry a **no-op** instead of a double delivery.

It is the `PRIMARY KEY` of the mutation ledger. Replay a request a hundred times: **one row.**

### `seq` — because the clock lies

A field phone's clock **drifts, gets set by hand, jumps on a timezone change,** and can be trivially modified by anyone who wants to.

`seq` is a local counter the device increments and never reuses. **Within a device, `seq` IS the truth about order** — and it beats `client_ts` even when the timestamp says the opposite.

Applied in arrival order, a shuffled batch would try `delivered` before `picked_up`, get rejected as an illegal transition, and **a real delivery would be lost to a networking artefact**.

### `base_version` — one integer, and it is the entire conflict detector

```sql
UPDATE jobs SET ... WHERE id = $1 AND version = $2
```

`rowCount = 0` → somebody moved the row while the device was dark.

No locks held across nine hours. No polling. No trusting a clock. **One integer comparison**, and it works whether the device was gone for four seconds or four days.

### `client_ts` — when it HAPPENED, not when it arrived

A normal API throws this away, because it assumes the two are the same moment. **They are not, and the gap between them is the most interesting number this system produces.**

It is what makes the dark-time report possible, and it is why a customer is told *"delivered at 14:02"* — when it actually happened — rather than *"delivered at 17:30"*, which is merely when we found out.

## What the device does

```
OFFLINE:
  1. write to IndexedDB immediately
  2. update the UI optimistically — the driver never waits for a network
  3. append a mutation to the local queue with seq = ++counter

ONLINE:
  4. POST the whole queue
  5. read the per-mutation verdicts
  6. drop the applied + duplicate ones from the local queue
  7. roll back the UI for anything rejected, and TELL THE DRIVER WHY
  8. GET /sync/pull to see what the office changed while he was gone
```

## The verdicts

| outcome | means | device should |
|---|---|---|
| `applied` | landed cleanly | drop from queue |
| `duplicate` | already seen — a retry | drop from queue |
| `conflict` + `field_wins` | **your work stands** | drop from queue, show the reason |
| `conflict` + `server_wins` | office decision stood | drop, **tell the driver he wasted a trip** |
| `conflict` + `merged` | no real disagreement | drop |
| `conflict` + `escalated` | a human must decide | drop, mark as pending review |
| `rejected` + `retryable: false` | illegal / unauthorised | drop, surface the error |
| `rejected` + `retryable: true` | server error | **KEEP IT. Retry.** |

That last row is why every error carries `retryable`. **A field device holding unsynced work has to decide: retry, or drop it and tell the driver it failed? Getting that wrong loses deliveries.**

## Partial success is NORMAL

A batch of 40 from a driver dark all afternoon might land 37 applied, 2 duplicates, and 1 conflict.

**That is a `200`.** The sync worked. The *mutations* are what have verdicts.
