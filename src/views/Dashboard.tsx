// Dashboard — the launcher home, rebuilt as a hub (v7.1).
//
// Layout: a hero (animated Auracle flame + the one Launch action +
// honest engine status), a row of live account tiles read straight
// from the broker, and a right "Today" status column.
//
// Honesty rules baked in:
//   - Mode (paper/live) is derived from IBKR's own account-id
//     convention (DU* = paper) — never assumed.
//   - Broker numbers carry an "as of HH:MM:SS" stamp. On a mid-session
//     fetch failure the last values are KEPT but flipped to an amber
//     "stale" state with the reason — never presented as live.
//   - Nothing is shown that the launcher can't really fetch (no market
//     clock, no run history — those live in the IDE / web console).

import { useCallback, useEffect, useRef, useState } from "react";

import Flame from "@/components/Flame";
import {
  cmd,
  openInBrowser,
  type BrokerAccountSummary,
  type BrokerDataQuality,
  type BrokerMarketDataStatus,
  type BrokerPosition,
  type HealthSnapshot,
  type UpdateInfo,
} from "@/lib/tauri";

export default function Dashboard({
  onOpenTutorial,
  onGotoSettings,
}: {
  onOpenTutorial?: () => void;
  onGotoSettings?: () => void;
}) {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [ideError, setIdeError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  // Broker glance + staleness tracking.
  const [summary, setSummary] = useState<BrokerAccountSummary | null>(null);
  const [positions, setPositions] = useState<BrokerPosition[] | null>(null);
  const [marketData, setMarketData] = useState<BrokerMarketDataStatus | null>(null);
  const [brokerErr, setBrokerErr] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const hadData = useRef(false);

  // Engine health (hero status + Today). 30s, visible-only.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await cmd.currentHealth();
        if (alive) setHealth(h);
      } catch {
        if (alive) setHealth(null);
      }
    };
    void tick();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void tick();
    }, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Launcher update check (best-effort, once).
  useEffect(() => {
    cmd.checkForUpdate().then(setUpdate).catch(() => setUpdate(null));
  }, []);

  // Broker data with stale-as-live guard.
  const refreshBroker = useCallback(async () => {
    const [s, p, md] = await Promise.allSettled([
      cmd.brokerAccountSummary(),
      cmd.brokerOpenPositions(),
      cmd.brokerMarketDataStatus(),
    ]);
    if (s.status === "fulfilled") {
      setSummary(s.value);
      setBrokerErr(null);
      setLastOkAt(Date.now());
      setStale(false);
      hadData.current = true;
    } else {
      setBrokerErr(String(s.reason));
      // Keep the last-good summary but mark it stale; only blank it if
      // we never had data (cold start with no broker).
      if (!hadData.current) setSummary(null);
      else setStale(true);
    }
    if (p.status === "fulfilled") setPositions(p.value.rows);
    if (md.status === "fulfilled") setMarketData(md.value);
  }, []);

  useEffect(() => {
    void refreshBroker();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshBroker();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshBroker]);

  const launch = () => {
    setIdeError(null);
    void cmd.openAuracleIDE().catch((err) => setIdeError(String(err)));
  };

  const openWebConsole = async () => {
    let url = "http://localhost:1969/ui/setup";
    try {
      const h = await cmd.currentHealth();
      if (h?.state === "healthy") url = "http://localhost:1969/ui/dashboard";
    } catch {
      // ignore — fall through to /ui/setup
    }
    await openInBrowser(url);
  };

  const openTrade = () => {
    void openInBrowser("http://localhost:1969/ui/blotter");
  };

  const eng = engineView(health);
  const mode = accountMode(summary);
  const hasBroker = summary !== null;
  const ccy = summary?.currency || "USD";
  const pnl = summary?.unrealized_pnl ?? null;
  const feed = feedView(marketData?.us_equity);

  return (
    <div className="hub">
      <div className="hub__main">
        <div className="hub__head">
          <h1>Overview</h1>
          {onOpenTutorial && (
            <button type="button" className="hlink" onClick={onOpenTutorial}>
              Take the tour
            </button>
          )}
        </div>

        {/* Hero — the one Launch action + animated brand mark */}
        <div className="hero">
          <div className="hero__body">
            <div className="hero__title">Your workspace</div>
            <p className="hero__sub">
              Take an idea from research to live, in one place.
            </p>
            <button type="button" className="btn-launch" onClick={launch}>
              <PlayIcon />
              Launch
              {mode && <span className={`mode-badge ${mode}`}>{mode.toUpperCase()}</span>}
            </button>
            <div className="statusline">
              <span className={`sdot ${eng.dot}`} />
              {eng.text}
            </div>
            {ideError && <div className="err-text fs-xs mt-2">{ideError}</div>}
            <div className="hero__links">
              <button type="button" className="hlink" onClick={openWebConsole}>
                Open web console ↗
              </button>
            </div>
          </div>
          <div className="hero__art">
            <Flame animated fill />
          </div>
        </div>

        {/* Account tiles — live broker data, time-stamped */}
        <div className="section-head">
          <h2>Account</h2>
          <span className={`asof${stale ? " stale" : ""}`}>
            {stale
              ? `stale · last ok ${lastOkAt ? clock(lastOkAt) : "—"}`
              : lastOkAt
                ? `as of ${clock(lastOkAt)}`
                : ""}
          </span>
          <div className="section-head__actions">
            <button type="button" className="ghost btn-sm" onClick={openTrade}>
              Open Trade →
            </button>
          </div>
        </div>

        {hasBroker ? (
          <div className="tiles">
            <div className="tile">
              <div className="tile__label">Unrealized P&amp;L</div>
              <div
                className="tile__value"
                style={{ color: pnl === null ? "var(--fg)" : pnl >= 0 ? "#6fcfa8" : "var(--err)" }}
              >
                {fmtSigned(pnl, ccy)}
              </div>
              <div className="tile__foot">net · open positions</div>
            </div>

            <div className="tile">
              <div className="tile__label">Exposure</div>
              <div className="tile__value">
                {positions ? `${positions.length} pos` : "—"}
              </div>
              <ExposureBars positions={positions} />
            </div>

            <div className="tile">
              <div className="tile__label">Data feed</div>
              <div className="tile__value" style={{ fontSize: 14, color: feed.color }}>
                {feed.label}
              </div>
              <div className="tile__foot">IBKR · US equities</div>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="row" style={{ alignItems: "center" }}>
              <div>
                <div>Connect your broker</div>
                <div className="muted fs-sm mt-1">
                  Link IBKR to see your account, P&amp;L, and feed here.
                </div>
                {brokerErr && <div className="muted mono fs-2xs mt-2">{brokerErr}</div>}
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() => onGotoSettings?.()}
              >
                Open Settings
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Today — honest status column */}
      <aside className="hub__aside">
        <div className="aside__title">Today</div>

        <div className="aside__row">
          <span className="lbl">Mode</span>
          {mode ? (
            <span className={`mode-badge ${mode}`}>{mode.toUpperCase()}</span>
          ) : (
            <span className="val">—</span>
          )}
        </div>
        <div className="aside__row">
          <span className={`sdot ${eng.dot}`} />
          <span className="lbl">Engine</span>
          <span className="val">{eng.short}</span>
        </div>
        <div className="aside__row">
          <span className={`sdot ${hasBroker ? "ok" : ""}`} />
          <span className="lbl">Broker</span>
          <span className="val">{hasBroker ? "IBKR" : "—"}</span>
        </div>
        <div className="aside__row">
          <span className={`sdot ${feed.dot}`} />
          <span className="lbl">Data feed</span>
          <span className="val">{feed.label}</span>
        </div>

        {update?.available && update.version && (
          <>
            <div className="aside__sep" />
            <div className="aside__row">
              <span className="sdot warn" />
              <span className="lbl">Update</span>
              <span className="val">v{update.version}</span>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

// ── Small pieces ────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 3 L13 8 L4 13 Z" />
    </svg>
  );
}

/** Snapshot bar chart of current position sizes (no time series —
 *  honest current state). Renders nothing when there are no positions. */
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
      height="16"
      style={{ marginTop: 6 }}
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
            fill={i === 0 ? "#10b981" : "#3a6a5c"}
          />
        );
      })}
    </svg>
  );
}

// ── Honest derivations ──────────────────────────────────────────────

function accountMode(summary: BrokerAccountSummary | null): "paper" | "live" | null {
  if (!summary || !summary.account_id) return null;
  // IBKR paper accounts start with "DU"; live accounts start with "U".
  return summary.account_id.toUpperCase().startsWith("DU") ? "paper" : "live";
}

function engineView(h: HealthSnapshot | null): {
  text: string;
  short: string;
  dot: string;
} {
  switch (h?.state) {
    case "healthy":
      return { text: "Local engine — ready", short: "ready", dot: "ok" };
    case "starting":
      return { text: "Local engine — starting…", short: "starting", dot: "hollow" };
    case "degraded":
      return { text: "Local engine — degraded", short: "degraded", dot: "warn" };
    case "down":
      return { text: "Local engine — not running", short: "not running", dot: "err" };
    default:
      return { text: "Local engine — checking…", short: "checking", dot: "" };
  }
}

function feedView(q: BrokerDataQuality | undefined): {
  label: string;
  color: string;
  dot: string;
} {
  switch (q) {
    case "realtime":
      return { label: "real-time", color: "var(--fg)", dot: "ok" };
    case "delayed":
      return { label: "delayed", color: "var(--warn)", dot: "warn" };
    case "frozen":
      return { label: "frozen", color: "var(--warn)", dot: "warn" };
    case "closed":
      return { label: "market closed", color: "var(--fg-dim)", dot: "" };
    case "halted":
      return { label: "halted", color: "var(--err)", dot: "err" };
    default:
      return { label: "—", color: "var(--fg-dim)", dot: "" };
  }
}

function fmtSigned(v: number | null, ccy: string): string {
  if (v === null || v === undefined) return "—";
  const body = v.toLocaleString("en-US", {
    style: "currency",
    currency: ccy || "USD",
    maximumFractionDigits: 0,
  });
  return v >= 0 ? `+${body}` : body;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false });
}
