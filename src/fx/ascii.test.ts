// Tests for the ascii stage's contract.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).
//
// Same arrangement as `ambient.test.ts`, for the same reason: there is no DOM
// in the runner, which is exactly why the ramp, the pointer model, the
// composition and the power law live in `ascii.ts` and only the canvas
// plumbing lives in `AsciiField.tsx`. Everything asserted below would
// otherwise be a claim in a comment.
//
// The runner tests drive `createStageRunner` with a fake clock and a fake rAF,
// so "hidden cancels the loop" and "reduced motion renders exactly once" are
// facts about the transitions rather than about a screenshot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { type AmbientEnv, ambientCadence } from "./ambient.ts";
import {
  ASCII_INK_FALLBACK,
  CELL,
  COMPOSE,
  DRIFT,
  POINTER,
  RAMP,
  RAMP_LAST,
  type StageIO,
  alphaFor,
  cellFont,
  createStageRunner,
  fillFor,
  floorGlyph,
  glyphAt,
  glyphForLuminance,
  gridFor,
  hash2,
  liftAt,
  luminanceOf,
  markPlacements,
  markSvgDataUri,
  relax,
  stageAction,
} from "./ascii.ts";

const env = (over: Partial<AmbientEnv> = {}): AmbientEnv => ({
  hidden: false,
  focused: true,
  reducedMotion: false,
  ...over,
});

// Boxes the launcher actually occupies: the 600×500 minimum, the 900×700
// default, and a large window. Heights are under the 46px topbar.
const BOXES: Array<[number, number]> = [
  [600, 454],
  [900, 654],
  [1200, 854],
  [1440, 900],
];

// ── The ramp ──────────────────────────────────────────────────────

test("the ramp is the ten-step density scale, empty first", () => {
  assert.equal(RAMP, " ·:-=+*#%@");
  assert.equal(RAMP.length, 10);
  assert.equal(RAMP_LAST, 9);
  assert.equal(RAMP.charAt(0), " ", "index 0 is the empty cell");
});

test("luminance maps monotonically up the ramp, dark to light", () => {
  assert.equal(glyphForLuminance(0), 0, "black leaves the cell empty");
  assert.equal(glyphForLuminance(1), RAMP_LAST, "white is the densest char");

  let previous = -1;
  const seen = new Set<number>();
  for (let l = 0; l <= 1.0001; l += 0.005) {
    const g = glyphForLuminance(l);
    assert.ok(Number.isInteger(g) && g >= 0 && g <= RAMP_LAST);
    assert.ok(g >= previous, `the ramp steps back down at luminance ${l}`);
    previous = g;
    seen.add(g);
  }
  assert.equal(seen.size, RAMP.length, "every step of the ramp is reachable");

  // Out of range clamps rather than indexing off the end of the string.
  assert.equal(glyphForLuminance(-3), 0);
  assert.equal(glyphForLuminance(7), RAMP_LAST);
});

test("the gamma lifts the thin parts of the mark rather than losing them", () => {
  // A cell catching a quarter of the ring is a character, not nothing — this
  // is the whole reason the sample is gamma'd on the way in. Linear, a quarter
  // would land on step 2.
  assert.ok(glyphForLuminance(0.25) >= 3);
  // …and it is a curve, not a rescale: mid-grey lands above the middle.
  assert.ok(glyphForLuminance(0.5) > RAMP_LAST / 2);
});

test("luminance is Rec.709 over the sampled pixel", () => {
  assert.equal(luminanceOf(0, 0, 0), 0);
  // The three coefficients sum to 1 in decimal but not in binary, so white
  // lands a float epsilon under it. glyphForLuminance clamps; nothing else
  // reads this value raw.
  assert.ok(Math.abs(luminanceOf(255, 255, 255) - 1) < 1e-9);
  assert.ok(luminanceOf(0, 255, 0) > luminanceOf(255, 0, 0), "green weighs most");
  assert.ok(luminanceOf(255, 0, 0) > luminanceOf(0, 0, 255), "blue weighs least");
});

// ── Ink (§2.1) ────────────────────────────────────────────────────

test("the ramp's alphas run rest → full and lift toward the ceiling", () => {
  const ink = ASCII_INK_FALLBACK;
  assert.equal(alphaFor(0, 0, ink), ink.rest.a);
  assert.equal(alphaFor(RAMP_LAST, 0, ink), ink.full.a);
  assert.equal(alphaFor(RAMP_LAST, 1, ink), ink.lift.a);
  assert.equal(alphaFor(0, 1, ink), ink.lift.a, "every lifted cell reaches it");

  let previous = -1;
  for (let g = 0; g <= RAMP_LAST; g++) {
    const a = alphaFor(g, 0, ink);
    assert.ok(a > previous, "density must brighten monotonically");
    previous = a;
  }
  for (let l = 0; l <= 1; l += 0.05) {
    const a = alphaFor(4, l, ink);
    assert.ok(a >= alphaFor(4, 0, ink) - 1e-12 && a <= ink.lift.a);
  }
});

test("the field is quieter than the site's and ink, not chrome", () => {
  const ink = ASCII_INK_FALLBACK;
  // The site (white on black) rests at .14 → .30 and lifts to .85. On cream,
  // behind live UI, every step of that comes down by more than half.
  assert.ok(ink.rest.a <= 0.14 / 2, `rest was ${ink.rest.a}`);
  assert.ok(ink.full.a <= 0.3 / 2, `full was ${ink.full.a}`);
  assert.ok(ink.lift.a <= 0.85 / 2, `lift was ${ink.lift.a}`);
  // Ink on cream, the same hue as --fg / --stage-dot, no new colour.
  for (const step of [ink.rest, ink.full, ink.lift]) {
    assert.equal(step.r, 35);
    assert.equal(step.g, 35);
    assert.equal(step.b, 35);
  }
  // Keep in step with --stage-ascii* in app.css.
  assert.deepEqual(
    [ink.rest.a, ink.full.a, ink.lift.a],
    [0.05, 0.12, 0.35],
  );
});

test("a cell's fill is an rgba() of the token ink, quantised", () => {
  const css = fillFor(4, 0, ASCII_INK_FALLBACK);
  assert.match(css, /^rgba\(35, 35, 35, 0\.\d{3}\)$/);
  // Quantisation is what keeps a cell relaxing through a thousandth from
  // churning the fill style every frame.
  assert.equal(fillFor(4, 0.0001, ASCII_INK_FALLBACK), css);
});

// ── The pointer model ─────────────────────────────────────────────

test("the pointer's reach is smoothstepped and stops at its radius", () => {
  assert.equal(liftAt(0), 1);
  assert.equal(liftAt(POINTER.radius), 0);
  assert.equal(liftAt(POINTER.radius * 4), 0, "nothing beyond the reach");
  assert.equal(liftAt(Number.POSITIVE_INFINITY), 0);

  let previous = Number.POSITIVE_INFINITY;
  for (let d = 0; d <= POINTER.radius; d += 2) {
    const t = liftAt(d);
    assert.ok(t >= 0 && t <= 1);
    assert.ok(t <= previous + 1e-12, `the falloff rises again at ${d}px`);
    previous = t;
  }
  // Smooth, not linear: the edge of the reach is a falloff, not a rim.
  assert.ok(liftAt(POINTER.radius * 0.9) < 0.1);
});

test("a fully lifted cell is back at rest within the relax window", () => {
  // 600ms of frames, at both tiers, from the ceiling.
  for (const frame of [1000 / 60, 1000 / 30]) {
    let lift = 1;
    let elapsed = 0;
    while (lift > 0 && elapsed < 5_000) {
      lift = relax(lift, frame);
      elapsed += frame;
    }
    assert.equal(lift, 0, `never reached rest at ${frame.toFixed(1)}ms frames`);
    assert.ok(
      elapsed <= POINTER.relaxMs + 2 * frame,
      `took ${elapsed}ms to relax at ${frame.toFixed(1)}ms frames`,
    );
    // …and it is not instant either: the relax is a curve to watch, ~600ms.
    assert.ok(elapsed >= POINTER.relaxMs);
  }
  assert.ok(POINTER.relaxMs <= 720, "the relax window is ~600ms, not longer");
});

test("relaxation is wall-clock, monotonic, and clamped against a stall", () => {
  assert.equal(relax(1, 0), 1, "no time, no decay");
  assert.equal(relax(0, 16), 0, "rest is a floor, never negative");
  assert.equal(relax(1, -50), 1, "a clock that goes backwards decays nothing");
  assert.ok(relax(1, 90) < relax(1, 40), "longer frames relax further");
  // A tab that stalls for a second must not fall a second's worth in one step.
  assert.equal(relax(1, 10_000), relax(1, POINTER.maxStepMs));
  // Two half-frames equal one whole one (within float noise).
  assert.ok(Math.abs(relax(relax(1, 8), 8) - relax(1, 16)) < 1e-9);
});

test("an empty cell stays empty however close the pointer gets", () => {
  for (let lift = 0; lift <= 1; lift += 0.05) {
    assert.equal(glyphAt(0, false, lift), 0);
    assert.equal(glyphAt(0, true, lift), 0, "…and the drift cannot light it");
  }
});

test("lift and drift each step an occupied cell one up the ramp, clamped", () => {
  assert.equal(glyphAt(3, false, 0), 3);
  assert.equal(glyphAt(3, false, POINTER.stepAt), 3, "the step is exclusive");
  assert.equal(glyphAt(3, false, POINTER.stepAt + 0.01), 4);
  assert.equal(glyphAt(3, true, 0), 4);
  assert.equal(glyphAt(3, true, 1), 5);
  assert.equal(glyphAt(RAMP_LAST, true, 1), RAMP_LAST, "clamped at the top");
});

// ── The drift ─────────────────────────────────────────────────────

test("the drift is bounded: a fixed few cells, a few per second", () => {
  // The whole point of handing the oldest cell back is that the field cannot
  // brighten as it ages — the held set is a constant, not a growing one.
  assert.equal(DRIFT.held, 24);
  const perSecond = 1000 / DRIFT.tickMs;
  assert.ok(perSecond >= 2 && perSecond <= 8, `${perSecond} promotions/second`);

  // The model, run for ten minutes of ticks against the smallest grid.
  const cells = gridFor(600, 454).count;
  const held: number[] = [];
  const drifted = new Uint8Array(cells);
  for (let tick = 0; tick < (10 * 60 * 1000) / DRIFT.tickMs; tick++) {
    const i = tick % cells;
    if (drifted[i]) continue;
    drifted[i] = 1;
    held.push(i);
    if (held.length > DRIFT.held) drifted[held.shift() as number] = 0;
    assert.ok(held.length <= DRIFT.held);
  }
  assert.equal(
    drifted.reduce((n, v) => n + v, 0),
    DRIFT.held,
    "the drift holds a constant number of cells forever",
  );
});

// ── The grid and the composition ──────────────────────────────────

test("the grid covers the box in whole cells", () => {
  for (const [w, h] of BOXES) {
    const g = gridFor(w, h);
    assert.equal(g.count, g.cols * g.rows);
    // Ceil, not floor: a strip of bare cream down one edge would read as a
    // seam.
    assert.ok(g.cols * CELL.size >= w);
    assert.ok(g.rows * CELL.size >= h);
    assert.ok((g.cols - 1) * CELL.size < w);
  }
  assert.equal(gridFor(0, 0).count, 0);
  assert.equal(gridFor(-10, -10).count, 0);
});

test("the cell budget stays in the thousands, not the hundreds of thousands", () => {
  assert.equal(gridFor(900, 654).count, 5_940);
  for (const [w, h] of BOXES) {
    assert.ok(gridFor(w, h).count <= 13_000, `${w}×${h} blew the cell budget`);
  }
});

test("the mark is composed large and bleeds off exactly one edge", () => {
  for (const [w, h] of BOXES) {
    const { cols, rows } = gridFor(w, h);
    const places = markPlacements(cols, rows);
    assert.equal(places.length, 1);
    const [p] = places;

    // Large: most of the grid's height.
    assert.ok(p.size >= rows * 0.7, `${w}×${h}: mark was ${p.size} cells`);

    const left = p.x - p.size / 2;
    const right = p.x + p.size / 2;
    const top = p.y - p.size / 2;
    const bottom = p.y + p.size / 2;

    assert.ok(right > cols, `${w}×${h}: nothing bleeds off the right edge`);
    assert.ok(left > 0, `${w}×${h}: it also bleeds off the left`);
    assert.ok(top > 0, `${w}×${h}: it also bleeds off the top`);
    assert.ok(bottom < rows, `${w}×${h}: it also bleeds off the bottom`);
    // A quarter or so hangs off, so the mark reads as running past the frame
    // rather than as being cropped by accident.
    assert.ok((right - cols) / p.size > 0.2);
  }
  assert.equal(markPlacements(0, 40).length, 0, "a degenerate box composes nothing");
  assert.ok(Math.abs(COMPOSE.tilt) > 0.05, "the mark is tilted, not stamped");
});

// ── The sparse floor ──────────────────────────────────────────────

test("the sparse floor is deterministic, sparse, and never overwrites the mark", () => {
  const { cols, rows } = gridFor(900, 654);
  let floored = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const g = floorGlyph(0, cx, cy);
      assert.ok(g === 0 || g === 1, "the floor is the faintest character only");
      if (g === 1) floored += 1;
      // Same cell, same answer: a rebuild must land on the same field.
      assert.equal(g, floorGlyph(0, cx, cy));
      // A cell the mark filled is never touched.
      for (const level of [1, 5, RAMP_LAST]) {
        assert.equal(floorGlyph(level, cx, cy), level);
      }
    }
  }
  const share = floored / (cols * rows);
  assert.ok(share > 0.15 && share < 0.25, `floor covered ${share} of the grid`);
});

test("the hash does not stripe", () => {
  // Hashed on the cell rather than the flat index, or the floor lands in
  // diagonal stripes. Neighbours along each axis and the diagonal must not
  // move together.
  let sameRight = 0;
  let sameDown = 0;
  let sameDiag = 0;
  for (let y = 0; y < 60; y++) {
    for (let x = 0; x < 60; x++) {
      const here = hash2(x, y) % 5 === 0;
      if (here === (hash2(x + 1, y) % 5 === 0)) sameRight += 1;
      if (here === (hash2(x, y + 1) % 5 === 0)) sameDown += 1;
      if (here === (hash2(x + 1, y + 1) % 5 === 0)) sameDiag += 1;
    }
  }
  // Independent draws agree ≈68% of the time (0.2² + 0.8²); a striped hash
  // would agree far more often.
  for (const [label, n] of [
    ["→", sameRight],
    ["↓", sameDown],
    ["↘", sameDiag],
  ] as const) {
    const agreement = n / 3600;
    assert.ok(agreement < 0.78, `${label} neighbours agree ${agreement}`);
  }
});

// ── The stencil ───────────────────────────────────────────────────

test("the mark rasterises from the shared vectors, at an explicit size, off-network", () => {
  const uri = markSvgDataUri(512);
  assert.ok(uri.startsWith("data:image/svg+xml;charset=utf-8,"));
  const svg = decodeURIComponent(uri.slice(uri.indexOf(",") + 1));
  // Explicit width/height: the art carries a viewBox and no intrinsic size,
  // and an engine that sizes it at the 150px default hands back a blurred
  // stamp to sample.
  assert.match(svg, /width="512"/);
  assert.match(svg, /height="512"/);
  assert.match(svg, /viewBox="0 0 1600 1600"/);
  assert.equal(svg.match(/<path /g)?.length, 3, "swirl + two bodies");
  // A data URI costs no request and taints no canvas, so the sample reads
  // back and the stage adds nothing to the network. The one URL in the file
  // is the SVG namespace, which is an identifier and never fetched.
  assert.ok(!/<image|href|url\(/.test(svg), "nothing external to fetch");
  const urls = svg.match(/https?:\/\/[^"']+/g) ?? [];
  assert.deepEqual(urls, ["http://www.w3.org/2000/svg"]);
});

test("the grid is set in the house mono face", () => {
  assert.match(cellFont('"Geist Mono", monospace'), /^9px "Geist Mono"/);
  assert.equal(CELL.size, 10);
  assert.ok(CELL.glyphScale < 1, "a glyph never reaches its neighbours' boxes");
});

// ── The power law (§3) — one table, shared with the dot field ─────

test("the stage's tiers are the ambient power law, not a second copy", () => {
  for (const hidden of [true, false]) {
    for (const focused of [true, false]) {
      for (const reducedMotion of [true, false]) {
        const cadence = ambientCadence(env({ hidden, focused, reducedMotion }));
        const action = stageAction(cadence);
        assert.equal(action.render, !hidden);
        assert.equal(action.loop, !hidden && !reducedMotion);
      }
    }
  }
});

/** A runner on a fake clock and a fake rAF. */
function harness(start: AmbientEnv) {
  let current = start;
  let now = 1_000;
  let nextHandle = 1;
  const pending = new Map<number, (now: number) => void>();
  const log = { render: 0, measure: 0, step: 0, cancel: 0 };

  const io: StageIO = {
    now: () => now,
    env: () => current,
    measure: () => {
      log.measure += 1;
    },
    render: () => {
      log.render += 1;
    },
    step: () => {
      log.step += 1;
    },
    schedule: (fn) => {
      const handle = nextHandle++;
      pending.set(handle, fn);
      return handle;
    },
    cancel: (handle) => {
      log.cancel += 1;
      pending.delete(handle);
    },
  };

  const runner = createStageRunner(io);
  return {
    runner,
    log,
    scheduled: () => pending.size,
    set(next: Partial<AmbientEnv>) {
      current = { ...current, ...next };
      runner.sync();
    },
    /** Deliver frames until the wall clock has advanced `ms`. */
    advance(ms: number, frameMs = 1000 / 60) {
      const until = now + ms;
      while (now < until) {
        now = Math.min(until, now + frameMs);
        for (const [handle, fn] of [...pending]) {
          pending.delete(handle);
          fn(now);
        }
      }
    },
  };
}

test("a focused window loops, and steps at 60fps", () => {
  const h = harness(env());
  h.runner.sync();
  assert.equal(h.runner.running(), true);
  assert.equal(h.log.render, 1, "one full render on entry");
  assert.equal(h.log.measure, 1, "measured before it rendered");

  h.advance(1000);
  assert.ok(h.log.step >= 55 && h.log.step <= 61, `${h.log.step} steps/second`);
});

test("a blurred window halves the tempo without stopping", () => {
  const h = harness(env({ focused: false }));
  h.runner.sync();
  assert.equal(h.runner.running(), true);
  h.advance(1000);
  assert.ok(h.log.step >= 28 && h.log.step <= 31, `${h.log.step} steps/second`);
});

test("hiding the document cancels the loop; showing it resumes and re-measures", () => {
  const h = harness(env());
  h.runner.sync();
  assert.equal(h.runner.running(), true);
  h.advance(200);
  const stepped = h.log.step;

  h.set({ hidden: true });
  assert.equal(h.runner.running(), false, "the running flag drops");
  assert.equal(h.scheduled(), 0, "the rAF handle is CANCELLED, not left alive");
  assert.ok(h.log.cancel >= 1);
  const rendered = h.log.render;

  // Nothing at all happens while hidden — no frames, no painting into a
  // webview that is not compositing.
  h.advance(2_000);
  assert.equal(h.log.step, stepped);
  assert.equal(h.log.render, rendered);

  h.set({ hidden: false });
  assert.equal(h.runner.running(), true);
  assert.equal(h.log.measure, 2, "a resume re-measures BEFORE it paints");
  assert.equal(h.log.render, rendered + 1);
  h.advance(200);
  assert.ok(h.log.step > stepped);
});

test("a resume does not charge the stage for the time it was gone", () => {
  const h = harness(env());
  h.runner.sync();
  h.advance(100);
  h.set({ hidden: true });
  h.advance(60_000);
  h.set({ hidden: false });
  const before = h.log.step;
  // One frame after a minute-long hide is one frame, not a catch-up burst.
  h.advance(1000 / 60);
  assert.equal(h.log.step, before + 1);
});

test("reduced motion renders exactly once and never starts a loop", () => {
  const h = harness(env({ reducedMotion: true }));
  h.runner.sync();
  assert.equal(h.log.render, 1, "the texture is there…");
  assert.equal(h.runner.running(), false, "…and it never moves again");
  assert.equal(h.scheduled(), 0);

  h.advance(5_000);
  assert.equal(h.log.render, 1, "still exactly one render");
  assert.equal(h.log.step, 0, "not one frame of animation");
});

test("a live flip of the preference takes effect without a remount", () => {
  // The preference is read at sync time, never cached at mount: users flip it
  // mid-session and the stage has to obey. Both directions.
  const h = harness(env());
  h.runner.sync();
  h.advance(200);
  assert.equal(h.runner.running(), true);

  h.set({ reducedMotion: true });
  assert.equal(h.runner.running(), false, "reduce, mid-session, stops it");
  assert.equal(h.scheduled(), 0);
  const stepped = h.log.step;
  h.advance(2_000);
  assert.equal(h.log.step, stepped);

  h.set({ reducedMotion: false });
  assert.equal(h.runner.running(), true, "…and turning it off starts it again");
  h.advance(200);
  assert.ok(h.log.step > stepped);
});

test("sync is idempotent — repeated events do not stack loops", () => {
  const h = harness(env());
  for (let i = 0; i < 5; i++) h.runner.sync();
  assert.equal(h.scheduled(), 1, "exactly one rAF handle outstanding");
  h.advance(100);
  assert.equal(h.scheduled(), 1);
  h.runner.stop();
  assert.equal(h.runner.running(), false);
  assert.equal(h.scheduled(), 0);
});

test("stop() is safe to call twice and leaves nothing scheduled", () => {
  const h = harness(env());
  h.runner.sync();
  h.runner.stop();
  h.runner.stop();
  assert.equal(h.runner.running(), false);
  assert.equal(h.scheduled(), 0);
});
