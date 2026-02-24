import type { Context } from "@resonatehq/sdk";
import {
  loginSession,
  recordActivity,
  markIdle,
  expireSession,
  cleanupSession,
  type SessionState,
} from "./session";

// ---------------------------------------------------------------------------
// User Session Entity
// ---------------------------------------------------------------------------
//
// A session entity modeled as a long-running durable workflow. The entity
// maintains state across time — login, activity tracking, idle timeout,
// expiry, and cleanup — all durably checkpointed.
//
// Entity lifecycle:
//   login → [record activities] → idle → (sleep: timeout) → expire → cleanup
//
// Why this maps naturally to a generator:
//   - ctx.sleep() gives you durable time-based behavior (survives crashes)
//   - State is just JavaScript: accumulated in `state`, not a K/V store
//   - The workflow IS the entity — its execution position is its lifecycle stage
//
// Restate models this as a Virtual Object: a keyed service with built-in
// K/V storage that serializes concurrent calls per session ID.
//
// Resonate models this as a long-running workflow: sequential execution
// provides the same ordering guarantee. State is local to the generator —
// no ctx.get("activities") / ctx.set("activities") required.
//
// Crash demo:
//   If the database times out recording an activity (e.g., "checkout_started"),
//   Resonate retries that one activity. Earlier activities are not re-recorded.
//   The session lifecycle continues normally after the retry.

export interface SessionResult {
  sessionId: string;
  userId: string;
  finalStatus: string;
  activitiesRecorded: number;
  loginAt: string;
  expiredAt?: string;
  cleanedAt?: string;
}

export function* sessionLifecycle(
  ctx: Context,
  sessionId: string,
  userId: string,
  activities: Array<{ type: string; data: Record<string, unknown> }>,
  idleTimeoutMs: number,
  crashOnActivity: string | null,
): Generator<any, SessionResult, any> {
  // ── LOGIN ─────────────────────────────────────────────────────────────────
  // Session created: JWT issued, last-seen timestamp initialized.
  let state: SessionState = yield* ctx.run(loginSession, sessionId, userId);

  // ── ACTIVITY TRACKING ─────────────────────────────────────────────────────
  // Each activity is an independent durable checkpoint.
  // On crash: completed activities are served from cache (no double-recording).
  // The loop resumes at the first unrecorded activity.
  for (const activity of activities) {
    const shouldCrash = activity.type === crashOnActivity;
    state = yield* ctx.run(
      recordActivity,
      sessionId,
      state,
      activity,
      shouldCrash,
    );
  }

  // ── IDLE ──────────────────────────────────────────────────────────────────
  // No more activity. Mark idle and wait for the timeout.
  state = yield* ctx.run(markIdle, sessionId, state);

  // ── DURABLE SLEEP: IDLE TIMEOUT ───────────────────────────────────────────
  // This is the key capability: a crash during the sleep period does NOT
  // restart the timer. The sleep resumes from wherever it was when the
  // process crashed. In production this would be minutes or hours.
  // For the demo it's milliseconds.
  yield* ctx.sleep(idleTimeoutMs);

  // ── EXPIRE ────────────────────────────────────────────────────────────────
  // Idle timeout elapsed. Session is now expired.
  state = yield* ctx.run(expireSession, sessionId, state);

  // ── CLEANUP ───────────────────────────────────────────────────────────────
  // Revoke tokens, clear session cache, write audit log.
  state = yield* ctx.run(cleanupSession, sessionId, state);

  return {
    sessionId: state.sessionId,
    userId: state.userId,
    finalStatus: state.status,
    activitiesRecorded: state.activities.length,
    loginAt: state.loginAt,
    expiredAt: state.expiredAt,
    cleanedAt: state.cleanedAt,
  };
}
