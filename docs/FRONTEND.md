# Building a client

## The one rule

**Never wait for the network to update the UI.**

```js
async function markDelivered(jobId, data) {
  // 1. Write locally. Immediately.
  const mutation = {
    mutation_id: crypto.randomUUID(),   // YOU generate this. Not the server.
    seq: await nextSeq(),               // a local counter. Never reused.
    type: 'job.deliver',
    entity_id: jobId,
    base_version: job.version,          // the version you last saw
    client_ts: new Date().toISOString(),// NOW. When it actually happened.
    payload: data,
  };

  await db.mutations.add(mutation);     // IndexedDB
  await db.jobs.update(jobId, { status: 'delivered', _pending: true });

  // 2. Update the UI. The driver does not wait.
  render();

  // 3. Sync when you can. Maybe now, maybe in nine hours.
  trySync();
}
```

## `mutation_id` must be generated on the device

**The server cannot generate it.** Only the device knows that two uploads are the same act.

Generate it **once**, when the driver taps the button — **not** when you send. If you regenerate on retry, every retry is a new mutation, and the idempotency guarantee is gone.

## `seq` must be monotonic and never reused

```js
async function nextSeq() {
  const s = (await db.meta.get('seq'))?.value ?? 0;
  await db.meta.put({ key: 'seq', value: s + 1 });
  return s + 1;
}
```

Persist it. If it resets on app restart, mutations reorder and deliveries get rejected as illegal transitions.

**Do not sort by timestamp.** The phone's clock lies.

## Handling the verdicts

```js
for (const r of response.data.results) {
  switch (r.outcome) {
    case 'applied':
    case 'duplicate':
      await db.mutations.delete(r.mutation_id);   // it landed. drop it.
      break;

    case 'conflict':
      await db.mutations.delete(r.mutation_id);
      // SHOW THE DRIVER THE REASON. Do not swallow it.
      //   "Your delivery was recorded. The office had reassigned this job
      //    while you were offline, but what happened in the field stands."
      notify(r.reason);
      break;

    case 'rejected':
      if (r.retryable) {
        // KEEP IT. A server error is worth retrying.
        break;
      }
      // Permanent. Drop it, roll back the optimistic UI, and TELL HIM.
      await db.mutations.delete(r.mutation_id);
      await rollbackOptimistic(r.mutation_id);
      notify(r.reason);
      break;
  }
}
```

**`retryable` is the most important field in the response.** A device holding unsynced work has to decide: retry, or drop it and tell the driver it failed? **Get that wrong and you lose deliveries.**

## Respect `Retry-After`

```js
if (res.status === 429) {
  const wait = Number(res.headers.get('Retry-After') || 5);
  setTimeout(trySync, wait * 1000);
  return;   // Do NOT drop the queue. The work is safe. Just wait.
}
```

A 429 during the 17:00 reconnect storm is **the limiter working**, not a failure. Hold the queue and come back.

## Backoff, with jitter

```js
const delay = Math.min(1000 * 2 ** attempt, 60000);
const jittered = delay * (0.5 + Math.random());   // jitter
```

**Without jitter, 300 devices all retry at the same millisecond** — and you have built a thundering herd on top of a reconnect storm.

## Pull, with an overlap

```js
const since = new Date(lastCursor - 1000);   // 1 second of overlap
```

Two rows can share an `updated_at` to the microsecond. A strict cursor **silently drops the second one, forever.**

Re-receiving a row you already have is free — you upsert it. **Losing one is not.** When in doubt, ask for it twice.
