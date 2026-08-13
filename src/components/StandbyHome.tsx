// StandbyHome — the launcher home, "The Standby".
//
// The calm panel of an already-running machine: one instrument (the orrery),
// one plain-English System Line, and one adaptive verb ("Open workspace" when
// the engine is ready, "Start engine" when it's down). The screen stays quiet
// by default — a footer of small links (update status / What's new / Help) —
// and only raises a card when something needs attention (the engine down). The
// instrument, line, and verb are pure derivations of one engine snapshot
// (deriveBoard), so what the home says is, by construction, what the engine
// reports.

import IncidentCard from "@/components/IncidentCard";
import Orrery from "@/components/Orrery";
import { frameFor } from "@/fx/orrery";
import {
  deriveBoard,
  type ActuatorState,
  type Door,
  type Vital,
} from "@/lib/aggregator";
import type { ContainerStatus } from "@/lib/tauri";
import type { EngineStateHook } from "@/lib/useEngineState";
import type { InspectorKey } from "@/components/InspectorHost";

export default function StandbyHome({
  eng,
  containers,
  onActuator,
  onDoor,
  onCard,
  onRerunSetup,
}: {
  /** Shared live engine read (owned by the Shell, so the home keeps
   *  polling behind an open inspector). */
  eng: EngineStateHook;
  /** The stack as `stackStatus()` last reported it — the ONLY source of the
   *  instrument's bodies. Undefined means "we haven't been told", which the
   *  instrument renders as the mark at rest rather than as an empty machine. */
  containers?: ContainerStatus[];
  /** Run the home's one verb — owned by the Shell so the palette and the
   *  button trigger the same action. */
  onActuator: () => void;
  /** Open an inspector for a pressed status (status-is-the-door). */
  onDoor?: (door: Exclude<Door, null>) => void;
  /** Open one of the footer destinations (Updates / Changelog / Help). */
  onCard?: (key: InspectorKey) => void;
  /** Re-run the first-run stack setup (Docker + engine + IDE). */
  onRerunSetup?: () => void;
  /** Retained so the Shell/palette can still reach the agent inspector even
   *  though the home no longer shows an agent chip. */
  onAgent?: () => void;
}) {
  const board = deriveBoard(eng.state);
  const { actuator } = board;

  // Footer update status — derived from real update/version truth only, and
  // never claims "Up to date" until the update probe has actually answered.
  const upd = eng.update;
  const ver = eng.version;
  const updateReady = !!upd?.available;
  const updateLabel = updateReady
    ? `Update available${upd?.version ? ` · v${upd.version}` : ""}`
    : upd
      ? `Up to date${ver ? ` · v${ver}` : ""}`
      : ver
        ? `v${ver}`
        : "Auracle";

  return (
    <div className="standby">
      <Orrery
        frame={frameFor(board, containers ?? [])}
        onOpen={() => onDoor?.("supervision")}
      />

      <h1 className="standby__line">{board.systemLine}</h1>

      <Actuator actuator={actuator} onClick={onActuator} />

      {(eng.engineErr || eng.ideError) && (
        <div className="standby__err">{eng.engineErr || eng.ideError}</div>
      )}

      {board.lamp === "err" && (
        <div className="standby__incident">
          <IncidentCard
            severity="err"
            cause="The local engine isn't running."
            detail="Start it to continue, or open Supervision to see the stack."
            action={{ label: "Open Supervision", onClick: () => onDoor?.("supervision") }}
          />
        </div>
      )}

      <div className="standby__footer">
        <button
          type="button"
          className={`standby__link${updateReady ? " is-accent" : ""}`}
          onClick={() => onCard?.("updates")}
        >
          {updateLabel}
        </button>
        <span className="standby__dot" aria-hidden="true">·</span>
        <button type="button" className="standby__link" onClick={() => onCard?.("changelog")}>
          What&rsquo;s new
        </button>
        <span className="standby__dot" aria-hidden="true">·</span>
        <button type="button" className="standby__link" onClick={() => onCard?.("help")}>
          Help
        </button>
      </div>

      {onRerunSetup && (
        <button type="button" className="standby__rerun" onClick={onRerunSetup}>
          Re-run setup
        </button>
      )}

      <div className="standby__vitals" role="group" aria-label="System vitals">
        {board.vitals.map((v) => (
          <VitalButton key={v.key} v={v} onClick={() => v.door && onDoor?.(v.door)} />
        ))}
      </div>
    </div>
  );
}

// ── Adaptive Actuator ───────────────────────────────────────────────

function Actuator({
  actuator,
  onClick,
}: {
  actuator: ActuatorState;
  onClick: () => void;
}) {
  return (
    <div className="standby__actuator-wrap">
      <button
        type="button"
        className={`standby__actuator${actuator.action === "starting" ? " is-progress" : ""}`}
        onClick={onClick}
        disabled={actuator.disabled}
        title={actuator.reason}
      >
        <span>{actuator.label}</span>
      </button>
      {actuator.reason && actuator.disabled && (
        <div className="standby__act-reason">{actuator.reason}</div>
      )}
    </div>
  );
}

// ── Vitals (status-is-the-door) ─────────────────────────────────────

function VitalButton({ v, onClick }: { v: Vital; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`vital${v.freshness === "stale" ? " is-stale" : ""}`}
      onClick={onClick}
      title={v.provenance}
    >
      <span className={`vital__dot ${v.dot}`} />
      <span className="vital__label">{v.label}</span>
      <span className="vital__value">
        {v.freshness === "stale" ? "stale" : v.value}
      </span>
      {v.provenance && <span className="vital__prov">{v.provenance}</span>}
    </button>
  );
}
