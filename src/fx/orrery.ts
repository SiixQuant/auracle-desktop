// orrery.ts — the instrument's geometry and its state→instrument mapping.
//
// Design authority: launcher-redesign-direction.md §1 (the concept), §2.5 (the
// orbital mark), §3.3 ("Band 1 — The Instrument", the exact state map) and
// Risk 8 ("instrument honesty drift"). Slice 4 of the redesign.
//
// This is the PURE half of the orrery, the same split slice 3 used for the
// ambient stage: this module decides *what the instrument shows* and *where
// its parts sit*, without touching the DOM, GSAP or React. `Orrery.tsx` is the
// imperative half and owns nothing but SVG nodes and tweens. The split exists
// so Risk 8 is a test rather than a promise — every aggregator state maps to a
// defined instrument state here, in a plain node test, with no renderer.
//
// The three laws it encodes:
//
//   1. THE INSTRUMENT NEVER FABRICATES A MACHINE. Bodies come only from real
//      containers reported by `stackStatus()`. An unknown or empty list does
//      not become "a couple of dots so it looks alive" — it falls back to the
//      brand mark's own two chrome dots, which are part of the ring drawing
//      and carry no data at all (§3.3). A count is never rendered anywhere, so
//      the 12-body ceiling truncates the *drawing*, never the truth: the
//      surplus is reported as `overflow` for tests to hold.
//
//   2. MOTION IS AMBIENCE, DATA IS INK. A body's angle is decorative — it is
//      seeded deterministically and then just turns — so nothing about where a
//      body sits on the ring may be read as a measurement. What a body *means*
//      lives in its ink (neutral / amber / red, straight off the container's
//      own state) and in its mono flag, which quotes the container's own
//      words. The revolution is a 60s horological drift: present, sub-
//      perceptual, and identical whatever the stack is doing.
//
//   3. THE RESTING STATE IS THE MARK. Core plus two chrome dots reproduces
//      `AuracleGlyph` — same two directions out of the centre, same relative
//      depth inside the ring, same size ratio between the dots (see MARK).
//      Opening the launcher on a stopped machine shows the logo, at rest.

import type { ActuatorAction, BoardState } from "../lib/aggregator.ts";
import type { ContainerStatus } from "../lib/tauri.ts";

// ── The state map (§3.3) ──────────────────────────────────────────

/** The aggregator's real ladder, as the instrument's own states. One per row
 *  of §3.3; nothing else is a valid instrument state. */
export type OrreryPhase =
  | "checking"
  | "starting"
  | "ready"
  | "needsSetup"
  | "degraded"
  | "down";

/** Which hue the CORE carries. The core is the only part of the instrument
 *  that is ever chromatic — the ring is chrome and the bodies are ink (§2.1
 *  accent discipline). `ready` is the calm 70%-blue (`--accent-text`); `accent`
 *  is full Nous-blue for "alive, but not a health verdict". */
export type CoreTone = "checking" | "accent" | "ready" | "warn" | "err";

/** How the ring draws. `seam` is the needsSetup tell (one dashed arc segment —
 *  the unfinished seam); `dashed` is the down tell (a stopped watch). */
export type RingStyle = "dim" | "chrome" | "seam" | "dashed";

/** Body ink. Neutral by default; only a container's OWN reported state can
 *  make it amber or red. */
export type BodyTone = "body" | "warn" | "err";

/** The core's breath while the machine is in flight. Amplitude is the §3.3
 *  4%-opacity swing; the period is what changes between checking and starting
 *  (4s vs 1.2s), which is the whole point — you can hear the tempo change. */
export interface Breath {
  /** Seconds for a full in-out cycle. */
  period: number;
  /** How far the core dips, as opacity. */
  opacityDelta: number;
}

export interface OrreryBody {
  /** The container's name — stable identity for its SVG node and its tween,
   *  so a body that is already riding never restarts when the list changes. */
  id: string;
  name: string;
  tone: BodyTone;
  /** The mono flag shown on hover, e.g. `houston · healthy`. Both halves are
   *  the container's own words; nothing here is composed by the instrument. */
  flag: string;
  /** Where this body is SEEDED on the ring, as path progress [0,1). Not a
   *  live position and not a reading: once a body is riding, its angle is
   *  ambience (law 2). Deterministic so reduced motion has a defined frame. */
  seed: number;
  /** Tempo multiplier. 1 = on the beat; OFF_TEMPO = visibly off-beat, which
   *  is how a degraded service reads before a single word is (§3.3). */
  tempo: number;
}

export interface OrreryFrame {
  phase: OrreryPhase;
  core: CoreTone;
  /** null when the core is calm. */
  breath: Breath | null;
  ring: RingStyle;
  /** Nominal seconds per revolution — always REVOLUTION_SECONDS. Whether the
   *  mechanism is actually turning is `running`, because a mechanism that has
   *  stopped still has a period; it just isn't using it. */
  revolution: number;
  /** False ⇒ spin down to a stop (and stay stopped). */
  running: boolean;
  /** Real containers, at most MAX_BODIES of them. */
  bodies: OrreryBody[];
  /** Render the mark's two chrome dots instead — true exactly when there are
   *  no real bodies to show. */
  chrome: boolean;
  /** Real containers the ring had no room for. The instrument renders no
   *  counts, so this exists to be asserted, never displayed. */
  overflow: number;
}

/** §2.4: "Orbit revolution (continuous, 60s/rev)". Horological, sub-perceptual
 *  — you cannot watch it move, only notice later that it has. */
export const REVOLUTION_SECONDS = 60;

/** §3.3: a degraded body rides at 0.9× and reads as visibly off-beat. */
export const OFF_TEMPO = 0.9;

/** §4 performance budget: "transform-only SVG animation on ≤ 12 nodes". */
export const MAX_BODIES = 12;

/** Where an unrecognised state lands. "checking" is the only honest fallback:
 *  it claims nothing — no health, no bodies, no motion — which is exactly what
 *  we know about a state we don't recognise. Never `ready`. */
export const FALLBACK_PHASE: OrreryPhase = "checking";

/** The aggregator's verb → the instrument's state. Typed as an exhaustive
 *  Record so that adding an ActuatorAction upstream fails the build here
 *  rather than silently falling through to the fallback at runtime. */
const PHASE_BY_ACTION: Record<ActuatorAction, OrreryPhase> = {
  checking: "checking",
  starting: "starting",
  start: "down",
  degraded: "degraded",
  setup: "needsSetup",
  launch: "ready",
};

/** Map the board's one verb onto the instrument. The verb is used rather than
 *  the lamp tone because it is 1:1 with the aggregator's ladder (two states
 *  share the `accent` lamp), and because it needs no edit to `aggregator.ts` —
 *  this slice re-skins truth, it does not re-derive it. */
export function orreryPhase(action: string): OrreryPhase {
  return PHASE_BY_ACTION[action as ActuatorAction] ?? FALLBACK_PHASE;
}

const CORE_BY_PHASE: Record<OrreryPhase, CoreTone> = {
  checking: "checking",
  starting: "accent",
  ready: "ready",
  needsSetup: "accent",
  degraded: "warn",
  down: "err",
};

const RING_BY_PHASE: Record<OrreryPhase, RingStyle> = {
  checking: "dim",
  starting: "chrome",
  ready: "chrome",
  needsSetup: "seam",
  degraded: "chrome",
  down: "dashed",
};

const BREATH_BY_PHASE: Record<OrreryPhase, Breath | null> = {
  checking: { period: 4, opacityDelta: 0.04 },
  starting: { period: 1.2, opacityDelta: 0.04 },
  ready: null,
  needsSetup: null,
  degraded: null,
  down: null,
};

/** Phases that show real bodies at all. `checking` has nothing to show yet and
 *  `down` is a stopped mechanism — in both, the mark's chrome dots stand in. */
const BODIES_BY_PHASE: Record<OrreryPhase, boolean> = {
  checking: false,
  starting: true,
  ready: true,
  needsSetup: true,
  degraded: true,
  down: false,
};

/** Phases in which the mechanism turns. */
const RUNNING_BY_PHASE: Record<OrreryPhase, boolean> = {
  checking: false,
  starting: true,
  ready: true,
  needsSetup: true,
  degraded: true,
  down: false,
};

// ── Bodies (Risk 8: the four body rules) ──────────────────────────

/** A container's ink, from its own reported state. Docker's vocabulary, not
 *  ours: `exited`/`dead`/`removing` are red, an unhealthy or non-running
 *  container is amber, everything else is neutral ink. Nothing here upgrades a
 *  container to healthy — an unknown state stays neutral, it never goes green,
 *  because the instrument has no green. */
export function containerTone(c: ContainerStatus): BodyTone {
  const state = (c.state ?? "").toLowerCase();
  const health = (c.health ?? "").toLowerCase();
  if (state === "exited" || state === "dead" || state === "removing") return "err";
  if (health === "unhealthy") return "warn";
  if (state !== "" && state !== "running") return "warn";
  if (health === "starting") return "warn";
  return "body";
}

/** The container's own words, for the hover flag: `houston · healthy`. Falls
 *  back to the state when there is no health report (most containers have no
 *  healthcheck), and to the bare name when there is neither. */
export function containerFlag(c: ContainerStatus): string {
  const word = (c.health ?? c.state ?? "").trim();
  return word ? `${c.name} · ${word}` : c.name;
}

/** Where body `i` of `n` is seeded, as path progress. Evenly spaced, starting
 *  at the mark's prominent body, so a single container sits where the logo's
 *  big dot does. Deterministic — this is what reduced motion freezes on. */
export function bodySeed(index: number, count: number): number {
  if (count <= 0) return MARK.seed;
  return (MARK.seed + index / count) % 1;
}

/** Real containers → bodies. Sorted by name so the seeding is stable across
 *  polls (docker does not promise an order), capped at the node budget. */
function bodiesOf(containers: readonly ContainerStatus[]): {
  bodies: OrreryBody[];
  overflow: number;
} {
  const real = containers.filter(
    (c) => typeof c?.name === "string" && c.name.trim() !== "",
  );
  const sorted = [...real].sort((a, b) => a.name.localeCompare(b.name));
  const shown = sorted.slice(0, MAX_BODIES);
  const bodies = shown.map((c, i) => {
    const tone = containerTone(c);
    return {
      id: c.name,
      name: c.name,
      tone,
      flag: containerFlag(c),
      seed: bodySeed(i, shown.length),
      tempo: tone === "body" ? 1 : OFF_TEMPO,
    };
  });
  return { bodies, overflow: sorted.length - shown.length };
}

/** The whole state map of §3.3, as one pure function.
 *
 *  `containers` is whatever `stackStatus()` last reported — an empty array is
 *  a legitimate answer ("nothing is running"), and so is a list the instrument
 *  is not allowed to show yet (checking / down). All three collapse to the
 *  same honest picture: the mark, at rest. */
export function orreryFrame(
  phase: OrreryPhase,
  containers: readonly ContainerStatus[] = [],
): OrreryFrame {
  const showBodies = BODIES_BY_PHASE[phase];
  const { bodies, overflow } = showBodies
    ? bodiesOf(containers)
    : { bodies: [], overflow: 0 };
  return {
    phase,
    core: CORE_BY_PHASE[phase],
    breath: BREATH_BY_PHASE[phase],
    ring: RING_BY_PHASE[phase],
    revolution: REVOLUTION_SECONDS,
    running: RUNNING_BY_PHASE[phase],
    bodies,
    chrome: bodies.length === 0,
    overflow: showBodies ? overflow : 0,
  };
}

/** The one call site the home needs: board + containers → instrument. */
export function frameFor(
  board: BoardState,
  containers: readonly ContainerStatus[] = [],
): OrreryFrame {
  return orreryFrame(orreryPhase(board.actuator.action), containers);
}

// ── Geometry (§2.5 — the mark, made functional) ───────────────────

const RAD = Math.PI / 180;

/** The instrument's drawing box, in SVG user units. 300 is chosen so that at
 *  the default 900×700 window (where the instrument renders at its 300px
 *  ceiling) one unit is one CSS pixel and §3.3's absolute sizes — an 8px core
 *  inside a 20px soft ring, 5px bodies — are literal. */
export const GEOM = {
  size: 300,
  cx: 150,
  cy: 150,
  /** The lamp's ellipse at 3× (49:18 → 147:54). Risk 4: the silhouette this
   *  replaces must not drift, so the ratio and the tilt are carried over
   *  exactly and only the scale changes. */
  rx: 147,
  ry: 54,
  /** Degrees. The lamp's tilt, kept for continuity with the mark (§3.3). It is
   *  baked into the ring path's x-axis-rotation rather than applied as a
   *  parent transform, so a body riding the ring translates without rotating
   *  and its mono flag stays level. */
  tilt: -24,
  /** 8px core dot. */
  core: 4,
  /** 20px soft ring at α.13 — the old lamp's `orb-glow`, kept (§3.3). */
  halo: 10,
  haloAlpha: 0.13,
  /** 5px bodies. */
  body: 2.5,
  /** Invisible hover target around a body — a 5px dot is not a pointer
   *  target, and the flag is the only thing a pointer can ask for. */
  hit: 12,
} as const;

/** A point on the ring, tilt included. `depth` is the fraction of the way out
 *  from the core (1 = on the ring itself), and `theta` is the ellipse
 *  parameter in degrees, NOT a screen angle — the two differ because the ring
 *  is foreshortened. */
export function ringPoint(
  theta: number,
  depth = 1,
): { x: number; y: number } {
  const t = theta * RAD;
  const a = GEOM.tilt * RAD;
  const x = GEOM.rx * Math.cos(t) * depth;
  const y = GEOM.ry * Math.sin(t) * depth;
  return {
    x: GEOM.cx + x * Math.cos(a) - y * Math.sin(a),
    y: GEOM.cy + x * Math.sin(a) + y * Math.cos(a),
  };
}

/** How far the ring is from the core along a SCREEN direction (degrees, SVG
 *  convention: 0 = right, positive = clockwise because y grows downward).
 *  This is what makes the mark quotation exact on a foreshortened orbit: the
 *  mark's dots sit at a fraction of the swirl's radius, so the instrument
 *  places them at the same fraction of the RING's reach in that direction. */
export function ringExtent(direction: number): number {
  const d = direction * RAD;
  const a = GEOM.tilt * RAD;
  // Undo the tilt, then evaluate the axis-aligned ellipse along the ray.
  const ux = Math.cos(d) * Math.cos(a) + Math.sin(d) * Math.sin(a);
  const uy = -Math.cos(d) * Math.sin(a) + Math.sin(d) * Math.cos(a);
  return 1 / Math.hypot(ux / GEOM.rx, uy / GEOM.ry);
}

const fmt = (n: number) => Number(n.toFixed(2));

/** The ring, as one closed path — two half-arcs, exactly like the lamp's, with
 *  the tilt carried in the arc's x-axis-rotation. This same string is what the
 *  bodies ride (GSAP MotionPath), so the ring you see and the orbit they run
 *  on cannot drift apart. */
export const RING_PATH = (() => {
  const a = ringPoint(180);
  const b = ringPoint(0);
  const arc = `A${GEOM.rx},${GEOM.ry} ${GEOM.tilt} 1 1`;
  return (
    `M${fmt(a.x)},${fmt(a.y)} ${arc} ${fmt(b.x)},${fmt(b.y)} ` +
    `${arc} ${fmt(a.x)},${fmt(a.y)}`
  );
})();

/** The needsSetup seam: one arc segment of the ring, drawn dashed. Placed on
 *  the upper-left sweep, where nothing else in the composition sits. */
export const SEAM = { from: 196, to: 242 } as const;

export const SEAM_PATH = (() => {
  const a = ringPoint(SEAM.from);
  const b = ringPoint(SEAM.to);
  return `M${fmt(a.x)},${fmt(a.y)} A${GEOM.rx},${GEOM.ry} ${GEOM.tilt} 0 1 ${fmt(b.x)},${fmt(b.y)}`;
})();

/** The rest of the ring — everything the seam is not. The seam state draws
 *  this plus SEAM_PATH rather than the whole ring plus an overlay, so the
 *  unfinished segment is genuinely a gap in the chrome and not a dashed line
 *  painted on top of a solid one. */
export const RING_GAPPED_PATH = (() => {
  const a = ringPoint(SEAM.to);
  const b = ringPoint(SEAM.from);
  return `M${fmt(a.x)},${fmt(a.y)} A${GEOM.rx},${GEOM.ry} ${GEOM.tilt} 1 1 ${fmt(b.x)},${fmt(b.y)}`;
})();

// ── The mark (§2.5) ───────────────────────────────────────────────

/** `AuracleGlyph`'s two bodies, measured off the traced vectors.
 *
 *  Method (reproducible): flatten each of the glyph's three subpaths under its
 *  `translate(0,1600) scale(0.1,-0.1)` transform, take each one's bounding-box
 *  centre and mean radius. The swirl fills the 1600 box, so the mark's centre
 *  is (800,800) and its radius R is 800. Against that:
 *
 *    small dot  centre (656.3, 452.9)  r 124.1  →  0.470 R out at −112.5°
 *    big dot    centre (1142.7, 730.1) r 198.7  →  0.437 R out at  −11.5°
 *
 *  Two facts fall out, and both are load-bearing for the instrument:
 *
 *   · the dots are near-equidistant from the centre (0.470 vs 0.437 R), i.e.
 *     the mark already draws two bodies on ONE orbit — which is the entire
 *     thesis of §1;
 *   · the far dot is the smaller one (0.155 R vs 0.248 R, a ratio of 0.624),
 *     i.e. the size difference is perspective, not encoding. So the resting
 *     state quotes the ratio and never lets a body's size mean anything.
 *
 *  What the instrument reproduces exactly: both DIRECTIONS out of the core,
 *  the relative DEPTH inside the ring, and the size RATIO. What it cannot
 *  reproduce is the absolute distance, because the instrument's orbit is
 *  foreshortened (Risk 4 keeps the lamp's 49:18 silhouette) while the mark is
 *  drawn flat — the same two dots, seen from the side. */
export const MARK = {
  /** Screen directions out of the centre, degrees (SVG convention). */
  directions: [-112.5, -11.5] as const,
  /** Distance from the centre, as a fraction of the mark's radius. */
  depths: [0.47, 0.437] as const,
  /** Dot radius as a fraction of the mark's radius. */
  radii: [0.155, 0.248] as const,
  /** Where body #1 is seeded on the ring path. The mark's prominent body sits
   *  a little past the ring's widest point; 0.586 is that point in path
   *  progress, so one lone container lands where the logo's big dot does. */
  seed: 0.586,
} as const;

/** The mark's two dots as the instrument draws them: at the mark's directions,
 *  at the mark's depth into the ring, carrying the mark's size ratio. These
 *  are chrome — part of the ring drawing (§3.3) — not bodies: they never move,
 *  never carry a tone, never mean anything. They are what the instrument shows
 *  when it has no machine to show. */
export const CHROME_DOTS = MARK.directions.map((direction, i) => {
  const reach = ringExtent(direction) * MARK.depths[i];
  const scale = MARK.radii[i] / Math.max(...MARK.radii);
  return {
    x: fmt(GEOM.cx + reach * Math.cos(direction * RAD)),
    y: fmt(GEOM.cy + reach * Math.sin(direction * RAD)),
    r: fmt(GEOM.body * scale),
  };
});
