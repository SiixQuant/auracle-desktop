// IbeamSetup — auto-managed IBKR gateway sub-card.
//
// Renders inside the IBKR row of Broker Connections. Drives the
// ibeam supervisor module (commands/ibeam.rs) — install, start,
// stop, restart, uninstall, log tail.
//
// State flow:
//
//   not_installed
//     → user enters credentials → ibeamInstall → ibeamStart
//   stopped (compose exists, container down)
//     → user hits Start → ibeamStart
//   running, auth_ok=false
//     → "container up, waiting for IBKR Mobile 2FA approval"
//     → user taps Approve on phone; poll auth state
//   running, auth_ok=true
//     → green "auto-managed" pill; only show Stop / View logs

import { useCallback, useEffect, useState } from "react";

import {
  cmd,
  type IbeamCredentials,
  type IbeamStatus,
} from "@/lib/tauri";

interface IbeamSetupProps {
  /** Fired when ibeam state changes meaningfully (install / start /
   *  stop) so the parent Broker Connections card can re-probe the
   *  IBKR connection state. */
  onStateChange: () => void;
}

export default function IbeamSetup({ onStateChange }: IbeamSetupProps) {
  const [status, setStatus] = useState<IbeamStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const s = await cmd.ibeamStatus();
      setStatus(s);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    // Auto-poll while the container is mid-flight (starting up,
    // mid-2FA, etc.) so we flip to the green pill the moment auth
    // lands without making the user hit Refresh.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const runBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
      onStateChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadLogs = async () => {
    setShowLogs(true);
    try {
      const text = await cmd.ibeamLogs(300);
      setLogs(text);
    } catch (err) {
      setLogs(`error reading logs: ${err}`);
    }
  };

  if (!status) {
    return (
      <div className="muted mono fs-xs" style={{ padding: 10 }}>
        probing ibeam…
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        background: "var(--bg-alt)",
        border: "1px solid var(--border)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: status.state.state === "not_installed" ? 8 : 6,
        }}
      >
        <StatePill state={status.state} />
        {status.state.state !== "not_installed" && (
          <span className="muted fs-xs">
            auto-managed via Docker · re-auths on every daily session reset
          </span>
        )}
      </div>
      {status.state.state === "not_installed" && (
        <div className="muted fs-xs mb-2" style={{ lineHeight: 1.5 }}>
          Stays connected continuously — no daily re-login. Requires Docker
          (running) and IBKR Mobile 2FA push notifications enabled on your phone.
        </div>
      )}

      {error && (
        <div className="banner err mono">
          {error}
        </div>
      )}

      {status.state.state === "not_installed" && (
        <CredentialsForm
          busy={busy === "install"}
          onSubmit={(creds) =>
            runBusy("install", async () => {
              await cmd.ibeamInstall(creds);
              await cmd.ibeamStart();
            })
          }
        />
      )}

      {status.state.state === "stopped" && (
        <div className="wrap-row">
          <button
            type="button"
            className="primary fs-xs"
            disabled={busy !== null}
            onClick={() => runBusy("start", cmd.ibeamStart)}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            className="ghost fs-xs"
            disabled={busy !== null}
            onClick={loadLogs}
          >
            View logs
          </button>
          <button
            type="button"
            className="ghost danger fs-xs"
            disabled={busy !== null}
            onClick={() => {
              if (
                !confirm(
                  "Uninstall ibeam? This stops the container, deletes its compose project, and removes stored IBKR credentials.",
                )
              )
                return;
              runBusy("uninstall", cmd.ibeamUninstall);
            }}
          >
            Uninstall
          </button>
          <div
            className="muted mono"
            style={{ fontSize: 11, alignSelf: "center" }}
          >
            last state: {status.state.reason}
          </div>
        </div>
      )}

      {status.state.state === "running" && (
        <div className="wrap-row">
          {!status.state.auth_ok && (
            <div className="banner warn">
              <strong>Awaiting 2FA approval.</strong> Check your phone for
              an IBKR Mobile push notification and tap Approve. This
              card will flip to green automatically once the session
              is authenticated.
            </div>
          )}
          <button
            type="button"
            className="ghost fs-xs"
            disabled={busy !== null}
            onClick={() => runBusy("restart", cmd.ibeamRestart)}
          >
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
          <button
            type="button"
            className="ghost fs-xs"
            disabled={busy !== null}
            onClick={() => runBusy("stop", cmd.ibeamStop)}
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button
            type="button"
            className="ghost fs-xs"
            disabled={busy !== null}
            onClick={loadLogs}
          >
            View logs
          </button>
          <button
            type="button"
            className="ghost danger fs-xs"
            disabled={busy !== null}
            onClick={() => {
              if (
                !confirm(
                  "Uninstall ibeam? This stops the container, deletes its compose project, and removes stored IBKR credentials.",
                )
              )
                return;
              runBusy("uninstall", cmd.ibeamUninstall);
            }}
          >
            Uninstall
          </button>
        </div>
      )}

      {status.state.state === "docker_unavailable" && (
        <div className="muted mono fs-xs">
          Docker isn&apos;t reachable: {status.state.detail}. Start Docker
          Desktop and refresh.
        </div>
      )}

      {showLogs && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <span
              className="muted"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              ibeam logs (last 300 lines)
            </span>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowLogs(false)}
              style={{ fontSize: 11, padding: "2px 6px" }}
            >
              hide
            </button>
          </div>
          <pre
            className="mono"
            style={{
              maxHeight: 200,
              overflow: "auto",
              padding: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 3,
              fontSize: 10,
              lineHeight: 1.4,
              whiteSpace: "pre-wrap",
            }}
          >
            {logs || "no output"}
          </pre>
        </div>
      )}
    </div>
  );
}

function StatePill({ state }: { state: IbeamStatus["state"] }) {
  const cfg: Record<IbeamStatus["state"]["state"], { variant: string; label: string }> = {
    not_installed: { variant: "neutral", label: "not installed" },
    stopped: { variant: "neutral", label: "stopped" },
    running:
      state.state === "running" && state.auth_ok
        ? { variant: "ok", label: "auto-managed" }
        : { variant: "warn", label: "starting · 2fa" },
    docker_unavailable: { variant: "err", label: "docker offline" },
    other: { variant: "err", label: "issue" },
  };
  const c = cfg[state.state];
  return <span className={`chip ${c.variant}`}>{c.label}</span>;
}

function CredentialsForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (creds: IbeamCredentials) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const ready = username.length > 0 && password.length > 0 && !busy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSubmit({ username, password });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div className="muted fs-xs" style={{ marginBottom: 2, lineHeight: 1.5 }}>
        Stored encrypted in the launcher&apos;s vault, injected into the
        container only at start time. Account ID and paper / live mode
        are detected automatically after the first login — you don&apos;t
        need to type them.
      </div>
      <input
        name="username"
        type="text"
        placeholder="IBKR username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        disabled={busy}
        className="fs-sm"
      />
      <input
        name="password"
        type="password"
        placeholder="IBKR password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        className="fs-sm"
      />
      <button
        type="submit"
        className="primary"
        disabled={!ready}
        style={{ alignSelf: "flex-start", fontSize: 12 }}
      >
        {busy ? "Installing…" : "Connect"}
      </button>
    </form>
  );
}
