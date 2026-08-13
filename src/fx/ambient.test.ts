// Tests for the ambient stage's contract — the perf gates of §4, asserted
// rather than merely promised.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
//
// There is no DOM in the test runner, which is exactly why `ambient.ts` holds
// the decisions and `DotField.tsx` holds only the canvas plumbing: the tiering
// table, the frame gates, the ink ramp and the dot-count budget are all pure
// functions here, so "the field stops when the window hides" is a test rather
// than a comment. The last test is this slice's grep guard: the WebGL stack
// the canvas-2D field replaced must not come back. Its package names are
// spelled from parts so the guard doesn't trip over its own source text.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  FIELD,
  STAGE_INK_FALLBACK,
  TARGET_FPS,
  ambientCadence,
  focusWeight,
  frameGate,
  gridSpec,
  inkRamp,
  parseRgba,
  shouldPaint,
  tierAt,
  tickerPower,
} from "./ambient.ts";

const HERE = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(HERE), "..");
const ROOT = path.resolve(SRC, "..");

// One vsync at each rate, as the browser actually delivers them.
const FRAME_60 = 1000 / 60;
const FRAME_120 = 1000 / 120;
const FRAME_30 = 1000 / 30;

const env = (over: Partial<Parameters<typeof ambientCadence>[0]> = {}) => ({
  hidden: false,
  focused: true,
  reducedMotion: false,
  ...over,
});

// ── Tier 1: hidden means stopped ──────────────────────────────────

test("a hidden document suspends the field completely", () => {
  for (const focused of [true, false]) {
    for (const reducedMotion of [true, false]) {
      const c = ambientCadence(env({ hidden: true, focused, reducedMotion }));
      assert.equal(c.animating, false, "no rAF loop while hidden");
      assert.equal(c.paints, false, "no painting into a hidden webview");
      assert.equal(c.drift, false);
      assert.equal(c.minFrameMs, Number.POSITIVE_INFINITY);
    }
  }
});

test("nothing paints while hidden, however long it has been", () => {
  const c = ambientCadence(env({ hidden: true }));
  for (const elapsed of [0, 16, 1000, 60_000, Number.POSITIVE_INFINITY]) {
    assert.equal(shouldPaint(elapsed, c), false);
  }
});

// ── Tier 2: focused 60fps · blurred 30fps ─────────────────────────

test("a focused window runs the field at 60fps", () => {
  const c = ambientCadence(env({ focused: true }));
  assert.equal(c.animating, true);
  assert.equal(c.drift, true);
  // A 60Hz vsync frame must be admitted — a gate of exactly 1000/60 would
  // reject a 16.6ms frame and silently halve the rate.
  assert.equal(shouldPaint(FRAME_60, c), true);
  // A 120Hz (ProMotion) panel gets clamped back down to 60.
  assert.equal(shouldPaint(FRAME_120, c), false);
});

test("a blurred window drops the field to 30fps", () => {
  const c = ambientCadence(env({ focused: false }));
  assert.equal(c.animating, true);
  assert.equal(c.drift, true);
  assert.equal(shouldPaint(FRAME_60, c), false, "60Hz frames are skipped");
  assert.equal(shouldPaint(FRAME_30, c), true);
  assert.ok(
    c.minFrameMs > ambientCadence(env({ focused: true })).minFrameMs,
    "blurred must be the slower tier",
  );
});

test("frame gates sit just under their nominal period", () => {
  for (const fps of Object.values(TARGET_FPS)) {
    const gate = frameGate(fps);
    assert.ok(gate < 1000 / fps, `${fps}fps gate must admit a real vsync`);
    assert.ok(gate > 1000 / (fps * 2), `${fps}fps gate must not admit double`);
  }
});

// ── Tier 3: reduced motion is one static frame ────────────────────

test("reduced motion renders a static field and never starts a loop", () => {
  for (const focused of [true, false]) {
    const c = ambientCadence(env({ focused, reducedMotion: true }));
    assert.equal(c.animating, false, "no rAF loop under reduced motion");
    assert.equal(c.paints, true, "the texture still renders — once");
    assert.equal(c.drift, false, "…and never drifts");
  }
});

// ── The GSAP ticker's half of the same law ────────────────────────

test("the ticker sleeps only when the document is hidden", () => {
  assert.equal(tickerPower({ hidden: true, focused: false }).sleeping, true);
  assert.equal(tickerPower({ hidden: true, focused: true }).sleeping, true);
  assert.equal(tickerPower({ hidden: false, focused: true }).sleeping, false);
  assert.equal(tickerPower({ hidden: false, focused: false }).sleeping, false);
});

test("the ticker clamps to 30fps when the window is blurred", () => {
  assert.equal(tickerPower({ hidden: false, focused: true }).fps, 60);
  assert.equal(tickerPower({ hidden: false, focused: false }).fps, 30);
});

test("the ticker is blind to reduced motion (zero-duration tweens still tick)", () => {
  // Sleeping the ticker under reduced motion would strand every entrance at
  // its "from" state, because motion.ts collapses durations to 0 rather than
  // skipping the tween. tickerPower's signature cannot even see the flag.
  const power = tickerPower({ hidden: false, focused: true });
  assert.deepEqual(Object.keys(power).sort(), ["fps", "sleeping"]);
});

// ── The dot count IS the budget (Risk 3) ──────────────────────────

test("the lattice hits the documented dot counts", () => {
  // ≈3.2k dots at the default 900×700 window (the sign-in field is full-bleed).
  assert.equal(gridSpec(900, 700).count, 3200);
  // ≈1.3k at the 600×500 minimum, under the 44px topbar (the home's field).
  const min = gridSpec(600, 500 - 44).count;
  assert.ok(min > 1200 && min < 1500, `min-window field was ${min} dots`);
});

test("dot count scales with area, and a degenerate box builds nothing", () => {
  assert.ok(gridSpec(1800, 1400).count > 4 * gridSpec(900, 700).count * 0.9);
  assert.equal(gridSpec(0, 0).count, 0);
  assert.equal(gridSpec(FIELD.step - 1, FIELD.step - 1).count, 0);
});

test("the lattice is centred in its box", () => {
  const g = gridSpec(905, 703);
  assert.ok(g.padX >= 0 && g.padX < FIELD.step);
  assert.ok(g.padY >= 0 && g.padY < FIELD.step);
  assert.ok(Math.abs(905 - (g.cols * FIELD.step + 2 * g.padX)) < 1e-9);
});

// ── The ink ramp (§2.1) ───────────────────────────────────────────

test("the whisper-dim alphas are the ones the design doc specifies", () => {
  assert.equal(STAGE_INK_FALLBACK.base.a, 0.05);
  assert.equal(STAGE_INK_FALLBACK.near.a, 0.09);
  assert.equal(FIELD.focusRadius, 240);
});

test("brightness falls off smoothly from the focus point to nothing", () => {
  assert.equal(focusWeight(0), 1);
  assert.equal(focusWeight(FIELD.focusRadius), 0);
  assert.equal(focusWeight(FIELD.focusRadius * 10), 0);
  let previous = Number.POSITIVE_INFINITY;
  for (let d = 0; d <= FIELD.focusRadius; d += 4) {
    const w = focusWeight(d);
    assert.ok(w <= previous + 1e-12, `falloff rises again at ${d}px`);
    assert.ok(w >= 0 && w <= 1);
    previous = w;
  }
});

test("every dot lands in a real tier, brightest at the centre", () => {
  assert.equal(tierAt(0), FIELD.tiers - 1);
  assert.equal(tierAt(FIELD.focusRadius), 0);
  for (let d = 0; d <= 600; d += 3) {
    const t = tierAt(d);
    assert.ok(Number.isInteger(t) && t >= 0 && t < FIELD.tiers);
  }
});

test("the ink ramp runs from the base token to the near token", () => {
  const ramp = inkRamp(STAGE_INK_FALLBACK.base, STAGE_INK_FALLBACK.near);
  assert.equal(ramp.length, FIELD.tiers);

  const alphas = ramp.map((c) => {
    const parsed = parseRgba(c);
    assert.ok(parsed, `tier ink "${c}" is not a valid rgba()`);
    return parsed.a;
  });
  assert.equal(alphas[0], STAGE_INK_FALLBACK.base.a);
  assert.equal(alphas[alphas.length - 1], STAGE_INK_FALLBACK.near.a);
  for (let i = 1; i < alphas.length; i++) {
    assert.ok(alphas[i] > alphas[i - 1], "the ramp must brighten monotonically");
  }
  // Whisper-dim is a hard ceiling: nothing in the field may out-shout the UI.
  for (const a of alphas) assert.ok(a <= 0.09);
});

test("rgb/rgba token values parse, and anything else falls back", () => {
  assert.deepEqual(parseRgba("rgba(230, 237, 243, 0.05)"), {
    r: 230,
    g: 237,
    b: 243,
    a: 0.05,
  });
  assert.deepEqual(parseRgba("  rgb(1,2,3)  "), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseRgba("rgb(1 2 3 / 50%)"), { r: 1, g: 2, b: 3, a: 0.5 });
  for (const bad of ["", "#e6edf3", "var(--stage-dot)", "rgba(1,2)", "none"]) {
    assert.equal(parseRgba(bad), null, `"${bad}" should not parse`);
  }
});

// ── The grep guard this slice exists to earn ──────────────────────

// Source text only — src/ also holds bundled font binaries.
const TEXT = /\.(tsx?|jsx?|css|json|html|md|txt)$/;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return TEXT.test(e.name) ? [full] : [];
  });

test("the WebGL stack stays deleted", () => {
  // Spelled from parts so this guard doesn't flag its own source text.
  const lib = "th" + "ree";
  const patterns: Array<[string, RegExp]> = [
    [`import of ${lib}`, new RegExp(`from\\s+["']${lib}["']`)],
    [`import of @react-${lib}`, new RegExp(`from\\s+["']@react-${lib}/`)],
    [`require of ${lib}`, new RegExp(`require\\(["']@?[\\w/-]*${lib}`)],
    [`${lib.toUpperCase()} namespace`, new RegExp(`\\b${lib.toUpperCase()}\\.`)],
  ];

  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const [label, re] of patterns) {
      if (re.test(text)) offenders.push(`${path.relative(ROOT, file)} → ${label}`);
    }
  }

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies"] as const) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.includes(lib)) offenders.push(`package.json ${field} → ${name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `the ambient stage is canvas-2D; the launcher owns zero WebGL contexts (§4). Offenders:\n${offenders.join("\n")}`,
  );
});
