// Tests for the instrument's contract — §3.3's state map and Risk 8's four
// body rules, asserted rather than merely drawn.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
//
// There is no DOM in the test runner, which is exactly why `orrery.ts` holds
// the decisions and `Orrery.tsx` holds only the tweens: "every aggregator
// state maps to a defined instrument state", "an unknown state never claims
// health", "the instrument never invents a body" and "the resting state is the
// brand mark" are all statements about pure values, and all four are tests
// here. The mapping is driven through the REAL aggregator (`deriveBoard`), not
// through hand-written phases, so the two can never drift apart in silence.
//
// The last test is this slice's grep guard, in the house pattern: the SMIL
// motion the orrery replaced must not come back.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { deriveBoard, type EngineState } from "../lib/aggregator.ts";
import type { ContainerStatus } from "../lib/tauri.ts";
import {
  CHROME_DOTS,
  ECHO,
  ECHO_CHROME_DOTS,
  FALLBACK_PHASE,
  GEOM,
  MARK,
  MAX_BODIES,
  OFF_TEMPO,
  REVOLUTION_SECONDS,
  RING_GAPPED_PATH,
  RING_PATH,
  SEAM,
  SEAM_PATH,
  bodySeed,
  containerFlag,
  containerTone,
  frameFor,
  orreryFrame,
  orreryPhase,
  ringExtent,
  ringPoint,
  seatPoint,
  type OrreryPhase,
} from "./orrery.ts";

const HERE = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(HERE), "..");

// ── The six aggregator states, as the aggregator itself derives them ──

/** One fixture per rung of the aggregator's ladder (§3.3). These are engine
 *  snapshots, not phases: the mapping under test is state → instrument, so the
 *  test may not shortcut past `deriveBoard`. */
const ENGINE: Record<OrreryPhase, EngineState> = {
  checking: { health: null },
  starting: { health: null, starting: true },
  down: { health: { state: "down" } },
  degraded: { health: { state: "degraded" } },
  needsSetup: { health: { state: "healthy" }, needsSetup: true },
  ready: { health: { state: "healthy" } },
};

const PHASES = Object.keys(ENGINE) as OrreryPhase[];

const container = (
  name: string,
  state = "running",
  health?: string,
): ContainerStatus => ({ name, state, health });

const STACK = [
  container("auracle-engine", "running", "healthy"),
  container("auracle-db", "running"),
  container("houston", "running", "healthy"),
];

test("every aggregator state maps to a defined instrument state", () => {
  for (const phase of PHASES) {
    const board = deriveBoard(ENGINE[phase]);
    assert.equal(
      orreryPhase(board.actuator.action),
      phase,
      `${phase}: the aggregator's "${board.actuator.action}" must land on it`,
    );
  }
});

test("the six states map onto six DISTINCT instruments", () => {
  // Not just "everything maps" — no two engine states may look the same, or
  // the instrument would be telling the user less than the engine knows.
  const seen = new Map<string, OrreryPhase>();
  for (const phase of PHASES) {
    const f = frameFor(deriveBoard(ENGINE[phase]), STACK);
    const shape = [f.core, f.ring, f.running, f.breath?.period ?? "-", f.chrome].join("/");
    const clash = seen.get(shape);
    assert.equal(clash, undefined, `${phase} is indistinguishable from ${clash}`);
    seen.set(shape, phase);
  }
  assert.equal(seen.size, 6);
});

test("an unrecognised state falls back without claiming anything", () => {
  for (const junk of ["", "ready", "ok", "healthy", "LAUNCH", "connect", "undefined"]) {
    assert.equal(orreryPhase(junk), FALLBACK_PHASE, `"${junk}" must fall back`);
  }
  // The fallback is not merely defined, it is EMPTY: no bodies, no motion, no
  // health colour. A state we don't recognise must look like a state we
  // haven't probed yet, never like a healthy one.
  const f = orreryFrame(orreryPhase("nonsense"), STACK);
  assert.equal(f.phase, "checking");
  assert.equal(f.core, "checking");
  assert.equal(f.running, false);
  assert.deepEqual(f.bodies, []);
  assert.equal(f.chrome, true);
});

test("every frame is complete, whatever the state", () => {
  for (const phase of PHASES) {
    const f = orreryFrame(phase, STACK);
    assert.equal(f.phase, phase);
    assert.ok(["checking", "accent", "ready", "warn", "err"].includes(f.core));
    assert.ok(["dim", "chrome", "seam", "dashed"].includes(f.ring));
    assert.equal(typeof f.running, "boolean");
    assert.equal(f.revolution, REVOLUTION_SECONDS, "one period, every state");
    assert.equal(f.chrome, f.bodies.length === 0);
    assert.ok(f.overflow >= 0);
  }
});

// ── §3.3's exact state map ────────────────────────────────────────

test("the state map is the one the design doc specifies", () => {
  const expected: Record<
    OrreryPhase,
    { core: string; ring: string; running: boolean; bodies: boolean; breath: number | null }
  > = {
    checking: { core: "checking", ring: "dim", running: false, bodies: false, breath: 4 },
    starting: { core: "accent", ring: "chrome", running: true, bodies: true, breath: 1.2 },
    ready: { core: "ready", ring: "chrome", running: true, bodies: true, breath: null },
    needsSetup: { core: "accent", ring: "seam", running: true, bodies: true, breath: null },
    degraded: { core: "warn", ring: "chrome", running: true, bodies: true, breath: null },
    down: { core: "err", ring: "dashed", running: false, bodies: false, breath: null },
  };
  for (const phase of PHASES) {
    const f = orreryFrame(phase, STACK);
    const want = expected[phase];
    assert.equal(f.core, want.core, `${phase} core`);
    assert.equal(f.ring, want.ring, `${phase} ring`);
    assert.equal(f.running, want.running, `${phase} running`);
    assert.equal(f.bodies.length > 0, want.bodies, `${phase} bodies`);
    assert.equal(f.breath?.period ?? null, want.breath, `${phase} breath`);
  }
});

test("the instrument has no green — a healthy core is blue, not a status hue", () => {
  // The lamp this replaces lit GREEN when ready, which spent a health colour
  // on a screen whose verdict already says "Everything's ready." (§2.1: blue
  // is "alive", green is a health semantic and belongs to the ledger's dot).
  const cores = PHASES.map((p) => orreryFrame(p, STACK).core);
  assert.ok(!cores.includes("ok" as never));
  assert.equal(orreryFrame("ready", STACK).core, "ready");
});

test("the core breathes only while the machine is in flight, and faster when starting", () => {
  const checking = orreryFrame("checking").breath;
  const starting = orreryFrame("starting", STACK).breath;
  assert.ok(checking && starting);
  assert.ok(starting.period < checking.period, "starting is the quicker breath");
  assert.equal(checking.opacityDelta, 0.04, "§3.3: a 4% swing, not a pulse");
  assert.equal(starting.opacityDelta, 0.04);
  for (const settled of ["ready", "needsSetup", "degraded", "down"] as OrreryPhase[]) {
    assert.equal(orreryFrame(settled, STACK).breath, null, `${settled} is calm`);
  }
});

// ── Risk 8: the instrument never fabricates a machine ─────────────

test("no container data means the mark, not an invented machine", () => {
  for (const containers of [[], undefined]) {
    const f = orreryFrame("ready", containers);
    assert.deepEqual(f.bodies, [], "nothing to show is not something to show");
    assert.equal(f.chrome, true, "the mark's own dots stand in");
    assert.equal(f.overflow, 0);
  }
});

test("a stopped or unprobed engine shows no bodies even when the list is full", () => {
  for (const phase of ["checking", "down"] as OrreryPhase[]) {
    const f = orreryFrame(phase, STACK);
    assert.deepEqual(f.bodies, [], `${phase} must not ride bodies`);
    assert.equal(f.chrome, true);
    assert.equal(f.running, false, `${phase} must not turn`);
    assert.equal(f.overflow, 0, "a suppressed list has no overflow to report");
  }
});

test("a body's ink is its own container's report", () => {
  const f = orreryFrame("degraded", [
    container("ok-one", "running", "healthy"),
    container("no-health", "running"),
    container("sick", "running", "unhealthy"),
    container("stopped", "exited"),
    container("booting", "restarting"),
  ]);
  const tone = (name: string) => f.bodies.find((b) => b.name === name)?.tone;
  assert.equal(tone("ok-one"), "body");
  assert.equal(tone("no-health"), "body", "no healthcheck is not bad news");
  assert.equal(tone("sick"), "warn");
  assert.equal(tone("stopped"), "err");
  assert.equal(tone("booting"), "warn");
  // …and the tint is per-container: a degraded stack does not paint the ones
  // that are fine.
  assert.equal(f.bodies.filter((b) => b.tone === "body").length, 2);
});

test("only an affected body falls off the beat", () => {
  const f = orreryFrame("degraded", [
    container("fine", "running", "healthy"),
    container("sick", "running", "unhealthy"),
  ]);
  assert.equal(f.bodies.find((b) => b.name === "fine")?.tempo, 1);
  assert.equal(f.bodies.find((b) => b.name === "sick")?.tempo, OFF_TEMPO);
  assert.ok(OFF_TEMPO < 1 && OFF_TEMPO > 0.5, "off-beat, not stopped");
});

test("counts are never invented, and never quietly truncated", () => {
  for (const n of [1, 3, MAX_BODIES]) {
    const many = Array.from({ length: n }, (_, i) => container(`svc-${i}`));
    const f = orreryFrame("ready", many);
    assert.equal(f.bodies.length, n, "one body per real container");
    assert.equal(f.overflow, 0);
  }
  const crowd = Array.from({ length: MAX_BODIES + 5 }, (_, i) =>
    container(`svc-${String(i).padStart(2, "0")}`),
  );
  const f = orreryFrame("ready", crowd);
  assert.equal(f.bodies.length, MAX_BODIES, "the node budget caps the drawing");
  assert.equal(f.overflow, 5, "…and the surplus is reported, not swallowed");
});

test("a body is only ever a real, named container", () => {
  const f = orreryFrame("ready", [
    container("real"),
    container("   "),
    { name: "", state: "running" },
  ]);
  assert.deepEqual(f.bodies.map((b) => b.name), ["real"]);
});

test("the flag quotes the container's own words", () => {
  assert.equal(containerFlag(container("houston", "running", "healthy")), "houston · healthy");
  assert.equal(containerFlag(container("auracle-db", "running")), "auracle-db · running");
  assert.equal(containerFlag({ name: "bare", state: "" }), "bare");
  assert.equal(containerTone({ name: "bare", state: "" }), "body");
});

test("bodies are stable and deterministically seeded", () => {
  const shuffled = [...STACK].reverse();
  const a = orreryFrame("ready", STACK).bodies;
  const b = orreryFrame("ready", shuffled).bodies;
  assert.deepEqual(a, b, "docker's ordering must not move the instrument");
  for (const body of a) {
    assert.ok(body.seed >= 0 && body.seed < 1, `${body.name} seed in range`);
  }
  assert.equal(new Set(a.map((x) => x.seed)).size, a.length, "no two share a seat");
  assert.equal(bodySeed(0, 4), MARK.seed, "the first body sits where the mark's does");
  assert.equal(bodySeed(0, 0), MARK.seed, "…and an empty ring still has a seat 0");
});

// ── §2.5: the resting state IS the mark ───────────────────────────

const RAD = Math.PI / 180;
const near = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test("the ring keeps the lamp's silhouette (Risk 4)", () => {
  near(GEOM.rx / GEOM.ry, 49 / 18, 1e-9, "ellipse ratio");
  assert.equal(GEOM.tilt, -24, "the lamp's tilt, kept for continuity");
  assert.equal(GEOM.rx, 49 * 3, "the lamp's ellipse at 3×");
  // §3.3's absolute sizes, literal at the instrument's 300px ceiling.
  assert.equal(GEOM.core * 2, 8, "8px core");
  assert.equal(GEOM.halo * 2, 20, "20px soft ring");
  assert.equal(GEOM.haloAlpha, 0.13);
  assert.equal(GEOM.body * 2, 5, "5px bodies");
});

test("the ring path and the ring geometry are the same ring", () => {
  const a = ringPoint(180);
  const b = ringPoint(0);
  assert.ok(RING_PATH.startsWith(`M${a.x.toFixed(2)},${a.y.toFixed(2)}`));
  assert.ok(RING_PATH.includes(`${b.x.toFixed(2)},${b.y.toFixed(2)}`));
  assert.ok(RING_PATH.includes(`A${GEOM.rx},${GEOM.ry} ${GEOM.tilt} 1 1`));
  // ringExtent() must agree with ringPoint() — the mark quotation rides on it.
  for (const theta of [0, 31.11, 90, 196, 270.55, 300]) {
    const p = ringPoint(theta);
    const dir = Math.atan2(p.y - GEOM.cy, p.x - GEOM.cx) / RAD;
    near(
      Math.hypot(p.x - GEOM.cx, p.y - GEOM.cy),
      ringExtent(dir),
      1e-6,
      `extent at θ=${theta}`,
    );
  }
});

test("the seam is a gap in the ring, not a line painted over it", () => {
  const from = ringPoint(SEAM.from);
  const to = ringPoint(SEAM.to);
  assert.ok(SEAM_PATH.startsWith(`M${from.x.toFixed(2)},${from.y.toFixed(2)}`));
  assert.ok(SEAM_PATH.endsWith(`${to.x.toFixed(2)},${to.y.toFixed(2)}`));
  // The remaining ring starts where the seam ends and ends where it starts:
  // together they cover the ring exactly once.
  assert.ok(RING_GAPPED_PATH.startsWith(`M${to.x.toFixed(2)},${to.y.toFixed(2)}`));
  assert.ok(RING_GAPPED_PATH.endsWith(`${from.x.toFixed(2)},${from.y.toFixed(2)}`));
  assert.ok(SEAM_PATH.includes(" 0 1 "), "the seam is the short way round");
  assert.ok(RING_GAPPED_PATH.includes(" 1 1 "), "…and the rest is the long way");
});

test("the resting state reproduces the brand mark", () => {
  // The numbers below are measured off AuracleGlyph's traced vectors (the
  // method is in orrery.ts's MARK comment). Duplicated here on purpose: if
  // someone nudges MARK by hand, this fails.
  assert.deepEqual([...MARK.directions], [-112.5, -11.5], "the mark's two angles");
  near(MARK.directions[1] - MARK.directions[0], 101, 1e-9, "angular separation");
  // 124.1 / 198.7 = 0.6246 off the traced vectors; 0.155 / 0.248 once each is
  // rounded to the three figures MARK carries.
  near(MARK.radii[0] / MARK.radii[1], 0.624, 0.002, "the mark's dot size ratio");
  near(MARK.depths[0], 0.47, 1e-9, "small dot depth");
  near(MARK.depths[1], 0.437, 1e-9, "big dot depth");

  assert.equal(CHROME_DOTS.length, 2, "core + two bodies — the mark, at rest");
  CHROME_DOTS.forEach((dot, i) => {
    const dx = dot.x - GEOM.cx;
    const dy = dot.y - GEOM.cy;
    // (1) each dot leaves the core on the mark's own bearing…
    near(Math.atan2(dy, dx) / RAD, MARK.directions[i], 0.05, `chrome ${i} direction`);
    // (2) …at the mark's depth into the ring, measured in that direction…
    const reach = ringExtent(MARK.directions[i]);
    near(Math.hypot(dx, dy) / reach, MARK.depths[i], 0.01, `chrome ${i} depth`);
    // (3) …and inside the ring, never on or beyond it.
    assert.ok(Math.hypot(dx, dy) < reach, `chrome ${i} sits inside the ring`);
  });
  // (4) the size difference is the mark's, and it is perspective, not data.
  near(CHROME_DOTS[0].r / CHROME_DOTS[1].r, 0.624, 0.005, "chrome dot size ratio");
  assert.equal(CHROME_DOTS[1].r, GEOM.body, "the near dot is a body-sized body");
});

// ── §3.4: the echo is the same instrument, sat still ──────────────

test("a seat is a point ON the ring, wherever the seed falls", () => {
  for (const p of [0, 0.1, 0.25, 0.333, 0.5, 0.586, 0.75, 0.99]) {
    const seat = seatPoint(p);
    const dir = Math.atan2(seat.y - GEOM.cy, seat.x - GEOM.cx) / RAD;
    // A body rides the ring itself, so its distance from the core must be the
    // ring's own reach in that direction — the echo may not float one inside.
    near(
      Math.hypot(seat.x - GEOM.cx, seat.y - GEOM.cy),
      ringExtent(dir),
      0.05,
      `seat at p=${p} sits on the ring`,
    );
  }
});

test("the seat walk starts where the ring path starts, and wraps", () => {
  const start = ringPoint(180);
  const zero = seatPoint(0);
  near(zero.x, start.x, 1e-6, "seat(0) x");
  near(zero.y, start.y, 1e-6, "seat(0) y");
  // Progress wraps, so a seed at 1 (or beyond) is the same seat as 0 — the
  // orbit has no end to fall off.
  for (const p of [1, 2, -1]) {
    const wrapped = seatPoint(p);
    near(wrapped.x, zero.x, 1e-6, `seat(${p}) x wraps`);
    near(wrapped.y, zero.y, 1e-6, `seat(${p}) y wraps`);
  }
});

test("seats are walked by ARC LENGTH, not by the ellipse parameter", () => {
  // This is the whole reason seatPoint exists. GSAP's MotionPath carries the
  // live bodies along the path by length, so equal steps of progress are equal
  // DISTANCES round the orbit. Evaluating the ellipse parameter instead would
  // sprint through the foreshortened ends and crawl along the sides, seating
  // the echo's bodies visibly away from where the home is carrying them.
  // Measured with short steps on purpose: the yardstick is a straight chord,
  // and a chord only equals the arc it spans in the limit. At 360 steps the
  // gap is under a thousandth even at the orbit's tightest end, so what is
  // left to see is the parameterisation itself.
  const steps = 360;
  const lengths: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = seatPoint(i / steps);
    const b = seatPoint((i + 1) / steps);
    lengths.push(Math.hypot(b.x - a.x, b.y - a.y));
  }
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  assert.ok(max / min < 1.005, `equal progress must be equal distance (${min}–${max})`);
  // …and the naive parameterisation really would be wrong. The two agree only
  // at the quarter points, where the ellipse's own symmetry forces it; away
  // from those they part by several body-widths, which is what makes this a
  // test rather than a preference. MARK.seed is one such place, and it is the
  // seat a lone container actually gets.
  for (const p of [0.1, MARK.seed]) {
    const naive = ringPoint(180 + p * 360);
    const seat = seatPoint(p);
    assert.ok(
      Math.hypot(naive.x - seat.x, naive.y - seat.y) > GEOM.body * 4,
      `the ellipse parameter is not the path parameter (p=${p})`,
    );
  }
});

test("the echo quotes the instrument's proportions, not its pixels", () => {
  // Scaling the drawing down would put a body under 2px — the echo re-picks
  // the radii for its own size instead. What may NOT drift is the ordering
  // (halo outside core, core bigger than a body) or the mark's dot ratio.
  assert.ok(ECHO.halo > ECHO.core, "the soft ring contains the core");
  assert.ok(ECHO.core > ECHO.body, "the core leads the bodies");
  assert.ok(ECHO.size < GEOM.size, "the echo is a miniature");
  // The cropped window keeps the drawing's own scale in both axes, so the
  // orbit is still circular-in-projection rather than squashed to fit.
  const [, vy, vw, vh] = ECHO.viewBox.split(" ").map(Number);
  near(ECHO.height / ECHO.size, vh / vw, 1e-4, "the box matches its window");
  assert.ok(vy > 0 && vy + vh < GEOM.size, "the window crops, and stays inside");
  // …and it still contains the whole instrument: the ring's extremes, the
  // halo, and a body's radius at each.
  for (const theta of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const p = ringPoint(theta);
    assert.ok(
      p.y - ECHO.body >= vy && p.y + ECHO.body <= vy + vh,
      `the window holds the ring at θ=${theta}`,
    );
  }
  assert.ok(GEOM.cy - ECHO.halo > vy, "…and the core's soft ring");
  // The mark's own two dots keep their ratio at echo scale (§2.5).
  near(
    ECHO_CHROME_DOTS[0].r / ECHO_CHROME_DOTS[1].r,
    CHROME_DOTS[0].r / CHROME_DOTS[1].r,
    0.005,
    "chrome dot ratio survives the scale",
  );
  assert.equal(ECHO_CHROME_DOTS[1].r, ECHO.body, "the near dot is a body");
  ECHO_CHROME_DOTS.forEach((dot, i) => {
    assert.equal(dot.x, CHROME_DOTS[i].x, "the bearings do not move");
    assert.equal(dot.y, CHROME_DOTS[i].y);
  });
});

test("the echo draws the frame it is given, never one of its own", () => {
  // The echo takes the home's frame whole, so every state it can be handed is
  // one of the six — and each is already asserted distinct above. What this
  // pins is that a frame carries everything the still drawing needs: a ring
  // style, a core tone, and either bodies with seats or the mark's dots.
  for (const phase of PHASES) {
    const f = orreryFrame(phase, STACK);
    assert.ok(f.ring && f.core, `${phase} has a ring and a core to draw`);
    if (f.chrome) {
      assert.equal(f.bodies.length, 0, `${phase}: chrome stands in for bodies`);
    } else {
      for (const body of f.bodies) {
        const seat = seatPoint(body.seed);
        assert.ok(
          Number.isFinite(seat.x) && Number.isFinite(seat.y),
          `${phase}: ${body.name} has a seat`,
        );
      }
    }
  }
});

// ── The guard ─────────────────────────────────────────────────────

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx|css)$/.test(e.name) && !e.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("the declarative SVG motion the instrument replaced does not come back", () => {
  // The lamp animated its satellites with SMIL, which cannot be paused,
  // re-tempoed or seeked — so it could honour neither the reduced-motion kill
  // switch nor the hidden-window power law, and a "spin-down" was impossible
  // to express (Risk 4). Spelled from parts so this file does not trip itself.
  const smil = ["animate", "Motion"].join("");
  const mpath = ["m", "path"].join("");
  const offenders = sources(SRC)
    .filter((f) => {
      const text = readFileSync(f, "utf8");
      return text.includes(`<${smil}`) || text.includes(`<${mpath}`);
    })
    .map((f) => path.relative(SRC, f));
  assert.deepEqual(offenders, [], "SMIL motion is not controllable; use MotionPath");
});
