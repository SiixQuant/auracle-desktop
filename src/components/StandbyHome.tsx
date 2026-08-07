// StandbyHome — the launcher home, "The Standby".
//
// The calm panel of an already-running machine: one orbital status lamp, one
// plain-English System Line, and one adaptive verb ("Open workspace" when the
// engine is ready, "Start engine" when it's down). The screen stays quiet by
// default — a footer of small links (update status / What's new / Help) — and
// only raises a card when something needs attention (the engine down). The
// lamp, line, and verb are pure derivations of one engine snapshot
// (deriveBoard), so what the home says is, by construction, what the engine
// reports.

import IncidentCard from "@/components/IncidentCard";
import {
  deriveBoard,
  type ActuatorState,
  type Door,
  type LampTone,
  type Vital,
} from "@/lib/aggregator";
import type { EngineStateHook } from "@/lib/useEngineState";
import type { InspectorKey } from "@/components/InspectorHost";

export default function StandbyHome({
  eng,
  onActuator,
  onDoor,
  onCard,
  onRerunSetup,
}: {
  /** Shared live engine read (owned by the Shell, so the home keeps
   *  polling behind an open inspector). */
  eng: EngineStateHook;
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
      <Lamp tone={board.lamp} pulse={board.pulse} onClick={() => onDoor?.("supervision")} />

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

// ── Lamp — an orbital that echoes the Auracle mark ──────────────────
//
// A glowing core with a comet-trail satellite tracing a tilted orbit. Colour
// follows the engine tone (green ready, amber degraded, red down, white
// active) through `currentColor`, so it reads as "alive and in orbit" rather
// than a plain dot. On `err` the orbit halts and the ring goes dashed.

function Lamp({
  tone,
  pulse,
  onClick,
}: {
  tone: LampTone;
  pulse: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`standby__lamp tone-${tone}${pulse ? " is-pulsing" : ""}`}
      onClick={onClick}
      aria-label="Engine status — open Supervision"
    >
      <svg
        className="standby__orbital"
        viewBox="0 0 140 140"
        width="108"
        height="108"
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
        xmlnsXlink="http://www.w3.org/1999/xlink"
      >
        <circle className="orb-halo" cx="70" cy="70" r="41" />
        <g transform="rotate(-24 70 70)">
          <ellipse className="orb-ring" cx="70" cy="70" rx="49" ry="18" />
          <path id="standbyOrb" d="M21,70 A49,18 0 1 1 119,70 A49,18 0 1 1 21,70" fill="none" />
          <circle className="orb-glow" cx="70" cy="70" r="18" opacity="0.13" />
          <circle className="orb-core" cx="70" cy="70" r="6.4" />
          <circle className="orb-bright" cx="70" cy="70" r="3.4" />
          <circle className="orb-sat orb-sat--t2" r="1.5">
            <animateMotion dur="6.5s" begin="-0.36s" repeatCount="indefinite">
              <mpath href="#standbyOrb" xlinkHref="#standbyOrb" />
            </animateMotion>
          </circle>
          <circle className="orb-sat orb-sat--t1" r="2.2">
            <animateMotion dur="6.5s" begin="-0.18s" repeatCount="indefinite">
              <mpath href="#standbyOrb" xlinkHref="#standbyOrb" />
            </animateMotion>
          </circle>
          <circle className="orb-sat orb-sat--head" r="3.3">
            <animateMotion dur="6.5s" repeatCount="indefinite">
              <mpath href="#standbyOrb" xlinkHref="#standbyOrb" />
            </animateMotion>
          </circle>
        </g>
      </svg>
    </button>
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
