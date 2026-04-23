# Durable Entity (User Session)

A long-lived user session entity modeled as a durable workflow. The session tracks login, activity recording, an idle timeout, expiry, and cleanup — all as durable checkpoints. If the process crashes mid-session, it resumes exactly where it left off: no activities are double-recorded, the idle timer picks up from where it paused.

## What This Demonstrates

- **Entity as workflow**: the session entity IS the generator — no separate state store or K/V API required
- **Durable activity tracking**: each activity is an independent checkpoint; crash mid-recording, resume from that activity, earlier activities not re-recorded
- **Durable sleep for idle timeout**: `ctx.sleep()` survives crashes — a crash during the idle period doesn't restart the timer (in production: 30-minute session timeout; in demo: 100ms)
- **Exactly-once cleanup**: revoke tokens and clear cache exactly once, even if the cleanup step is retried

## How It Works

The session lifecycle is a generator function. The entity's state is accumulated in a local variable — no `ctx.get`/`ctx.set` needed:

```typescript
export function* sessionLifecycle(ctx: Context, sessionId: string, userId: string, activities: Activity[], idleTimeoutMs: number, crashOnActivity: string | null) {

  // Login: JWT issued, session initialized
  let state = yield* ctx.run(loginSession, sessionId, userId);

  // Activity tracking: each is an independent checkpoint
  for (const activity of activities) {
    state = yield* ctx.run(recordActivity, sessionId, state, activity, activity.type === crashOnActivity);
  }

  // Mark idle, then wait out the timeout
  state = yield* ctx.run(markIdle, sessionId, state);
  yield* ctx.sleep(idleTimeoutMs);  // ← durable: crash here, timer resumes

  // Expire and clean up
  state = yield* ctx.run(expireSession, sessionId, state);
  state = yield* ctx.run(cleanupSession, sessionId, state);

  return { ...state };
}
```

On crash and resume, Resonate replays the generator. Each `yield*` checks the promise store first. Completed activities return cached results — no re-recording. The `ctx.sleep()` resumes from wherever it was when the crash happened.

### Why the entity is the workflow

There is no separate K/V store for the session's state. The generator's local variables ARE the state. Entity lifecycle is expressed as sequential code: login → activity loop → idle timeout → cleanup. No object declaration, no `ctx.get`/`ctx.set`, no handler registration. The workflow ID (the session ID) is the stable identifier; any process that reaches the same ID replays the same durable execution.

## Prerequisites

- [Bun](https://bun.sh) v1.0+

No external services required. Resonate runs in embedded mode.

## Setup

```bash
git clone https://github.com/resonatehq-examples/example-durable-entity-ts
cd example-durable-entity-ts
bun install
```

## Run It

**Normal mode** — all activities recorded, idle timeout fires, session cleaned up:
```bash
bun start
```

```
=== Durable User Session Entity ===
Mode: NORMAL (all activities recorded, idle timeout, cleanup)
Session: sess_1771899691132

  [sess_...]  User user_alice_42 logged in  ✓
  [sess_...]  Activity 'page_view'  ✓
  [sess_...]  Activity 'search'  ✓
  [sess_...]  Activity 'product_view'  ✓
  [sess_...]  Activity 'add_to_cart'  ✓
  [sess_...]  Activity 'checkout_started'  ✓
  [sess_...]  Session idle — waiting for timeout...
  [sess_...]  Session expired (idle timeout reached)  ✓
  [sess_...]  Session cleaned up (tokens revoked, cache cleared)  ✓

=== Result ===
{
  "finalStatus": "cleaned_up",
  "activitiesRecorded": 5,
  "wallTimeMs": 446
}
```

**Crash mode** — database times out writing `checkout_started`, retries once:
```bash
bun start:crash
```

```
  [sess_...]  Activity 'page_view'  ✓
  [sess_...]  Activity 'search'  ✓
  [sess_...]  Activity 'product_view'  ✓
  [sess_...]  Activity 'add_to_cart'  ✓
  [sess_...]  Activity 'checkout_started'  ✗  (database write timeout)
Runtime. Function 'recordActivity' failed with 'Error: ...' (retrying in 2 secs)
  [sess_...]  Activity 'checkout_started' (retry 2)  ✓
  [sess_...]  Session idle — waiting for timeout...
  [sess_...]  Session expired (idle timeout reached)  ✓
  [sess_...]  Session cleaned up (tokens revoked, cache cleared)  ✓

Notice: page_view, search, product_view, add_to_cart each logged once (completed before crash).
Only checkout_started was retried — and only once.
```

## What to Observe

1. **No double-recording**: in crash mode, the four activities before the crash each appear exactly once in the output. Resonate serves them from the promise cache.
2. **Retry message from the SDK**: `Runtime. Function '...' failed (retrying in N secs)` is the SDK. No retry logic needed in your code.
3. **Durable sleep**: in normal mode, the 100ms idle timeout is a `ctx.sleep()` call. In production this would be 30 minutes — and a crash during that window would NOT restart the clock.
4. **State accumulated, not stored**: the `state` variable in the workflow is rebuilt on replay by re-executing `ctx.run()` calls (which return cached results). There is no external state store.

## File Structure

```
example-durable-entity-ts/
├── src/
│   ├── index.ts    Entry point — Resonate setup and demo runner
│   ├── workflow.ts Session lifecycle generator — the entity
│   └── session.ts  Session operations (login, record, expire, cleanup)
├── package.json
└── tsconfig.json
```

**Lines of code**: ~306 total, ~45 lines of entity logic (workflow.ts minus comments).

## Concurrency note

Two HTTP requests racing to update the same session with the same session ID get the same cached result — that's workflow idempotency, not per-key serialization under a lock. If you need concurrent-mutation exclusivity (multiple independent callers racing to mutate an entity under a true mutex), reach for a mutex pattern (see [example-distributed-mutex-ts](https://github.com/resonatehq-examples/example-distributed-mutex-ts)) or an external store with its own concurrency model. This example optimizes for the common case: one session, one durable execution path.

## Learn More

- [Resonate documentation](https://docs.resonatehq.io)
- [Distributed mutex pattern](https://github.com/resonatehq-examples/example-distributed-mutex-ts) — serialized access when multiple callers race
