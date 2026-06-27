import assert from "node:assert/strict";
import { test } from "node:test";

import {
  engineIsUp,
  engineServing,
  needsOnboarding,
  waitForEngineHealthy,
} from "./onboarding.ts";
import type { HealthSnapshot } from "./tauri.ts";

const snap = (state: HealthSnapshot["state"]): HealthSnapshot => ({ state });
const noSleep = async () => {};

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

// ── post-install health gate ─────────────────────────────────────────

test("engineServing: only healthy/degraded count as actually serving", () => {
  // Stricter than engineIsUp — "starting" answered the probe but Houston
  // isn't ready, so we must NOT claim "the stack is up" yet.
  assert.equal(engineServing(snap("healthy")), true);
  assert.equal(engineServing(snap("degraded")), true);
  assert.equal(engineServing(snap("starting")), false);
  assert.equal(engineServing(snap("down")), false);
  assert.equal(engineServing(null), false);
});

test("waitForEngineHealthy: resolves true once the engine starts serving", async () => {
  let calls = 0;
  const probe = async (): Promise<HealthSnapshot | null> => {
    calls += 1;
    // down, then starting, then healthy on the 3rd probe.
    if (calls === 1) return snap("down");
    if (calls === 2) return snap("starting");
    return snap("healthy");
  };
  const ok = await waitForEngineHealthy(probe, { attempts: 5, sleep: noSleep });
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test("waitForEngineHealthy: resolves false when the engine never answers", async () => {
  let calls = 0;
  const probe = async (): Promise<HealthSnapshot | null> => {
    calls += 1;
    return snap("starting"); // containers up but Houston never ready
  };
  const ok = await waitForEngineHealthy(probe, { attempts: 4, sleep: noSleep });
  assert.equal(ok, false);
  assert.equal(calls, 4); // exactly `attempts` probes, no extra
});

test("waitForEngineHealthy: a throwing probe is treated as not-serving", async () => {
  const probe = async (): Promise<HealthSnapshot | null> => {
    throw new Error("engine unreachable");
  };
  const ok = await waitForEngineHealthy(probe, { attempts: 2, sleep: noSleep });
  assert.equal(ok, false);
});
