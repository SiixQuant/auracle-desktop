// StandbyHome — the launcher home, "The Standby".
//
// The calm panel of an already-running machine: a single status lamp, one
// plain-English System Line, and one adaptive verb. Everything denser is
// one drill-in deeper (status-is-the-door, via the vitals) — this surface
// shows only "status + the next move". All three focal elements are pure
// derivations of one engine snapshot (deriveBoard), so what the home says
// is, by construction, what the engine reports.

import {
  deriveBoard,
  type ActuatorState,
  type Door,
  type LampTone,
  type Vital,
} from "@/lib/aggregator";
import type { EngineStateHook } from "@/lib/useEngineState";

export default function StandbyHome({
  eng,
  onDoor,
}: {
  /** Shared live engine read (owned by the Shell, so the home keeps
   *  polling behind an open inspector). */
  eng: EngineStateHook;
  /** Open an inspector for a pressed status (status-is-the-door). */
  onDoor?: (door: Exclude<Door, null>) => void;
}) {
  const board = deriveBoard(eng.state);
  const { actuator } = board;

  const act = () => {
    switch (actuator.action) {
      case "launch":
        void eng.launch();
        break;
      case "start":
        void eng.startEngine();
        break;
      case "connect":
        onDoor?.("connections");
        break;
      case "degraded":
        onDoor?.("supervision");
        break;
      default:
        break; // checking / starting — disabled
    }
  };

  const asOf = stamp(eng.lastOkAt, eng.now, eng.state.brokerStale ?? false);

  return (
    <div className="standby">
      <Lamp tone={board.lamp} pulse={board.pulse} onClick={() => onDoor?.("supervision")} />

      <h1 className="standby__line">{board.systemLine}</h1>
      {asOf && <div className="standby__stamp">{asOf}</div>}

      <Actuator actuator={actuator} onClick={act} />

      {(eng.engineErr || eng.ideError) && (
        <div className="standby__err">{eng.engineErr || eng.ideError}</div>
      )}

      <div className="standby__vitals" role="group" aria-label="System vitals">
        {board.vitals.map((v) => (
          <VitalButton key={v.key} v={v} onClick={() => v.door && onDoor?.(v.door)} />
        ))}
      </div>
    </div>
  );
}

// ── Lamp ────────────────────────────────────────────────────────────

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
      <span className="standby__lamp-core" />
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
        className="standby__actuator"
        onClick={onClick}
        disabled={actuator.disabled}
        title={actuator.reason}
      >
        <span>{actuator.label}</span>
        {actuator.badge && (
          <span className={`standby__badge${actuator.badge === "live" ? " is-live" : ""}`}>
            {actuator.badge.toUpperCase()}
          </span>
        )}
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
      <span className={`vital__value${v.key === "mode" && v.value === "LIVE" ? " is-live" : ""}`}>
        {v.freshness === "stale" ? "stale" : v.value}
      </span>
    </button>
  );
}

// ── Stamp helpers ───────────────────────────────────────────────────

function stamp(lastOkAt: number | null, now: number, stale: boolean): string {
  if (!lastOkAt) return "";
  if (stale) return `stale · last ok ${clock(lastOkAt)} · ${relAge(lastOkAt, now)}`;
  const age = now - lastOkAt;
  return `as of ${clock(lastOkAt)}${age >= 60_000 ? ` · ${relAge(lastOkAt, now)}` : ""}`;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false });
}

function relAge(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
