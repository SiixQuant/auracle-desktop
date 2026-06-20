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
//   engine-unreachable > engine-unhealthy > unconfigured >
//   unconnected-broker > feed-degraded > ready
// A null health means the first probe hasn't returned yet ("checking") —
// never "ready". The LIVE/paper token is derived ONLY from IBKR's DU*
// account-id convention, never assumed. A tripped staleness guard flips
// the affected vitals to "stale", never presenting last-good as live.

import type {
  BrokerAccountSummary,
  BrokerDataQuality,
  BrokerMarketDataStatus,
  HealthSnapshot,
  SettingsAggregate,
} from "@/lib/tauri";

export type LampTone = "ok" | "warn" | "err" | "accent" | "checking";
export type Mode = "paper" | "live";
export type DotTone = "ok" | "warn" | "err" | "accent" | "";
export type Freshness = "fresh" | "stale" | "checking";

/** What the single primary button should do, computed from engine truth. */
export type ActuatorAction =
  | "checking" // first poll pending — nothing to offer yet
  | "start" // engine down — compose up
  | "starting" // engine coming up — disabled, in-flight
  | "degraded" // engine up but unhealthy — route to Supervision
  | "connect" // engine ready, no broker — finish setup
  | "launch"; // engine ready + broker — open the workspace

/** Which inspector a status opens (status-is-the-door). */
export type Door = "supervision" | "connections" | "account" | null;

/** One snapshot of everything the home derives from. Assembled by the
 *  home component from the existing engine probes + SharedSettings. */
export interface EngineState {
  /** null = the first health poll hasn't resolved yet (checking). */
  health: HealthSnapshot | null;
  /** True while the user-initiated start sequence is running. */
  starting?: boolean;
  /** Broker account snapshot, or null when not connected/fetched. */
  summary: BrokerAccountSummary | null;
  /** Market-data tier probe, or null when not connected/fetched. */
  marketData: BrokerMarketDataStatus | null;
  /** True when the broker staleness guard has tripped (a fetch failed
   *  after we'd had good data) — folds into vital freshness. */
  brokerStale?: boolean;
  /** Shared settings aggregate (tier etc.), or null before first load. */
  settings?: SettingsAggregate | null;
}

export interface Vital {
  key: "engine" | "broker" | "feed" | "mode";
  /** Lowercase mono label, e.g. "engine". */
  label: string;
  /** The displayed value, e.g. "Healthy" / "IBKR" / "real-time". */
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
  /** paper/live badge to render inline on a Launch verb. */
  badge: Mode | null;
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
  mode: Mode | null;
}

/** Paper vs live from IBKR's own account-id convention. Paper accounts
 *  start with "DU"; everything else with a real id is live. Never assumed
 *  from any other signal. */
export function accountMode(summary: BrokerAccountSummary | null): Mode | null {
  if (!summary || !summary.account_id) return null;
  return summary.account_id.toUpperCase().startsWith("DU") ? "paper" : "live";
}

/** The effective engine state, treating a user-initiated start as
 *  "starting" even before the health probe reports it. */
function effectiveState(s: EngineState): HealthSnapshot["state"] | null {
  if (s.starting) return "starting";
  return s.health?.state ?? null;
}

function feedLabel(q: BrokerDataQuality | undefined): {
  value: string;
  dot: DotTone;
} {
  switch (q) {
    case "realtime":
      return { value: "real-time", dot: "ok" };
    case "delayed":
      return { value: "delayed", dot: "warn" };
    case "frozen":
      return { value: "frozen", dot: "warn" };
    case "closed":
      return { value: "market closed", dot: "" };
    case "halted":
      return { value: "halted", dot: "err" };
    default:
      return { value: "—", dot: "" };
  }
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
  const mode = accountMode(s.summary);
  const hasBroker = s.summary !== null && !!s.summary.account_id;
  const feedQ = s.marketData?.us_equity;
  const feedDelayed = feedQ === "delayed" || feedQ === "frozen";

  // ── The lamp + System Line + Actuator, by the priority ladder ──
  let lamp: LampTone;
  let pulse = false;
  let systemLine: string;
  let actuator: ActuatorState;

  if (state === null) {
    lamp = "checking";
    pulse = true;
    systemLine = "Checking the desk…";
    actuator = { label: "Checking engine…", action: "checking", disabled: true, badge: null };
  } else if (state === "starting") {
    lamp = "accent";
    pulse = true;
    systemLine = "Engine is starting…";
    actuator = { label: "Starting engine…", action: "starting", disabled: true, badge: null };
  } else if (state === "down") {
    lamp = "err";
    systemLine = "Engine's down — start it to continue.";
    actuator = { label: "Start engine", action: "start", disabled: false, badge: null };
  } else if (state === "degraded") {
    lamp = "warn";
    systemLine = "Engine is degraded — check the stack.";
    actuator = {
      label: "Engine degraded",
      action: "degraded",
      disabled: true,
      badge: null,
      reason: "Open Supervision to see which service is unhealthy.",
    };
  } else if (!hasBroker) {
    // engine healthy, nothing connected — finish setup
    lamp = "accent";
    systemLine = "Connect your broker to finish setup.";
    actuator = { label: "Connect a broker", action: "connect", disabled: false, badge: null };
  } else if (feedDelayed) {
    lamp = "ok";
    systemLine = "Ready — market data is delayed.";
    actuator = { label: "Launch workspace", action: "launch", disabled: false, badge: mode };
  } else {
    lamp = "ok";
    systemLine = "Everything's ready.";
    actuator = { label: "Launch workspace", action: "launch", disabled: false, badge: mode };
  }

  // ── Quiet vitals row (each a door + interrogable provenance) ──
  const engineFresh: Freshness = s.health === null && !s.starting ? "checking" : "fresh";
  const brokerFresh: Freshness = s.brokerStale ? "stale" : "fresh";

  const ew = engineWord(state);
  const fw = feedLabel(feedQ);

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
    {
      key: "broker",
      label: "broker",
      value: hasBroker ? "IBKR" : "—",
      dot: hasBroker ? "ok" : "",
      freshness: brokerFresh,
      door: "connections",
      provenance: hasBroker
        ? `account ${s.summary?.account_id}`
        : "no broker connected",
    },
    {
      key: "feed",
      label: "feed",
      value: fw.value,
      dot: fw.dot,
      freshness: brokerFresh,
      door: "connections",
      provenance: s.marketData
        ? `IBKR availability code "${s.marketData.us_equity_raw}"`
        : "no market-data probe yet",
    },
    {
      key: "mode",
      label: "mode",
      value: mode ? mode.toUpperCase() : "—",
      dot: mode === "live" ? "accent" : mode === "paper" ? "ok" : "",
      freshness: brokerFresh,
      door: "account",
      provenance: mode
        ? `account id ${mode === "paper" ? "starts with DU → paper" : "is live (no DU prefix)"}`
        : "connect a broker to confirm paper vs live",
    },
  ];

  return { lamp, pulse, systemLine, actuator, vitals, mode };
}
