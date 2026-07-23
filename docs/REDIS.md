# Redis — from zero

> You've never used Redis. This explains what it is, why this project needs it, and exactly what it does here. No prior knowledge assumed.

---

## What Redis actually is

Redis is an **in-memory key-value store**. Break that down:

- **Key-value store** — it holds data as `key → value` pairs, like a giant hash map / dictionary. You `SET a key` and later `GET` it. That's the core.
- **In-memory** — the data lives in RAM, not on disk. This is the whole point: RAM is *thousands of times faster* than a database on disk. A Redis read is sub-millisecond.

The tradeoff of in-memory: it's fast but **volatile** — if Redis restarts, the data can be gone (it has optional persistence, but you generally treat Redis data as disposable). So you use Redis for things that are **hot, temporary, and okay to lose**, not for your source of truth. Your source of truth is Postgres; Redis is the fast scratchpad next to it.

**The mental model:** Postgres is the filing cabinet — permanent, organized, a bit slow to open. Redis is the sticky notes on your monitor — instant to read, and it's fine if you lose one.

---

## Why this project needs Redis (two reasons)

Sanad uses Redis for exactly two things. Both need to be **fast** and **shared across all copies of the app**.

That second part — *shared across all copies* — is the key. In production you don't run one copy of the API; you run many (that's what Kubernetes scaling means). If each copy kept its own data in its own memory, they'd disagree with each other. Redis is the one shared place they all read and write, so they stay consistent.

### Reason 1: Rate limiting

**The problem:** stop one client from hammering the API with thousands of requests. You count requests per client and reject them over a limit.

**Why it needs Redis:** imagine you kept the count in the app's own memory. With 5 copies of the API running behind a load balancer, a client's requests get spread across all 5 copies. Each copy counts only the ~1/5 it sees. So the client gets **5× its real limit** — the limit becomes a suggestion, while your dashboard cheerfully shows it "working."

Put the counter in Redis instead, and **all 5 copies read and write the same counter.** Now the limit is real.

**The Sanad detail (this is the clever bit):** the rate limiter is a "token bucket" algorithm, and it runs as an **atomic Lua script** inside Redis. Why Lua? Because the operation is *read the count → calculate → write the new count* — three steps. Between those steps, another request could sneak in and both would pass. That's a race condition, and it defeats the whole limiter. Running it as a Lua script means Redis executes all three steps as **one indivisible operation** — nothing can interleave. That's the difference between a rate *limiter* and a rate *suggestion*.

**One more Sanad-specific decision:** the limiter **fails open**. If Redis is down, requests are *allowed* (and it logs loudly). Why? A rate limiter exists to protect against abuse. Taking down the entire API because the *protection* broke is far worse than briefly allowing unlimited requests. A safety feature that causes an outage isn't a safety feature. (Note: an *auth* check fails the opposite way — *closed* — because letting someone in when your check is broken is the worse outcome. The rule is: fail in the direction of the lesser harm, and know which direction that is for each thing.)

### Reason 2: The Socket.IO adapter (the live dispatcher map)

**The problem:** the dispatcher's dashboard has a live map — when a driver's delivery syncs, the dispatcher sees it update in real time, over a websocket (Socket.IO).

**Why it needs Redis:** websockets are long-lived connections, and each dispatcher's connection lives on *one specific copy* of the server. When a driver's sync lands on a *different* copy and that copy says "tell all the dispatchers," the message only reaches dispatchers connected to *that* copy. The dispatcher on another copy sees nothing. The live map silently stops being live.

This is the classic bug that **only appears once you run more than one copy** — it works perfectly on your laptop (one copy) and breaks the day you deploy to production (many copies).

The **Redis adapter** fixes it: Socket.IO uses Redis's pub/sub feature to broadcast events *between* all the server copies. Now a "driver synced" message from any copy reaches every connected dispatcher, everywhere.

---

## What Redis is NOT used for here

- Not the source of truth (that's Postgres).
- Not for storing deliveries, cash, or anything that matters permanently.
- Not as a cache of database queries (it could be, but this project doesn't need it).

If Redis vanished, you'd lose rate limiting (fails open, so the API keeps working) and the live map would break across copies — but **not one delivery would be lost**, because nothing important lives in Redis. That's deliberate.

---

## The commands you'd actually see

Redis has its own tiny command language. The ones relevant here:

```
SET ratelimit:user123 5        # store a value
GET ratelimit:user123          # read it back → "5"
INCR ratelimit:user123         # atomically add 1 → 6
EXPIRE ratelimit:user123 60    # auto-delete after 60 seconds
PUBLISH events "driver synced" # send a message to all subscribers (pub/sub)
```

That `EXPIRE` is another reason Redis fits rate limiting perfectly — keys can auto-expire, so a per-minute counter cleans itself up. In Postgres you'd need a cron job to delete old counters.

---

## Where it is in the code

- `src/middleware/rateLimiter.js` — the token-bucket limiter, with the Lua script.
- `src/realtime/gateway.js` — the Socket.IO server; the Redis adapter is wired in `server.js`.
- `docker-compose.yml` — the `redis` service (you never install it; Docker runs it).
- Connection string in `.env`: `REDIS_URL=redis://localhost:6379` (6379 is Redis's standard port).

---
