// InspectorHost — the drill-don't-traverse depth layer.
//
// "The Standby" home shows only status + the next move. Everything denser
// lives one calm layer deep: pressing a status (status-is-the-door) or the
// top-bar gear/agent slides a right-docked inspector OVER a dimmed-but-
// still-live home. The home keeps polling behind the sheet (the engine
// read is shared, owned by the Shell), so finishing a flow shows the lamp
// flip the instant the engine confirms. Esc / scrim-click closes; one
// inspector open at a time (no stacking). The inspectors RE-HOST the
// existing control-plane cards verbatim — a re-host, not a rewrite.

import { useEffect } from "react";

import { accountMode } from "@/lib/aggregator";
import { openIdePanel, type BrokerPosition } from "@/lib/tauri";
import type { EngineStateHook } from "@/lib/useEngineState";
import ConnectionsCard from "@/views/BrokerConnections";
import {
  AdvancedDrawer,
  GeneralCard,
  GithubCard,
  HealthReadoutCard,
  IdeUpdateCard,
  IntelligenceCard,
  LicenseCard,
  SystemCard,
} from "@/views/Settings";

export type InspectorKey =
  | "connections"
  | "supervision"
  | "account"
  | "intelligence"
  | "system";

const TITLES: Record<InspectorKey, string> = {
  connections: "Connections",
  supervision: "Supervision",
  account: "Account",
  intelligence: "Intelligence",
  system: "System",
};

export default function InspectorHost({
  open,
  onClose,
  eng,
}: {
  open: InspectorKey | null;
  onClose: () => void;
  eng: EngineStateHook;
}) {
  // Esc closes — keyboard-first, never a modal that traps you.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="insp-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="insp" role="dialog" aria-modal="true" aria-label={TITLES[open]}>
        <div className="insp__head">
          <h2 className="insp__title">{TITLES[open]}</h2>
          <button type="button" className="insp__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="insp__body">
          <InspectorBody which={open} eng={eng} onClose={onClose} />
        </div>
      </aside>
    </>
  );
}

function InspectorBody({
  which,
  eng,
  onClose,
}: {
  which: InspectorKey;
  eng: EngineStateHook;
  onClose: () => void;
}) {
  switch (which) {
    case "connections":
      return (
        <>
          <ConnectionsCard />
          <GithubCard />
        </>
      );
    case "supervision":
      // Phase 1: re-host the engine + Docker health readout. Phase 4
      // replaces this with the per-container Supervision console.
      return <HealthReadoutCard />;
    case "account":
      return <AccountInspector eng={eng} onClose={onClose} />;
    case "intelligence":
      return <IntelligenceCard />;
    case "system":
      return (
        <>
          <LicenseCard />
          <GeneralCard />
          <SystemCard />
          <IdeUpdateCard />
          <AdvancedDrawer />
        </>
      );
  }
}

// ── Account inspector (Phase 1 — current snapshot) ──────────────────
//
// Net-liq + unrealized P&L + position count, read straight from the
// shared broker snapshot, with a deep-link into the IDE blotter. Phase 2
// adds the opt-in real-time tick + the exposure sparkline with data_quality.

function AccountInspector({
  eng,
  onClose,
}: {
  eng: EngineStateHook;
  onClose: () => void;
}) {
  const s = eng.state.summary;
  const positions = eng.positions;
  const mode = accountMode(s);

  if (!s) {
    return (
      <div className="card">
        <p className="muted fs-sm m-0 lh-relaxed">
          No broker connected. Connect IBKR to see your account, P&amp;L, and exposure here.
        </p>
      </div>
    );
  }

  const ccy = s.currency || "USD";
  const pnl = s.unrealized_pnl ?? null;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Account</span>
        {mode && <span className={`mode-badge ${mode}`}>{mode.toUpperCase()}</span>}
      </div>
      <div className="row">
        <div className="muted fs-sm">Net liquidation</div>
        <div className="mono fs-sm">{fmt(s.net_liquidation, ccy)}</div>
      </div>
      <div className="row">
        <div className="muted fs-sm">Unrealized P&amp;L</div>
        <div
          className="mono fs-sm"
          style={{ color: pnl === null ? "var(--fg)" : pnl >= 0 ? "var(--ok)" : "var(--err)" }}
        >
          {fmtSigned(pnl, ccy)}
        </div>
      </div>
      <div className="row">
        <div className="muted fs-sm">Open positions</div>
        <div className="mono fs-sm">{positions ? `${positions.length}` : "—"}</div>
      </div>
      <ExposureBars positions={positions} />
      <div className="mt-3">
        <button
          type="button"
          className="ghost btn-sm"
          onClick={() => {
            void openIdePanel("blotter");
            onClose();
          }}
        >
          Open Trade →
        </button>
      </div>
    </div>
  );
}

/** Snapshot bar chart of current position sizes — honest current state,
 *  no fabricated time series. Renders nothing with no positions. */
function ExposureBars({ positions }: { positions: BrokerPosition[] | null }) {
  if (!positions || positions.length === 0) return null;
  const top = [...positions]
    .sort((a, b) => Math.abs(b.market_value ?? 0) - Math.abs(a.market_value ?? 0))
    .slice(0, 6);
  const max = Math.max(1, ...top.map((p) => Math.abs(p.market_value ?? 0)));
  const w = 16;
  const gap = 4;
  return (
    <svg
      viewBox={`0 0 ${top.length * (w + gap)} 18`}
      width="100%"
      height="18"
      style={{ marginTop: 10 }}
      aria-hidden="true"
    >
      {top.map((p, i) => {
        const h = Math.max(2, Math.round((Math.abs(p.market_value ?? 0) / max) * 16));
        return (
          <rect
            key={p.symbol + i}
            x={i * (w + gap)}
            y={18 - h}
            width={w - 2}
            height={h}
            rx="1.5"
            fill={i === 0 ? "var(--accent)" : "var(--fg-muted)"}
          />
        );
      })}
    </svg>
  );
}

function fmt(v: number | null, ccy: string): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: ccy || "USD",
    maximumFractionDigits: 0,
  });
}

function fmtSigned(v: number | null, ccy: string): string {
  if (v === null || v === undefined) return "—";
  const body = fmt(v, ccy);
  return v >= 0 ? `+${body}` : body;
}
