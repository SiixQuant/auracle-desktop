// Tests for the sign-in gate.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
// These assert the one thing this module exists to guarantee: the screen
// never waits on a browser sign-in that the local engine cannot serve, and
// never re-opens the browser on its own once the engine returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { engineIsUp } from "./onboarding.ts";
import {
  ENGINE_DOWN_DETAIL,
  ENGINE_DOWN_LINE,
  phaseOnProbe,
  phaseOnStart,
  shouldProbe,
  SIGN_IN_MAX_TICKS,
  SIGN_IN_POLL_MS,
  type SignInPhase,
} from "./signin.ts";

const PHASES: SignInPhase[] = ["idle", "waiting", "engine-down"];

// ── The click ──────────────────────────────────────────────────────

test("a click with the engine down never opens the browser", () => {
  assert.equal(phaseOnStart(false), "engine-down");
  // The only phase that means "the browser was opened" is `waiting`.
  assert.notEqual(phaseOnStart(false), "waiting");
});

test("a click with the engine answering starts the normal wait", () => {
  assert.equal(phaseOnStart(true), "waiting");
});

// ── The engine dropping mid-wait ───────────────────────────────────

test("waiting: an unreachable engine retires the wait", () => {
  // The sign-in being waited on can no longer complete, so the card must
  // stop claiming it might.
  assert.equal(phaseOnProbe("waiting", false), "engine-down");
});

test("waiting: a reachable engine keeps waiting", () => {
  assert.equal(phaseOnProbe("waiting", true), "waiting");
});

// ── Coming back ────────────────────────────────────────────────────

test("engine-down: the engine returning hands the screen back, idle", () => {
  // Explicitly NOT "waiting" — returning must never re-open the browser
  // without a click.
  assert.equal(phaseOnProbe("engine-down", true), "idle");
});

test("engine-down: still unreachable stays put", () => {
  assert.equal(phaseOnProbe("engine-down", false), "engine-down");
});

test("idle is never moved by a probe alone", () => {
  assert.equal(phaseOnProbe("idle", true), "idle");
  assert.equal(phaseOnProbe("idle", false), "idle");
});

test("no probe result can invent a wait", () => {
  // A wait is only ever entered by a click (phaseOnStart), never by a poll.
  for (const phase of PHASES) {
    for (const reachable of [true, false]) {
      if (phase === "waiting") continue;
      assert.notEqual(phaseOnProbe(phase, reachable), "waiting");
    }
  }
});

// ── The timer ──────────────────────────────────────────────────────

test("the probe runs in exactly the two live phases", () => {
  assert.equal(shouldProbe("waiting"), true);
  assert.equal(shouldProbe("engine-down"), true);
  // Idle needs no timer — the click probes for itself.
  assert.equal(shouldProbe("idle"), false);
});

test("poll cadence and ceiling are real values, not zero", () => {
  assert.ok(SIGN_IN_POLL_MS >= 1_000);
  assert.ok(SIGN_IN_MAX_TICKS > 0);
});

// ── Reachability is the shared definition ──────────────────────────

test("reachability: any answer other than down counts", () => {
  // A degraded engine still serves the sign-in route, and a failed probe
  // (null) is not an engine — same ladder the install decision uses.
  assert.equal(phaseOnStart(engineIsUp({ state: "healthy" })), "waiting");
  assert.equal(phaseOnStart(engineIsUp({ state: "degraded" })), "waiting");
  assert.equal(phaseOnStart(engineIsUp({ state: "starting" })), "waiting");
  assert.equal(phaseOnStart(engineIsUp({ state: "down" })), "engine-down");
  assert.equal(phaseOnStart(engineIsUp(null)), "engine-down");
});

// ── The copy ───────────────────────────────────────────────────────

test("the verdict names the cause and the next move, without jargon", () => {
  assert.equal(ENGINE_DOWN_LINE, "The engine isn't running, so sign-in can't start.");
  assert.equal(ENGINE_DOWN_DETAIL, "Start Auracle's engine first, then try again.");
  // Nothing in the verdict may read as a wait.
  assert.doesNotMatch(ENGINE_DOWN_LINE, /waiting|checking|…/i);
  assert.doesNotMatch(ENGINE_DOWN_DETAIL, /waiting|checking|…/i);
});
