// LifecycleInspector — the read-only strategy lifecycle belt.
//
// Reached from the palette. Renders the six canonical stages; when the
// engine reports per-strategy states it shows per-stage counts with LIVE
// lit, otherwise it degrades to labels-only — it NEVER fabricates a count
// the engine didn't give it. Mutation belongs to the IDE/engine, so every
// segment deep-links into the workspace that owns the files and runs.
//
// Slice 6 redrew the belt as §3.4 specifies: six stations on one horizontal
// hairline spine, each a tick with its count in mono above it. The one reading
// that changed is the Live station's — it used to sit permanently highlighted,
// which said "live" whether or not anything was. Now it carries the --ok dot
// only when the engine has actually reported a strategy running there. Same
// data, one fewer standing claim.

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
      {/* No title here: the tray header already says "Strategy lifecycle", and
          §3.4's law is that the tray IS the container — a body that renames
          itself under its own header is the nested-card smell in typographic
          form. The head exists only when there is a badge to hang on it. */}
      {cached && (
        <div className="card-head card-head--action-only">
          <span className="chip warn">cached</span>
        </div>
      )}

      <div className="belt">
        {STRATEGY_STATES.map((s) => {
          // Lit = the engine says something is actually running there. A
          // count we were never given cannot light anything.
          const lit = s === "live" && !!counts && counts.live > 0;
          return (
            <button
              key={s}
              type="button"
              className="belt__station"
              onClick={() => void openIdePanel(s === "live" ? "runs" : "strategies")}
              title={`Open ${LABELS[s]} in the workspace`}
            >
              <b className="belt__count">{counts ? counts[s] : "–"}</b>
              <span className={`belt__rail${lit ? " is-lit" : ""}`} aria-hidden="true" />
              <span className="belt__label">{LABELS[s]}</span>
            </button>
          );
        })}
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
