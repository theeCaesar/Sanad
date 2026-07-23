# Conflict resolution is a business decision, not a technical one

> If you read one document in this repository, read this one. The code is downstream of it.

---

## The moment the problem becomes real

A driver loses signal in Abu Ghraib at 13:40.

At **14:02** he hands a parcel to Um Ahmed, gets a signature, and taps *Delivered* on a phone with no connectivity. The mutation goes into a local queue. As far as the server is concerned, nothing happened.

At **14:30**, in the office, a dispatcher looks at a job that has not moved in an hour, assumes the driver is stuck in traffic or has broken down, and **reassigns it to another driver**. This is a reasonable decision. Given what the office can see, it is arguably the *correct* decision.

At **17:00** the first driver reaches wifi. His delivery arrives — three hours after it happened — against a row that has changed underneath him.

**Who wins?**

---

## Why the obvious answers are all wrong

### "Last write wins"

The dispatcher's write is newer (14:30 > 14:02). So the reassignment stands, and the delivery is discarded.

The system now believes a parcel currently sitting in Um Ahmed's kitchen is still out for delivery. It dispatches a second driver to collect it. The first driver's work — the actual, physical, completed work — has been silently deleted by a system that trusted a clock.

This is not a merge conflict. **This is the database lying about the physical world.**

### "The server is authoritative"

Same outcome, wearing a nicer hat. The server's state is *not* more true than the field's — it is merely more *recent*, and recency is not truth. The server did not see the parcel change hands. The driver did.

The office is not authoritative about reality. It is authoritative about *intent*. Those are different things, and conflating them is the root error.

### "The newest timestamp wins"

Whose clock? A field phone's clock drifts, gets set by hand, jumps on a timezone change, and can be trivially modified by anyone who wants to. Building your consistency model on a hostile client's system clock is not a design, it is a wish.

### "Ask the user every time"

There will be forty conflicts on a bad day. A dispatcher who is asked forty times will, by the fifth, start clicking whichever button is on the left. **A prompt that fires constantly is a prompt nobody reads** — and the two conflicts that genuinely needed a human get buried in thirty-eight that did not.

False alarms are not harmless. They destroy the value of the true alarms.

---

## The rule

> ## Physical truth outranks administrative intent.

A delivery **happened**. It is an event, in the world, irreversible.
A reassignment is an **intention** about what *should* happen. It is a plan.

When a plan collides with an event, **the event wins**, and the plan is told it was overtaken by reality.

The delivery stands. The reassignment is superseded. The dispatcher is notified, in plain language, that a physical delivery at 14:02 outranks an office edit at 14:30 — and can see exactly why.

**That sentence is the entire system.** Everything below is bookkeeping.

---

## Encoding it

Every state gets a **rank**. Higher rank wins.

| rank | kind | states | means |
|---|---|---|---|
| **3** | PHYSICAL | `delivered` `failed` `completed` `skipped` | it happened in the world. Irreversible. |
| **2** | ADMIN | `cancelled` | an office decision. Beats in-progress, loses to physical. |
| **1** | PROGRESS | `assigned` `accepted` `picked_up` `checked_in` | a step along the way. Loses to any terminal state. |
| **0** | INITIAL | `draft` `planned` | nothing has happened yet. |

Note carefully:

- `delivered` is **PHYSICAL** — a parcel changed hands.
- `failed` is **PHYSICAL** too — the customer was genuinely not home. That is an event, not an opinion.
- `cancelled` is only **ADMIN** — somebody at a desk decided something.

**Those three lines are the most consequential in the codebase.** They are three lines because the thinking happened before the typing.

### The consequence, stated bluntly

**A cancellation cannot un-deliver a parcel.** The office cancels at 14:30; the driver delivered at 14:02. `PHYSICAL (3) > ADMIN (2)`. The delivery stands. The cancellation was a decision about a future that had already been overtaken by the past.

---

## The decision order — and this is where I got it wrong

The rules are checked **in this order**, and the order *is* the design.

```
(a) DISJOINT FIELDS       → MERGE
(b) SERVER IS PHYSICAL    → SERVER_WINS  (+ escalate if device is ALSO physical)
(c) DEVICE IS PHYSICAL    → FIELD_WINS   the core rule
(d) SERVER TERMINAL,
    DEVICE IN-PROGRESS    → SERVER_WINS
(e) RANK COMPARE          → higher wins; equal → ESCALATE
```

### The bug

I wrote (a) before (c) and shipped it straight into a test suite that immediately went red.

Trace it. The driver writes `{status, delivered_at, recipient_name}`. The office writes `{assigned_to}`. **Those field sets do not overlap.** So rule (a) fired: no overlap, nobody disagrees, merge them, apply both.

Result: a job that is **simultaneously `delivered` AND reassigned to a second driver.** The parcel is with the customer and the system has just dispatched another van to go and collect it.

Four unit tests caught it in 0.7 seconds. The fix is one condition — a physical claim skips the merge path unconditionally — and the lesson generalises well beyond this codebase:

> **A merge is only safe when neither side is asserting a fact about the world.**
>
> Two edits to *metadata* can be blended. An edit that says *this physically happened* cannot be blended with anything, because it may **invalidate the other side entirely**. It has to be arbitrated.

That paragraph is now a comment above the check, so the next person who tries to "simplify" the ordering hits the reasoning before they hit the code.

---

## Merge: the quiet 80%

Most "conflicts" are not conflicts.

The office bumps `priority`. The driver records `recipient_name`. The version moved, so a naive implementation shouts *CONFLICT!* — but **nobody actually disagrees about anything.** Different fields, different owners, no contradiction.

So we split ownership explicitly:

| **device may author** | **office may author** |
|---|---|
| `status` `delivered_at` `picked_up_at` `failure_reason` `cash_collected` `proof_media_key` `recipient_name` `field_note` `delivered_lat/lng` | `assigned_to` `priority` `customer_id` `address` `window_start/end` `price` `cod_amount` |

Disjoint sets → **merge**. Both apply. No alarm, no prompt, no dispatcher's time wasted.

Getting this right is what keeps the conflict inbox *readable* — and a conflict inbox nobody reads is a conflict inbox where the real conflicts get missed.

### And it doubles as a security control

A driver's phone is a **hostile client**. It is in someone's pocket, it can be rooted, the APK can be modified.

A mutation claiming to set `price` or `assigned_to` is not a conflict to be arbitrated. **It is an attack to be refused.** That allowlist is OWASP API #3 (mass assignment), enforced at the sync boundary — which for this system *is* the write path.

The allowlist check runs **first**, before any resolution logic. An attacker cannot smuggle a `price` change through by attaching it to a legitimate delivery. **Order of checks is a security property.**

---

## Escalation: refusing to guess

Sometimes there is no principled winner. Two writes of equal rank, touching the same field, and no rule that says which is right.

The system **does not guess.** It escalates to a human, attaches both versions, and **touches nothing.**

```js
reason:
  'Equal rank with overlapping fields. There is no principled winner here, so the ' +
  'system refuses to invent one. Escalated to a dispatcher with both versions ' +
  'attached. Guessing silently is how systems lose money quietly.'
```

**An escalation is not a failure of the design.** It is the design declining to invent an answer it does not have.

And an escalation **must not write.** A system that escalates *and* acts has escalated nothing — it has merely added a notification to a decision it already made unilaterally. There is a unit test asserting `applyFields` is empty on every escalation path, because this is exactly the property that erodes first.

> A **rising** escalation rate is the system telling you, honestly, that reality contains a case your rules do not cover. That is a feature.
>
> The failure mode to fear is an escalation rate of **zero**, achieved by guessing.

---

## The special case that is not a data problem

Two devices both report delivering the same parcel.

`SERVER_WINS` — the first physical claim stands, because a parcel is delivered once. But we **escalate anyway**, with a different reason:

> *"The device ALSO reports a physical event — two devices claim the same parcel. Escalated: this is a real-world discrepancy, not a data one."*

No amount of clever code fixes this. Either a driver made a mistake, or a parcel was handed to the wrong person, or someone is lying. **The correct behaviour of the software is to notice, refuse to paper over it, and get a human involved** — because the bug is not in the database.

Knowing which problems are *not yours to solve* is part of the job.

---

## Detection: one integer

```sql
UPDATE jobs SET status = $1, version = version + 1
 WHERE id = $2 AND version = $3   -- ← the version the device last saw
```

`rowCount = 0` → somebody moved the row while the device was dark.

That is the whole mechanism. **Optimistic concurrency control.** No locks held across the device's nine dark hours, no polling, no trusting a clock. One integer comparison, and it works whether the device was gone for four seconds or four days.

A stale write is not automatically **wrong**. It is merely **uninformed**. Deciding what to do about it is what everything above is for.

---

## Ordering: a lying clock

Mutations apply in the order the **human acted**, not the order the packets arrived.

Why not sort by timestamp? Because **the phone's clock is not trustworthy.**

So: order by `(device_id, seq)`. `seq` is a monotonic counter the device increments locally and never reuses. **Within a device, `seq` IS the truth about order** — and it beats the timestamp even when the timestamp says the opposite.

Across devices, fall back to `client_ts`, then `mutation_id` for a **deterministic** tiebreak. Never an unstable sort: the same batch must always apply the same way, or replay stops being reproducible — and replay is one of the reasons this system has an event log at all.

> Applied in arrival order, a shuffled batch would try `delivered` before `picked_up`, get rejected as an illegal transition, and **a real delivery would be lost to a networking artefact.**

---

## Why every driver sees the reason

Every conflict carries a human-readable `resolution_reason`, and it is surfaced to *both* the driver and the dispatcher:

> *"Your delivery was recorded. The office had reassigned this job while you were offline, but what happened in the field stands."*

> *"Physical truth outranks administrative intent: the parcel is in the customer's hands and no office edit can un-happen that. Your reassignment was superseded and the delivery has been applied."*

This is not decoration. **A system that silently overrides a human's decision is a system that human will fight, work around, and eventually disable.**

An automated decision nobody understands is an automated decision nobody trusts — and an untrusted automatic decision is *worse than no automatic decision at all*, because now you have both the wrong answer and no one watching for it.

**The reason string is the product.** The resolution is just the mechanism.

---

## What this actually cost

Honest accounting, because a design doc that only lists wins is marketing.

**The device can be wrong.** A driver taps *Delivered* at the wrong address. That physical claim outranks everything and is applied. The system has no way to know — and neither would any other design, because the system was not there. What it *does* have is a complete audit trail with a name, a device, a GPS fix, a photo, and a timestamp on it. **You cannot prevent this in software. You can make it accountable.**

**A revoked device does not know it is revoked** until it reaches signal. Everything it queued in the meantime is discarded. That is not a flaw in the scheme — *it is not possible to tell an offline device anything*, by definition, so every scheme has this property. The alternative (trusting the offline token) is strictly worse.

**Escalations need a human, and humans are slow.** An unresolved conflict is a job whose true state nobody knows, and every hour it sits there the business runs on a fiction. The mitigation is to make escalations *rare* (that is what the merge rule is for) and *loud* (`severity: critical`).

**The rules encode a judgement.** "Physical outranks administrative" is right for parcels and shop visits. It would be **wrong** for a system where the office holds information the field does not — a trading desk, a system where a cancellation carries legal weight. *The doctrine is domain-specific, and pretending otherwise would be the real error.*

That is the actual thesis, and it is why the title of this document is what it is:

> **Conflict resolution is a business decision, not a technical one.**
>
> The technology can detect the conflict. Only the business can say who is right.
