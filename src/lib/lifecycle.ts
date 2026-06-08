// Strategy lifecycle — the single source of truth for the conveyor belt.
//
// The belt (LifecycleBelt) and the Forge surfaces all read the stage
// model + the Houston deep-links from here, so there is exactly ONE place
// that knows the stage order and how to reach Houston for the real
// backtest/deploy work. Before this module those URLs were duplicated
// across the Editor and the PreviewPane.
//
// Architecture note: the desktop is a thin client. The heavy lifting
// (running a backtest, scheduling a deployment, placing orders) lives in
// Houston (the web platform). The belt routes to Houston's working UI
// deep-links and is aware of Houston's health; it never executes a trade
// itself. Promoting to live is a gated, explicit human action.

import { type StrategyState } from "@/lib/tauri";

/** Houston (the web platform) base origin. Plain http on :1969 is fine
 *  for a browser navigation — no TLS hop needed for a UI deep-link. */
export const HOUSTON_BASE = "http://localhost:1969";

/** Ordered forward path of the belt. `archived` is a terminal side-state
 *  reachable from anywhere, so it is not part of the linear order. */
export const BELT_STAGES: StrategyState[] = [
  "draft",
  "research",
  "backtested",
  "paper",
  "live",
];

export interface StageMeta {
  label: string;
  blurb: string;
}

export const STAGE_META: Record<StrategyState, StageMeta> = {
  draft: { label: "Draft", blurb: "A new idea — write or generate the strategy." },
  research: { label: "Research", blurb: "Exploring — iterate on the logic." },
  backtested: { label: "Backtested", blurb: "Validated on history — review the results." },
  paper: { label: "Paper", blurb: "Running on a paper account — no real capital." },
  live: { label: "Live", blurb: "Trading real capital." },
  archived: { label: "Archived", blurb: "Retired — kept for reference." },
};

/** Deep-link into Houston's backtest form, pre-filled with the strategy. */
export function backtestUrl(relPath: string): string {
  const params = new URLSearchParams({ strategy: relPath });
  return `${HOUSTON_BASE}/ui/backtests/new?${params}`;
}

/** Deep-link into Houston's Forge board, where a strategy is promoted
 *  through paper/live. The strategy + intended mode are passed as hints;
 *  if Houston ignores them the user simply picks up from the board. */
export function deployUrl(relPath: string, mode: "paper" | "live"): string {
  const params = new URLSearchParams({ strategy: relPath, mode });
  return `${HOUSTON_BASE}/ui/forge?${params}`;
}

/** Probe Houston's health. `no-cors` keeps it a cheap reachability ping —
 *  we only care that something answered on :1969/healthz, not the body. */
export async function probeHouston(
  signal?: AbortSignal,
): Promise<"online" | "offline"> {
  try {
    await fetch(`${HOUSTON_BASE}/healthz`, { signal, mode: "no-cors" });
    return "online";
  } catch {
    return "offline";
  }
}

export type StepKind =
  | "backtest"
  | "deploy-paper"
  | "promote-live"
  | "manage"
  | "none";

export interface NextStep {
  kind: StepKind;
  /** Button label for the belt's contextual CTA. */
  label: string;
  /** Stage this step advances to once acted on — used to document the
   *  belt's forward intent. null = no forward stage (terminal/manage). */
  advancesTo: StrategyState | null;
  /** True when the step opens a real-capital path and must be confirmed. */
  guarded: boolean;
}

/** The single contextual action the belt offers for the current stage. */
export function nextStep(state: StrategyState): NextStep {
  switch (state) {
    case "draft":
    case "research":
      return { kind: "backtest", label: "Run backtest", advancesTo: "backtested", guarded: false };
    case "backtested":
      return { kind: "deploy-paper", label: "Deploy to paper", advancesTo: "paper", guarded: false };
    case "paper":
      return { kind: "promote-live", label: "Promote to live", advancesTo: "live", guarded: true };
    case "live":
      return { kind: "manage", label: "Manage in Houston", advancesTo: null, guarded: false };
    case "archived":
      return { kind: "none", label: "", advancesTo: null, guarded: false };
  }
}
