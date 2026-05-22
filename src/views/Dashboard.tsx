// Dashboard — the launcher's home view.
//
// Three sections render conditionally:
//
//   1. License activation card — only when no license key is stored
//      in the OS keychain. First thing a customer sees on first
//      launch so they can't miss it.
//
//   2. Quick Actions — "Open Auracle" always; other actions only
//      when there's something to act on.
//
//   3. Containers — only when the launcher detects an installed
//      stack. When no install is present (AURACLE_INSTALL_DIR
//      missing/empty), the section is silently omitted rather than
//      showing a "backend unavailable" error.
//
// Stack status polls every 5s while this view is mounted. The
// effect cleanup tears the interval down on unmount so we're not
// spawning a docker-compose-ps subprocess every 5s after the user
// switches tabs.

import { useCallback, useEffect, useState } from "react";

import {
  cmd,
  type BrokerAccountSummary,
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
      <BrokerSection />
      <h2>Quick Actions</h2>
      <div className="card">
        <div className="row">
          <div>Open the Auracle dashboard in your browser</div>
          <OpenAuracleButton />
        </div>
      </div>
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Parallel fan-out — neither call blocks the other. Both are
      // best-effort: if one fails the other still renders.
      const [s, p] = await Promise.allSettled([
        cmd.brokerAccountSummary(),
        cmd.brokerOpenPositions(),
      ]);
      if (s.status === "fulfilled") {
        setSummary(s.value);
        setError(null);
      } else {
        setSummary(null);
        setError(String(s.reason));
      }
      setPositions(p.status === "fulfilled" ? p.value.rows : []);
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
        <h2 style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>Broker</span>
          <button
            type="button"
            className="ghost"
            onClick={refresh}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            Retry
          </button>
        </h2>
        <div className="card">
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            No broker connected. Open <strong>Settings → Broker Connections</strong> to
            link IBKR, then your account summary and open positions will
            stream into this card.
          </p>
          <pre
            className="muted mono"
            style={{
              marginTop: 8,
              padding: 8,
              background: "var(--bg-alt)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              fontSize: 11,
              overflow: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {error}
          </pre>
        </div>
      </>
    );
  }

  return (
    <>
      <h2 style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>Broker</span>
        {loading && (
          <span className="muted mono" style={{ fontSize: 11 }}>
            refreshing…
          </span>
        )}
        <button
          type="button"
          className="ghost"
          onClick={refresh}
          style={{ fontSize: 12, padding: "4px 10px", marginLeft: "auto" }}
        >
          Refresh
        </button>
      </h2>
      <div className="card">
        {summary && (
          <BrokerKpiRow summary={summary} />
        )}
        {positions !== null && positions.length > 0 && (
          <BrokerPositionsList positions={positions} />
        )}
        {positions !== null && positions.length === 0 && summary && (
          <div className="muted mono" style={{ fontSize: 12, marginTop: 8 }}>
            No open positions.
          </div>
        )}
      </div>
    </>
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

  const cards: { label: string; value: string; color?: string }[] = [
    { label: "Net liq", value: fmt(summary.net_liquidation) },
    { label: "Buying power", value: fmt(summary.buying_power) },
    { label: "Available", value: fmt(summary.available_funds) },
    {
      label: "Unrealized P&L",
      value: fmtSigned(summary.unrealized_pnl),
      color:
        (summary.unrealized_pnl ?? 0) > 0
          ? "var(--ok, #4ade80)"
          : (summary.unrealized_pnl ?? 0) < 0
            ? "var(--err, #f87171)"
            : undefined,
    },
  ];

  return (
    <div>
      <div className="muted mono" style={{ fontSize: 11, marginBottom: 8 }}>
        account · {summary.account_id} · {summary.currency}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cards.length}, 1fr)`,
          gap: 8,
        }}
      >
        {cards.map((c) => (
          <div
            key={c.label}
            style={{
              padding: "10px 12px",
              background: "var(--bg-alt)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          >
            <div
              className="muted"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 4,
              }}
            >
              {c.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: c.color ?? "var(--fg)",
              }}
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
    <div style={{ marginTop: 16 }}>
      <div
        className="muted"
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 6,
        }}
      >
        Top positions
      </div>
      <table
        className="mono"
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--fg-dim)" }}>
            <th style={{ padding: "4px 8px", textAlign: "left", fontWeight: 400 }}>Symbol</th>
            <th style={{ padding: "4px 8px", textAlign: "right", fontWeight: 400 }}>Qty</th>
            <th style={{ padding: "4px 8px", textAlign: "right", fontWeight: 400 }}>Mkt Val</th>
            <th style={{ padding: "4px 8px", textAlign: "right", fontWeight: 400 }}>P&L</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const pnl = p.unrealized_pnl ?? 0;
            const pnlColor =
              pnl > 0
                ? "var(--ok, #4ade80)"
                : pnl < 0
                  ? "var(--err, #f87171)"
                  : "var(--fg)";
            return (
              <tr
                key={p.symbol}
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <td style={{ padding: "6px 8px" }}>{p.symbol}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {p.quantity?.toLocaleString("en-US") ?? "—"}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {p.market_value !== null
                    ? p.market_value.toLocaleString("en-US", {
                        style: "currency",
                        currency: p.currency,
                        maximumFractionDigits: 0,
                      })
                    : "—"}
                </td>
                <td
                  style={{
                    padding: "6px 8px",
                    textAlign: "right",
                    color: pnlColor,
                  }}
                >
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
        <div
          className="muted mono"
          style={{ fontSize: 11, marginTop: 4 }}
        >
          showing top {sorted.length} of {positions.length}
        </div>
      )}
    </div>
  );
}

// ── Open Auracle ────────────────────────────────────────────────

function OpenAuracleButton() {
  const onClick = async () => {
    // Two-mode open: embedded WebviewWindow (native feel) or
    // external browser. Preference lives in view-mode.json; default
    // is 'browser' for fresh installs (matches pre-v0.2.0 behavior).
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

    // Browser path: prefer the dashboard URL if the stack is
    // healthy, otherwise drop the user on /ui/setup so they can
    // diagnose the failed startup.
    let url = "http://localhost:1969/ui/setup";
    try {
      const h = await cmd.currentHealth();
      if (h?.state === "healthy") url = "http://localhost:1969/ui/dashboard";
    } catch {
      // ignore
    }
    await openInBrowser(url);
  };

  return (
    <button type="button" className="primary" onClick={onClick}>
      Open Auracle
    </button>
  );
}

// ── License activation ──────────────────────────────────────────

function LicenseSection() {
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);

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

  if (stored && !editing) {
    return (
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <strong>License active</strong>
          <div className="muted mono" style={{ marginTop: 2 }}>
            {stored.slice(0, 16)}…
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge ok">activated</span>
          <button
            type="button"
            className="ghost"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
          <button
            type="button"
            className="ghost danger"
            onClick={async () => {
              if (
                !confirm(
                  "Remove the stored license key? You can paste it again from your email anytime.",
                )
              )
                return;
              try {
                await cmd.licenseClear();
                refresh();
              } catch (err) {
                alert("Could not clear: " + err);
              }
            }}
          >
            Clear
          </button>
        </div>
      </div>
    );
  }

  return (
    <ActivationCard
      onSaved={() => {
        setEditing(false);
        refresh();
      }}
    />
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
      <h2 style={{ marginTop: 0 }}>Activate Auracle</h2>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        Paste the license key from your purchase email.
      </p>
      <input
        type="password"
        placeholder="akey_…"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button type="button" className="primary" onClick={save}>
          Save
        </button>
        <span className="muted mono">{status}</span>
      </div>
    </div>
  );
}

// ── Containers ──────────────────────────────────────────────────

function ContainersSection() {
  const [status, setStatus] = useState<StackStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let handle: number | undefined;

    const tick = async () => {
      try {
        const s = await cmd.stackStatus();
        if (!cancelled) setStatus(s);
      } catch {
        // Transient docker-compose error — leave the previous paint
        // up rather than blanking the section.
        if (!cancelled && status === undefined) setStatus(null);
      }
    };

    tick().then(() => {
      if (!cancelled) handle = window.setInterval(tick, 5_000);
    });

    return () => {
      cancelled = true;
      if (handle !== undefined) window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === undefined) return null;             // initial probe in flight
  if (!status || status.containers.length === 0) {
    return null;                                     // no install — silent
  }

  return (
    <>
      <h2>Containers</h2>
      <div className="card">
        {status.containers.map((c) => (
          <div className="row" key={c.name}>
            <div>
              <strong>{c.name}</strong>
              <div className="muted mono" style={{ marginTop: 2 }}>
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
