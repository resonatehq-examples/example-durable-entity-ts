import type { Context } from "@resonatehq/sdk";

// ---------------------------------------------------------------------------
// User Session Entity — Operations
// ---------------------------------------------------------------------------
//
// These are the durable operations that make up a user session's lifecycle.
// Each one is wrapped in ctx.run() in the workflow, creating a checkpoint.
//
// In Restate, session state lives in a Virtual Object's K/V store:
//   ctx.set("status", "ACTIVE")
//   ctx.set("activities", [...activities, newActivity])
//
// In Resonate, state is JavaScript state inside the generator. The entity
// IS the workflow — no separate store, no ctx.get/set boilerplate.

export type SessionStatus = "active" | "idle" | "expired" | "cleaned_up";

export interface Activity {
  type: string;
  data: Record<string, unknown>;
  recordedAt: string;
}

export interface SessionState {
  sessionId: string;
  userId: string;
  status: SessionStatus;
  loginAt: string;
  activities: Activity[];
  expiredAt?: string;
  cleanedAt?: string;
}

// Track attempt counts for crash simulation
const attemptMap = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Session lifecycle operations
// ---------------------------------------------------------------------------

export async function loginSession(
  _ctx: Context,
  sessionId: string,
  userId: string,
): Promise<SessionState> {
  await sleep(30);
  const state: SessionState = {
    sessionId,
    userId,
    status: "active",
    loginAt: new Date().toISOString(),
    activities: [],
  };
  console.log(`  [${sessionId}]  User ${userId} logged in  ✓`);
  return state;
}

export async function recordActivity(
  _ctx: Context,
  sessionId: string,
  state: SessionState,
  activity: { type: string; data: Record<string, unknown> },
  shouldCrash = false,
): Promise<SessionState> {
  const key = `${sessionId}:activity:${activity.type}`;
  const attempt = (attemptMap.get(key) ?? 0) + 1;
  attemptMap.set(key, attempt);

  await sleep(40);

  if (shouldCrash && attempt === 1) {
    console.log(
      `  [${sessionId}]  Activity '${activity.type}'  ✗  (database write timeout)`,
    );
    throw new Error(`Database write timeout recording '${activity.type}'`);
  }

  const retryTag = attempt > 1 ? ` (retry ${attempt})` : "";
  const recorded: Activity = {
    type: activity.type,
    data: activity.data,
    recordedAt: new Date().toISOString(),
  };

  console.log(
    `  [${sessionId}]  Activity '${activity.type}'${retryTag}  ✓`,
  );

  return { ...state, activities: [...state.activities, recorded] };
}

export async function markIdle(
  _ctx: Context,
  sessionId: string,
  state: SessionState,
): Promise<SessionState> {
  console.log(`  [${sessionId}]  Session idle — waiting for timeout...`);
  return { ...state, status: "idle" };
}

export async function expireSession(
  _ctx: Context,
  sessionId: string,
  state: SessionState,
): Promise<SessionState> {
  await sleep(20);
  console.log(`  [${sessionId}]  Session expired (idle timeout reached)  ✓`);
  return { ...state, status: "expired", expiredAt: new Date().toISOString() };
}

export async function cleanupSession(
  _ctx: Context,
  sessionId: string,
  state: SessionState,
): Promise<SessionState> {
  await sleep(50);
  console.log(`  [${sessionId}]  Session cleaned up (tokens revoked, cache cleared)  ✓`);
  return { ...state, status: "cleaned_up", cleanedAt: new Date().toISOString() };
}
