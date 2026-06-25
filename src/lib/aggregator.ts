// State aggregator — the single source of "what the home says".
//
// "The Standby" home is three things: a status lamp, one plain-English
// System Line, and one adaptive verb (the Actuator). All three, plus the
// quiet vitals row, are PURE derivations of one engine snapshot. Keeping
// that derivation here — with no React, no I/O, no `import` that resolves
// at runtime (types only) — makes it the highest-value test seam: feed it
// a fixture EngineState, assert the lamp/sentence/verb/freshness.
//
// HONESTY CONTRACT (encoded as the priority ladder):
//   engine-unreachable > engine-unhealthy > ready
// A null health means the first probe hasn't returned yet ("checking") —
// never "ready". Connections (brokers / data sources) live in the IDE now,
// so the launcher home never derives a broker/feed/mode reading and never
// offers a "connect" verb — the next move is only Start engine (when down)
// or Open workspace (when ready).

import type { HealthSnapshot } from "@/lib/tauri";

export type LampTone = "ok" | "warn" | "err" | "accent" | "checking";
export type DotTone = "ok" | "warn" | "err" | "accent" | "";
export type Freshness = "fresh" | "stale" | "checking";

/** What the single primary button should do, computed from engine truth. */
export type ActuatorAction =
  | "checking" // first poll pending — nothing to offer yet
  | "start" // engine down — compose up
  | "starting" // engine coming up — disabled, in-flight
  | "degraded" // engine up but unhealthy — route to Supervision
  | "launch"; // engine ready — open the workspace

/** Which inspector a status opens (status-is-the-door). */
export type Door = "supervision" | null;

/** One snapshot of everything the home derives from. Assembled by the
 *  Shell from the engine health probe. */
export interface EngineState {
  /** null = the first health poll hasn't resolved yet (checking). */
  health: HealthSnapshot | null;
  /** True while the user-initiated start sequence is running. */
  starting?: boolean;
}

export interface Vital {
  key: "engine";
  /** Lowercase mono label, e.g. "engine". */
  label: string;
  /** The displayed value, e.g. "Healthy". */
  value: string;
  dot: DotTone;
  freshness: Freshness;
  /** The inspector this vital opens when pressed, or null. */
  door: Door;
  /** One-line provenance for the interrogable hover/focus. */
  provenance?: string;
}

export interface ActuatorState {
  label: string;
  action: ActuatorAction;
  disabled: boolean;
  /** Why the verb is disabled (shown as the honest reason). */
  reason?: string;
}

export interface BoardState {
  lamp: LampTone;
  /** True while in-flight (checking / starting) — drives the lamp pulse. */
  pulse: boolean;
  systemLine: string;
  actuator: ActuatorState;
  vitals: Vital[];
}

/** The effective engine state, treating a user-initiated start as
 *  "starting" even before the health probe reports it. */
function effectiveState(s: EngineState): HealthSnapshot["state"] | null {
  if (s.starting) return "starting";
  return s.health?.state ?? null;
}

function engineWord(state: HealthSnapshot["state"] | null): {
  value: string;
  dot: DotTone;
} {
  switch (state) {
    case "healthy":
      return { value: "Healthy", dot: "ok" };
    case "starting":
      return { value: "Starting…", dot: "warn" };
    case "degraded":
      return { value: "Degraded", dot: "warn" };
    case "down":
      return { value: "Not running", dot: "err" };
    default:
      return { value: "Checking…", dot: "" };
  }
}

/** Derive the entire Standby home from one engine snapshot. Pure. */
export function deriveBoard(s: EngineState): BoardState {
  const state = effectiveState(s);

  // ── The lamp + System Line + Actuator, by the priority ladder ──
  let lamp: LampTone;
  let pulse = false;
  let systemLine: string;
  let actuator: ActuatorState;

  if (state === null) {
    lamp = "checking";
    pulse = true;
    systemLine = "Checking the desk…";
    actuator = { label: "Checking engine…", action: "checking", disabled: true };
  } else if (state === "starting") {
    lamp = "accent";
    pulse = true;
    systemLine = "Engine is starting…";
    actuator = { label: "Starting engine…", action: "starting", disabled: true };
  } else if (state === "down") {
    lamp = "err";
    systemLine = "Engine's down — start it to continue.";
    actuator = { label: "Start engine", action: "start", disabled: false };
  } else if (state === "degraded") {
    lamp = "warn";
    systemLine = "Engine is degraded — check the stack.";
    actuator = {
      label: "Engine degraded",
      action: "degraded",
      disabled: true,
      reason: "Open Supervision to see which service is unhealthy.",
    };
  } else {
    // engine healthy — the workspace is one click away
    lamp = "ok";
    systemLine = "Everything's ready.";
    actuator = { label: "Open workspace", action: "launch", disabled: false };
  }

  // ── Quiet vitals row (each a door + interrogable provenance) ──
  const engineFresh: Freshness = s.health === null && !s.starting ? "checking" : "fresh";

  const ew = engineWord(state);

  const vitals: Vital[] = [
    {
      key: "engine",
      label: "engine",
      value: ew.value,
      dot: ew.dot,
      freshness: engineFresh,
      door: "supervision",
      provenance: s.health?.last_error
        ? `last error: ${s.health.last_error}`
        : s.health?.last_ok_at
          ? `last ok ${s.health.last_ok_at}`
          : "from the engine /healthz probe",
    },
  ];

  return { lamp, pulse, systemLine, actuator, vitals };
}
