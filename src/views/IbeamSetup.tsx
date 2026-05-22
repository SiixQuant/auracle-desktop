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
        marginTop: 10,
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
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Persistent connection</strong>
        <StatePill state={status.state} />
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>
        Runs ibeam in Docker — auto re-logs in to the IBKR Client Portal Gateway
        whenever the daily session expires. Requires IBKR Mobile 2FA
        push notifications enabled on your phone.
      </div>

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
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => runBusy("start", cmd.ibeamStart)}
            style={{ fontSize: 12 }}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={loadLogs}
            style={{ fontSize: 12 }}
          >
            View logs
          </button>
          <button
            type="button"
            className="ghost danger"
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
            style={{ fontSize: 12 }}
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
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
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
            className="ghost"
            disabled={busy !== null}
            onClick={() => runBusy("restart", cmd.ibeamRestart)}
            style={{ fontSize: 12 }}
          >
            {busy === "restart" ? "Restarting…" : "Restart"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={() => runBusy("stop", cmd.ibeamStop)}
            style={{ fontSize: 12 }}
          >
            {busy === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={loadLogs}
            style={{ fontSize: 12 }}
          >
            View logs
          </button>
          <button
            type="button"
            className="ghost danger"
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
            style={{ fontSize: 12 }}
          >
            Uninstall
          </button>
        </div>
      )}

      {status.state.state === "docker_unavailable" && (
        <div className="muted mono" style={{ fontSize: 11 }}>
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
  const [accountId, setAccountId] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper");

  const ready =
    username.length > 0 &&
    password.length > 0 &&
    accountId.length > 0 &&
    !busy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSubmit({ username, password, account_id: accountId, mode });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      <div className="muted" style={{ fontSize: 11, marginBottom: 4, lineHeight: 1.5 }}>
        Credentials are stored encrypted in the launcher&apos;s Stronghold
        vault and only injected into the container at start time via
        a short-lived tempfile. After this one-time entry every restart
        — daily IBKR re-auth, machine reboot, app relaunch — reads
        from the vault automatically.
      </div>
      {/*
        autoComplete attributes are deliberate. Standard W3C values that
        every password manager (1Password, Bitwarden, Apple Passwords,
        Chrome, Firefox) recognizes — they'll offer to autofill the form
        if the user has an IBKR entry saved. The wrapping <form> + name
        attributes give password managers enough hints to scope correctly.
        For password creation / first-time entry, 'current-password' (not
        'new-password') is right because IBKR sets the password elsewhere
        and we're just storing the existing one.
      */}
      <input
        name="username"
        type="text"
        placeholder="IBKR username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        disabled={busy}
        style={{ fontSize: 13 }}
      />
      <input
        name="password"
        type="password"
        placeholder="IBKR password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        style={{ fontSize: 13 }}
      />
      <input
        name="account-id"
        type="text"
        placeholder="Account ID (e.g. DU1234567 or U1234567)"
        autoComplete="off"
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        disabled={busy}
        style={{ fontSize: 13 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label
          style={{
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <input
            type="radio"
            name="ibeam-mode"
            value="paper"
            checked={mode === "paper"}
            onChange={() => setMode("paper")}
            disabled={busy}
          />
          paper
        </label>
        <label
          style={{
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <input
            type="radio"
            name="ibeam-mode"
            value="live"
            checked={mode === "live"}
            onChange={() => setMode("live")}
            disabled={busy}
          />
          live
        </label>
        <button
          type="submit"
          className="primary"
          disabled={!ready}
          style={{ marginLeft: "auto", fontSize: 12 }}
        >
          {busy ? "Installing…" : "Install + start"}
        </button>
      </div>
    </form>
  );
}
