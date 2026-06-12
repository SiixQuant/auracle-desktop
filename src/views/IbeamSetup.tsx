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
      <div className="muted mono" style={{ fontSize: 11, padding: 10 }}>
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
        <div className="muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
          Stays connected continuously — no daily re-login. Requires Docker
          (running) and IBKR Mobile 2FA push notifications enabled on your phone.
        </div>
      )}

      {error && (
        <div
          className="muted mono"
          style={{
            color: "var(--err)",
            fontSize: 11,
            marginBottom: 8,
            padding: 6,
            background: "rgba(248,113,113,0.08)",
            border: "1px solid rgba(248,113,113,0.3)",
            borderRadius: 3,
          }}
        >
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
            <div
              className="muted"
              style={{
                fontSize: 11,
                padding: 6,
                background: "rgba(251,191,36,0.1)",
                border: "1px solid rgba(251,191,36,0.3)",
                borderRadius: 3,
                width: "100%",
                marginBottom: 6,
                lineHeight: 1.5,
              }}
            >
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
  const cfg: Record<
    IbeamStatus["state"]["state"],
    { label: string; bg: string; fg: string }
  > = {
    not_installed: {
      label: "not installed",
      bg: "rgba(148,163,184,0.15)",
      fg: "#cbd5e1",
    },
    stopped: {
      label: "stopped",
      bg: "rgba(148,163,184,0.15)",
      fg: "#cbd5e1",
    },
    running:
      state.state === "running" && state.auth_ok
        ? {
            label: "auto-managed",
            bg: "rgba(74,222,128,0.15)",
            fg: "#86efac",
          }
        : {
            label: "starting · 2fa",
            bg: "rgba(251,191,36,0.15)",
            fg: "#fcd34d",
          },
    docker_unavailable: {
      label: "docker offline",
      bg: "rgba(248,113,113,0.15)",
      fg: "#fca5a5",
    },
    other: {
      label: "issue",
      bg: "rgba(248,113,113,0.15)",
      fg: "#fca5a5",
    },
  };
  const c = cfg[state.state];
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        padding: "2px 8px",
        background: c.bg,
        color: c.fg,
        borderRadius: 999,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {c.label}
    </span>
  );
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
      <div className="muted" style={{ fontSize: 11, marginBottom: 2, lineHeight: 1.5 }}>
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
