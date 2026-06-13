// Dashboard — the launcher's home view.
//
// Three sections render conditionally:
//
//   1. License card — section appears with an activation form when no
//      key is stored in the OS keychain, or a quiet active card when
//      one is. First thing a customer sees on first launch.
//
//   2. Workspaces — the one door into the web product.
//
//   3. Broker glance + Containers — only when there's something to
//      show. When no install is present the containers section is
//      silently omitted rather than showing a "backend unavailable"
//      error.
//
// Stack status polls every 5s while this view is mounted. The
// effect cleanup tears the interval down on unmount so we're not
// spawning a docker-compose-ps subprocess every 5s after the user
// switches tabs.

import { useCallback, useEffect, useRef, useState } from "react";

import ConfirmRow from "@/components/ConfirmRow";
import IncidentCard from "@/components/IncidentCard";
import {
  cmd,
  type BrokerAccountSummary,
  type BrokerDataQuality,
  type BrokerMarketDataStatus,
  type BrokerPosition,
  type ContainerStatus,
  type StackStatus,
  openInBrowser,
} from "@/lib/tauri";

export default function Dashboard() {
  return (
    <>
      <h1>Auracle</h1>
      <LicenseSection />

      {/* The launcher boots the engine, then hands the user into the
          Auracle IDE — the native workspace app and the primary door.
          The web console stays one click away (capability retention),
          and an honest line appears if the IDE isn't installed. */}
      <WorkspaceDoor />

      <BrokerSection />
      <ContainersSection />
    </>
  );
}

// ── Broker readout ──────────────────────────────────────────────
//
// Pulls live account summary + top positions from whichever broker
// the user has connected. Falls back to a short "connect a broker"
// prompt when no source is reachable. Refreshes every 30s while
// the view is mounted + visible.

function BrokerSection() {
  const [summary, setSummary] = useState<BrokerAccountSummary | null>(null);
  const [positions, setPositions] = useState<BrokerPosition[] | null>(null);
  const [marketData, setMarketData] = useState<BrokerMarketDataStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Parallel fan-out — neither call blocks the others. All
      // best-effort: if one fails the rest still render.
      const [s, p, md] = await Promise.allSettled([
        cmd.brokerAccountSummary(),
        cmd.brokerOpenPositions(),
        cmd.brokerMarketDataStatus(),
      ]);
      if (s.status === "fulfilled") {
        setSummary(s.value);
        setError(null);
      } else {
        setSummary(null);
        setError(String(s.reason));
      }
      setPositions(p.status === "fulfilled" ? p.value.rows : []);
      setMarketData(md.status === "fulfilled" ? md.value : null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    };
    const handle = window.setInterval(tick, 30_000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  // No broker connected — render a compact prompt instead of a
  // full card with empty rows.
  if (!summary && error) {
    return (
      <>
        <div className="section-head">
          <h2>Broker</h2>
          <div className="section-head__actions">
            <button type="button" className="ghost btn-sm" onClick={refresh}>
              Retry
            </button>
          </div>
        </div>
        <div className="card">
          <p className="muted m-0 fs-sm">
            No broker connected. Open <strong>Settings → Broker Connections</strong> to
            link IBKR, then your account summary and open positions will
            stream into this card.
          </p>
          <pre className="logs logs-compact mt-2">{error}</pre>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="section-head">
        <h2>Broker</h2>
        {marketData && <DataQualityBadge quality={marketData.us_equity} />}
        {loading && <span className="muted mono fs-xs">refreshing…</span>}
        {/* Quick-glance only — full portfolio + order management lives in
            the web Trade view (R-4: keep the glance, link out for depth). */}
        <div className="section-head__actions">
          <button
            type="button"
            className="ghost btn-sm"
            onClick={() => { void openAuracle("/blotter"); }}
            title="Open the full Trade view in Auracle"
          >
            Open Trade →
          </button>
          <button type="button" className="ghost btn-sm" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>
      <div className="card">
        {summary && <BrokerKpiRow summary={summary} />}
        {positions !== null && positions.length > 0 && (
          <BrokerPositionsList positions={positions} />
        )}
        {positions !== null && positions.length === 0 && summary && (
          <div className="muted mono fs-xs mt-2">
            No open positions.
          </div>
        )}
      </div>
    </>
  );
}

/** Compact pill showing the user's market-data subscription tier
 *  for US equities (derived from probing the gateway with a SPY
 *  snapshot). Renders next to the section heading so the user
 *  always knows whether prices on this page are real-time or
 *  trailing the tape. */
function DataQualityBadge({ quality }: { quality: BrokerDataQuality }) {
  const cfg: Record<BrokerDataQuality, { variant: string; label: string; title: string }> = {
    realtime: {
      variant: "ok",
      label: "real-time",
      title: "Live US equity data — your IBKR subscription includes real-time quotes.",
    },
    delayed: {
      variant: "warn",
      label: "15-min delayed",
      title:
        "Delayed US equity data. Upgrade your IBKR market-data subscription for real-time quotes.",
    },
    frozen: {
      variant: "neutral",
      label: "frozen",
      title: "Last-known quote (market closed or feed paused).",
    },
    closed: {
      variant: "neutral",
      label: "market closed",
      title: "US equity market is closed; values are the closing prices.",
    },
    halted: {
      variant: "err",
      label: "halted",
      title: "Trading is halted on at least one of the displayed symbols.",
    },
    unknown: {
      variant: "neutral",
      label: "tier unknown",
      title:
        "Couldn't determine your data tier — gateway response didn't carry the availability code.",
    },
  };
  const c = cfg[quality] ?? cfg.unknown;
  return (
    <span className={`chip ${c.variant}`} title={c.title}>
      {c.label}
    </span>
  );
}

function BrokerKpiRow({ summary }: { summary: BrokerAccountSummary }) {
  const fmt = (v: number | null, opts: Intl.NumberFormatOptions = {}) =>
    v === null || v === undefined
      ? "—"
      : v.toLocaleString("en-US", {
          style: "currency",
          currency: summary.currency || "USD",
          maximumFractionDigits: 0,
          ...opts,
        });
  const fmtSigned = (v: number | null) =>
    v === null
      ? "—"
      : `${v >= 0 ? "+" : ""}${v.toLocaleString("en-US", {
          style: "currency",
          currency: summary.currency || "USD",
          maximumFractionDigits: 2,
        })}`;

  const pnl = summary.unrealized_pnl ?? 0;
  const cards: { label: string; value: string; tone?: "ok" | "err" }[] = [
    { label: "Net liq", value: fmt(summary.net_liquidation) },
    { label: "Buying power", value: fmt(summary.buying_power) },
    { label: "Available", value: fmt(summary.available_funds) },
    {
      label: "Unrealized P&L",
      value: fmtSigned(summary.unrealized_pnl),
      tone: pnl > 0 ? "ok" : pnl < 0 ? "err" : undefined,
    },
  ];

  return (
    <div>
      <div className="micro-label mb-2">
        account · {summary.account_id} · {summary.currency}
      </div>
      <div
        className="kpi-grid"
        style={{ gridTemplateColumns: `repeat(${cards.length}, 1fr)` }}
      >
        {cards.map((c) => (
          <div className="kpi" key={c.label}>
            <div className="micro-label mb-1">{c.label}</div>
            <div
              className={`kpi__value${
                c.tone === "ok" ? " ok-text" : c.tone === "err" ? " err-text" : ""
              }`}
            >
              {c.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BrokerPositionsList({ positions }: { positions: BrokerPosition[] }) {
  // Sort by absolute market value descending — biggest exposures first.
  const sorted = [...positions]
    .sort(
      (a, b) =>
        Math.abs(b.market_value ?? 0) - Math.abs(a.market_value ?? 0),
    )
    .slice(0, 6);

  return (
    <div className="mt-4">
      <div className="micro-label mb-2">Top positions</div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="cell">Symbol</th>
            <th className="cell-num">Qty</th>
            <th className="cell-num">Mkt Val</th>
            <th className="cell-num">P&L</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const pnl = p.unrealized_pnl ?? 0;
            const pnlClass =
              pnl > 0 ? " ok-text" : pnl < 0 ? " err-text" : "";
            return (
              <tr key={p.symbol}>
                <td className="cell">{p.symbol}</td>
                <td className="cell-num">
                  {p.quantity?.toLocaleString("en-US") ?? "—"}
                </td>
                <td className="cell-num">
                  {p.market_value !== null
                    ? p.market_value.toLocaleString("en-US", {
                        style: "currency",
                        currency: p.currency,
                        maximumFractionDigits: 0,
                      })
                    : "—"}
                </td>
                <td className={`cell-num${pnlClass}`}>
                  {pnl >= 0 ? "+" : ""}
                  {pnl.toLocaleString("en-US", {
                    style: "currency",
                    currency: p.currency,
                    maximumFractionDigits: 2,
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {positions.length > sorted.length && (
        <div className="muted mono fs-xs mt-1">
          showing top {sorted.length} of {positions.length}
        </div>
      )}
    </div>
  );
}

// ── Workspaces (entry cards) ────────────────────────────────────

/** The launcher's primary door. "Open Auracle IDE" launches the
 *  native workspace app; the web console stays available as a
 *  secondary action. If the IDE isn't installed, an honest line says
 *  so and offers the web console — never a silent failure. */
function WorkspaceDoor() {
  const [ideError, setIdeError] = useState<string | null>(null);

  return (
    <div className="mb-3" style={{ maxWidth: 440 }}>
      <LaunchCard
        primary
        title="Open Auracle IDE"
        description="Your workspace — research, build, validate, paper-trade, go live."
        onClick={() => {
          setIdeError(null);
          void cmd.openAuracleIDE().catch((err) => setIdeError(String(err)));
        }}
      />
      {ideError && (
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--fg-muted)" }}>
          {ideError}
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <LaunchCard
          title="Open the web console"
          description="The browser version — Home, Build, Research, Trade, Seer."
          onClick={() => {
            void openAuracle();
          }}
        />
      </div>
    </div>
  );
}

/** The single canonical door into the web product. Two-mode open:
 *  embedded WebviewWindow (native feel) or external browser.
 *  Preference lives in view-mode.json; default is 'browser' for fresh
 *  installs (matches pre-v0.2.0 behavior). */
async function openAuracle(path: string = ""): Promise<void> {
  // ``path`` deep-links a specific web surface (e.g. "/blotter" for Trade)
  // in browser mode. Embedded mode opens the platform window at /ui (the
  // embedded webview is reused/focused, so it doesn't deep-link).
  const safePath = path.startsWith("/") ? path : "";

  let mode: "browser" | "embedded" = "browser";
  try {
    mode = await cmd.getViewMode();
  } catch {
    // Backend unavailable — fall through to the browser path.
  }

  if (mode === "embedded") {
    try {
      await cmd.openEmbeddedAuracle();
      return;
    } catch (err) {
      // Embedded window failed to spawn — fall through to browser
      // so the customer still gets where they were going.
      console.warn("embedded open failed, falling back to browser:", err);
    }
  }

  // Browser path: deep-link the requested surface if the stack is healthy,
  // otherwise drop the user on /ui/setup so they can diagnose the
  // failed startup.
  let url = "http://localhost:1969/ui/setup";
  try {
    const h = await cmd.currentHealth();
    if (h?.state === "healthy") {
      url = "http://localhost:1969/ui" + (safePath || "/dashboard");
    }
  } catch {
    // ignore
  }
  await openInBrowser(url);
}

/** A large, calm, clickable entry card. The whole card is the button
 *  — the arrow + hover accent signal that. `primary` gives the one
 *  platform door a stronger emerald treatment. */
function LaunchCard({
  title,
  description,
  primary,
  onClick,
}: {
  title: string;
  description: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`launch-card${primary ? " launch-card--primary" : ""}`}
      onClick={onClick}
    >
      <span className="launch-card__arrow" aria-hidden="true">
        →
      </span>
      <span className="launch-card__title">{title}</span>
      <span className="launch-card__desc">{description}</span>
    </button>
  );
}

// ── License ─────────────────────────────────────────────────────

function LicenseSection() {
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const value = await cmd.licenseGet();
      setStored(value);
    } catch {
      // Keychain access failed — likely first launch with no
      // permission yet. Show the prompt so they can save one
      // (which will trigger the keychain permission grant).
      setStored(null);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (stored === undefined) {
    return null; // initial fetch in flight
  }

  return (
    <>
      <h2>License</h2>
      {stored && !editing ? (
        <div className="card">
          <div className="wrap-row">
            <div style={{ flex: 1 }}>
              <strong>License active</strong>
              <div className="muted mono mt-1">{stored.slice(0, 16)}…</div>
            </div>
            <span className="badge ok">activated</span>
            <button type="button" className="ghost" onClick={() => setEditing(true)}>
              Change
            </button>
            <ConfirmRow
              trigger="Clear"
              title="Remove the stored license key?"
              body="You can paste it again from your purchase email anytime."
              confirmLabel="Remove"
              onConfirm={async () => {
                setClearError(null);
                try {
                  await cmd.licenseClear();
                  refresh();
                } catch (err) {
                  setClearError("Could not clear: " + err);
                }
              }}
            />
          </div>
          {clearError && <div className="err-text fs-xs mt-2">{clearError}</div>}
        </div>
      ) : (
        <ActivationCard
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ActivationCard({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setStatus("Paste a key first.");
      return;
    }
    try {
      await cmd.licenseSet(v);
      setStatus("Saved.");
      setTimeout(onSaved, 600);
    } catch (err) {
      setStatus("Could not save: " + err);
    }
  };

  return (
    <div className="card">
      <p className="muted m-0 mb-3">
        Paste the license key from your purchase email to activate Auracle.
      </p>
      <input
        type="password"
        placeholder="akey_…"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="hstack mt-4">
        <button type="button" className="primary" onClick={save}>
          Save
        </button>
        <span
          className={
            /^(Could not|Paste)/.test(status)
              ? "err-text fs-xs"
              : "muted mono fs-xs"
          }
        >
          {status}
        </span>
      </div>
    </div>
  );
}

// ── Containers ──────────────────────────────────────────────────

function ContainersSection() {
  const [status, setStatus] = useState<StackStatus | null | undefined>(undefined);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const alive = useRef(true);

  const probe = useCallback(async () => {
    try {
      const s = await cmd.stackStatus();
      if (alive.current) {
        setStatus(s);
        setProbeError(null);
      }
    } catch (err) {
      // Transient docker-compose error — keep the previous paint up
      // rather than blanking the rows, but SAY that the check failed:
      // a section that silently vanishes on probe failure is
      // indistinguishable from "no install".
      if (alive.current) {
        setStatus((prev) => (prev === undefined ? null : prev));
        setProbeError(String(err));
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let handle: number | undefined;
    probe().then(() => {
      if (alive.current) handle = window.setInterval(() => void probe(), 5_000);
    });
    return () => {
      alive.current = false;
      if (handle !== undefined) window.clearInterval(handle);
    };
  }, [probe]);

  const retry = async () => {
    setRetrying(true);
    try {
      await probe();
    } finally {
      setRetrying(false);
    }
  };

  if (status === undefined) return null;             // initial probe in flight

  // Probe failed with nothing ever painted: Docker isn't answering at
  // all. This is an incident, not an empty state.
  if (status === null) {
    if (!probeError) return null;
    return (
      <>
        <h2>Containers</h2>
        <IncidentCard
          severity="warn"
          cause="Container status unavailable — last check failed."
          action={{
            label: retrying ? "Retrying…" : "Retry",
            onClick: retry,
            busy: retrying,
          }}
        />
      </>
    );
  }

  if (status.containers.length === 0) {
    return null;                                     // no install — silent
  }

  return (
    <>
      <h2>Containers</h2>
      {probeError && (
        <IncidentCard
          severity="warn"
          cause="Container status unavailable — last check failed."
          detail="Showing the last successful check."
          action={{
            label: retrying ? "Retrying…" : "Retry",
            onClick: retry,
            busy: retrying,
          }}
        />
      )}
      <div className="card">
        {status.containers.map((c) => (
          <div className="row" key={c.name}>
            <div>
              <strong>{c.name}</strong>
              <div className="muted mono mt-1">
                state: {c.state}
                {c.health ? ` · health: ${c.health}` : ""}
              </div>
            </div>
            {badgeFor(c)}
          </div>
        ))}
      </div>
    </>
  );
}

function badgeFor(c: ContainerStatus) {
  if (c.state !== "running")    return <span className="badge err">down</span>;
  if (c.health === "unhealthy") return <span className="badge err">unhealthy</span>;
  if (c.health === "starting")  return <span className="badge warn">starting</span>;
  return <span className="badge ok">healthy</span>;
}
