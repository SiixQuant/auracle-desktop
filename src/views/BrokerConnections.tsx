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
        {statuses?.map((b) => <BrokerRow key={b.id} broker={b} onRefresh={refresh} />)}
      </div>
    </>
  );
}

function BrokerRow({
  broker,
  onRefresh,
}: {
  broker: BrokerStatus;
  onRefresh: () => void;
}) {
  return (
    <div
      className="row"
      style={{
        alignItems: "flex-start",
        padding: "10px 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <strong>{broker.label}</strong>
          <StatePill state={broker.state} />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {broker.description}
        </div>
        <BrokerDetail broker={broker} />
      </div>
      <BrokerActions broker={broker} onRefresh={onRefresh} />
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
