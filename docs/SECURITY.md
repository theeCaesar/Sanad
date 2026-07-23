# Threat model

> I hold an eJPT. I spend part of my time breaking systems. This is what happens when the person who would attack this thing is the person who built it.
>
> Most backend engineers write features and hope. This document is me attacking my own system on purpose, writing down what I found, and fixing it before someone else does.

---

## The thing that makes this system unusual

**The client is hostile by design.**

A driver's phone is not a trusted terminal in a controlled office. It is:

- in someone's pocket, in a van, in a city
- rootable
- running an APK that can be modified
- **holding a credential that must remain valid for nine hours with no way to check in**

That last one is not a corner case. It is the core requirement. And it means the standard playbook — short-lived tokens, refresh silently, revoke instantly — **does not work here**, and pretending it does would be the first vulnerability.

---

## 1. The offline auth problem

### The attack

Steal a driver's phone. It holds a token. How long is that token good for?

### Why the standard answer fails

Short-lived access token (15m) + refresh in the background. The entire scheme assumes the client can reach the auth server whenever it likes.

A driver in Abu Ghraib **cannot**. If his token expires at 08:15, then for the next nine hours his app is logged out, and he cannot record the twelve deliveries he is physically making. The app is useless at the exact moment it is needed.

The naive fix — a 30-day access token — is a **security disaster**. A stolen phone is a valid credential for a month, with no way to pull it back.

### The answer: separate the two things the token is doing

**Invert what the credential authorises.**

| | **Device token** | **Access token** |
|---|---|---|
| lifetime | 90 days | 15 minutes |
| what it proves | *this physical device belongs to this driver* | *this person is logged in* |
| what it opens | **`/sync` and nothing else** | the dashboard, reports, media |
| can it read the fleet? | **no** | yes (if dispatcher) |
| can it change a price? | **no** | no |

The device token is long-lived **precisely because it authorises so little**.

Working offline requires **no authorisation at all** — it is just writing to a local queue. Authorisation happens when the work **arrives**, and it is checked against **current server state**, not against whatever the token claimed nine hours ago:

```js
// syncService.applyOne — every mutation, every time
if (row.assigned_to && row.assigned_to !== ctx.userId) {
  logger.warn({...}, 'sync: BOLA attempt');
  return reject('This item is not assigned to you.');
}
```

> **The scope of a credential should be inversely proportional to its lifetime.**

### And revocation still works

Three kill switches, checked **fresh from the database on every single sync** — because a token in a driver's hand may be nine hours old and cannot be trusted to reflect any of them:

1. `devices.revoked` — this phone was lost
2. `users.active` — this driver left the company
3. `users.token_version` — global session revocation

A thief can tap *Delivered* into a local queue all day. **Every mutation is rejected the moment it touches the network.** The blast radius of a stolen device is **zero server-side writes**.

### The honest cost

A device revoked at 09:00 does not find out until it reaches signal, and any work it did in between is discarded. **That is not a flaw in the scheme — it is not possible to tell an offline device anything.** Every design has this property. The alternative (trusting the offline token) is strictly worse.

---

## 2. BOLA — the #1 API vulnerability, and the easiest to ship

### The attack

```http
GET /api/v1/jobs/{someone-elses-job-id}
Authorization: Bearer <a valid driver token>
```

I am authenticated. The check passes. I get another driver's job — with the **customer's name, phone number, and home address** in it.

This is **Broken Object Level Authorization**, it is the most common serious API vulnerability in the world, and it exists because *"is this user logged in?"* is a different question from *"is this user allowed to see THIS ONE?"*

Every codebase I have written before this one had it somewhere.

### Closed, at the row

```js
const job = await jobRepo.findById(req.ctx.orgId, req.params.id);
if (!job) return next(new AppError('Not found.', 404));

// The job exists AND the caller is authenticated. Neither of those means
//   he is allowed to see THIS ONE.
if (req.ctx.role === 'driver' && job.assigned_to !== req.ctx.userId) {
  return next(new AppError('This item is not assigned to you.', 403));
}
```

And at the **query**, for lists — which is stronger, because it cannot be forgotten:

```sql
WHERE org_id = $1 AND assigned_to = $2   -- $2 comes from the TOKEN
```

**There is no parameter a driver could send that would widen this.** The scope is derived from his identity, not requested by him. That is the difference between a control you *apply* and a control you *cannot fail to apply*.

### Tenant-level BOLA

Same bug, one level up: could a driver at company A read company B's fleet?

`org_id` **always** comes from the verified token. Never from a query string, never from a body. And there is a middleware that **rejects any request that even tries** to supply one:

```js
if (req.query.org_id || req.body?.org_id) {
  logger.error({...}, 'authz: client attempted to specify org_id — refusing');
  return next(new AppError('org_id may not be supplied by the client.', 400));
}
```

*Refusing loudly* rather than silently ignoring it, because a client sending `org_id` is either a bug worth finding or an attack worth logging.

---

## 3. Mass assignment — at the sync boundary

### The attack

Root the phone. Modify the app. Send a legitimate-looking delivery, with something extra:

```json
{
  "type": "job.deliver",
  "payload": {
    "status": "delivered",
    "delivered_at": "2026-07-13T14:02:00Z",
    "cod_amount": 0,          ← "I owe no cash"
    "price": 999999,          ← "pay me more"
    "assigned_to": "<me>"     ← "this job is mine now"
  }
}
```

A naive implementation spreads `payload` into the update and I have just given myself a raise.

### The defence: an allowlist, checked FIRST

```js
const DEVICE_AUTHORABLE = {
  job: new Set([
    'status', 'accepted_at', 'picked_up_at', 'delivered_at',
    'failure_reason', 'cash_collected', 'proof_media_key',
    'recipient_name', 'field_note', 'delivered_lat', 'delivered_lng',
  ]),
};
```

`price`, `cod_amount`, `assigned_to`, `customer_id` are **not in it** and never will be. A device that names them is not in conflict — **it is attacking**, and it is refused outright.

### The subtle part: order of checks is a security property

The allowlist check runs **before** any conflict resolution.

Why that matters: without it, an attacker wraps the `price` change inside a **genuine delivery**. The delivery is physical, so it wins under the core rule (`FIELD_WINS`), and the malicious field rides along on a legitimate decision.

There is a unit test for exactly this — *"the rejection beats even the field-wins rule"* — because it is the kind of thing that gets broken by a well-meaning refactor two years from now.

---

## 4. Replay & double-spend

### The attack

Capture a sync request. Send it a hundred times. Each one collects 25,000 IQD.

### The defence

`mutation_id` is the **PRIMARY KEY** of the mutation ledger, and it is **generated on the device**.

```sql
mutation_id uuid PRIMARY KEY   -- the client's own id
```

And, separately, on the cash ledger:

```sql
mutation_id uuid UNIQUE        -- one mutation cannot create two cash entries
```

Replay it a hundred times: **one row.** The other 99 collide with the constraint and return `duplicate`.

Not a `SELECT` — a `SELECT`-then-`INSERT` has a race between two API replicas, both of which check, both of which see nothing, and both of which proceed. **Only the unique index is atomic across processes.** So the `INSERT` *is* the check.

> This is not a theoretical control. There is a k6 test that retries 15% of batches **under a 300-device storm**, asserting the retry comes back fully deduped. If that ever fails, the fleet double-counts cash at the busiest moment of the day, and nobody finds out until the money fails to reconcile.

---

## 5. JWT — the three checks people skip

```js
jwt.verify(token, secret, {
  algorithms: ['HS256'],     // ← pin it. Never trust the header's `alg`.
  issuer: 'sanad',
  audience: 'sanad-api',     // ← a device token cannot open an API endpoint
});
```

1. **Pin the algorithm.** Without this, `{"alg": "none"}` — a forged token with no signature that some libraries will happily accept. The oldest trick there is.
2. **Pin the audience.** Otherwise a *device* token (90 days, `aud: sanad-sync`) is accepted on the *dashboard*, and the whole scope/lifetime argument in §1 collapses.
3. **The payload is base64, not encrypted.** Anyone can read it. **Nothing secret goes in a JWT.** Its value is entirely in the signature.

And the DB is re-read on **every** request — the token says what was true when it was minted; only the database says what is true **now**. A driver fired an hour ago still holds a perfectly valid-looking token.

---

## 6. Rate limiting — and the mistake that makes it worthless

The limiter is a token bucket in **Redis**, executed as an **atomic Lua script**.

**Why Redis:** with N API replicas behind a load balancer, an in-memory counter means a client hitting 5 pods gets **5× its limit**. The limit becomes a suggestion, while the dashboard cheerfully shows it working.

**Why Lua:** *read tokens → compute refill → write tokens* is three round trips. Between them, another request interleaves and both pass. That is a check-then-act race, and it defeats the entire point. The Lua script runs **inside** Redis, single-threaded, atomically. Read-compute-write becomes one indivisible operation.

> The difference between a rate limiter and a rate *suggestion*.

### Fail open, deliberately

If Redis is down, the limiter **allows** the request and logs loudly.

A limiter exists to protect against abuse. Taking the entire API down because the *protection* broke is a far worse outcome than briefly allowing unlimited requests. **A safety feature that can cause an outage is not a safety feature.**

*(For an auth check the answer is the opposite — fail **closed**. The rule is: fail in the direction of the lesser harm, and know which direction that is **for each control**. Applying one blanket policy to both is how you end up either wide open or self-DoSing.)*

---

## 7. Secrets — the control that is personal

**I have shipped `config.env` and `.env` files with live credentials inside a zip. More than once.** Mongo URIs, JWT secrets, R2 keys, payment gateway credentials. Every time, the fix was *"remember not to do that."*

**Remembering harder is not a security control.**

So it is structural now:

1. `.env` and `config.env` are in `.gitignore`
2. Secrets are injected at **runtime** from a K8s Secret — never baked into an image (anyone who can pull the image can read them), never in a file in the repo
3. **A CI gate ([gitleaks](../.github/workflows/ci.yml)) fails the build if a credential is ever committed** — and a second check fails if an env file is merely *tracked*

The machine remembers so I do not have to. That gate is the single most valuable thing in this repository, because it fixes a failure mode that had a 100% recurrence rate.

**Next step:** Vault, for dynamic short-lived DB credentials that expire in an hour — so a leaked one is worthless before anyone can use it. A K8s Secret is only base64: **encoding, not encryption.** It is a floor, not a ceiling, and I would rather say so than let it be mistaken for one.

---

## 8. Realtime — the hole everyone leaves

The most-forgotten vulnerability in socket apps: authenticate the handshake, then **never check anything again.**

`socket.join(room)` is a client-influenced operation. If a driver can name his own room, **he joins the dispatcher's feed and watches the entire fleet.**

```js
// Rooms are DERIVED from the verified token, never requested.
if (role === 'dispatcher' || role === 'admin') {
  socket.join(`org:${orgId}:dispatch`);
} else {
  socket.join(`org:${orgId}:user:${userId}`);   // ONLY his own lane
}
```

**There is deliberately no `socket.on('join')` handler anywhere in this codebase.** Adding one is how you accidentally hand a driver the whole fleet.

And the token is re-verified against the DB on connect — a socket may live for hours, and `token_version` may have moved in that time.

---

## 9. The public demo — a live endpoint on the open internet

The demo is a **real, unauthenticated, public** endpoint that writes to the production database. That is an obvious target, and it deserved an honest look.

**Isolation comes free.** A demo session is *just another org*. It is not a special sandbox mode with its own code path — it uses the **same `org_id` scoping that separates two real paying customers.**

That is the whole argument: the demo cannot leak into real data for **exactly the same reason customer A cannot see customer B**. There is no separate, less-tested isolation mechanism that exists only for the demo — which is precisely where a vulnerability would hide.

If the tenant isolation were weak, the demo would be a live exploit. It is not, **because the demo runs on the real thing.**

Plus: demo orgs are hard rate-limited, flagged by slug, and swept after an hour by a CronJob.

---

## What I have *not* done

An honest list, because a threat model that only lists wins is marketing.

| | status |
|---|---|
| **mTLS between services** | Not implemented. Right now a compromised pod can call any other service freely. Istio + zero-trust is the fix; it is real work and I have not done it. |
| **DAST in CI** | SAST (CodeQL) and dependency scanning are gates. OWASP ZAP against a running instance is not wired up yet — and it is the one I am best placed to write. |
| **Signed sync payloads** | A rooted device can forge a mutation *within its own scope* (it can claim a delivery that did not happen, for a job that IS assigned to it). Device-key signing would raise the bar. The audit trail makes it accountable; it does not make it impossible. |
| **Vault** | K8s Secrets are base64, not encryption. Fine as a floor. Not a ceiling. |
| **Rate limiting per-org** | Currently per-device and per-user. A single org spinning up 500 devices could still hurt. |

---

## The point

> A backend engineer who can threat-model his own system is rare. Most write the feature and hope.

Everything above is the same instinct I use on someone else's system, turned inward — **before** shipping rather than after a bug bounty email.

The `sync.deliver` endpoint is not "an endpoint". It is a **hostile client asserting a fact about the physical world, three hours late, against a row that has changed, while holding a credential I cannot revoke in real time.**

Design for that and the ordinary attacks have nowhere to stand.
