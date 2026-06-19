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
//
// Destructive confirm is an in-surface row, not a native browser
// dialog — Tauri's WKWebView can suppress those entirely, which
// would turn the guard into a silent no-op.

import { useCallback, useEffect, useState } from "react";

import ConfirmRow from "@/components/ConfirmRow";
import IncidentCard from "@/components/IncidentCard";
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

  const uninstall = () => runBusy("uninstall", cmd.ibeamUninstall);

  if (!status) {
    return <div className="subcard muted fs-xs">Checking…</div>;
  }

  return (
    <div className="subcard">
      <div className="hstack mb-2">
        <StatePill state={status.state} />
        {status.state.state !== "not_installed" && (
          <span className="muted fs-xs">
            Stays logged in for you, even through IBKR&apos;s daily reset.
          </span>
        )}
      </div>
      {status.state.state === "not_installed" && (
        <div className="muted fs-xs mb-2 lh-relaxed">
          Stay connected with no daily re-login. Needs Docker running and IBKR
          Mobile 2FA turned on, so you can approve sign-in from your phone.
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
          <ConfirmRow
            compact
            trigger="Uninstall"
            title="Uninstall ibeam?"
            body="Stops the container, deletes its compose project, and removes stored IBKR credentials from the vault."
            busy={busy !== null}
            onConfirm={uninstall}
          />
          <div className="muted mono">last state: {status.state.reason}</div>
        </div>
      )}

      {status.state.state === "running" && (
        <>
          {!status.state.auth_ok && (
            <div className="banner warn">
              <strong>Awaiting 2FA approval.</strong> Check your phone for
              an IBKR Mobile push notification and tap Approve. This
              card will flip to green automatically once the session
              is authenticated.
            </div>
          )}
          <div className="wrap-row">
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
            <ConfirmRow
              compact
              trigger="Uninstall"
              title="Uninstall ibeam?"
              body="Stops the container, deletes its compose project, and removes stored IBKR credentials from the vault."
              busy={busy !== null}
              onConfirm={uninstall}
            />
          </div>
        </>
      )}

      {status.state.state === "docker_unavailable" && (
        <IncidentCard
          severity="err"
          cause={`Docker isn't reachable: ${status.state.detail}.`}
          detail="Start Docker Desktop and return to this screen."
        />
      )}

      {status.state.state === "other" && (
        <IncidentCard severity="err" cause={status.state.detail} />
      )}

      {showLogs && (
        <div className="mt-2">
          <div className="pane-head">
            <span className="pane-head__label">ibeam logs (last 300 lines)</span>
            <div className="pane-head__actions">
              <button
                type="button"
                className="ghost btn-sm"
                onClick={() => setShowLogs(false)}
              >
                hide
              </button>
            </div>
          </div>
          <pre className="logs logs-compact">{logs || "no output"}</pre>
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
        ? { variant: "live", label: "auto-managed" }
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
  const [mode, setMode] = useState<"paper" | "live">("paper");

  const ready = username.length > 0 && password.length > 0 && !busy;

  return (
    <form
      className="vstack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSubmit({ username, password, trading_mode: mode });
      }}
    >
      <p className="muted fs-xs m-0 lh-relaxed">
        Encrypted and only used to start your connection — never stored as
        plain text.
      </p>
      <div>
        <label className="micro-label">Account type</label>
        <div className="seg-toggle mt-1" role="tablist" aria-label="IBKR account type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "paper"}
            className={`seg-tab seg-tab--paper ${mode === "paper" ? "active" : ""}`}
            disabled={busy}
            onClick={() => setMode("paper")}
          >
            Paper
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "live"}
            className={`seg-tab seg-tab--live ${mode === "live" ? "active" : ""}`}
            disabled={busy}
            onClick={() => setMode("live")}
          >
            Live
          </button>
        </div>
        <p className="muted fs-2xs m-0 mt-1 lh-relaxed">
          {mode === "paper"
            ? "Practice account (IBKR usernames usually start with DU)."
            : "Real-money account — orders execute for real. Pick this only for a live IBKR account."}
        </p>
      </div>
      <div>
        <label htmlFor="ibeam-username" className="micro-label">
          IBKR username
        </label>
        <input
          id="ibeam-username"
          name="username"
          type="text"
          placeholder="e.g. U1234567"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
          className="mt-1"
        />
      </div>
      <div>
        <label htmlFor="ibeam-password" className="micro-label">
          IBKR password
        </label>
        <input
          id="ibeam-password"
          name="password"
          type="password"
          placeholder="your IBKR login password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="mt-1"
        />
      </div>
      <button
        type="submit"
        className="primary"
        disabled={!ready}
        style={{ alignSelf: "flex-start" }}
      >
        {busy ? "Installing…" : "Connect"}
      </button>
    </form>
  );
}
