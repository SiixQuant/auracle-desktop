// Tests for the motion foundation — the laws of §2.4, asserted rather than
// merely commented.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
//
// These are contract tests, not animation tests: there is no DOM in the test
// runner, so the reduced-motion *branch* is covered through `resolveMotionTime`
// (the pure core the live media query feeds) rather than through matchMedia.
// The last test is the grep guard the redesign doc asks for: the React
// animation library GSAP replaced must not come back. Its package names are
// spelled from parts down below so this file doesn't trip its own audit.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  DUR,
  EASE,
  MAX_DURATION,
  STAGGER,
  gsap,
  resolveMotionTime,
} from "./motion.ts";

const HERE = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(HERE), "..");
const ROOT = path.resolve(SRC, "..");

// ── House curves ──────────────────────────────────────────────────

const SAMPLES = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

const sameCurve = (a: string, b: string) => {
  const ea = gsap.parseEase(a);
  const eb = gsap.parseEase(b);
  assert.equal(typeof ea, "function", `${a} is not a registered ease`);
  for (const t of SAMPLES) {
    assert.ok(
      Math.abs(ea(t) - eb(t)) < 1e-9,
      `${a} diverges from ${b} at t=${t}`,
    );
  }
};

test("aur-enter is power4.out", () => sameCurve(EASE.enter, "power4.out"));
test("aur-exit is power2.in", () => sameCurve(EASE.exit, "power2.in"));
test("aur-mech is power2.inOut", () => sameCurve(EASE.mech, "power2.inOut"));

test("house curves never overshoot (no bounce / elastic / back)", () => {
  for (const name of Object.values(EASE)) {
    const ease = gsap.parseEase(name);
    for (let t = 0; t <= 1; t += 0.01) {
      const v = ease(t);
      assert.ok(v >= -1e-9 && v <= 1 + 1e-9, `${name} leaves [0,1] at t=${t}`);
    }
  }
});

// ── Duration bands (§2.4) ─────────────────────────────────────────

test("entrance durations sit in the 200–450ms band", () => {
  for (const d of [DUR.enter, DUR.verdict, DUR.long]) {
    assert.ok(d >= 0.2 && d <= 0.45, `${d}s is outside the entrance band`);
  }
});

test("exit durations sit in the 120–180ms band", () => {
  for (const d of [DUR.snap, DUR.exit]) {
    assert.ok(d >= 0.12 && d <= 0.18, `${d}s is outside the exit band`);
  }
});

test("mechanical durations sit in the 240–400ms band", () => {
  for (const d of [DUR.enter, DUR.long]) {
    assert.ok(d >= 0.24 && d <= 0.4, `${d}s is outside the mech band`);
  }
});

test("nothing in the vocabulary exceeds the 800ms ceiling", () => {
  assert.equal(MAX_DURATION, 0.8);
  for (const [name, d] of Object.entries(DUR)) {
    assert.ok(d <= MAX_DURATION, `DUR.${name} (${d}s) breaks the ceiling`);
  }
  assert.equal(DUR.ceremony, MAX_DURATION);
  assert.equal(DUR.micro, 0.15); // the CSS hover/focus ceiling
  assert.equal(STAGGER.word, 0.03);
});

// ── The reduced-motion kill switch ────────────────────────────────

test("reduced motion collapses every time to zero", () => {
  for (const d of Object.values(DUR)) {
    assert.equal(resolveMotionTime(d, true), 0);
  }
  assert.equal(resolveMotionTime(STAGGER.word, true), 0);
});

test("motion time is clamped to the house ceiling, never negative", () => {
  assert.equal(resolveMotionTime(DUR.verdict, false), DUR.verdict);
  assert.equal(resolveMotionTime(5, false), MAX_DURATION);
  assert.equal(resolveMotionTime(-1, false), 0);
  assert.equal(resolveMotionTime(Number.NaN, false), 0);
});

// ── Honesty as motion ─────────────────────────────────────────────

test("the foundation ships no number-tween helper", async () => {
  const surface = Object.keys(await import("./motion.ts"));
  const forbidden = /count|number|odometer|tally|percent|digit/i;
  for (const name of surface) {
    assert.ok(
      !forbidden.test(name),
      `motion.ts exports "${name}" — numbers and counts snap, they never tween (§2.4)`,
    );
  }
});

// ── The grep guard the doc asks for ───────────────────────────────

// Source text only — src/ also holds bundled font/asset binaries.
const TEXT = /\.(tsx?|jsx?|css|json|html|md|txt)$/;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return TEXT.test(e.name) ? [full] : [];
  });

test("no plugin that INVENTS text may enter the tree", () => {
  // §2.4 + §4: the verdict is allowed to animate, never to lie. Scramble /
  // decrypt / typewriter / split-flap all render characters the machine never
  // said — a half-scrambled "Everything's ready." is a sentence the engine
  // never reported. SplitText is the one text plugin this app registers, and
  // it only ever REVEALS words that are already in the DOM.
  const banned = ["ScrambleText" + "Plugin", "gsap/" + "TextPlugin", "Decrypted" + "Text"];
  const offenders: string[] = [];

  for (const file of [...walk(SRC), path.join(ROOT, "package.json")]) {
    const text = readFileSync(file, "utf8");
    for (const needle of banned) {
      if (text.includes(needle)) offenders.push(`${path.relative(ROOT, file)} → ${needle}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `text is truth, not material (§2.4). Offenders:\n${offenders.join("\n")}`,
  );
});

test("the retired animation library stays out of the frontend", () => {
  // Spelled from parts so the guard doesn't trip over its own source text.
  const banned = ["framer" + "-motion", "motion" + "/react"];
  const offenders: string[] = [];

  for (const file of [...walk(SRC), path.join(ROOT, "package.json")]) {
    const text = readFileSync(file, "utf8");
    for (const needle of banned) {
      if (text.includes(needle)) {
        offenders.push(`${path.relative(ROOT, file)} → ${needle}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `one motion engine only (§2.4) — GSAP. Offenders:\n${offenders.join("\n")}`,
  );
});
