// Tests for the ledger's contract — §3.3's "Band 3" and the update truth
// ladder it inherited from the footer it replaces.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
//
// There is no DOM in the test runner, which is exactly why `ledger.ts` holds
// the decisions and the component holds only the ink. Two statements are worth
// a test and both are statements about pure values:
//
//   · "never claims current before the check returns" (§3.3) — the ladder;
//   · "all six aggregator states keep an honest ledger" — the merge of the
//     vitals row into the band may not lose a state, so the row is driven
//     through the REAL aggregator here, never through hand-written cells.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveBoard, type EngineState } from "./aggregator.ts";
import {
  LEDGER_LINKS,
  UNKNOWN_VERSION_LABEL,
  buildLedger,
  versionCell,
  vitalCell,
  type VersionRung,
} from "./ledger.ts";

// ── The six aggregator states, as the aggregator itself derives them ──

const ENGINE: Record<string, EngineState> = {
  checking: { health: null },
  starting: { health: null, starting: true },
  down: { health: { state: "down" } },
  degraded: { health: { state: "degraded" } },
  needsSetup: { health: { state: "healthy" }, needsSetup: true },
  ready: { health: { state: "healthy" } },
};

const STATES = Object.keys(ENGINE);

// ── The truth ladder (§3.3) ───────────────────────────────────────

test("the ladder's four rungs read exactly as the doc spells them", () => {
  assert.deepEqual(versionCell({ available: true, current: "0.8.37", version: "0.9.0" }, "0.8.37"), {
    rung: "update",
    label: "Update available · v0.9.0",
    waiting: true,
    target: "updates",
  });
  assert.deepEqual(versionCell({ available: false, current: "0.8.37" }, "0.8.37"), {
    rung: "current",
    label: "Up to date · v0.8.37",
    waiting: false,
    target: "updates",
  });
  assert.deepEqual(versionCell(null, "0.8.37"), {
    rung: "version",
    label: "v0.8.37",
    waiting: false,
    target: "updates",
  });
  assert.deepEqual(versionCell(null, null), {
    rung: "unknown",
    label: UNKNOWN_VERSION_LABEL,
    waiting: false,
    target: "updates",
  });
});

test("it never claims to be current before the probe answers", () => {
  // The whole point of the ladder: no update object means no answer yet, and
  // "Up to date" is a claim about an answer we do not have.
  for (const version of [null, undefined, "0.8.37"]) {
    for (const update of [null, undefined]) {
      const cell = versionCell(update, version);
      assert.ok(
        !/up to date/i.test(cell.label),
        `"${cell.label}" claims currency with no update probe`,
      );
      assert.equal(cell.waiting, false);
    }
  }
});

test("the rungs are ordered — an available update outranks everything", () => {
  // An update that arrives while the installed version is still unknown must
  // still report the update; the ladder is priority, not a fallback chain.
  const cell = versionCell({ available: true, current: "0.8.37", version: "0.9.0" }, null);
  assert.equal(cell.rung, "update");
  assert.equal(cell.label, "Update available · v0.9.0");

  // And an update with no version string still announces itself honestly,
  // without inventing a number.
  const bare = versionCell({ available: true, current: "0.8.37" }, "0.8.37");
  assert.equal(bare.label, "Update available");
  assert.ok(!bare.label.includes("undefined"));
});

test("only the update rung sweeps", () => {
  const rungs = new Map<VersionRung, boolean>();
  rungs.set(versionCell({ available: true, current: "1", version: "2" }, "1").rung, true);
  for (const cell of [
    versionCell({ available: false, current: "1" }, "1"),
    versionCell(null, "1"),
    versionCell(null, null),
  ]) {
    assert.equal(cell.waiting, false, `${cell.rung} must not sweep`);
    rungs.set(cell.rung, cell.waiting);
  }
  // Four rungs, exactly one of which is a waiting update.
  assert.equal(rungs.size, 4);
  assert.equal([...rungs.values()].filter(Boolean).length, 1);
});

// ── The vitals fold INTO the row, they don't disappear ────────────

test("every aggregator state keeps a full, honest ledger", () => {
  for (const state of STATES) {
    const board = deriveBoard(ENGINE[state]);
    const ledger = buildLedger(board, null, "0.8.37");

    // A cell per vital the board reports — the merge drops nothing.
    assert.equal(ledger.vitals.length, board.vitals.length, state);
    assert.ok(ledger.vitals.length >= 1, `${state}: the row lost the engine vital`);

    const engine = ledger.vitals[0];
    assert.equal(engine.key, "engine");
    assert.equal(engine.label, "engine");
    assert.ok(engine.value.trim() !== "", `${state}: the engine cell says nothing`);
    assert.equal(engine.target, "supervision", `${state}: the vital lost its door`);
    assert.ok(engine.provenance, `${state}: the vital lost its provenance`);

    // …and the rest of the row is always there.
    assert.equal(ledger.version.target, "updates");
    assert.deepEqual(
      ledger.links.map((l) => l.target),
      ["changelog", "help"],
    );
  }
});

test("every aggregator state keeps a verdict and a verb beside the row", () => {
  // The band composition's contract: three things, always all three. A state
  // that renders a ledger but no verdict (or an unlabelled verb) would leave
  // the home saying less than the engine knows.
  for (const state of STATES) {
    const board = deriveBoard(ENGINE[state]);
    assert.ok(board.systemLine.trim() !== "", `${state}: no verdict`);
    assert.ok(board.actuator.label.trim() !== "", `${state}: no verb`);
    // A disabled verb always says WHY. The two in-flight states say it in the
    // label itself ("Checking engine…", "Starting engine…" — the verb IS the
    // reason); anything else disabled owes the user a reason line.
    const inFlight = board.actuator.action === "checking" || board.actuator.action === "starting";
    if (board.actuator.disabled && !inFlight) {
      assert.ok(board.actuator.reason, `${state}: a disabled verb with no reason`);
    }
    if (board.actuator.disabled && inFlight) {
      assert.match(board.actuator.label, /…$/, `${state}: an in-flight verb must read as in-flight`);
    }
  }
});

test("the six states produce six DISTINCT bands", () => {
  // Distinctness is a property of the WHOLE band, not of the engine cell: the
  // engine really is `Healthy` in both `ready` and `needsSetup`, and a row that
  // claimed otherwise would be lying to look informative. What separates those
  // two is the verdict and the verb, which is exactly where the difference
  // lives in the machine.
  const seen = new Map<string, string>();
  for (const state of STATES) {
    const board = deriveBoard(ENGINE[state]);
    const cell = buildLedger(board, null, "0.8.37").vitals[0];
    const shape = [cell.value, cell.dot, board.systemLine, board.actuator.label].join("/");
    const clash = seen.get(shape);
    if (clash) assert.fail(`${state} is indistinguishable from ${clash} ("${shape}")`);
    seen.set(shape, state);
  }
  assert.equal(seen.size, 6);

  // And the engine cell alone separates the four states that ARE distinct
  // engine states (ready and needsSetup share one, honestly).
  const words = STATES.map(
    (s) => buildLedger(deriveBoard(ENGINE[s]), null, "0.8.37").vitals[0].value,
  );
  assert.equal(new Set(words).size, 5);
});

test("a stale reading refuses to quote its value", () => {
  const fresh = vitalCell({
    key: "engine",
    label: "engine",
    value: "Healthy",
    dot: "ok",
    freshness: "fresh",
    door: "supervision",
    provenance: "last ok 2026-08-13T00:00:00Z",
  });
  assert.equal(fresh.value, "Healthy");
  assert.equal(fresh.stale, false);

  const stale = vitalCell({
    key: "engine",
    label: "engine",
    value: "Healthy",
    dot: "ok",
    freshness: "stale",
    door: "supervision",
    provenance: "last ok 2026-08-13T00:00:00Z",
  });
  assert.equal(stale.value, "stale", "a stale cell may not repeat a reading it can't stand behind");
  assert.equal(stale.stale, true);
  assert.equal(stale.provenance, "last ok 2026-08-13T00:00:00Z", "provenance survives staleness");
  assert.equal(stale.target, "supervision", "…and so does the door");
});

test("the row's tail is fixed and both halves are doors", () => {
  assert.equal(LEDGER_LINKS.length, 2);
  for (const link of LEDGER_LINKS) {
    assert.ok(link.label.trim() !== "");
    assert.ok(link.target === "changelog" || link.target === "help");
  }
  // Copy check: the sketch's row is `… · What's new · Help`.
  assert.match(LEDGER_LINKS[0].label, /^What.s new$/);
  assert.equal(LEDGER_LINKS[1].label, "Help");
});
