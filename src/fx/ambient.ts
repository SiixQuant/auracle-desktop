// ambient.ts — the ambient stage's power law, geometry and ink ramp.
//
// Design authority: launcher-redesign-direction.md §2.1 (the `--stage-dot`
// token), §2.4 (reduced motion), §4 ("Performance budget") and Risk 2/3.
// Slice 3 of the redesign.
//
// This module is the PURE half of the ambient stage: it decides *whether and
// how often* the field may paint, *how dense* it is, and *how bright* each dot
// is — without touching a canvas. `DotField.tsx` is the imperative half and
// owns nothing but the canvas plumbing. The split exists so the perf gates the
// budget is held to are assertable in a plain node test (`ambient.test.ts`)
// instead of being a claim in a comment.
//
// The three laws it encodes:
//
//   1. HIDDEN MEANS STOPPED. `document.hidden` (minimised, or a tray-resident
//      window with no visible surface) suspends everything — no rAF, no
//      timers. A launcher that lives in the menu bar spends most of its life
//      here, so this is the single biggest battery lever in the app.
//
//   2. BLURRED MEANS HALF TEMPO. A visible-but-unfocused window drops to 30fps
//      (§4 tiering). The user is working somewhere else; the ambient is
//      texture, not information.
//
//   3. REDUCED MOTION MEANS ONE FRAME. Not "a slower field" and not "no
//      field": the texture still renders, it just never moves again (§2.4),
//      so the rAF loop is never started at all.

// ── Geometry (§4 budget, Risk 3) ──────────────────────────────────

/** The field's fixed geometry. Deliberately NOT props: the dot count is a
 *  performance budget the design doc holds the PR to (≈3k dots at 900×700,
 *  ≈1.3k at the 600×500 minimum), and a caller that could widen the spacing
 *  could also blow the budget. `ambient.test.ts` asserts both counts. */
export const FIELD = {
  /** px between dot centres. 14 ⇒ one dot per ~196px² ⇒ the budgeted counts. */
  step: 14,
  /** Drawn radius in CSS px. Sub-pixel dots wash out to nothing once the ink
   *  is at α.05, so the dot is kept just over 1px — whisper, but present. */
  dotRadius: 1.1,
  /** Dots within this radius of the focus point carry the brightened ink
   *  (§2.1: "brightens to 0.09 within 240px of the instrument center"). */
  focusRadius: 240,
  /** Quantised steps across the base→near ramp. Precomputed per dot at build
   *  time and drawn as one batched path per tier, so the whole field costs a
   *  handful of `fill()` calls rather than one per dot — and the ramp reads as
   *  a soft falloff rather than a hard 240px circle. */
  tiers: 6,
  /** Device-pixel-ratio ceiling. A retina backing store is worth it; a 3x one
   *  is 2.25× the fill cost for texture nobody can see. */
  dprCap: 2,
} as const;

/** The drift (§2.4 — the field is the one loop animation on the sign-in
 *  screen). A slow standing wave, amplitude well under the dot spacing, so it
 *  reads as the field breathing rather than as anything moving. */
export const DRIFT = {
  /** radians/second — matched to the vendored source's 60fps frame counter,
   *  but driven by wall-clock so the tempo is identical at 30fps. */
  rate: 1.2,
  /** spatial frequency (radians per px of anchor position) */
  freq: 0.03,
  /** px of vertical travel (horizontal is half this) */
  amplitude: 1.2,
} as const;

/** Frame rates for the two live tiers (§4). */
export const TARGET_FPS = { focused: 60, blurred: 30 } as const;

/** Tolerance subtracted from every frame gate. Without it a 60fps gate of
 *  16.667ms rejects a 16.6ms vsync frame and the field silently runs at 30fps;
 *  with it, a 120Hz ProMotion panel still gets clamped to 60. */
const FRAME_TOLERANCE_MS = 1;

/** Minimum ms between painted frames for a target rate. */
export function frameGate(fps: number): number {
  return Math.max(0, 1000 / fps - FRAME_TOLERANCE_MS);
}

// ── The power law (§4 tiering) ────────────────────────────────────

export type AmbientEnv = {
  /** `document.hidden` — minimised, occluded, or hidden to the tray. */
  hidden: boolean;
  /** The window owns keyboard focus. */
  focused: boolean;
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
};

export type AmbientCadence = {
  /** Run the rAF loop at all. False ⇒ paint one frame and stop. */
  animating: boolean;
  /** Minimum ms between painted frames. `Infinity` when suspended. */
  minFrameMs: number;
  /** Apply the drift wave. False ⇒ dots sit on their anchors. */
  drift: boolean;
  /** Paint at least one frame in this state (false only when hidden — a
   *  hidden webview delivers no rAF and painting into it is pure waste). */
  paints: boolean;
};

const SUSPENDED: AmbientCadence = {
  animating: false,
  minFrameMs: Number.POSITIVE_INFINITY,
  drift: false,
  paints: false,
};

const STATIC: AmbientCadence = {
  animating: false,
  minFrameMs: Number.POSITIVE_INFINITY,
  drift: false,
  paints: true,
};

/** The whole tiering table from §4, as one pure function.
 *
 *  hidden → nothing · reduced-motion → one static frame ·
 *  visible+blurred → 30fps · visible+focused → 60fps. */
export function ambientCadence(env: AmbientEnv): AmbientCadence {
  if (env.hidden) return SUSPENDED;
  if (env.reducedMotion) return STATIC;
  return {
    animating: true,
    minFrameMs: frameGate(
      env.focused ? TARGET_FPS.focused : TARGET_FPS.blurred,
    ),
    drift: true,
    paints: true,
  };
}

/** The frame-skip test the rAF loop runs. Kept here so the 30fps tier is a
 *  tested arithmetic fact rather than an inline `if` nobody can see. */
export function shouldPaint(
  sinceLastPaintMs: number,
  cadence: AmbientCadence,
): boolean {
  if (!cadence.paints) return false;
  return sinceLastPaintMs >= cadence.minFrameMs;
}

/** The GSAP ticker's half of the same tiering (§4: "gsap ticker slept").
 *
 *  Deliberately blind to `reducedMotion`: the motion engine collapses reduced
 *  motion to zero-duration tweens, and a zero-duration tween still needs one
 *  tick to land on its end state. Sleeping the ticker there would strand every
 *  entrance mid-flight — the exact bug the kill switch was written to avoid. */
export function tickerPower(env: Pick<AmbientEnv, "hidden" | "focused">): {
  sleeping: boolean;
  fps: number;
} {
  if (env.hidden) return { sleeping: true, fps: TARGET_FPS.blurred };
  return {
    sleeping: false,
    fps: env.focused ? TARGET_FPS.focused : TARGET_FPS.blurred,
  };
}

// ── The ink ramp (§2.1) ───────────────────────────────────────────

export type Rgba = { r: number; g: number; b: number; a: number };

/** The `--stage-dot` / `--stage-dot-near` values, hard-coded as the fallback
 *  for when the tokens can't be read (a detached canvas, a node test). CSS
 *  stays the source of truth; this is the parachute. */
export const STAGE_INK_FALLBACK = {
  base: { r: 230, g: 237, b: 243, a: 0.05 },
  near: { r: 230, g: 237, b: 243, a: 0.09 },
} as const;

const RGBA = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i;

/** Parse `rgb()` / `rgba()` (comma or space separated). Returns null on
 *  anything else — the caller falls back rather than drawing garbage. */
export function parseRgba(text: string): Rgba | null {
  const m = RGBA.exec(text.trim());
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map(Number);
  if (![r, g, b].every(Number.isFinite)) return null;
  let a = 1;
  if (m[4] != null) {
    a = m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    if (!Number.isFinite(a)) return null;
  }
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

/** Smoothstep falloff: 1 at the focus point, 0 at (and beyond) `focusRadius`.
 *  Smooth rather than linear so the brightened core has no visible edge. */
export function focusWeight(distance: number): number {
  const t = 1 - Math.min(1, Math.max(0, distance / FIELD.focusRadius));
  return t * t * (3 - 2 * t);
}

/** Which precomputed ink tier a dot at this distance belongs to. */
export function tierAt(distance: number): number {
  return Math.round(focusWeight(distance) * (FIELD.tiers - 1));
}

/** The tier → `rgba(...)` strings the canvas fills with, ramped from the base
 *  ink to the near-the-instrument ink. Tier 0 is the far field. */
export function inkRamp(base: Rgba, near: Rgba): string[] {
  const last = FIELD.tiers - 1;
  return Array.from({ length: FIELD.tiers }, (_, i) => {
    const t = last === 0 ? 1 : i / last;
    const mix = (from: number, to: number) => from + (to - from) * t;
    const ch = (from: number, to: number) => Math.round(mix(from, to));
    return `rgba(${ch(base.r, near.r)}, ${ch(base.g, near.g)}, ${ch(
      base.b,
      near.b,
    )}, ${Number(mix(base.a, near.a).toFixed(4))})`;
  });
}

// ── Grid (Risk 3: the dot count IS the budget) ────────────────────

export type GridSpec = {
  cols: number;
  rows: number;
  padX: number;
  padY: number;
  count: number;
};

/** Lay a centred lattice over a CSS-pixel box. */
export function gridSpec(width: number, height: number): GridSpec {
  const step = FIELD.step;
  const cols = Math.max(0, Math.floor(width / step));
  const rows = Math.max(0, Math.floor(height / step));
  return {
    cols,
    rows,
    padX: (width - cols * step) / 2,
    padY: (height - rows * step) / 2,
    count: cols * rows,
  };
}

// ── DOM adapters (the only impure exports) ────────────────────────

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Read the live environment. Off-DOM this reports the safest state: visible,
 *  focused, motion allowed — a caller with no document isn't painting anyway. */
export function readAmbientEnv(): AmbientEnv {
  if (typeof document === "undefined") {
    return { hidden: false, focused: true, reducedMotion: false };
  }
  return {
    hidden: document.hidden,
    // A window that has never been focused still deserves the full frame rate;
    // `hasFocus` only goes false once something else has taken it.
    focused: document.hasFocus(),
    reducedMotion:
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(REDUCED_MOTION_QUERY).matches
        : false,
  };
}

/** Subscribe to every input of `readAmbientEnv`. Returns the unsubscribe.
 *
 *  DOM `focus`/`blur` on the window are the Tauri window's focus events as the
 *  webview sees them, so no Tauri import is needed here — which also keeps the
 *  stage working unchanged in `npm run dev` in a plain browser. */
export function watchAmbientEnv(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  const mql =
    typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  mql?.addEventListener("change", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    mql?.removeEventListener("change", onChange);
  };
}

/** Read the ambient ink from the house tokens (§2.1). The tokens are the one
 *  place the hue is declared; this resolves them once per mount. */
export function readStageInk(): { base: Rgba; near: Rgba } {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { ...STAGE_INK_FALLBACK };
  }
  const style = window.getComputedStyle(document.documentElement);
  const token = (name: string, fallback: Rgba) =>
    parseRgba(style.getPropertyValue(name)) ?? fallback;
  return {
    base: token("--stage-dot", STAGE_INK_FALLBACK.base),
    near: token("--stage-dot-near", STAGE_INK_FALLBACK.near),
  };
}
