// Shell — the single-surface launcher chrome for "The Standby".
//
// Replaces the old Home/Settings/Help rail. There is one surface (the
// Standby home) plus a thin top bar and the right-docked inspector layer.
// The Shell owns the shared engine read so the home keeps polling behind
// an open inspector (drill-don't-traverse). Connections / Supervision /
// Account are reached by pressing the status that names them (status-is-
// the-door, from the home); Intelligence and System are reached from the
// top bar — there is no Settings page.

import { useState } from "react";

import Flame from "@/components/Flame";
import InspectorHost, { type InspectorKey } from "@/components/InspectorHost";
import StandbyHome from "@/components/StandbyHome";
import { useEngineState } from "@/lib/useEngineState";

export default function Shell({ onOpenTutorial }: { onOpenTutorial: () => void }) {
  const eng = useEngineState();
  const [inspector, setInspector] = useState<InspectorKey | null>(null);

  return (
    <div className="shell-standby">
      <header className="topbar">
        <div className="topbar__brand">
          <Flame size={20} />
          <strong>Auracle</strong>
        </div>
        <div className="topbar__actions">
          <button
            type="button"
            className="topbar__btn"
            onClick={() => setInspector("intelligence")}
          >
            <BrainIcon />
            Intelligence
          </button>
          <button
            type="button"
            className="topbar__btn"
            onClick={() => setInspector("system")}
          >
            <GearIcon />
            System
          </button>
          <button type="button" className="topbar__btn icon-only" onClick={onOpenTutorial} aria-label="Help">
            <HelpIcon />
          </button>
        </div>
      </header>

      <main className="standby-stage">
        <StandbyHome eng={eng} onDoor={(d) => setInspector(d)} />
        <InspectorHost open={inspector} onClose={() => setInspector(null)} eng={eng} />
      </main>
    </div>
  );
}

// ── Top-bar icons (inline, no icon-font dependency) ─────────────────

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function BrainIcon() {
  return (
    <svg {...iconProps}>
      <path d="M7.5 4.5 a2.2 2.2 0 0 0 -2.2 2.2 a2 2 0 0 0 -0.8 3.6 a2 2 0 0 0 1 3.5 a2 2 0 0 0 4 0.2 V5 a2 2 0 0 0 -2 -0.5Z" />
      <path d="M12.5 4.5 a2.2 2.2 0 0 1 2.2 2.2 a2 2 0 0 1 0.8 3.6 a2 2 0 0 1 -1 3.5 a2 2 0 0 1 -4 0.2" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 2.5 v2 M10 15.5 v2 M2.5 10 h2 M15.5 10 h2 M4.7 4.7 l1.4 1.4 M13.9 13.9 l1.4 1.4 M15.3 4.7 l-1.4 1.4 M6.1 13.9 l-1.4 1.4" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.2 8 a2 2 0 1 1 2.6 2 c-0.6 0.35 -0.8 0.8 -0.8 1.4" />
      <circle cx="10" cy="14.3" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
