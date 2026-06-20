// Tests for the home state aggregator — the PRD's primary test seam.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
// These assert "what the home says is always true": the priority ladder,
// the DU*→paper derivation, and that a tripped staleness guard flips the
// affected vitals to "stale" rather than presenting last-good as live.

import { test } from "node:test";
import assert from "node:assert/strict";

import { accountMode, deriveBoard, type EngineState } from "./aggregator.ts";

// Minimal fixtures — only the fields the aggregator reads.
const acct = (account_id: string): EngineState["summary"] =>
  ({ account_id }) as EngineState["summary"];
const feed = (q: string): EngineState["marketData"] =>
  ({ us_equity: q, us_equity_raw: "R", options: "", hint: "" }) as EngineState["marketData"];

const base: EngineState = { health: null, summary: null, marketData: null };

const vital = (b: ReturnType<typeof deriveBoard>, key: string) =>
  b.vitals.find((v) => v.key === key)!;

// ── Priority ladder ────────────────────────────────────────────────

test("checking: null health is never 'ready'", () => {
  const b = deriveBoard({ ...base });
  assert.equal(b.lamp, "checking");
  assert.equal(b.pulse, true);
  assert.equal(b.systemLine, "Checking the desk…");
  assert.equal(b.actuator.action, "checking");
  assert.equal(b.actuator.disabled, true);
  assert.equal(vital(b, "engine").freshness, "checking");
});

test("starting (user-initiated) outranks a stale healthy reading", () => {
  const b = deriveBoard({ ...base, starting: true, health: { state: "healthy" } });
  assert.equal(b.actuator.action, "starting");
  assert.equal(b.actuator.disabled, true);
  assert.equal(b.pulse, true);
});

test("starting (engine-reported)", () => {
  const b = deriveBoard({ ...base, health: { state: "starting" } });
  assert.equal(b.actuator.action, "starting");
  assert.match(b.systemLine, /starting/i);
});

test("down: lamp red, actuator becomes Start engine", () => {
  const b = deriveBoard({ ...base, health: { state: "down" } });
  assert.equal(b.lamp, "err");
  assert.equal(b.systemLine, "Engine's down — start it to continue.");
  assert.equal(b.actuator.action, "start");
  assert.equal(b.actuator.disabled, false);
  assert.equal(b.actuator.label, "Start engine");
});

test("degraded: disabled with an honest reason, routes to Supervision", () => {
  const b = deriveBoard({ ...base, health: { state: "degraded" } });
  assert.equal(b.lamp, "warn");
  assert.equal(b.actuator.action, "degraded");
  assert.equal(b.actuator.disabled, true);
  assert.match(b.actuator.reason ?? "", /supervision/i);
});

test("healthy but no broker: finish setup, lamp accent", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" } });
  assert.equal(b.lamp, "accent");
  assert.equal(b.systemLine, "Connect your broker to finish setup.");
  assert.equal(b.actuator.action, "connect");
  assert.equal(b.actuator.disabled, false);
  assert.equal(b.mode, null);
});

test("ready: healthy + broker + real-time feed", () => {
  const b = deriveBoard({
    ...base,
    health: { state: "healthy" },
    summary: acct("DU123"),
    marketData: feed("realtime"),
  });
  assert.equal(b.lamp, "ok");
  assert.equal(b.systemLine, "Everything's ready.");
  assert.equal(b.actuator.action, "launch");
  assert.equal(b.actuator.disabled, false);
  assert.equal(b.actuator.badge, "paper");
});

test("feed-degraded outranks plain ready in the System Line", () => {
  const b = deriveBoard({
    ...base,
    health: { state: "healthy" },
    summary: acct("DU123"),
    marketData: feed("delayed"),
  });
  assert.equal(b.lamp, "ok"); // still launchable
  assert.equal(b.systemLine, "Ready — market data is delayed.");
  assert.equal(b.actuator.action, "launch");
  assert.equal(vital(b, "feed").dot, "warn");
});

// ── LIVE/paper derived ONLY from the DU* convention ────────────────

test("accountMode: DU*→paper, else live, empty→null", () => {
  assert.equal(accountMode(acct("DU1234567")), "paper");
  assert.equal(accountMode(acct("U7654321")), "live");
  assert.equal(accountMode(acct("")), null);
  assert.equal(accountMode(null), null);
});

test("live account renders LIVE in the mode vital with the accent dot", () => {
  const b = deriveBoard({
    ...base,
    health: { state: "healthy" },
    summary: acct("U999"),
    marketData: feed("realtime"),
  });
  assert.equal(b.mode, "live");
  assert.equal(b.actuator.badge, "live");
  assert.equal(vital(b, "mode").value, "LIVE");
  assert.equal(vital(b, "mode").dot, "accent");
});

// ── Staleness guard folds into vital freshness ─────────────────────

test("brokerStale flips broker/feed/mode vitals to stale, never last-good-as-live", () => {
  const b = deriveBoard({
    ...base,
    health: { state: "healthy" },
    summary: acct("DU123"),
    marketData: feed("realtime"),
    brokerStale: true,
  });
  assert.equal(vital(b, "broker").freshness, "stale");
  assert.equal(vital(b, "feed").freshness, "stale");
  assert.equal(vital(b, "mode").freshness, "stale");
  // engine has its own probe — not stale just because the broker fetch failed
  assert.equal(vital(b, "engine").freshness, "fresh");
});

// ── Status-is-the-door wiring is present on every vital ────────────

test("every vital names the inspector it opens", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" }, summary: acct("DU1") });
  assert.equal(vital(b, "engine").door, "supervision");
  assert.equal(vital(b, "broker").door, "connections");
  assert.equal(vital(b, "feed").door, "connections");
  assert.equal(vital(b, "mode").door, "account");
});
