// Tests for the version truth ladder — the one piece of real logic the home's
// retired mono ledger held, and the reason `ledger.ts` outlived the band.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
//
// There is no DOM in the test runner, which is exactly why `ledger.ts` holds
// the decision and the component holds only the ink. The statement worth a
// test is a statement about a pure value: "never claims current before the
// check returns".
//
// The band-level assertions that used to live here — every aggregator state
// keeps a full row, and the six states stay distinguishable — moved to
// `aggregator.test.ts` with the readings themselves. They were always
// statements about the BOARD; the row was just where they were read.

import { test } from "node:test";
import assert from "node:assert/strict";

import { UNKNOWN_VERSION_LABEL, versionCell, type VersionRung } from "./ledger.ts";

test("the ladder's four rungs read exactly as the doc spells them", () => {
  assert.deepEqual(versionCell({ available: true, current: "0.8.37", version: "0.9.0" }, "0.8.37"), {
    rung: "update",
    label: "Update available · v0.9.0",
    waiting: true,
  });
  assert.deepEqual(versionCell({ available: false, current: "0.8.37" }, "0.8.37"), {
    rung: "current",
    label: "Up to date · v0.8.37",
    waiting: false,
  });
  assert.deepEqual(versionCell(null, "0.8.37"), {
    rung: "version",
    label: "v0.8.37",
    waiting: false,
  });
  assert.deepEqual(versionCell(null, null), {
    rung: "unknown",
    label: UNKNOWN_VERSION_LABEL,
    waiting: false,
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

test("exactly one rung reports a waiting update", () => {
  const rungs = new Map<VersionRung, boolean>();
  rungs.set(versionCell({ available: true, current: "1", version: "2" }, "1").rung, true);
  for (const cell of [
    versionCell({ available: false, current: "1" }, "1"),
    versionCell(null, "1"),
    versionCell(null, null),
  ]) {
    assert.equal(cell.waiting, false, `${cell.rung} must not report a waiting update`);
    rungs.set(cell.rung, cell.waiting);
  }
  // Four rungs, exactly one of which is a waiting update.
  assert.equal(rungs.size, 4);
  assert.equal([...rungs.values()].filter(Boolean).length, 1);
});

test("the ladder is a reading, not a door", () => {
  // Auracle installs its own updates, so no rung carries an action or a target
  // for one. A field named `target` reappearing here would be a manual update
  // control growing back through the pure layer.
  for (const cell of [
    versionCell({ available: true, current: "1", version: "2" }, "1"),
    versionCell({ available: false, current: "1" }, "1"),
    versionCell(null, "1"),
    versionCell(null, null),
  ]) {
    assert.deepEqual(Object.keys(cell).sort(), ["label", "rung", "waiting"]);
  }
});
