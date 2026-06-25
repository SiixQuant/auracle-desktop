// Tests for the home state aggregator — the launcher hub's primary test
// seam.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
// These assert "what the home says is always true": the priority ladder,
// that a null health is never "ready", and that the engine vital names the
// inspector it opens. Connections (brokers / data sources) moved to the
// IDE, so the home derives no broker/feed/mode reading and never offers a
// "connect" verb — the next move is only Start engine or Open workspace.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBoard, type EngineState } from "./aggregator.ts";

const base: EngineState = { health: null };

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

test("healthy: the verb is Open workspace, never connect-broker", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" } });
  assert.equal(b.lamp, "ok");
  assert.equal(b.systemLine, "Everything's ready.");
  assert.equal(b.actuator.action, "launch");
  assert.equal(b.actuator.label, "Open workspace");
  assert.equal(b.actuator.disabled, false);
});

test("healthy but no owner yet: the verb is Finish setup, not Open workspace", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" }, needsSetup: true });
  assert.equal(b.actuator.action, "setup");
  assert.equal(b.actuator.label, "Finish setup");
  assert.equal(b.actuator.disabled, false);
  assert.notEqual(b.systemLine, "Everything's ready.");
});

test("needsSetup only applies when healthy — down still says Start engine", () => {
  const b = deriveBoard({ ...base, health: { state: "down" }, needsSetup: true });
  assert.equal(b.actuator.action, "start");
});

// ── The adaptive verb is ONLY ever launch / start (never connect) ──

test("no engine state produces a 'connect' actuator action", () => {
  const states = ["healthy", "down", "degraded", "starting"] as const;
  for (const state of states) {
    const b = deriveBoard({ ...base, health: { state } });
    assert.notEqual(b.actuator.action, "connect" as unknown);
  }
  // checking (null health) too
  assert.notEqual(deriveBoard(base).actuator.action, "connect" as unknown);
});

// ── Status-is-the-door wiring is present on the engine vital ────────

test("the engine vital names the inspector it opens (supervision)", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" } });
  assert.equal(vital(b, "engine").door, "supervision");
  // The home no longer derives broker / feed / mode vitals.
  assert.equal(b.vitals.length, 1);
});
