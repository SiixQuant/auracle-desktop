import assert from "node:assert/strict";
import { test } from "node:test";

import { engineIsUp, needsOnboarding } from "./onboarding.ts";
import type { HealthSnapshot } from "./tauri.ts";

const snap = (state: HealthSnapshot["state"]): HealthSnapshot => ({ state });

test("engineIsUp: down or absent is not up", () => {
  assert.equal(engineIsUp(null), false);
  assert.equal(engineIsUp(undefined), false);
  assert.equal(engineIsUp(snap("down")), false);
});

test("engineIsUp: any reachable state counts as up", () => {
  assert.equal(engineIsUp(snap("healthy")), true);
  assert.equal(engineIsUp(snap("degraded")), true);
  assert.equal(engineIsUp(snap("starting")), true);
});

test("needsOnboarding: only when neither installed nor engine reachable", () => {
  // Fresh machine — nothing present.
  assert.equal(needsOnboarding(false, null), true);
  assert.equal(needsOnboarding(false, snap("down")), true);
});

test("needsOnboarding: install marker present skips onboarding", () => {
  assert.equal(needsOnboarding(true, null), false);
  assert.equal(needsOnboarding(true, snap("down")), false);
});

test("needsOnboarding: a live engine skips onboarding even without the marker", () => {
  // This is the bug fix: a healthy stack (e.g. started outside the launcher)
  // must NOT trigger a fresh install that would collide with it.
  assert.equal(needsOnboarding(false, snap("healthy")), false);
  assert.equal(needsOnboarding(false, snap("starting")), false);
});
