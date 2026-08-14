// Tests for the home state aggregator — the launcher hub's primary test
// seam.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
// These assert "what the home says is always true": the priority ladder,
// that a null health is never "ready", that the engine vital names the
// inspector it opens, and that the home's one conditional line stays silent
// unless something really needs the owner. Connections (brokers / data
// sources) moved to the IDE, so the home derives no broker/feed/mode reading
// and never offers a "connect" verb — the next move is only Start engine or
// Open workspace.
//
// The home shows LESS than it used to, which makes this file matter more: it
// is where "we restaged the readings, we did not drop them" is enforced.

import { test } from "node:test";
import assert from "node:assert/strict";

import { attentionLine, deriveBoard, type EngineState } from "./aggregator.ts";

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

test("degraded: disabled with an honest reason, routes to Status", () => {
  const b = deriveBoard({ ...base, health: { state: "degraded" } });
  assert.equal(b.lamp, "warn");
  assert.equal(b.actuator.action, "degraded");
  assert.equal(b.actuator.disabled, true);
  assert.match(b.actuator.reason ?? "", /status/i);
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

test("the engine vital names the inspector it opens (status)", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" } });
  assert.equal(vital(b, "engine").door, "status");
  // The home no longer derives broker / feed / mode vitals.
  assert.equal(b.vitals.length, 1);
});

// ── Every state stays fully stated ──────────────────────────────────
//
// These three moved here from `ledger.test.ts` when the home's mono row did.
// They were always assertions about the BOARD — the row was only where they
// were read — and the home now shows strictly less than the row did, so they
// matter more, not less: whatever the engine is doing, the verdict, the verb
// and the vital have to keep saying it.

const ENGINE: Record<string, EngineState> = {
  checking: { health: null },
  starting: { health: null, starting: true },
  down: { health: { state: "down" } },
  degraded: { health: { state: "degraded" } },
  needsSetup: { health: { state: "healthy" }, needsSetup: true },
  ready: { health: { state: "healthy" } },
};
const STATES = Object.keys(ENGINE);

test("every engine state keeps a verdict, a verb and an engine vital", () => {
  for (const state of STATES) {
    const board = deriveBoard(ENGINE[state]);
    assert.ok(board.systemLine.trim() !== "", `${state}: no verdict`);
    assert.ok(board.actuator.label.trim() !== "", `${state}: no verb`);

    const engine = vital(board, "engine");
    assert.ok(engine.value.trim() !== "", `${state}: the engine vital says nothing`);
    assert.equal(engine.door, "status", `${state}: the vital lost its door`);
    assert.ok(engine.provenance, `${state}: the vital lost its provenance`);

    // A disabled verb always says WHY. The two in-flight states say it in the
    // label itself ("Checking engine…", "Starting engine…" — the verb IS the
    // reason); anything else disabled owes the user a reason line.
    const inFlight =
      board.actuator.action === "checking" || board.actuator.action === "starting";
    if (board.actuator.disabled && !inFlight) {
      assert.ok(board.actuator.reason, `${state}: a disabled verb with no reason`);
    }
    if (board.actuator.disabled && inFlight) {
      assert.match(
        board.actuator.label,
        /…$/,
        `${state}: an in-flight verb must read as in-flight`,
      );
    }
  }
});

test("the six states produce six DISTINCT homes", () => {
  // Distinctness is a property of the WHOLE home, not of the engine vital: the
  // engine really is `Healthy` in both `ready` and `needsSetup`, and a reading
  // that claimed otherwise would be lying to look informative. What separates
  // those two is the verdict and the verb, which is exactly where the
  // difference lives in the machine.
  const seen = new Map<string, string>();
  for (const state of STATES) {
    const board = deriveBoard(ENGINE[state]);
    const engine = vital(board, "engine");
    const shape = [
      engine.value,
      engine.dot,
      board.systemLine,
      board.actuator.label,
    ].join("/");
    const clash = seen.get(shape);
    if (clash) assert.fail(`${state} is indistinguishable from ${clash} ("${shape}")`);
    seen.set(shape, state);
  }
  assert.equal(seen.size, 6);

  // And the engine vital alone separates the four states that ARE distinct
  // engine states (ready and needsSetup share one, honestly).
  const words = STATES.map((s) => vital(deriveBoard(ENGINE[s]), "engine").value);
  assert.equal(new Set(words).size, 5);
});

// ── The one quiet line under the verb ───────────────────────────────
//
// The home carries a single conditional line now, so what it decides to say —
// and, more importantly, when it says nothing — is the whole contract.

test("healthy shows nothing extra", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" } });
  assert.equal(attentionLine(b), null);
  assert.equal(attentionLine(b, { engineErr: null, ideError: null }), null);
});

test("a failure the machine reported is quoted verbatim", () => {
  const b = deriveBoard({ ...base, health: { state: "healthy" } });
  assert.equal(
    attentionLine(b, { engineErr: "compose up exited 1" }),
    "compose up exited 1",
  );
  assert.equal(
    attentionLine(b, { ideError: "The engine isn't ready (down)." }),
    "The engine isn't ready (down).",
  );
});

test("a failure outranks a disabled verb's reason", () => {
  // Degraded's verb is disabled WITH a reason; a real failure still wins,
  // because a reason explains a button and a failure explains the machine.
  const b = deriveBoard({ ...base, health: { state: "degraded" } });
  assert.ok(b.actuator.reason);
  assert.equal(attentionLine(b, { engineErr: "docker daemon not running" }), "docker daemon not running");
});

test("a disabled verb always explains itself on the line", () => {
  const b = deriveBoard({ ...base, health: { state: "degraded" } });
  assert.equal(attentionLine(b), b.actuator.reason);
});

test("an in-flight verb is its own explanation and adds no line", () => {
  // "Checking engine…" / "Starting engine…" already say why they can't be
  // pressed; a second line under them would be the home talking to itself.
  for (const s of [{ ...base }, { ...base, starting: true }]) {
    const b = deriveBoard(s);
    assert.equal(b.actuator.disabled, true);
    assert.equal(attentionLine(b), null);
  }
});

test("every engine state's line is either absent or a real sentence", () => {
  for (const state of STATES) {
    const line = attentionLine(deriveBoard(ENGINE[state]));
    if (line !== null) assert.ok(line.trim() !== "", `${state}: an empty line`);
  }
});
