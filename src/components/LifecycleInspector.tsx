// LifecycleInspector — the read-only strategy lifecycle belt.
//
// Reached from the palette. Renders the six canonical stages; when the
// engine reports per-strategy states it shows per-stage counts with LIVE
// lit, otherwise it degrades to labels-only — it NEVER fabricates a count
// the engine didn't give it. Mutation belongs to the IDE/engine, so every
// segment deep-links into the workspace that owns the files and runs.

import { useEffect, useState } from "react";

import {
  cmd,
  openIdePanel,
  STRATEGY_STATES,
  type StrategyState,
  type StrategyStates,
} from "@/lib/tauri";

const LABELS: Record<StrategyState, string> = {
  draft: "Draft",
  research: "Research",
  backtested: "Backtested",
  paper: "Paper",
  live: "Live",
  archived: "Archived",
};

export default function LifecycleInspector() {
  const [data, setData] = useState<StrategyStates | null | "error">(null);

  useEffect(() => {
    let alive = true;
    cmd
      .strategyStates()
      .then((d) => alive && setData(d))
      .catch(() => alive && setData("error"));
    return () => {
      alive = false;
    };
  }, []);

  const fresh = data && data !== "error";
  const counts = fresh ? tally(data.states) : null;
  const cached = fresh && !data.from_houston;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Strategy lifecycle</span>
        {cached && <span className="chip warn">cached</span>}
      </div>

      <div className="belt">
        {STRATEGY_STATES.map((s) => (
          <button
            key={s}
            type="button"
            className={`belt__seg${s === "live" ? " live" : ""}`}
            onClick={() => void openIdePanel(s === "live" ? "runs" : "strategies")}
            title={`Open ${LABELS[s]} in the workspace`}
          >
            <b>{counts ? counts[s] : "–"}</b>
            {LABELS[s]}
          </button>
        ))}
      </div>

      <p className="muted fs-xs mt-3 lh-relaxed">
        {counts
          ? "Counts are read from the engine. The launcher reports lifecycle read-only — open the workspace to move a strategy along."
          : data === "error"
            ? "Per-stage counts aren't available yet — open the workspace to see and manage your strategies."
            : "Checking the engine…"}
      </p>
      <button
        type="button"
        className="ghost btn-sm"
        onClick={() => void openIdePanel("strategies")}
      >
        Open workspace →
      </button>
    </div>
  );
}

/** Count strategies per stage. Missing/unknown states are ignored (never
 *  bucketed into a stage they don't belong to). */
function tally(states: Record<string, StrategyState>): Record<StrategyState, number> {
  const counts = Object.fromEntries(STRATEGY_STATES.map((s) => [s, 0])) as Record<
    StrategyState,
    number
  >;
  for (const st of Object.values(states)) {
    if (st in counts) counts[st] += 1;
  }
  return counts;
}
