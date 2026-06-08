// BrokerConnections — Settings card showing the live state of every
// broker integration and the next action the user can take per
// connection.
//
// Rendered states (driven by BrokerStatus.state.state):
//
//   offline          → install / start instructions inline
//   unauthenticated  → "Connect" button that opens IBKR login webview
//   connected        → account id readout + Test + Disconnect controls
//   error            → red pill + detail; "Refresh" retries
//   not_implemented  → ghost pill + "coming soon"

import { useCallback, useEffect, useState } from "react";

import IbeamSetup from "@/views/IbeamSetup";
import {
  cmd,
  openInBrowser,
  type BrokerState,
  type BrokerStatus,
} from "@/lib/tauri";

export default function BrokerConnectionsCard() {
  const [statuses, setStatuses] = useState<BrokerStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [houstonConflict, setHoustonConflict] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await cmd.forgeBrokerStatus();
      setStatuses(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshing(false);
    }
    // Probe for the Houston-managed IBKR gateway container — it's
    // the predecessor of the launcher's ibeam path and the two
    // can't coexist (both bind port 5000). Surface a clear
    // conflict notice if it's running so the user knows to take
    // one path or the other.
    try {
      const found = await cmd.dockerContainerRunning([
        "auracle-cpgateway",
        "auracle-ibgateway",
        "ibgateway",
        "cpgateway",
      ]);
      setHoustonConflict(found);
    } catch {
      setHoustonConflict(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 15s ONLY while the user has the Settings view
  // open AND there's at least one broker mid-flight (unauthenticated
  // is the most common case — they clicked Connect, the login window
  // popped open, now they're entering credentials; we want to flip
  // the card to Connected the moment that completes without making
  // them hit Refresh).
  useEffect(() => {
    if (!statuses) return;
    const needsPoll = statuses.some(
      (s) =>
        s.state.state === "unauthenticated" || s.state.state === "offline",
    );
    if (!needsPoll) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, 15000);
    return () => clearInterval(interval);
  }, [statuses, refresh]);

  return (
    <>
      <h2 style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>Broker Connections</span>
        <button
          type="button"
          className="ghost"
          onClick={refresh}
          disabled={refreshing}
          style={{ fontSize: 12, padding: "4px 10px" }}
        >
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </h2>
      <div className="card">
        <CanonicalSourceBanner />
        {houstonConflict && (
          <HoustonConflictBanner
            containerName={houstonConflict}
            onResolved={refresh}
          />
        )}
        {error && (
          <div className="muted mono" style={{ color: "var(--err)", marginBottom: 12 }}>
            {error}
          </div>
        )}
        {!statuses && !error && (
          <div className="muted mono" style={{ padding: 8 }}>
            probing brokers…
          </div>
        )}
        {statuses && <BrokerList statuses={statuses} onRefresh={refresh} />}
      </div>
    </>
  );
}

/** Splits brokers into real integrations (full rows) and not-yet-shipped
 *  ones. The latter used to render three full label/description/pill
 *  blocks that did nothing but take space — they now collapse into a
 *  single muted "on the roadmap" line, so the card is all signal. */
function BrokerList({
  statuses,
  onRefresh,
}: {
  statuses: BrokerStatus[];
  onRefresh: () => void;
}) {
  const real = statuses.filter((b) => b.state.state !== "not_implemented");
  const soon = statuses.filter((b) => b.state.state === "not_implemented");
  return (
    <>
      {real.map((b) => (
        <BrokerRow key={b.id} broker={b} onRefresh={onRefresh} />
      ))}
      {soon.length > 0 && (
        <div className="broker-soon">
          More brokers on the roadmap — {soon.map((b) => b.label).join(" · ")}.
        </div>
      )}
    </>
  );
}

/** Header explaining the role of this card: one broker session,
 *  consumed by every surface (Forge agent, launcher Dashboard,
 *  Houston web UI). The card owns connection + auth state; the
 *  other surfaces read from it. */
function CanonicalSourceBanner() {
  return (
    <div
      style={{
        padding: 10,
        marginBottom: 12,
        background: "rgba(96,165,250,0.08)",
        border: "1px solid rgba(96,165,250,0.25)",
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.6,
        color: "var(--fg-dim)",
      }}
    >
      <strong style={{ color: "var(--fg)" }}>One connection, everywhere.</strong>
      {" "}
      Set up your broker once here — the launcher, Forge, and the web UI all use it.
    </div>
  );
}

/** Conflict banner — shown when Houston's bundled IBKR gateway
 *  container is currently running. It and the launcher-managed
 *  ibeam container both bind localhost:5000, so one of them has to
 *  yield. Default recommendation is to let the launcher take over
 *  (auto-reauth is the whole point) but provide both paths. */
function HoustonConflictBanner({
  containerName,
  onResolved,
}: {
  containerName: string;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const takeOver = async () => {
    setBusy(true);
    setError(null);
    try {
      // Operate directly on the container name we detected — no
      // compose intermediary, so the action works even when the
      // stack's .env is missing optional vars (POSTGRES_PASSWORD,
      // IBKR_USER, etc.) that would otherwise cause compose to
      // fail before it reaches the rm.
      await cmd.dockerRemoveContainer(containerName);
      onResolved();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        padding: 10,
        marginBottom: 12,
        background: "rgba(251,191,36,0.08)",
        border: "1px solid rgba(251,191,36,0.35)",
        borderRadius: 4,
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <div style={{ color: "var(--fg)", marginBottom: 6 }}>
        <strong>Port already in use</strong> — the Auracle stack is currently
        running its own IBKR gateway container (<code>{containerName}</code>)
        on the port the launcher&apos;s auto-managed connection wants
        (<code>localhost:5000</code>).
      </div>
      <div style={{ color: "var(--fg-dim)", marginBottom: 8 }}>
        Free it and the launcher hosts the connection for every surface —
        and re-logs in for you on IBKR&apos;s daily reset, so no more 24-hour
        re-login.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className="primary"
          onClick={takeOver}
          disabled={busy}
          style={{ fontSize: 12 }}
        >
          {busy ? "Stopping…" : "Free the port"}
        </button>
        <span className="muted mono" style={{ fontSize: 10 }}>
          stops <code>{containerName}</code>
        </span>
      </div>
      {error && (
        <div
          className="muted mono"
          style={{ color: "var(--err)", fontSize: 11, marginTop: 6 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function BrokerRow({
  broker,
  onRefresh,
}: {
  broker: BrokerStatus;
  onRefresh: () => void;
}) {
  // IBKR row delegates ALL action surface to the IbeamSetup sub-card
  // below — that card owns the install/start/stop/restart/logs flow.
  // Suppressing BrokerDetail + BrokerActions for IBKR prevents
  // doubled-up "Gateway didn't respond" + "Get gateway" controls
  // that say the same thing the ibeam card already says, just less
  // actionably. Other brokers (Alpaca, Tradier, Hyperliquid) still
  // render the full original action surface.
  const isIbkr = broker.id === "ibkr";

  return (
    <div
      style={{
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <strong>{broker.label}</strong>
            <StatePill state={broker.state} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {broker.description}
          </div>
          {!isIbkr && <BrokerDetail broker={broker} />}
        </div>
        {!isIbkr && <BrokerActions broker={broker} onRefresh={onRefresh} />}
      </div>
      {isIbkr && <IbeamSetup onStateChange={onRefresh} />}
    </div>
  );
}

function StatePill({ state }: { state: BrokerState }) {
  const styles: Record<BrokerState["state"], { bg: string; fg: string; label: string }> = {
    offline: { bg: "rgba(248,113,113,0.15)", fg: "#fca5a5", label: "offline" },
    unauthenticated: {
      bg: "rgba(251,191,36,0.15)",
      fg: "#fcd34d",
      label: "log in needed",
    },
    connected: { bg: "rgba(74,222,128,0.15)", fg: "#86efac", label: "connected" },
    error: { bg: "rgba(248,113,113,0.15)", fg: "#fca5a5", label: "error" },
    not_implemented: {
      bg: "rgba(148,163,184,0.15)",
      fg: "#cbd5e1",
      label: "coming soon",
    },
  };
  const s = styles[state.state];
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        padding: "2px 8px",
        background: s.bg,
        color: s.fg,
        borderRadius: 999,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {s.label}
    </span>
  );
}

function BrokerDetail({ broker }: { broker: BrokerStatus }) {
  const s = broker.state;
  if (s.state === "offline") {
    return (
      <pre
        className="mono"
        style={{
          fontSize: 11,
          marginTop: 8,
          padding: 10,
          background: "var(--bg-alt)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          overflow: "auto",
          color: "var(--fg-dim)",
          whiteSpace: "pre-wrap",
        }}
      >
        {s.hint}
      </pre>
    );
  }
  if (s.state === "error") {
    return (
      <div
        className="muted mono"
        style={{ fontSize: 11, marginTop: 6, color: "var(--err)" }}
      >
        {s.detail}
      </div>
    );
  }
  if (s.state === "connected") {
    return (
      <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>
        account · {s.account_id}
        {s.account_label ? ` · ${s.account_label}` : null}
      </div>
    );
  }
  if (s.state === "unauthenticated") {
    return (
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Gateway is running — log in to start pulling data.
      </div>
    );
  }
  return null;
}

function BrokerActions({
  broker,
  onRefresh,
}: {
  broker: BrokerStatus;
  onRefresh: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const s = broker.state;

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await cmd.forgeBrokerTest(broker.id);
      // result is the raw JSON string of the account summary
      const parsed = (() => {
        try {
          return JSON.parse(result);
        } catch {
          return result;
        }
      })();
      const summary =
        typeof parsed === "object" && parsed !== null
          ? `net liq ${(parsed as Record<string, unknown>).net_liquidation ?? "?"} · ${
              (parsed as Record<string, unknown>).currency ?? "?"
            }`
          : String(parsed);
      setTestResult({ ok: true, msg: summary });
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) });
    } finally {
      setTesting(false);
    }
  };

  if (s.state === "not_implemented") {
    return (
      <span className="muted mono" style={{ fontSize: 11 }}>
        roadmap
      </span>
    );
  }

  if (s.state === "offline") {
    return (
      <button
        type="button"
        className="ghost"
        onClick={() => openInBrowser("https://www.interactivebrokers.com/en/trading/ib-api.php#client-portal-api")}
        style={{ fontSize: 12 }}
      >
        Get gateway
      </button>
    );
  }

  if (s.state === "unauthenticated") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <button
          type="button"
          className="primary"
          onClick={async () => {
            try {
              await cmd.openIbkrLogin(s.login_url);
            } catch (err) {
              // Embedded webview might error on self-signed cert
              // first time — fall back to the user's default browser.
              console.warn("openIbkrLogin failed, falling back:", err);
              await openInBrowser(s.login_url);
            }
            // Poll once after a short delay; the auto-poll above
            // handles the steady state.
            setTimeout(onRefresh, 4000);
          }}
          style={{ fontSize: 12 }}
        >
          Connect
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => openInBrowser(s.login_url)}
          style={{ fontSize: 11 }}
        >
          Open in browser
        </button>
      </div>
    );
  }

  if (s.state === "connected") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <button
          type="button"
          className="ghost"
          onClick={runTest}
          disabled={testing}
          style={{ fontSize: 12 }}
        >
          {testing ? "Testing…" : "Test pull"}
        </button>
        {testResult && (
          <div
            className="muted mono"
            style={{
              fontSize: 10,
              color: testResult.ok ? "var(--ok, #4ade80)" : "var(--err)",
              maxWidth: 200,
              textAlign: "right",
              whiteSpace: "pre-wrap",
            }}
          >
            {testResult.ok ? "✓ " : "✗ "}
            {testResult.msg}
          </div>
        )}
      </div>
    );
  }

  if (s.state === "error") {
    return (
      <button
        type="button"
        className="ghost"
        onClick={onRefresh}
        style={{ fontSize: 12 }}
      >
        Retry
      </button>
    );
  }

  return null;
}
