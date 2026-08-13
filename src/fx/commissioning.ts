// commissioning.ts — the first-run sequence's staging, as a pure value.
//
// Design authority: launcher-redesign-direction.md §3.2 ("First-run —
// Commissioning") and §2.4's honesty laws. Slice 8 of the redesign.
//
// Same split as slices 3 and 4: this module decides *what the commissioning
// screen is showing* — which station the rail is on, what the instrument's
// ring, core and arc are doing — without touching the DOM, GSAP or React.
// `views/Onboarding.tsx` owns the real state machine (the Docker probe, the
// license step, the pre-flight, `installer-progress`, the health poll) and
// `components/CommissioningInstrument.tsx` owns the SVG and the tweens.
//
// The split exists so the one rule this slice lives or dies by is a test
// rather than a promise:
//
//   THE SEQUENCE MAY ONLY SHOW WHAT THE MACHINE ACTUALLY REPORTED.
//
// Three consequences, all encoded below:
//
//   1. PROGRESS IS NEVER INVENTED. `arcProgress` is a pure function of the
//      last percent the INSTALLER ITSELF sent on `installer-progress`. There
//      is no clock in this module, no floor, no minimum speed, no trickle and
//      no easing: a step that stalls renders stalled, at exactly the number it
//      stalled on, for as long as it stalls. An install that dies at 41% draws
//      41% until the user acts. `fx/motion.ts` deliberately ships no number
//      tween for the same reason (§2.4) — the arc is set, never animated.
//
//   2. NOTHING TURNS UNTIL SOMETHING IS RUNNING. The mechanism is `running`
//      in exactly one stage: `live`, which is reached only after
//      `waitForEngineHealthy` got a real health answer out of the engine.
//      Neither the installer exiting nor the arc reaching 100 is enough — both
//      are claims about a process, and the instrument reports the machine.
//
//   3. THE INSTRUMENT IS THE SAME INSTRUMENT. Ring styles, core tones and
//      breaths are the orrery's own vocabulary (`fx/orrery.ts`), not a
//      lookalike set — so the frame the ceremony lands on IS the frame the
//      home draws a second later, and the handover is a continuation rather
//      than a cut.

import type { Breath, CoreTone, RingStyle } from "./orrery.ts";

// ── The stages (§3.2) ─────────────────────────────────────────────

/** Every state the commissioning sequence can be in. One per real branch of
 *  the onboarding state machine — there is no stage here that the code in
 *  `views/Onboarding.tsx` cannot actually be in, and none of its branches is
 *  missing. */
export type CommissioningStage =
  /** Station 1 — the Docker probe. */
  | "environment"
  /** Station 2 — sign in, or paste a license key, or skip to Community. */
  | "credentials"
  /** Station 3 — pre-flight checks are in flight. */
  | "preflight"
  /** Station 3 — the checks answered and the install cannot run. */
  | "blocked"
  /** Station 3 — a live stack already owns the ports; there is nothing to
   *  install (`engineIsUp`). */
  | "occupied"
  /** Station 3 — the checks pass. Waiting for the user to consent to the
   *  download; the installer NEVER starts itself. */
  | "ready"
  /** install.sh is running and reporting. */
  | "installing"
  /** The installer exited; the engine health poll is running. */
  | "awaiting"
  /** The engine answered. The one sanctioned ceremony, then the handover. */
  | "live"
  /** The containers installed but the engine never answered within the
   *  window. Installed is not the same as serving, and this stage says so. */
  | "stalled"
  /** install.sh failed. */
  | "failed";

/** Declared as a list so a test can walk every stage and prove each one maps
 *  to a defined instrument frame (Risk 8, applied to the first run). */
export const COMMISSIONING_STAGES = [
  "environment",
  "credentials",
  "preflight",
  "blocked",
  "occupied",
  "ready",
  "installing",
  "awaiting",
  "live",
  "stalled",
  "failed",
] as const;

/** What the pre-flight has said so far. `pending` is the honest name for "we
 *  asked and have not been told" — it is not a synonym for "clear". */
export type PreflightVerdict = "pending" | "clear" | "blocked" | "failed";

/** Everything the sequence is allowed to know, read straight off the real
 *  state machine. Every field is a fact the launcher already had; nothing here
 *  is derived, defaulted or remembered on the sequence's behalf. */
export interface CommissioningReading {
  /** The wizard's own step. */
  step: 1 | 2 | 3;
  /** The Docker probe reported an installed AND running runtime. */
  dockerRunning: boolean;
  /** A browser sign-in is genuinely in flight (App's Clerk session poll). */
  signInWaiting: boolean;
  /** The pre-flight's last word. */
  preflight: PreflightVerdict;
  /** The engine is already answering, so a fresh install would collide. */
  alreadyRunning: boolean;
  /** install.sh is running. */
  installing: boolean;
  /** install.sh exited successfully. */
  finished: boolean;
  /** null until the post-install health poll resolves. */
  engineHealthy: boolean | null;
  /** install.sh failed and has not been retried. */
  installFailed: boolean;
  /** The last percent the INSTALLER reported on `installer-progress`.
   *  `undefined` means it has never said a number — which draws an empty arc,
   *  not a polite little sliver. */
  percent?: number;
}

/** The real state machine → the stage.
 *
 *  The order of these branches mirrors the order the view renders them in, so
 *  the instrument can never be describing one situation while the station
 *  content underneath describes another. */
export function commissioningStage(r: CommissioningReading): CommissioningStage {
  if (r.step === 1) return "environment";
  if (r.step === 2) return "credentials";
  // Station 3, in the order the install actually walks.
  if (r.installFailed && !r.installing) return "failed";
  if (r.finished) {
    if (r.engineHealthy === true) return "live";
    if (r.engineHealthy === false) return "stalled";
    return "awaiting";
  }
  if (r.installing) return "installing";
  if (r.alreadyRunning) return "occupied";
  if (r.preflight === "failed" || r.preflight === "blocked") return "blocked";
  if (r.preflight === "pending") return "preflight";
  return "ready";
}

// ── The rail (§3.2) ───────────────────────────────────────────────

export type StationKey = "environment" | "signin" | "install";
export type StationState = "pending" | "current" | "done";

export interface Station {
  key: StationKey;
  label: string;
  state: StationState;
}

/** The three stations, in order. Labels are the ones the wizard has always
 *  used — §3.2 names the same three. */
export const STATION_LABELS: { key: StationKey; label: string }[] = [
  { key: "environment", label: "Environment" },
  { key: "signin", label: "Sign in" },
  { key: "install", label: "Install" },
];

/** The rail's ticks.
 *
 *  A station is `done` when it has been WALKED, which is exactly what the
 *  wizard's own stepper meant before this slice — station 1 cannot be walked
 *  without a running Docker runtime (its Next is gated on the live probe), and
 *  station 2 is walked by signing in, by pasting a key, or by choosing
 *  Community. The tick records the sequence, and claims nothing else. */
export function stationsFor(
  step: 1 | 2 | 3,
  stage: CommissioningStage,
): Station[] {
  // The commissioned machine has walked all three, whatever step the wizard
  // technically stopped on.
  const done = stage === "live" ? 3 : step - 1;
  return STATION_LABELS.map((s, i) => ({
    ...s,
    state: i < done ? "done" : i === done ? "current" : "pending",
  }));
}

// ── The instrument (§3.2, in the orrery's own vocabulary) ─────────

export interface CommissioningView {
  stage: CommissioningStage;
  /** How the ring draws — the orrery's own styles. */
  ring: RingStyle;
  /** The core's hue — the orrery's own tones. */
  core: CoreTone;
  /** The in-flight breath, or null when nothing is in flight. */
  breath: Breath | null;
  /** The commissioning arc, as real completion in [0,1] — or null when
   *  nothing has begun and there is therefore nothing to draw. */
  arc: number | null;
  /** The mechanism turns. True in exactly one stage: `live`. */
  running: boolean;
  /** The instrument is the finished orbit — the frame the home draws. This is
   *  the handover, and it is reached only from `live`. */
  assembled: boolean;
  /** The commissioning rail. */
  stations: Station[];
}

/** Breaths, from the orrery's two periods (§3.3): the fast one means work is
 *  happening, the slow one means we are waiting on a probe. Both are the
 *  4%-opacity swing — the tempo is the whole message. */
const WORKING: Breath = { period: 1.2, opacityDelta: 0.04 };
const WAITING: Breath = { period: 4, opacityDelta: 0.04 };

/** Per stage: what the ring does, what the core is, and what it is breathing.
 *
 *  Read down the `core` column and the sequence's honesty is visible at a
 *  glance: the core stays UNLIT through the whole build — station 1, the
 *  license, the checks, the download — because nothing is alive yet. The one
 *  place it lights is `live`, after the engine answered a real health probe.
 *  §3.2 calls that ignition, and this table is what keeps it earned. */
const FRAME_BY_STAGE: Record<
  CommissioningStage,
  { ring: RingStyle; core: CoreTone; breath: Breath | null }
> = {
  // The chassis is not proven yet: the ring is the dim one the home shows
  // before any probe has answered. `ringFor` lifts it to chrome the moment
  // the Docker probe really reports a running runtime.
  environment: { ring: "dim", core: "checking", breath: null },
  // Reachable only through station 1's gate, so the runtime is real chrome.
  credentials: { ring: "chrome", core: "checking", breath: null },
  preflight: { ring: "chrome", core: "checking", breath: WAITING },
  // A failed check is a machine that cannot be built: the stopped watch.
  blocked: { ring: "dashed", core: "err", breath: null },
  // Nothing to install — the stack is already serving. The core carries the
  // home's calm ready tone because that is the truth about the engine.
  occupied: { ring: "chrome", core: "ready", breath: null },
  ready: { ring: "chrome", core: "checking", breath: null },
  installing: { ring: "chrome", core: "checking", breath: WORKING },
  awaiting: { ring: "chrome", core: "checking", breath: WAITING },
  live: { ring: "chrome", core: "ready", breath: null },
  // Installed, but not serving. Amber, and still.
  stalled: { ring: "chrome", core: "warn", breath: null },
  failed: { ring: "dashed", core: "err", breath: null },
};

/** Stages that draw an arc at all: the ones where an install has begun. Before
 *  that there is no progress to have — an arc at 0 would still be a claim that
 *  something is under way. */
const ARC_STAGES: Record<CommissioningStage, boolean> = {
  environment: false,
  credentials: false,
  preflight: false,
  blocked: false,
  occupied: false,
  ready: false,
  installing: true,
  awaiting: true,
  live: true,
  stalled: true,
  failed: true,
};

/** The mechanism turns in exactly one stage. */
const RUNNING_STAGES: Record<CommissioningStage, boolean> = {
  environment: false,
  credentials: false,
  preflight: false,
  blocked: false,
  occupied: false,
  ready: false,
  installing: false,
  awaiting: false,
  live: true,
  stalled: false,
  failed: false,
};

/** The installer's own last word, as ring completion in [0,1].
 *
 *  This is the whole of the progress law, and it is four lines long on
 *  purpose. `percent` is whatever arrived on the last `installer-progress`
 *  event and nothing else: never a floor, never a minimum speed, never a
 *  function of elapsed time. A stalled phase returns the same number every
 *  time it is asked, which is what makes a stalled install LOOK stalled. */
export function arcProgress(
  stage: CommissioningStage,
  percent: number | undefined,
): number | null {
  if (!ARC_STAGES[stage]) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  return Math.min(1, Math.max(0, percent / 100));
}

/** The ring style, with the one fact station 1 can prove: a real Docker
 *  runtime, really running. Nothing else about the environment moves it. */
export function ringFor(
  stage: CommissioningStage,
  dockerRunning: boolean,
): RingStyle {
  const base = FRAME_BY_STAGE[stage].ring;
  if (stage === "environment" && dockerRunning) return "chrome";
  return base;
}

/** The whole screen, as one pure value. */
export function commissioningView(r: CommissioningReading): CommissioningView {
  const stage = commissioningStage(r);
  const frame = FRAME_BY_STAGE[stage];
  return {
    stage,
    ring: ringFor(stage, r.dockerRunning),
    core: frame.core,
    // Station 2 is the one stage whose breath depends on a fact rather than on
    // the stage alone: the browser sign-in is either in flight or it is not.
    breath:
      stage === "credentials" ? (r.signInWaiting ? WAITING : null) : frame.breath,
    arc: arcProgress(stage, r.percent),
    running: RUNNING_STAGES[stage],
    assembled: stage === "live",
    stations: stationsFor(r.step, stage),
  };
}
