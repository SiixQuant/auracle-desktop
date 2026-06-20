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

import { useCallback, useEffect, useRef, useState } from "react";

import { accountMode, dataQualityView } from "@/lib/aggregator";
import {
  cmd,
  onEvent,
  openIdePanel,
  type BrokerPosition,
  type BrokerStatus,
  type BrokerTickEvent,
} from "@/lib/tauri";
import type { EngineStateHook } from "@/lib/useEngineState";
import LifecycleInspector from "@/components/LifecycleInspector";
import SupervisionInspector from "@/components/SupervisionInspector";
import ConnectionsCard from "@/views/BrokerConnections";
import {
  AdvancedDrawer,
  GeneralCard,
  GithubCard,
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
  | "system"
  | "lifecycle";

const TITLES: Record<InspectorKey, string> = {
  connections: "Connections",
  supervision: "Supervision",
  account: "Account",
  intelligence: "Intelligence",
  system: "System",
  lifecycle: "Strategy lifecycle",
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
          <UnblockersLegend />
          <ConnectionsCard />
          <GithubCard />
        </>
      );
    case "supervision":
      return <SupervisionInspector />;
    case "lifecycle":
      return <LifecycleInspector />;
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

// ── Connections: "what this unblocks" ──────────────────────────────
//
// Pure derivation of the provides_data / provides_execution flags already
// on every connector, so a missing key reads as a blocked lane ("Backtest
// blocked") rather than an abstract unconfigured row. Live needs an
// execution rail connected; Backtest needs a data rail connected.

function UnblockersLegend() {
  const [rows, setRows] = useState<BrokerStatus[] | null>(null);
  useEffect(() => {
    let alive = true;
    cmd.forgeBrokerStatus().then((r) => alive && setRows(r)).catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!rows) return null;

  const connected = (r: BrokerStatus) => r.state.state === "connected";
  const exec = rows.filter((r) => r.provides_execution);
  const data = rows.filter((r) => r.provides_data);
  const liveRail = exec.find(connected);
  const dataRail = data.find(connected);

  return (
    <div className="unblockers">
      <div className="unblockers__title">What this unblocks</div>
      <Lane label="Live needs execution" rail={liveRail?.label} fallback={exec[0]?.label} />
      <Lane label="Backtest needs data" rail={dataRail?.label} fallback={data[0]?.label} />
    </div>
  );
}

function Lane({
  label,
  rail,
  fallback,
}: {
  label: string;
  rail?: string;
  fallback?: string;
}) {
  return (
    <div className="unblockers__row">
      <span className={`sdot ${rail ? "ok" : ""}`} />
      <span>
        {label} —{" "}
        {rail ? (
          <>
            <span style={{ color: "var(--fg)" }}>{rail}</span>{" "}
            <span style={{ color: "var(--ok)" }}>✓</span>
          </>
        ) : (
          <span className="muted">
            {fallback ? `connect ${fallback}` : "not connected"}
          </span>
        )}
      </span>
    </div>
  );
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
  const ticks = usePositionTicks();

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
  const top = positions
    ? [...positions]
        .sort((a, b) => Math.abs(b.market_value ?? 0) - Math.abs(a.market_value ?? 0))
        .slice(0, 8)
    : [];

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

      {top.length > 0 && (
        <div className="mt-3">
          <div className="muted fs-2xs mb-2">
            Positions — watch for a live last price
          </div>
          {top.map((p, i) => {
            const t = ticks.ticks[p.symbol];
            const watching = ticks.isWatched(p.symbol);
            const dq = t ? dataQualityView(t.data_quality) : null;
            return (
              <div className="row" key={p.symbol + i}>
                <div className="hstack">
                  <span className="mono fs-sm">{p.symbol}</span>
                  <span className="muted fs-2xs">{fmtNum(p.quantity)}</span>
                </div>
                <div className="hstack">
                  {watching && t?.last != null && (
                    <>
                      <span className="mono fs-sm">{t.last.toFixed(2)}</span>
                      {dq && (
                        <span className={`chip ${dq.tone || "neutral"}`}>{dq.label}</span>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="ghost btn-sm"
                    aria-pressed={watching}
                    onClick={() =>
                      watching ? ticks.unwatch(p.symbol) : ticks.watch(p.symbol)
                    }
                  >
                    {watching ? "Unwatch" : "Watch"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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

// ── Opt-in real-time ticks ──────────────────────────────────────────
//
// Subscribe a symbol to the engine's refcounted quote stream and surface
// the live last price + its data_quality. Strict cleanup: unsubscribe on
// unwatch and on inspector close (unmount), and pause the whole set while
// the launcher is backgrounded (document.hidden) so we never leak a
// subscription or hammer the IBKR gateway from a hidden window.

function usePositionTicks() {
  const [ticks, setTicks] = useState<Record<string, BrokerTickEvent>>({});
  const watched = useRef<Set<string>>(new Set());
  const [, bump] = useState(0);

  // One listener for the whole stream; each tick updates its symbol.
  useEffect(() => {
    let alive = true;
    let un: () => void = () => {};
    void onEvent<BrokerTickEvent>("broker-tick", (t) => {
      if (alive) setTicks((prev) => ({ ...prev, [t.symbol]: t }));
    }).then((u) => {
      if (alive) un = u;
      else u();
    });
    return () => {
      alive = false;
      un();
    };
  }, []);

  // Pause/resume on visibility; unsubscribe everything on unmount.
  useEffect(() => {
    const onVis = () => {
      if (typeof document === "undefined") return;
      const op = document.hidden ? cmd.brokerStreamUnsubscribe : cmd.brokerStreamSubscribe;
      watched.current.forEach((s) => void op(s).catch(() => {}));
    };
    document.addEventListener("visibilitychange", onVis);
    const subs = watched.current;
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      subs.forEach((s) => void cmd.brokerStreamUnsubscribe(s).catch(() => {}));
      subs.clear();
    };
  }, []);

  const isWatched = useCallback((sym: string) => watched.current.has(sym), []);

  const watch = useCallback((sym: string) => {
    if (watched.current.has(sym)) return;
    watched.current.add(sym);
    bump((v) => v + 1);
    void cmd.brokerStreamSubscribe(sym).catch(() => {});
  }, []);

  const unwatch = useCallback((sym: string) => {
    if (!watched.current.delete(sym)) return;
    bump((v) => v + 1);
    void cmd.brokerStreamUnsubscribe(sym).catch(() => {});
    setTicks((prev) => {
      const next = { ...prev };
      delete next[sym];
      return next;
    });
  }, []);

  return { ticks, isWatched, watch, unwatch };
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

function fmtNum(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `${v} sh`;
}
