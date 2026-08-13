// Contract tests for the commissioning sequence's staging (§3.2).
//
// These hold the one rule slice 8 lives or dies by: the sequence may only show
// what the machine actually reported. There is no DOM here and no renderer —
// the staging is a pure function precisely so that "progress is never
// invented" can be an assertion instead of a comment.
//
// The last test is a grep guard in the spirit of motion.test.ts's: a module
// that may not invent progress may not own a clock, a random number or a
// timer, so it is checked for all three.

import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  COMMISSIONING_STAGES,
  arcProgress,
  commissioningStage,
  commissioningView,
  ringFor,
  stationsFor,
  type CommissioningReading,
  type CommissioningStage,
} from "./commissioning.ts";

const HERE = fileURLToPath(import.meta.url);

/** A fresh machine at station 1: nothing probed, nothing installed. */
const FRESH: CommissioningReading = {
  step: 1,
  dockerRunning: false,
  signInWaiting: false,
  preflight: "pending",
  alreadyRunning: false,
  installing: false,
  finished: false,
  engineHealthy: null,
  installFailed: false,
};

const at = (over: Partial<CommissioningReading>): CommissioningReading => ({
  ...FRESH,
  ...over,
});

/** Station 3, checks clear, nothing started yet. */
const READY = at({ step: 3, dockerRunning: true, preflight: "clear" });

// ── The stage map: one reading, one stage ─────────────────────────

test("the wizard's own step owns stations 1 and 2", () => {
  assert.equal(commissioningStage(at({ step: 1 })), "environment");
  assert.equal(commissioningStage(at({ step: 2 })), "credentials");
  // Station-3 facts cannot leak backwards into an earlier station: a stale
  // pre-flight or a half-finished install must not re-stage station 1.
  assert.equal(
    commissioningStage(
      at({ step: 1, preflight: "clear", installing: true, finished: true }),
    ),
    "environment",
  );
});

test("station 3 walks pending → clear → installing → awaiting → live", () => {
  assert.equal(commissioningStage(at({ step: 3 })), "preflight");
  assert.equal(commissioningStage(READY), "ready");
  assert.equal(commissioningStage({ ...READY, installing: true }), "installing");
  assert.equal(
    commissioningStage({ ...READY, finished: true, engineHealthy: null }),
    "awaiting",
  );
  assert.equal(
    commissioningStage({ ...READY, finished: true, engineHealthy: true }),
    "live",
  );
});

test("installed is not serving: a silent engine stalls, it does not complete", () => {
  assert.equal(
    commissioningStage({ ...READY, finished: true, engineHealthy: false }),
    "stalled",
  );
});

test("a failed pre-flight blocks, and its own error blocks too", () => {
  assert.equal(commissioningStage({ ...READY, preflight: "blocked" }), "blocked");
  assert.equal(commissioningStage({ ...READY, preflight: "failed" }), "blocked");
});

test("a live stack is occupied, never a fresh install", () => {
  // The ports are held by a running Auracle; §3.2 keeps the "already running"
  // path and the install must not be staged over it.
  assert.equal(commissioningStage({ ...READY, alreadyRunning: true }), "occupied");
  // …but an install the user has already consented to outranks it: the reading
  // came from a probe taken before the button was pressed.
  assert.equal(
    commissioningStage({ ...READY, alreadyRunning: true, installing: true }),
    "installing",
  );
});

test("a failure is only a failure once the installer has actually stopped", () => {
  assert.equal(
    commissioningStage({ ...READY, installing: true, installFailed: true }),
    "installing",
  );
  assert.equal(commissioningStage({ ...READY, installFailed: true }), "failed");
});

test("every stage is reachable from a real reading", () => {
  const reached = new Set<CommissioningStage>([
    commissioningStage(at({ step: 1 })),
    commissioningStage(at({ step: 2 })),
    commissioningStage(at({ step: 3 })),
    commissioningStage({ ...READY, preflight: "blocked" }),
    commissioningStage({ ...READY, alreadyRunning: true }),
    commissioningStage(READY),
    commissioningStage({ ...READY, installing: true }),
    commissioningStage({ ...READY, finished: true }),
    commissioningStage({ ...READY, finished: true, engineHealthy: true }),
    commissioningStage({ ...READY, finished: true, engineHealthy: false }),
    commissioningStage({ ...READY, installFailed: true }),
  ]);
  assert.deepEqual([...reached].sort(), [...COMMISSIONING_STAGES].sort());
});

// ── The instrument: never ahead of the machine ────────────────────

test("every stage maps to a defined instrument frame", () => {
  for (const stage of COMMISSIONING_STAGES) {
    const view = commissioningView(stageReading(stage));
    assert.equal(view.stage, stage);
    assert.ok(view.ring, `${stage} has no ring`);
    assert.ok(view.core, `${stage} has no core tone`);
    assert.equal(view.stations.length, 3);
  }
});

test("the mechanism turns in exactly one stage, and only after the engine answered", () => {
  for (const stage of COMMISSIONING_STAGES) {
    const view = commissioningView(stageReading(stage));
    assert.equal(
      view.running,
      stage === "live",
      `${stage} must ${stage === "live" ? "" : "not "}turn`,
    );
    assert.equal(view.assembled, stage === "live");
  }
});

test("the core stays unlit through the whole build — the ignition is earned", () => {
  // Not station 1, not the license, not the checks, and not the download: at
  // none of those is anything of the customer's actually alive.
  for (const stage of [
    "environment",
    "credentials",
    "preflight",
    "ready",
    "installing",
    "awaiting",
  ] as const) {
    assert.equal(
      commissioningView(stageReading(stage)).core,
      "checking",
      `${stage} lit the core early`,
    );
  }
  assert.equal(commissioningView(stageReading("live")).core, "ready");
});

test("a fault reads as a fault: blocked and failed stop the watch", () => {
  for (const stage of ["blocked", "failed"] as const) {
    const view = commissioningView(stageReading(stage));
    assert.equal(view.ring, "dashed");
    assert.equal(view.core, "err");
  }
  // Installed-but-silent is amber, not red: the containers are really there.
  assert.equal(commissioningView(stageReading("stalled")).core, "warn");
});

test("the ring lifts to chrome on the one fact station 1 can prove", () => {
  assert.equal(ringFor("environment", false), "dim");
  assert.equal(ringFor("environment", true), "chrome");
  // And on nothing else — a dashed ring is a verdict, not a chassis reading.
  assert.equal(ringFor("failed", true), "dashed");
  assert.equal(ringFor("blocked", true), "dashed");
});

test("the breath tracks a real in-flight operation, not the step", () => {
  const idle = commissioningView(at({ step: 2 }));
  assert.equal(idle.breath, null);
  const waiting = commissioningView(at({ step: 2, signInWaiting: true }));
  assert.ok(waiting.breath, "a browser sign-in in flight must show as in flight");
  // Working vs waiting is the tempo, and the tempo is the message.
  const installing = commissioningView({ ...READY, installing: true });
  const awaiting = commissioningView({ ...READY, finished: true });
  assert.ok(installing.breath && awaiting.breath);
  assert.ok(
    installing.breath.period < awaiting.breath.period,
    "pulling images is work; polling health is waiting",
  );
});

// ── Progress is never invented (§2.4) ─────────────────────────────

test("there is no arc before an install has begun", () => {
  for (const stage of [
    "environment",
    "credentials",
    "preflight",
    "blocked",
    "occupied",
    "ready",
  ] as const) {
    assert.equal(
      arcProgress(stage, 42),
      null,
      `${stage} drew an arc for an install that has not started`,
    );
  }
});

test("the arc is the installer's own last word, exactly", () => {
  assert.equal(arcProgress("installing", 0), 0);
  assert.equal(arcProgress("installing", 41), 0.41);
  assert.equal(arcProgress("installing", 100), 1);
});

test("a silent installer draws nothing — not a polite sliver", () => {
  assert.equal(arcProgress("installing", undefined), 0);
  assert.equal(arcProgress("installing", Number.NaN), 0);
});

test("a stalled step shows stalled, for as long as it stalls", () => {
  // Same reading, asked repeatedly: the arc may not creep. Nothing in this
  // module has a clock, so this holds by construction — the test is what keeps
  // a "just a little easing" patch from ever landing.
  const stuck = { ...READY, installing: true, percent: 37 };
  const first = commissioningView(stuck).arc;
  for (let i = 0; i < 100; i++) {
    assert.equal(commissioningView(stuck).arc, first);
  }
  assert.equal(first, 0.37);
});

test("a failed install freezes the arc where the real progress stopped", () => {
  const died = commissioningView({ ...READY, installFailed: true, percent: 41 });
  assert.equal(died.stage, "failed");
  assert.equal(died.arc, 0.41);
  // …and a stalled engine keeps the completed arc it earned.
  assert.equal(
    commissioningView({
      ...READY,
      finished: true,
      engineHealthy: false,
      percent: 100,
    }).arc,
    1,
  );
});

test("a nonsense percent is clamped, never trusted past the ring", () => {
  assert.equal(arcProgress("installing", 140), 1);
  assert.equal(arcProgress("installing", -20), 0);
});

// ── The rail ──────────────────────────────────────────────────────

test("the rail records the stations walked, and nothing else", () => {
  assert.deepEqual(
    stationsFor(1, "environment").map((s) => s.state),
    ["current", "pending", "pending"],
  );
  assert.deepEqual(
    stationsFor(2, "credentials").map((s) => s.state),
    ["done", "current", "pending"],
  );
  assert.deepEqual(
    stationsFor(3, "installing").map((s) => s.state),
    ["done", "done", "current"],
  );
  // Commissioned: all three walked.
  assert.deepEqual(
    stationsFor(3, "live").map((s) => s.state),
    ["done", "done", "done"],
  );
});

// ── The grep guard ────────────────────────────────────────────────

test("the staging module owns no clock, no timer and no dice", () => {
  // A module that may not invent progress may not be able to: with no source
  // of elapsed time and no randomness, the only thing the arc CAN report is
  // the number the installer sent. Spelled from parts so the guard does not
  // trip over its own source text.
  const banned = [
    "Date" + ".now",
    "performance" + ".now",
    "set" + "Timeout",
    "set" + "Interval",
    "requestAnimation" + "Frame",
    "Math" + ".random",
    "new " + "Date",
  ];
  const source = readFileSync(path.join(path.dirname(HERE), "commissioning.ts"), "utf8");
  const offenders = banned.filter((needle) => source.includes(needle));
  assert.deepEqual(
    offenders,
    [],
    `progress is reported, never generated (§2.4). Offenders: ${offenders.join(", ")}`,
  );
});

// ── Fixtures ──────────────────────────────────────────────────────

/** A minimal reading that lands on each stage, for the table-walking tests. */
function stageReading(stage: CommissioningStage): CommissioningReading {
  switch (stage) {
    case "environment":
      return at({ step: 1 });
    case "credentials":
      return at({ step: 2 });
    case "preflight":
      return at({ step: 3 });
    case "blocked":
      return { ...READY, preflight: "blocked" };
    case "occupied":
      return { ...READY, alreadyRunning: true };
    case "ready":
      return READY;
    case "installing":
      return { ...READY, installing: true, percent: 40 };
    case "awaiting":
      return { ...READY, finished: true, percent: 100 };
    case "live":
      return { ...READY, finished: true, engineHealthy: true, percent: 100 };
    case "stalled":
      return { ...READY, finished: true, engineHealthy: false, percent: 100 };
    case "failed":
      return { ...READY, installFailed: true, percent: 41 };
  }
}
