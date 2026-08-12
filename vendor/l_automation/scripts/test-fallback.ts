/**
 * Focused tests for the Veo -> Flow browser rate-limit fallback logic.
 * Runs offline (no API key, no network, no browser). Run: npm run test:fallback
 */
import assert from "node:assert/strict";
import {
  VeoRateLimitError,
  isRateLimitMessage,
  toVeoError,
  shouldFallbackToBrowser,
} from "../src/veo-api.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// Representative real Veo 429 / quota error strings.
const rateLimited = [
  'got status: 429 Too Many Requests {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
  "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'generate requests'",
  "Error: 429 You exceeded your current quota",
];

// Errors that must NOT be treated as rate limits (so we don't pointlessly
// open a browser when the real problem is auth/access).
const notRateLimited = [
  "API key not valid. Please pass a valid API key.",
  'PERMISSION_DENIED: {"error":{"code":403}}',
  "NOT_FOUND: model veo-x not found (404)",
  "Veo API returned no video.",
];

console.log("rate-limit message detection:");
for (const m of rateLimited) {
  check(`detects 429: "${m.slice(0, 38)}…"`, () =>
    assert.equal(isRateLimitMessage(m), true),
  );
}
for (const m of notRateLimited) {
  check(`ignores: "${m.slice(0, 38)}…"`, () =>
    assert.equal(isRateLimitMessage(m), false),
  );
}

console.log("error tagging (toVeoError):");
check("429 error becomes VeoRateLimitError (and stays an Error)", () => {
  const e = toVeoError(
    new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'),
  );
  assert.ok(e instanceof VeoRateLimitError);
  assert.ok(e instanceof Error);
});
check("403 error is NOT tagged as rate limit", () => {
  const e = toVeoError(new Error('PERMISSION_DENIED {"code":403}'));
  assert.ok(!(e instanceof VeoRateLimitError));
});

console.log("sticky fallback decision (shouldFallbackToBrowser):");
check("rate-limit + fallback enabled -> fall back to browser", () =>
  assert.equal(shouldFallbackToBrowser(new VeoRateLimitError("x"), true), true),
);
check("rate-limit + fallback disabled -> do NOT fall back", () =>
  assert.equal(shouldFallbackToBrowser(new VeoRateLimitError("x"), false), false),
);
check("non-rate-limit error + enabled -> do NOT fall back", () =>
  assert.equal(shouldFallbackToBrowser(new Error("bad key"), true), false),
);
check("end-to-end: a raw 429 string flows through to a fallback decision", () => {
  const tagged = toVeoError(new Error("got status: 429 RESOURCE_EXHAUSTED"));
  assert.equal(shouldFallbackToBrowser(tagged, true), true);
});

console.log(`\nAll ${passed} checks passed.`);
