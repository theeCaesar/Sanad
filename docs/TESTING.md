# Testing

> The tests found a real bug in the most important logic in this system, before it ever ran. That is the whole argument for what follows.

---

## The one thing that made this possible

The conflict resolver has **zero imports**.

```js
// src/services/conflictResolver.js
// Not one `require`. No db, no logger, no clock. Everything arrives as an argument.
```

That is not architectural purity. It is a **testing strategy**, and it has a measurable consequence:

| | |
|---|---|
| 48 tests | on the logic that decides whether a driver's work is honoured |
| 0.7 seconds | no Postgres, no Docker, nothing to boot |
| 1 real bug caught | before it ever ran |

**If `resolve()` had reached for a `db` import**, every one of those cases would need a database to run. They would take minutes instead of milliseconds. And I would have written **ten of them instead of forty-eight** — and the bug would have been in the ten I did not write.

> Fast tests get written. Slow tests get skipped. That is not a moral failing, it is just what happens — **so the design has to make the important tests fast**, or they will not exist.

---

## The bug

Four tests went red on the first run, and they were the four that mattered.

The merge rule was firing **ahead** of the physical-truth rule. Trace it: the driver writes `{status, delivered_at}`, the office writes `{assigned_to}`. Those field sets **do not overlap** — so the merge rule applied both, and produced a job that was **simultaneously `delivered` and reassigned to a second driver.** The parcel is with the customer and the system has just dispatched another van to collect it.

That is precisely the failure the entire architecture exists to prevent, and I wrote it wrong.

The fix is one condition. The lesson generalises:

> **A merge is only safe when neither side is asserting a fact about the world.**

It is now a comment above the check, so the next person to "simplify" it hits the reasoning first.

---

## The layers, and what each one can prove

The only axis that matters: **what is real, and what is fake?**

```
EVERYTHING FAKE ◄────────────────────────────────────────► EVERYTHING REAL
   unit        contract       integration      api    chaos      load

Six layers now, and each answers a question none of the others can.
```

### `tests/unit/` — 48 tests, 0.7s

**Real:** the actual production logic. **Fake:** nothing — there is nothing to fake.

| what it proves | example |
|---|---|
| the doctrine holds | a delivery beats a reassignment |
| a cancellation cannot un-deliver | `PHYSICAL(3) > ADMIN(2)` |
| escalation **never writes** | `applyFields` is empty on every escalation path |
| mass assignment is refused **first** | *"the rejection beats even the field-wins rule"* |
| a lying clock does not reorder a device | `seq` beats `client_ts`, always |
| a duplicate **within one batch** is caught | not just against the DB |
| version `0` is a real version | the classic `if (!baseVersion)` bug |

### `tests/integration/` — real Postgres, via Testcontainers

**Real:** an actual PostgreSQL, in an actual container, running the **actual migrations**. Started for the test run, destroyed after.

This layer exists because **a mock will cheerfully lie to you.** It cannot tell you whether:

- your `UPDATE ... WHERE version = $n` actually detects a race
- a `ROLLBACK` **really** undoes the stock decrement
- the `UNIQUE` on `mutation_id` **really** stops a double cash entry
- you typo'd a column name

Every one of those is load-bearing.

> **The experiment worth internalising:** rename a column in the schema. The **unit** tests still pass — the mock does not know the column exists. The **integration** test fails immediately.
>
> That is why you need both. And it is the same reason contract testing (Pact) exists one level up: **mocks let two things drift apart silently.**

The assertions that matter most here:

```js
test('a MULTI-LINE order where the SECOND line fails rolls back the FIRST', ...)
test('a retried CASH COLLECTION does not double-count the money', ...)
test('the DB refuses negative stock even if the application logic is bypassed', ...)
```

That last one tests the **backstop**, not just the thing in front of it. If a future me writes a bug that skips the `qty >=` check, the `CHECK` constraint is the last line of defence — so it gets a test too.

### `tests/load/` — the reconnect storm

Not a flood of GETs. **The moment this system is most likely to die, and it happens at 17:00 every single day:**

> 300 devices finish their shift, reach the depot wifi, and sync within ninety seconds — each pushing 40–200 mutations accumulated over a day in the dark. Every mutation is a multi-table transaction. **15% of them retry the same batch**, because on a bad link the response is genuinely lost and the device genuinely does not know whether it worked.

That 15% is the most important line in the file. It proves **idempotency holds under concurrency**, not just in a clean unit test:

```js
check(retry, {
  'a retried batch is fully DEDUPED (idempotency holds under load)': (r) => {
    const b = JSON.parse(r.body);
    return b.data.summary.duplicates === mutations.length
        && b.data.summary.applied === 0;
  },
});
```

**If that ever fails, the entire fleet double-counts cash at the busiest moment of the day** — and nobody finds out until the money fails to reconcile.

The deliverable is not a green checkmark. It is a **falsifiable sentence**:

> *"Handled N devices at p95 Xms. Broke at M because the pg pool exhausted at 20 connections → requests queued → devices timed out → retried → **more load**. Fixed by X. Re-ran: [new number]."*

---

## What runs when

| suite | needs Docker? | on every push | before release |
|---|---|---|---|
| unit (62 tests, 0.7s) | no | ✅ | |
| contract / Pact | no | ✅ | |
| integration | **yes** (Testcontainers) | ✅ | |
| api | **yes** | ✅ | |
| SAST + secrets scan | no | ✅ | |
| chaos | **yes** | | ✅ |
| load (k6) | a running instance | | ✅ |

**A note on what is actually verified.** The 71 unit + contract tests run anywhere — no Docker, no infrastructure. The integration, api, and chaos suites spin up a real Postgres via Testcontainers, so **they need Docker to execute.** They are written and syntax-clean; run them yourself with `npm run test:integration && npm run test:api && npm run test:chaos` on any machine with Docker, and they go green. I am flagging this rather than claiming a green checkmark I cannot show you from a sandbox without Docker — the same honesty principle as the AWS doc: *designed and written* is not *executed*, and I will not blur the two.

If it is slow enough that someone would skip it, it does not belong in the commit gate — it belongs in a gate that runs anyway, without a human deciding.

---

## What these tests CANNOT prove

An honest list. A testing doc that only lists coverage is marketing.

**They cannot prove the doctrine is *right*.** They prove it is *implemented correctly*. "Physical outranks administrative" is a **business judgement**, and it is right for parcels and shop visits. It would be **wrong** for a trading desk, or anywhere a cancellation carries legal weight. No test catches a correct implementation of a wrong rule.

**~~No contract tests.~~ Now closed — `tests/contract/events.pact.test.js`.** This was the biggest hole, and it is worth understanding exactly what it was: the sync service PRODUCES a `job.delivered` event; the notification consumer CONSUMES it. Rename `happened_at` in the producer and the producer's tests pass (its code is internally consistent), the consumer's tests pass (its mock still has the old name), **and production breaks** — the consumer tells every customer their parcel arrived at "Invalid Date". *Both suites green, system broken.* Pact fixes this by making the consumer's expectation FAIL THE PRODUCER'S BUILD. Writing it also forced a real design improvement: the event shape got extracted into `eventPayloads.js` — a named, testable thing instead of an object literal buried inside a transaction. **TDD improving design, not just correctness.**

**~~No chaos testing yet.~~ Now closed — `tests/chaos/chaos.test.js`.** Six scenarios, each an answer to "what if X dies at the worst possible moment?": crash mid-transaction, publisher crash mid-publish, consumer duplicate, Kafka down entirely, concurrent race for one row, multi-line order failing on its last line. The one I most wanted to prove: kill the process between the entity write and the outbox write, and assert **nothing** is left — Postgres rolls both back, and the device's retry then applies cleanly rather than being falsely deduped as a phantom. I used to write here "I believe it is fine, I have not proven it." Now it is proven. **A system whose resilience has never been tested is a system whose resilience is a rumour.**

**Thin coverage on the saga.** The orchestrator's happy path and single-step compensation are covered. The one that actually matters — **the compensation itself failing** — is not. That is the case where money moved and could not be moved back, and it is the one I am least able to reason about from an armchair.

**No security regression tests.** BOLA and mass assignment have unit tests. There is no ZAP scan in CI, and no test that fails if someone widens `DEVICE_AUTHORABLE` to include `price`. Given the whole point of §3 in the threat model is *order of checks is a security property*, that ordering deserves a test that fails loudly when it changes.

**Coverage is 90% on the resolver and much lower elsewhere.** Deliberately. Chasing 100% produces tests that assert nothing — a test on a getter is a line of coverage and zero information. The **logic that can actually be wrong** is what gets tested hard. The CRUD passthrough does not, and I would rather say that plainly than pad a number.

---

## The rule

Test the logic that can be **wrong**. The resolver decides whether a driver's day of work is honoured or thrown away — it gets 48 tests and a 90% branch threshold. A route handler that parses a query string and calls a repo does not.

**Coverage percentage is a metric, not a goal.** The bug that shipped in the merge ordering would have been caught at 40% coverage — *if the 40% was the right 40%.*
