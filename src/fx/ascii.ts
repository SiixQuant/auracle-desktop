// ascii.ts — the ascii stage's ramp, composition, pointer model and
// power law. The PURE half; `AsciiField.tsx` owns the canvas and nothing else.
//
// Design authority: `auracle-marketing/js/ledger.js` (the shipped site field —
// this is the port of it) for the model, and DESIGN.md §2.1/§3/§5 for the
// materials, the power law and the reduced-motion kill switch it has to obey
// here. Same split as `ambient.ts`/`DotField.tsx`, for the same reason: the
// laws are assertable under plain `node --test` instead of being a claim in a
// comment (§8.1 — "decide in a pure module, draw in a component").
//
// WHAT THE FIELD IS. A grid of monospaced characters, one per 10px cell, whose
// density is the brand mark rasterised and read back as luminance: the darker
// the pixel the mark left in a cell, the emptier the cell, and the brighter it
// left it, the further up the ramp ` ·:-=+*#%@` that cell's character sits. The
// mark is composed large and bleeding off one edge, so what reads first is a
// field of characters and only second the shape inside it.
//
// FOUR THINGS IT INHERITS FROM THE DOT FIELD IT REPLACES.
//
//   1. ONE POWER LAW. The cadence comes from `ambientCadence()` in
//      `ambient.ts` — not a second copy of the tiering table. Hidden means the
//      rAF is CANCELLED, blurred means half tempo, reduced motion means one
//      static render and no loop at all. `createStageRunner` below is that law
//      with the rAF lifted out behind an interface, so "the loop stops when
//      the window hides" is a test rather than a promise.
//
//   2. INK FROM TOKENS. The three alphas are `--stage-ascii{,-near,-lift}`,
//      resolved at mount, with the constant below as the parachute — exactly
//      `readStageInk()`'s arrangement, and it reuses that module's parser so
//      there is one rgba() reader in the app.
//
//   3. QUIETER THAN THE SITE. The site's field is white on black at α.14→.30
//      and lifts to .85. This one is INK ON CREAM and sits behind live UI
//      rather than under a heading, so the whole ramp comes down: see
//      `ASCII_INK_FALLBACK`.
//
//   4. NOTHING IS FABRICATED. A cell the mark left empty stays empty however
//      close the pointer gets (`glyphAt`) — a cursor that grows characters
//      where the mark put none would be drawing its own picture. What the
//      pointer may do is brighten what is already there.

import {
  type AmbientCadence,
  type AmbientEnv,
  type Rgba,
  ambientCadence,
  parseRgba,
  shouldPaint,
} from "./ambient.ts";
import { GLYPH_ART } from "./glyph.ts";

// ── The ramp ──────────────────────────────────────────────────────

/** Ten steps of density. Index 0 is the empty cell and is never drawn. The
 *  middle dot is escaped so this file reads the same whatever encoding an
 *  editor or a terminal decides on. */
export const RAMP = " ·:-=+*#%@";
export const RAMP_LAST = RAMP.length - 1;

/** The grid. A 10px square cell at a 0.92em face is the site's measure, and it
 *  is a budget as much as a look: at 900×700 it is 6,300 cells, and every one
 *  of them is a `fillText` on the build pass. */
export const CELL = {
  /** css px, square */
  size: 10,
  /** face size as a fraction of the cell — a glyph at 0.92 of a square cell
   *  never reaches its neighbours' boxes, which is what lets a repaint clear
   *  and redraw exactly one cell. */
  glyphScale: 0.92,
  /** Device-pixel-ratio ceiling, matching the dot field's. */
  dprCap: 2,
} as const;

/** The pointer model (§ the site's `ASCII_*`, unchanged except the ceiling). */
export const POINTER = {
  /** px the pointer reaches */
  radius: 120,
  /** ms from fully lifted back to rest */
  relaxMs: 600,
  /** the frame-to-frame clamp: a tab that stalls for a second must not fall
   *  a second's worth of relaxation in one step. */
  maxStepMs: 100,
  /** lift at which a cell also steps one up the ramp */
  stepAt: 0.4,
  /** the smallest change in lift worth a repaint */
  eps: 0.015,
} as const;

/** The ambient drift: a couple of dozen cells held one ramp step brighter, the
 *  oldest handed back every time a new one is taken. Bounded by construction —
 *  the field can never brighten as it ages. */
export const DRIFT = {
  /** ms between promotions ⇒ ~4 cells/second */
  tickMs: 240,
  /** cells held up at any one moment */
  held: 24,
  /** attempts to find an occupied, undrifted cell before giving up for this
   *  tick. A miss is not worth a second pass — the next tick is 240ms away. */
  tries: 8,
} as const;

/** The composition (requirement: large, bleeding off ONE edge). The mark is
 *  sized against the SHORT side so it always fits vertically, and pushed right
 *  until roughly a quarter of it hangs off the right edge. */
export const COMPOSE = {
  /** mark size as a fraction of the grid's height. Large, but short of the
   *  full height: a mark that grazes the top and bottom edges is a mark that
   *  bleeds off three edges at the slightest change of aspect, and the
   *  composition is one edge. */
  ofHeight: 0.86,
  /** …clamped against the width, so a narrow box cannot bleed off both sides */
  ofWidth: 1.15,
  /** fraction of the mark hanging past the right edge */
  overhang: 0.28,
  /** centre, down the grid */
  centreY: 0.48,
  /** radians — the mark's own tilt, so it does not read as a stamp */
  tilt: -0.28,
} as const;

/** Gamma applied to the sampled luminance on the way in. The mark is mostly a
 *  thin ring, and a cell that catches only a fraction of it should still read
 *  as a character rather than falling to nothing. */
const SAMPLE_GAMMA = 0.7;

/** One cell in this many, hashed, carries the faintest character in the empty
 *  ground — so the band reads as a field with the mark emerging out of it,
 *  rather than as a logo sitting on cream. */
const FLOOR_EVERY = 5;

// ── Ink (§2.1: tokens are the declaration, this is the parachute) ──

export type AsciiInk = {
  /** the faintest character at rest */
  rest: Rgba;
  /** the densest character at rest */
  full: Rgba;
  /** directly under the pointer */
  lift: Rgba;
};

/** The `--stage-ascii*` values, hard-coded for when the tokens cannot be read
 *  (a detached canvas, a node test). CSS stays the source of truth.
 *
 *  These are INK ON CREAM and they sit behind live UI, so they are a long way
 *  under the site's white-on-black pair (.14 → .30, lifting to .85). The rest
 *  alpha is the one that matters for loudness: it is what the sparse floor is
 *  drawn at across the whole box, and at α.05 a 1.6px middle-dot in a 100px²
 *  cell every fifth cell lays down roughly a QUARTER of the ink the 3.2k-dot
 *  lattice it replaces does. The top of the ramp is louder than the dot field's
 *  brightest tier, but it is spent only where the mark actually is.
 *
 *  Keep in step with app.css or the first frame after a resume is wrong. */
export const ASCII_INK_FALLBACK: AsciiInk = {
  rest: { r: 35, g: 35, b: 35, a: 0.05 },
  full: { r: 35, g: 35, b: 35, a: 0.12 },
  lift: { r: 35, g: 35, b: 35, a: 0.35 },
};

/** Monospace fallback for when `--font-mono` cannot be read. Geist Mono is
 *  bundled and served from 'self', so this is a parachute, not a stack. */
export const MONO_FALLBACK =
  '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

/** The alpha a character is drawn at: up the ramp with its density, then
 *  toward the lift ceiling with how close the pointer is. */
export function alphaFor(glyph: number, lift: number, ink: AsciiInk): number {
  const g = Math.min(RAMP_LAST, Math.max(0, glyph));
  const l = Math.min(1, Math.max(0, lift));
  const rest = ink.rest.a + (ink.full.a - ink.rest.a) * (g / RAMP_LAST);
  return rest + (ink.lift.a - rest) * l;
}

/** The `rgba()` string for a cell. Alpha quantised to three places so a cell
 *  relaxing through a thousandth does not churn the fill style. */
export function fillFor(glyph: number, lift: number, ink: AsciiInk): string {
  const { r, g, b } = ink.rest;
  return `rgba(${r}, ${g}, ${b}, ${alphaFor(glyph, lift, ink).toFixed(3)})`;
}

// ── The pointer model ─────────────────────────────────────────────

/** How far a cell is lifted at this distance from the pointer: 1 under it, 0
 *  at and beyond the reach. Smoothstepped, so the edge of the reach is a
 *  falloff and not a rim. */
export function liftAt(distance: number): number {
  if (!(distance < POINTER.radius)) return 0;
  const t = 1 - Math.max(0, distance) / POINTER.radius;
  return t * t * (3 - 2 * t);
}

/** One frame of relaxation. Linear, so a cell is always back at rest within
 *  `relaxMs` of the pointer leaving it, whatever the frame rate: the decay is
 *  wall-clock, not per-frame. */
export function relax(lift: number, elapsedMs: number): number {
  const step =
    Math.min(POINTER.maxStepMs, Math.max(0, elapsedMs)) / POINTER.relaxMs;
  return lift > step ? lift - step : 0;
}

/** The character a cell shows: its own density, plus the drift's step, plus
 *  the pointer's — clamped to the top of the ramp.
 *
 *  An empty cell stays empty. That is the honesty law of this surface: the
 *  field is the mark, and nothing may add a character the mark did not put
 *  there. */
export function glyphAt(level: number, drifted: boolean, lift: number): number {
  if (!level) return 0;
  const g = level + (drifted ? 1 : 0) + (lift > POINTER.stepAt ? 1 : 0);
  return g > RAMP_LAST ? RAMP_LAST : g;
}

// ── The grid, the stencil and its composition ─────────────────────

export type AsciiGrid = { cols: number; rows: number; count: number };

/** Cells over a CSS-pixel box. Ceil, not floor: the grid covers the box even
 *  when the box is not a whole number of cells, because a strip of bare cream
 *  down one edge would read as a seam. */
export function gridFor(width: number, height: number): AsciiGrid {
  const cols = Math.max(0, Math.ceil(width / CELL.size));
  const rows = Math.max(0, Math.ceil(height / CELL.size));
  return { cols, rows, count: cols * rows };
}

export type Placement = {
  /** centre, in cells */
  x: number;
  y: number;
  /** side, in cells */
  size: number;
  /** radians */
  rotation: number;
};

/** Where the mark sits on the grid. Large, tilted, and running off the right
 *  edge — texture first, image second.
 *
 *  Returns a list because the composition is one placement's worth of policy
 *  and the caller should not have to know that; it is also what makes "bleeds
 *  off exactly one edge" a property a test can state over a range of boxes. */
export function markPlacements(cols: number, rows: number): Placement[] {
  if (cols <= 0 || rows <= 0) return [];
  const size = Math.min(rows * COMPOSE.ofHeight, cols * COMPOSE.ofWidth);
  return [
    {
      x: cols - size * COMPOSE.overhang,
      y: rows * COMPOSE.centreY,
      size,
      rotation: COMPOSE.tilt,
    },
  ];
}

/** A stable 2D hash. The sparse floor has to be the same field every time the
 *  grid is rebuilt, so it cannot come out of `Math.random`, and it has to be
 *  hashed on the cell rather than on its flat index or the pattern lands in
 *  diagonal stripes. */
export function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Luminance (0..1) → ramp index. Monotonic by construction: gamma is a
 *  monotonic curve and rounding preserves order. */
export function glyphForLuminance(luminance: number): number {
  const l = Math.min(1, Math.max(0, luminance));
  return Math.round(Math.pow(l, SAMPLE_GAMMA) * RAMP_LAST);
}

/** Rec.709 luminance of one sampled pixel, 0..1. */
export function luminanceOf(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The sparse floor: an empty cell, sometimes, becomes the faintest character.
 *  Deterministic in the cell, so a rebuild lands on the same field. */
export function floorGlyph(glyph: number, cx: number, cy: number): number {
  if (glyph !== 0) return glyph;
  return hash2(cx, cy) % FLOOR_EVERY === 0 ? 1 : 0;
}

/** The mark as an SVG data URI at an explicit pixel size.
 *
 *  Explicit width/height matter: the art carries a viewBox and no intrinsic
 *  size, which is right for CSS and wrong for a canvas — an engine that sizes
 *  such an image once, at the 150px default, hands back a blurred stamp to
 *  sample. A data URI also costs no request and taints no canvas, so the
 *  sample reads back and the field adds nothing to the network.
 *
 *  `#fff` and `#000` here are not brand values and are never seen: this is a
 *  luminance stencil, and they are its two ends. The field's actual colour is
 *  the token ink above. */
export const STENCIL_BG = "#000000";

export function markSvgDataUri(px: number): string {
  const paths = GLYPH_ART.paths.map((d) => `<path d="${d}"/>`).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${GLYPH_ART.viewBox}"` +
    ` width="${px}" height="${px}" fill="#ffffff">` +
    `<g transform="${GLYPH_ART.transform}">${paths}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ── The power law, minus the rAF (§3) ─────────────────────────────

/** What the stage does in a cadence: whether to render at all, and whether to
 *  hold a loop open. One row of §3's table, as a value.
 *
 *  `render && !loop` is the reduced-motion tier — the texture is there, it
 *  simply never moves again. `!render` is the hidden tier, and it is a real
 *  suspension: nothing is painted into a webview that is not compositing. */
export function stageAction(cadence: AmbientCadence): {
  render: boolean;
  loop: boolean;
} {
  return { render: cadence.paints, loop: cadence.animating && cadence.paints };
}

/** The plumbing the runner needs, injected so the whole power law can be
 *  driven by a fake clock in a node test. */
export type StageIO = {
  now(): number;
  /** Read the live window state — `readAmbientEnv` in the app. */
  env(): AmbientEnv;
  /** Re-measure the box and rebuild if it moved. Called BEFORE the first
   *  render of every resume: a hidden webview delivers neither rAF nor
   *  ResizeObserver, so a size cached across a hide describes a window that
   *  may no longer exist (DESIGN.md §3). */
  measure(): void;
  /** Draw the whole grid at rest. */
  render(): void;
  /** Advance one frame: relax, lift, repaint what changed, drift. */
  step(elapsedMs: number, now: number): void;
  schedule(fn: (now: number) => void): number;
  cancel(handle: number): void;
};

export type StageRunner = {
  /** True exactly while a rAF handle is outstanding. The provable half of
   *  "hidden means stopped". */
  running(): boolean;
  /** Read the environment and apply its tier. Idempotent, and the only way in:
   *  every visibility, focus, reduced-motion and readiness change calls this. */
  sync(): void;
  /** Tear down. */
  stop(): void;
};

/** The stage's governor. Mirrors `DotField`'s `sync()`/`loop()`/`stop()` exactly
 *  — measure, then render, then decide whether to loop, in that order — with
 *  the rAF behind `StageIO` so the transitions are testable. */
export function createStageRunner(io: StageIO): StageRunner {
  let handle: number | null = null;
  let cadence = ambientCadence(io.env());
  let last = 0;

  function stop() {
    if (handle !== null) {
      io.cancel(handle);
      handle = null;
    }
  }

  function loop(now: number) {
    handle = io.schedule(loop);
    const elapsed = last ? now - last : 16;
    if (!shouldPaint(elapsed, cadence)) return;
    last = now;
    io.step(elapsed, now);
  }

  function sync() {
    cadence = ambientCadence(io.env());
    const action = stageAction(cadence);
    if (!action.render) {
      stop();
      return;
    }
    io.measure();
    io.render();
    if (!action.loop) {
      stop();
      return;
    }
    // A resume starts its clock here, not at the last frame before the hide:
    // the gap is not elapsed animation time, it is time the stage did not exist.
    last = io.now();
    if (handle === null) handle = io.schedule(loop);
  }

  return { running: () => handle !== null, sync, stop };
}

// ── DOM adapters (the only impure exports) ────────────────────────

/** Read the field's ink from the house tokens (§2.1). */
export function readAsciiInk(): AsciiInk {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { ...ASCII_INK_FALLBACK };
  }
  const style = window.getComputedStyle(document.documentElement);
  const token = (name: string, fallback: Rgba) =>
    parseRgba(style.getPropertyValue(name)) ?? fallback;
  return {
    rest: token("--stage-ascii", ASCII_INK_FALLBACK.rest),
    full: token("--stage-ascii-near", ASCII_INK_FALLBACK.full),
    lift: token("--stage-ascii-lift", ASCII_INK_FALLBACK.lift),
  };
}

/** The face the grid is set in, off `--font-mono`. The grid is measured in
 *  cells, not in glyph metrics, so a fallback face is not fatal here — but it
 *  is the wrong texture, which is why the component waits for the real one. */
export function readMonoFace(): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return MONO_FALLBACK;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return value || MONO_FALLBACK;
}

/** `ctx.font` for the cell size. */
export function cellFont(face: string): string {
  return `${Math.round(CELL.size * CELL.glyphScale)}px ${face}`;
}
