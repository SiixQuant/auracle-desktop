// motion.ts — the launcher's one motion engine.
//
// Design authority: launcher-redesign-direction.md §2.4 ("Motion language").
// Slice 2 of the redesign. One engine: GSAP. The React animation library it
// replaces is deleted from the tree, and a grep guard in motion.test.ts keeps
// it out. CSS transitions survive ONLY for hover/focus micro-states
// (≤ DUR.micro, eased out) — everything that moves on a state change comes
// through here.
//
// Three rules this module exists to enforce:
//
//   1. ONE VOCABULARY. Components import EASE / DUR / STAGGER from here and
//      never hand-roll a curve or a magic millisecond. The house curves are
//      registered as named eases (`aur-enter` / `aur-exit` / `aur-mech`), so
//      `ease: EASE.enter` works in any raw gsap call too.
//
//   2. HONESTY AS MOTION (§2.4). Numbers and counts never tween — a tweened
//      number is a small lie — so this module deliberately ships NO
//      number/count/percentage tween helper, and never will. Status hues
//      never crossfade through in-between colors either: they snap at the
//      trough of a short opacity dip (`snapStatus`).
//
//   3. REDUCED MOTION IS A KILL SWITCH, NOT A SKIP. Every duration, delay and
//      stagger passes through `motionTime`, which returns 0 when the OS asks
//      for less motion. Zero-duration tweens still RUN — they land on their
//      end state in one tick and still fire onComplete — so an entrance can
//      never strand content at opacity 0 and no mount/unmount logic gated on
//      a completion callback can hang.
//
// GSAP ships under the GreenSock standard "no charge" license: free for use
// inside a commercial product like this one. @gsap/react rides the same
// license. Neither is redistributed as a tool.

import { useSyncExternalStore } from "react";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { SplitText } from "gsap/SplitText";

// Relative, with the extension: this module is imported by `node --test`,
// which resolves neither Vite's `@/` alias nor extensionless specifiers.
import { readAmbientEnv, tickerPower, watchAmbientEnv } from "./ambient.ts";

// useGSAP() is the only sanctioned way to create tweens from a component:
// it scopes them to a gsap.context and reverts on unmount, which is what
// keeps React 18 StrictMode's double-mounted effects from double-registering
// (redesign doc, Risk 5). Registering it also protects it from tree-shaking.
//
// SplitText joins it for the verdict line (§2.4, §3.3 Band 2). It is registered
// HERE rather than at the one call site for the same reason the eases are: a
// plugin is a process-wide singleton, and the module that owns the vocabulary
// owns the registration. What it is allowed to do is narrow — see revealWords.
gsap.registerPlugin(useGSAP, SplitText);

// ── The vocabulary ────────────────────────────────────────────────

/** House curves (§2.4). Registered once, below, as named GSAP eases.
 *
 *  Never bounce, elastic, or overshoot — this is an instrument, not a toy. */
export const EASE = {
  /** power4.out — entrances, 200–450ms. */
  enter: "aur-enter",
  /** power2.in — exits, 120–180ms. */
  exit: "aur-exit",
  /** power2.inOut — mechanical moves (tray, orbit spin-up/down), 240–400ms. */
  mech: "aur-mech",
} as const;

/** House durations, in seconds (GSAP's native unit). Every value traces to a
 *  line in §2.4 / §3 — add one only when the design doc names a new beat. */
export const DUR = {
  /** 120ms · the honest snap: the opacity dip a status hue changes inside of,
   *  and the outgoing verdict line. */
  snap: 0.12,
  /** 150ms · the ceiling for CSS hover/focus micro-states. Motion above this
   *  belongs to GSAP, not to a `transition:` declaration. */
  micro: 0.15,
  /** 180ms · exits — tray close, palette open/close. */
  exit: 0.18,
  /** 200ms · scrim fade to α.55. */
  scrim: 0.2,
  /** 240ms · the default entrance, and the tray's mechanical slide. */
  enter: 0.24,
  /** 320ms · a verdict line change. */
  verdict: 0.32,
  /** 400ms · the long entrance, and the orbit's spin-up/spin-down timeScale
   *  tween (top of both the enter and mech bands). */
  long: 0.4,
  /** 500ms · the one-shot underline sweep when an update appears. Never loops. */
  sweep: 0.5,
  /** 800ms · the absolute ceiling, and the only thing allowed to reach it: the
   *  once-per-machine commissioning ceremony (§3.2). */
  ceremony: 0.8,
} as const;

/** Stagger steps, in seconds. */
export const STAGGER = {
  /** 30ms · per-word stagger on a verdict / display line change. */
  word: 0.03,
} as const;

/** The hard ceiling from §2.4: nothing animates for longer than 800ms. Every
 *  helper clamps to this, so the law holds even if a call site asks for more. */
export const MAX_DURATION = DUR.ceremony;

gsap.registerEase(EASE.enter, gsap.parseEase("power4.out"));
gsap.registerEase(EASE.exit, gsap.parseEase("power2.in"));
gsap.registerEase(EASE.mech, gsap.parseEase("power2.inOut"));

// ── Ticker power management (§4 tiering) ──────────────────────────

/** Hold the ticker to the tier the window is in: asleep while the document is
 *  hidden, 30fps while the window is merely blurred, 60fps when it is focused.
 *  The launcher lives in the menu bar and is hidden most of its life, so an
 *  awake ticker there is a battery leak with nothing to show for it.
 *
 *  Deferred out of the motion slice for want of a place to hang the resume
 *  logic; it lands here, sharing one power law with the ambient stage
 *  (`fx/ambient.ts`) so the two can never disagree about what "hidden" means.
 *
 *  Installed once at import — the ticker is a process-wide singleton, exactly
 *  like the eases registered above, so its governor is too. Returns the
 *  uninstaller for tests and for a hot-reload teardown. */
export function governTicker(): () => void {
  if (typeof document === "undefined") return () => {};
  const apply = () => {
    const power = tickerPower(readAmbientEnv());
    if (power.sleeping) {
      gsap.ticker.sleep();
      return;
    }
    gsap.ticker.fps(power.fps);
    gsap.ticker.wake();
  };
  apply();
  return watchAmbientEnv(apply);
}

governTicker();

// ── Reduced motion ────────────────────────────────────────────────

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// `undefined` = not resolved yet, `null` = no matchMedia (SSR / node tests).
let mql: MediaQueryList | null | undefined;

function reducedMotionQuery(): MediaQueryList | null {
  if (mql === undefined) {
    mql =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(REDUCED_MOTION_QUERY)
        : null;
  }
  return mql;
}

/** The live OS preference. Read at call time, never cached into a module
 *  constant — users flip this mid-session and the instrument must obey. */
export function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches ?? false;
}

/** Subscribe to preference flips. Returns the unsubscribe. */
export function onReducedMotionChange(fn: () => void): () => void {
  const q = reducedMotionQuery();
  if (!q) return () => {};
  q.addEventListener("change", fn);
  return () => q.removeEventListener("change", fn);
}

/** React binding for the same preference, for the branches motion helpers
 *  can't express: the orbit freezing at a deterministic angle, the dot-field
 *  rendering one static frame, a SplitText line degrading to a plain opacity
 *  swap (§2.4). Prefer `motionTime` when all you need is "shorter or none". */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    onReducedMotionChange,
    prefersReducedMotion,
    // Server/prerender snapshot: assume motion is fine, then correct on mount.
    () => false,
  );
}

/** Pure core of the kill switch: fold a requested time through the house
 *  ceiling and the reduced-motion preference. Negative times are not a thing. */
export function resolveMotionTime(seconds: number, reduced: boolean): number {
  if (reduced) return 0;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, MAX_DURATION);
}

/** The gate every duration / delay / stagger in the app passes through.
 *  Returns 0 under `prefers-reduced-motion: reduce` — tweens then land on
 *  their end state immediately instead of being skipped. */
export function motionTime(seconds: number): number {
  return resolveMotionTime(seconds, prefersReducedMotion());
}

// ── The three moves ───────────────────────────────────────────────

type Vars = gsap.TweenVars;

/** Run a caller's vars through the kill switch + the house ceiling. Times are
 *  plain numbers in this vocabulary; GSAP's function-based durations/delays are
 *  not house language, so anything else falls back to the default beat rather
 *  than sneaking past the gate. */
function houseVars(defaults: Vars, vars: Vars): Vars {
  const merged: Vars = { ...defaults, ...vars };
  merged.duration = motionTime(
    typeof merged.duration === "number" ? merged.duration : DUR.enter,
  );
  if (merged.delay != null) {
    merged.delay = motionTime(
      typeof merged.delay === "number" ? merged.delay : 0,
    );
  }
  if (typeof merged.stagger === "number") {
    merged.stagger = motionTime(merged.stagger);
  }
  return merged;
}

/** An entrance: animates FROM the hidden state to whatever the element already
 *  is, so nothing can be stranded invisible if the tween never runs. Defaults
 *  to a plain opacity lift on the house enter curve; pass `y`/`x`/`scale` for
 *  the shift, and a `DUR.*` for anything other than the 240ms default. */
export function enter(
  targets: gsap.TweenTarget,
  vars: Vars = {},
): gsap.core.Tween {
  return gsap.from(
    targets,
    houseVars({ opacity: 0, duration: DUR.enter, ease: EASE.enter }, vars),
  );
}

/** An exit. Short and in — 120–180ms (§2.4). Gate any unmount on `onComplete`;
 *  it still fires under reduced motion (duration collapses to 0, not to
 *  "never runs"). */
export function exit(
  targets: gsap.TweenTarget,
  vars: Vars = {},
): gsap.core.Tween {
  return gsap.to(
    targets,
    houseVars({ opacity: 0, duration: DUR.exit, ease: EASE.exit }, vars),
  );
}

/** A mechanical move — the tray sliding, the orbit changing tempo. Reads as a
 *  mechanism repositioning, which is why it's inOut and not an entrance. */
export function mech(
  targets: gsap.TweenTarget,
  vars: Vars = {},
): gsap.core.Tween {
  return gsap.to(
    targets,
    houseVars({ duration: DUR.enter, ease: EASE.mech }, vars),
  );
}

/** Change a status color HONESTLY (§2.4): hues never crossfade through
 *  in-between colors, because a half-amber dot is a state the machine was
 *  never in. The element dips out, `apply` swaps the hue at the trough, and it
 *  comes back — 120ms end to end.
 *
 *  `apply` runs exactly once, and still runs under reduced motion. */
export function snapStatus(
  target: gsap.TweenTarget,
  apply: () => void,
): gsap.core.Timeline {
  const half = motionTime(DUR.snap / 2);
  return gsap
    .timeline()
    .to(target, { opacity: 0, duration: half, ease: EASE.exit })
    .add(apply)
    .to(target, { opacity: 1, duration: half, ease: EASE.enter });
}

/** The verdict entrance (§2.4, §3.3 Band 2): a display line arrives word by
 *  word — y 8→0, opacity 0→1, 30ms apart, 320ms on the house enter curve.
 *
 *  THE HONESTY LAW, AS A HELPER. A verdict may animate as ceremony, but its
 *  CONTENT is truth: this reveals the words the element already holds, and can
 *  do nothing else. No scramble, no decrypt, no typewriter, no split-flap —
 *  every one of those spells words the machine never said, and the one sentence
 *  on this screen may not be wrong even for 200ms (§4 excludes that whole
 *  family from the quarry for exactly this reason; a grep guard in the tests
 *  keeps their plugins out of the tree).
 *
 *  Splitting rewrites the element's markup, so the caller must hand the
 *  returned function to `useGSAP`'s cleanup — it kills the tween and restores
 *  the element to its own text. `aria: "auto"` (SplitText's default, stated
 *  here because it is load-bearing) mirrors the line into an `aria-label` and
 *  hides the word pieces, so assistive tech still reads one sentence.
 *
 *  Under reduced motion every time collapses to zero: the words are still
 *  split and the tween still runs, it simply lands complete on its first tick. */
export function revealWords(target: HTMLElement, vars: Vars = {}): () => void {
  const split = SplitText.create(target, { type: "words", aria: "auto" });
  const tween = gsap.from(
    split.words,
    houseVars(
      {
        y: 8,
        opacity: 0,
        duration: DUR.verdict,
        ease: EASE.enter,
        stagger: STAGGER.word,
      },
      vars,
    ),
  );
  return () => {
    tween.kill();
    split.revert();
  };
}

// NOTE — there is deliberately no `countTo` / `tweenNumber` / `progressTo`
// helper here, and there must never be one. Numbers, counts, countdowns and
// percentages SNAP (§2.4): a lifecycle count that rolls up to its value, or an
// install bar that trickles ahead of real `installer-progress` events, is a
// small lie about what the machine knows. Render the value; let it change.

export { SplitText, gsap, useGSAP };
