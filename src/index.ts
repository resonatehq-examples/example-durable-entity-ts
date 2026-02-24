import { Resonate } from "@resonatehq/sdk";
import { sessionLifecycle } from "./workflow";

// ---------------------------------------------------------------------------
// Resonate setup
// ---------------------------------------------------------------------------

const resonate = new Resonate();
resonate.register(sessionLifecycle);

// ---------------------------------------------------------------------------
// Demo: simulate a user session lifecycle
// ---------------------------------------------------------------------------

const crashMode = process.argv.includes("--crash");

// Session activities (compressed timescale for demo — production would be real events)
const activities = [
  { type: "page_view", data: { path: "/products", referrer: "google.com" } },
  { type: "search", data: { query: "wireless headphones", results: 24 } },
  { type: "product_view", data: { productId: "prod_wh_001", name: "ANC Pro 5" } },
  { type: "add_to_cart", data: { productId: "prod_wh_001", quantity: 1, price: 149.99 } },
  { type: "checkout_started", data: { cartTotal: 149.99, itemCount: 1 } },
];

// In crash mode: checkout_started DB write fails on first attempt
const crashOnActivity = crashMode ? "checkout_started" : null;

// Idle timeout: 100ms for demo (would be 30 minutes in production)
const IDLE_TIMEOUT_MS = 100;

const sessionId = `sess_${Date.now()}`;
const userId = "user_alice_42";

console.log("=== Durable User Session Entity ===");
console.log(
  `Mode: ${crashMode ? "CRASH (database timeout on checkout_started, retries once)" : "NORMAL (all activities recorded, idle timeout, cleanup)"}`,
);
console.log(`Session: ${sessionId}`);
console.log(`User:    ${userId}\n`);

const wallStart = Date.now();

const result = await resonate.run(
  `session/${sessionId}`,
  sessionLifecycle,
  sessionId,
  userId,
  activities,
  IDLE_TIMEOUT_MS,
  crashOnActivity,
);

const wallMs = Date.now() - wallStart;

console.log("\n=== Result ===");
console.log(
  JSON.stringify(
    {
      sessionId: result.sessionId,
      userId: result.userId,
      finalStatus: result.finalStatus,
      activitiesRecorded: result.activitiesRecorded,
      wallTimeMs: wallMs,
    },
    null,
    2,
  ),
);

if (crashMode) {
  console.log(
    "\nNotice: page_view, search, product_view, add_to_cart each logged once",
    "(completed before crash).",
    "\nOnly checkout_started was retried — and only once.",
    "\nThe idle timeout and cleanup ran normally after the retry.",
  );
}
