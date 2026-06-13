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

import IncidentCard from "@/components/IncidentCard";
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
    <div className="card">
      <div className="card-head">
        <span className="card-title">Broker connections</span>
        <button
          type="button"
          className="ghost btn-sm"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>
      <CanonicalSourceBanner />
        {houstonConflict && (
          <HoustonConflictBanner
            containerName={houstonConflict}
            onResolved={refresh}
          />
        )}
        {error && (
          <div className="mono err-text mb-3">
            {error}
          </div>
        )}
        {!statuses && !error && (
          <div className="muted mono fs-xs mt-1">
            probing brokers…
          </div>
        )}
        {statuses && <BrokerList statuses={statuses} onRefresh={refresh} />}
    </div>
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
    <p className="muted fs-sm m-0 mb-3">
      One connection for everything — set it up once.
    </p>
  );
}

/** Port conflict — Houston's bundled IBKR gateway and the launcher's
 *  ibeam container both bind localhost:5000, so one has to yield.
 *  Default recommendation: let the launcher take over (auto-reauth is
 *  the whole point). Renders through the shared incident contract;
 *  the action operates directly on the detected container name — no
 *  compose intermediary, so it works even when the stack's .env is
 *  missing optional vars that would fail compose before the rm. */
function HoustonConflictBanner({
  containerName,
  onResolved,
}: {
  containerName: string;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <IncidentCard
      severity="warn"
      cause="Port already in use — the stack's IBKR gateway holds localhost:5000."
      detail={`container: ${containerName}`}
      action={{
        label: busy ? "Stopping…" : "Free the port",
        primary: true,
        busy,
        onClick: async () => {
          setBusy(true);
          try {
            await cmd.dockerRemoveContainer(containerName);
            onResolved();
          } finally {
            setBusy(false);
          }
        },
      }}
    >
      <p className="muted fs-2xs m-0 lh-relaxed mt-2">
        Freeing it lets the launcher host the connection for every surface
        and re-log in on IBKR&apos;s daily session reset.
      </p>
    </IncidentCard>
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
    <div className="list-row">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="hstack">
            <strong>{broker.label}</strong>
            <StatePill state={broker.state} />
          </div>
          <div className="muted fs-xs mt-1">
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
  const cfg: Record<BrokerState["state"], { variant: string; label: string }> = {
    offline: { variant: "err", label: "offline" },
    unauthenticated: { variant: "warn", label: "log in needed" },
    connected: { variant: "ok", label: "connected" },
    error: { variant: "err", label: "error" },
    not_implemented: { variant: "neutral", label: "coming soon" },
  };
  const s = cfg[state.state];
  return <span className={`chip ${s.variant}`}>{s.label}</span>;
}

function BrokerDetail({ broker }: { broker: BrokerStatus }) {
  const s = broker.state;
  if (s.state === "offline") {
    return (
      <pre className="logs logs-compact mt-2">{s.hint}</pre>
    );
  }
  if (s.state === "error") {
    return (
      <div className="mono err-text mt-2">
        {s.detail}
      </div>
    );
  }
  if (s.state === "connected") {
    return (
      <div className="muted mono fs-xs mt-2">
        account · {s.account_id}
        {s.account_label ? ` · ${s.account_label}` : null}
      </div>
    );
  }
  if (s.state === "unauthenticated") {
    return (
      <div className="muted fs-xs mt-2">
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
      <span className="muted mono fs-xs">
        roadmap
      </span>
    );
  }

  if (s.state === "offline") {
    return (
      <button
        type="button"
        className="ghost fs-xs"
        onClick={() => openInBrowser("https://www.interactivebrokers.com/en/trading/ib-api.php#client-portal-api")}
      >
        Get gateway
      </button>
    );
  }

  if (s.state === "unauthenticated") {
    return (
      <div className="vstack">
        <button
          type="button"
          className="primary fs-xs"
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
        >
          Connect
        </button>
        <button
          type="button"
          className="ghost fs-xs"
          onClick={() => openInBrowser(s.login_url)}
        >
          Open in browser
        </button>
      </div>
    );
  }

  if (s.state === "connected") {
    return (
      <div className="vstack" style={{ alignItems: "flex-end" }}>
        <button
          type="button"
          className="ghost fs-xs"
          onClick={runTest}
          disabled={testing}
        >
          {testing ? "Testing…" : "Test pull"}
        </button>
        {testResult && (
          <div
            className={`mono fs-2xs ${testResult.ok ? "ok-text" : "err-text"}`}
            style={{ maxWidth: 200, textAlign: "right", whiteSpace: "pre-wrap" }}
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
        className="ghost fs-xs"
        onClick={onRefresh}
      >
        Retry
      </button>
    );
  }

  return null;
}
