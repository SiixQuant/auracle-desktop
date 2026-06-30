// StandbyHome — the launcher home, "The Standby".
//
// The calm panel of an already-running machine: a single status lamp, one
// plain-English System Line, and one adaptive verb. The launcher is a
// global hub now — connections (brokers / data sources) live in the IDE —
// so the home's verb is only "Open workspace" (engine ready) or "Start
// engine" (engine down), never "connect a broker". Below the verb sits a
// 2x2 hub-card grid (Updates / Changelog / FAQ / Support) and a quiet
// "Re-run setup". The lamp + System Line + verb are pure derivations of one
// engine snapshot (deriveBoard), so what the home says is, by construction,
// what the engine reports.

import IncidentCard from "@/components/IncidentCard";
import {
  deriveBoard,
  type ActuatorState,
  type Door,
  type LampTone,
  type Vital,
} from "@/lib/aggregator";
import { agentById, agentIdFromEngineProvider } from "@/lib/intelligence";
import { useSettings } from "@/lib/settings";
import type { EngineStateHook } from "@/lib/useEngineState";
import type { InspectorKey } from "@/components/InspectorHost";

export default function StandbyHome({
  eng,
  onActuator,
  onDoor,
  onCard,
  onRerunSetup,
  onAgent,
}: {
  /** Shared live engine read (owned by the Shell, so the home keeps
   *  polling behind an open inspector). */
  eng: EngineStateHook;
  /** Run the home's one verb — owned by the Shell so the palette and the
   *  button trigger the same action. */
  onActuator: () => void;
  /** Open an inspector for a pressed status (status-is-the-door). */
  onDoor?: (door: Exclude<Door, null>) => void;
  /** Open one of the hub cards (Updates / Changelog / FAQ / Support). */
  onCard?: (key: InspectorKey) => void;
  /** Re-run the first-run stack setup (Docker + engine + IDE). */
  onRerunSetup?: () => void;
  /** Open the Intelligence inspector (the agent on-ramp). */
  onAgent?: () => void;
}) {
  const { settings } = useSettings();
  const board = deriveBoard(eng.state);
  const { actuator } = board;

  const ai = settings?.ai_model;
  const agentName = ai
    ? agentById(agentIdFromEngineProvider(ai.provider))?.label ?? "Agent"
    : "Auracle Agent";
  const keyOnFile = ai?.configured ?? false;

  const asOf = stamp(eng.lastOkAt, eng.now);

  return (
    <div className="standby">
      <Lamp tone={board.lamp} pulse={board.pulse} onClick={() => onDoor?.("supervision")} />

      <h1 className="standby__line">{board.systemLine}</h1>
      {asOf && <div className="standby__stamp">{asOf}</div>}

      <Actuator actuator={actuator} onClick={onActuator} />

      <button type="button" className="standby__agent" onClick={onAgent}>
        <span className="standby__agent-label">agent</span>
        <span className="standby__agent-name">{agentName}</span>
        <span className={`vital__dot ${keyOnFile ? "ok" : ""}`} />
      </button>

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

      <div className="hub-grid" role="group" aria-label="Hub">
        <HubCard
          title="Update Auracle"
          desc="Update the launcher and the IDE"
          onClick={() => onCard?.("updates")}
          icon={<DownloadIcon />}
        />
        <HubCard
          title="Changelog"
          desc="What changed in each release"
          onClick={() => onCard?.("changelog")}
          icon={<ListIcon />}
        />
        <HubCard
          title="FAQ"
          desc="Common questions, answered"
          onClick={() => onCard?.("faq")}
          icon={<HelpIcon />}
        />
        <HubCard
          title="Support"
          desc="Diagnostics + how to reach us"
          onClick={() => onCard?.("support")}
          icon={<LifebuoyIcon />}
        />
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

// ── Hub card ────────────────────────────────────────────────────────

function HubCard({
  title,
  desc,
  icon,
  onClick,
}: {
  title: string;
  desc: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="hub-card" onClick={onClick}>
      <span className="hub-card__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="hub-card__title">{title}</span>
      <span className="hub-card__desc">{desc}</span>
    </button>
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

// ── Stamp helpers ───────────────────────────────────────────────────

function stamp(lastOkAt: number | null, now: number): string {
  if (!lastOkAt) return "";
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

// ── Hub-card icons (inline, currentColor) ───────────────────────────

const cardIconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function DownloadIcon() {
  return (
    <svg {...cardIconProps}>
      <path d="M10 3 v9 M6.5 8.5 L10 12 l3.5 -3.5 M4 15.5 h12" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg {...cardIconProps}>
      <path d="M7 6 h9 M7 10 h9 M7 14 h9 M4 6 h0.01 M4 10 h0.01 M4 14 h0.01" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg {...cardIconProps}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.2 8 a2 2 0 1 1 2.6 2 c-0.6 0.35 -0.8 0.8 -0.8 1.4" />
      <circle cx="10" cy="14.3" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LifebuoyIcon() {
  return (
    <svg {...cardIconProps}>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3" />
      <path d="M5 5 l2.2 2.2 M12.8 12.8 L15 15 M15 5 l-2.2 2.2 M7.2 12.8 L5 15" />
    </svg>
  );
}
