// Dashboard — the launcher home, rebuilt as a hub (v7.1).
//
// Layout: a hero (animated Auracle flame + the primary action + honest
// engine status), a row of live account tiles read straight from the
// broker, and a right "Today" status column.
//
// Honesty rules baked in:
//   - The primary action follows engine truth: when the engine is down
//     it becomes "Start engine" (compose up -d) — Launch never fires
//     into a dead backend; "Starting…" shows while it comes up.
//   - Mode (paper/live) is derived from IBKR's own account-id
//     convention (DU* = paper) — never assumed.
//   - The broker glance is stamped "as of HH:MM:SS". If ANY of the
//     three fetches (summary / positions / feed) fails after we had
//     data, the whole glance flips to an amber "stale" state with the
//     reason — never presenting last-good values as live.
//   - Nothing is shown that the launcher can't really fetch.

import { useCallback, useEffect, useRef, useState } from "react";

import Flame from "@/components/Flame";
import {
  cmd,
  openIdePanel,
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
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [launching, setLaunching] = useState(false);
  const [starting, setStarting] = useState(false);

  // Broker glance + staleness tracking.
  const [summary, setSummary] = useState<BrokerAccountSummary | null>(null);
  const [positions, setPositions] = useState<BrokerPosition[] | null>(null);
  const [marketData, setMarketData] = useState<BrokerMarketDataStatus | null>(null);
  const [brokerErr, setBrokerErr] = useState<string | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const hadData = useRef(false);

  const pollHealth = useCallback(async () => {
    try {
      const h = await cmd.currentHealth();
      setHealth(h);
      return h;
    } catch {
      setHealth(null);
      return null;
    }
  }, []);

  // Engine health (hero status + Today). 30s, visible-only.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await pollHealth();
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
  }, [pollHealth]);

  // Launcher update check (best-effort, once).
  useEffect(() => {
    cmd.checkForUpdate().then(setUpdate).catch(() => setUpdate(null));
  }, []);

  // Tick a clock so the "as of" stamp shows a live relative age
  // between the 30s broker polls.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Broker data with a stale-as-live guard covering ALL three fetches.
  const refreshBroker = useCallback(async () => {
    const [s, p, md] = await Promise.allSettled([
      cmd.brokerAccountSummary(),
      cmd.brokerOpenPositions(),
      cmd.brokerMarketDataStatus(),
    ]);
    const allOk =
      s.status === "fulfilled" && p.status === "fulfilled" && md.status === "fulfilled";

    if (s.status === "fulfilled") {
      setSummary(s.value);
      hadData.current = true;
      setBrokerErr(null);
    } else {
      setBrokerErr(String(s.reason));
      if (!hadData.current) setSummary(null);
    }
    if (p.status === "fulfilled") setPositions(p.value.rows);
    if (md.status === "fulfilled") setMarketData(md.value);

    if (allOk) {
      setLastOkAt(Date.now());
      setStale(false);
    } else if (hadData.current) {
      // Any of the three failing means the glance is no longer fully
      // current — mark the whole block stale rather than letting a
      // failed positions/feed fetch sit at full confidence.
      setStale(true);
    }
  }, []);

  useEffect(() => {
    void refreshBroker();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshBroker();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refreshBroker]);

  const launch = async () => {
    setIdeError(null);
    // Defensive: the Launch button is already gated on a healthy engine,
    // but the cached health can be up to a poll-interval stale, so refuse
    // here too rather than open the workspace into a non-ready engine.
    // (The Rust side re-confirms with a fresh /healthz poll as well.)
    if (health?.state !== "healthy") {
      setIdeError(
        `The engine isn't ready (${health?.state ?? "checking"}). ` +
          `Start it and wait for "ready" before opening the workspace.`,
      );
      return;
    }
    setLaunching(true);
    try {
      await cmd.openAuracleIDE();
    } catch (err) {
      setIdeError(String(err));
    } finally {
      window.setTimeout(() => setLaunching(false), 1200);
    }
  };

  const startEngine = async () => {
    setEngineErr(null);
    setStarting(true);
    try {
      await cmd.stackStart();
      // Poll until healthy (or ~60s), so the status reflects reality.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => window.setTimeout(r, 2_000));
        const h = await pollHealth();
        if (h?.state === "healthy") break;
      }
    } catch (err) {
      setEngineErr(String(err));
    } finally {
      setStarting(false);
    }
  };

  const openTrade = () => {
    void openIdePanel("blotter");
  };

  const engineStarting = starting || health?.state === "starting";
  const engineDown = !engineStarting && health?.state === "down";
  // Only a CONFIRMED-healthy engine may be launched into. `health === null`
  // means the first poll hasn't returned yet (checking), and "degraded"
  // means Houston is up but unhealthy (e.g. DB unreachable) — neither is
  // safe to open the workspace into.
  const engineReady = health?.state === "healthy";
  const eng = engineStarting
    ? { text: "Local engine — starting…", short: "starting", dot: "hollow" }
    : engineView(health);
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

        {/* Hero — primary action follows engine truth + animated brand */}
        <div className="hero">
          <div className="hero__body">
            <div className="hero__title">Your workspace</div>
            <p className="hero__sub">
              Take an idea from research to live, in one place.
            </p>

            {engineStarting ? (
              <button type="button" className="btn-launch" disabled>
                Starting engine…
              </button>
            ) : engineDown ? (
              <button type="button" className="btn-launch" onClick={startEngine}>
                <PowerIcon />
                Start engine
              </button>
            ) : engineReady ? (
              <button
                type="button"
                className="btn-launch"
                onClick={launch}
                disabled={launching}
              >
                <PlayIcon />
                {launching ? "Opening…" : "Launch"}
                {mode && <span className={`mode-badge ${mode}`}>{mode.toUpperCase()}</span>}
              </button>
            ) : (
              // Health not yet confirmed (null = first poll pending) or
              // degraded — don't offer to launch into an unconfirmed/
              // unhealthy engine. The statusline below shows the live state.
              <button type="button" className="btn-launch" disabled>
                {health === null ? "Checking engine…" : "Engine degraded"}
              </button>
            )}

            <div className="statusline">
              <span className={`sdot ${eng.dot}`} />
              {eng.text}
            </div>

            {engineErr && <div className="err-text fs-xs mt-2">{engineErr}</div>}
            {ideError && (
              <div className="mt-2">
                <div className="err-text fs-xs">{ideError}</div>
              </div>
            )}
          </div>
          <div className="hero__bg" aria-hidden="true">
            <Flame animated fill />
          </div>
        </div>

        {/* Account tiles — live broker data, time-stamped */}
        <div className="section-head">
          <h2>Account</h2>
          <span className={`asof${stale ? " stale" : ""}`}>
            {lastOkAt
              ? stale
                ? `stale · last ok ${clock(lastOkAt)} · ${relAge(lastOkAt, now)}`
                : `as of ${clock(lastOkAt)}${
                    now - lastOkAt >= 60_000 ? ` · ${relAge(lastOkAt, now)}` : ""
                  }`
              : ""}
          </span>
          <div className="section-head__actions">
            <button type="button" className="ghost btn-sm" onClick={openTrade}>
              Open Trade →
            </button>
          </div>
        </div>

        {hasBroker ? (
          <div className={`tiles${stale ? " is-stale" : ""}`}>
            <div className="tile">
              <div className="tile__label">Unrealized P&amp;L</div>
              <div
                className="tile__value"
                style={{ color: pnl === null ? "var(--fg)" : pnl >= 0 ? "var(--ok)" : "var(--err)" }}
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
                  Link IBKR to see your account, P&amp;L, and feed here. You'll enter
                  your IBKR login and approve a sign-in on the IBKR Mobile app.
                </div>
                {brokerErr && (
                  <details className="mt-2">
                    <summary className="muted fs-xs" style={{ cursor: "pointer" }}>
                      Couldn't reach your broker — details
                    </summary>
                    <div className="muted mono fs-2xs mt-1">{brokerErr}</div>
                  </details>
                )}
              </div>
              <button type="button" className="ghost" onClick={() => onGotoSettings?.()}>
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
            <span className="val" title="Connect a broker to confirm paper vs live">
              not connected
            </span>
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

function PowerIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 2 V7" />
      <path d="M4.8 4.2 a4.5 4.5 0 1 0 6.4 0" />
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
            fill={i === 0 ? "var(--accent)" : "var(--fg-muted)"}
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

function relAge(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
