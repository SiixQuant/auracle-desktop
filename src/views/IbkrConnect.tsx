// IbkrConnect — the unified IBKR connect form (dockerized IB Gateway).
//
// Replaces the old ibeam/Client-Portal sub-card. This drives the engine's
// owner-gated connections API, which sets up the SAME ib_insync IB Gateway
// that automated strategies use for data + execution — so "connected"
// finally means "my strategies can pull data and place trades."
//
// Fields: IBKR username + password + a TOTP reconnect key (REQUIRED — the
// engine refuses without it so the gateway stays logged in unattended
// through IBKR's daily reset) + paper/live. Credentials ride to the engine
// vault and are never displayed or logged. Choosing Live takes an explicit
// confirm; connecting places ZERO orders by itself (arming a strategy to
// live is a separate, deliberate step).

import { useState } from "react";

import { cmd } from "@/lib/tauri";

type Phase =
  | { kind: "form" }
  | { kind: "connecting" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export default function IbkrConnect({ onStateChange }: { onStateChange: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // The engine requires TOTP for an unattended connection; enforce it here
  // too so the user gets immediate feedback instead of a round-trip 400.
  const ready =
    username.trim().length > 0 &&
    password.length > 0 &&
    totp.trim().length > 0 &&
    (mode === "paper" || liveConfirmed) &&
    phase.kind !== "connecting";

  const connect = async () => {
    setPhase({ kind: "connecting" });
    try {
      await cmd.ibkrConnect(username.trim(), password, totp.trim(), mode);
      setPhase({ kind: "done" });
      // Clear the secrets from component state once handed to the vault.
      setPassword("");
      setTotp("");
      onStateChange();
    } catch (err) {
      setPhase({ kind: "error", message: String(err) });
    }
  };

  if (phase.kind === "done") {
    return (
      <div className="subcard">
        <div className="banner info m-0 lh-relaxed">
          <strong>Gateway starting.</strong> Flips to connected when it&apos;s up.
          Your 2FA key keeps it logged in.
        </div>
        <button
          type="button"
          className="ghost btn-sm mt-2"
          onClick={() => setPhase({ kind: "form" })}
        >
          Edit credentials
        </button>
      </div>
    );
  }

  return (
    <div className="subcard">
      <p className="muted fs-xs m-0 mb-2 lh-relaxed">
        Stored encrypted in your vault. Needs Docker running.
      </p>

      <form
        className="vstack"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void connect();
        }}
      >
        <div>
          <label className="micro-label">Trading mode</label>
          <div className="seg-toggle mt-1" role="tablist" aria-label="IBKR trading mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "paper"}
              className={`seg-tab seg-tab--paper ${mode === "paper" ? "active" : ""}`}
              onClick={() => {
                setMode("paper");
                setLiveConfirmed(false);
              }}
            >
              Paper
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "live"}
              className={`seg-tab seg-tab--live ${mode === "live" ? "active" : ""}`}
              onClick={() => setMode("live")}
            >
              Live
            </button>
          </div>
          {mode === "live" && (
            <label className="hstack mt-2 fs-xs" style={{ gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={liveConfirmed}
                onChange={(e) => setLiveConfirmed(e.target.checked)}
              />
              <span className="lh-relaxed">
                Real money — armed strategies place real orders.
              </span>
            </label>
          )}
        </div>

        <div>
          <label htmlFor="ibkr-username" className="micro-label">IBKR username</label>
          <input
            id="ibkr-username"
            type="text"
            autoComplete="username"
            placeholder="your-ibkr-login"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="ibkr-password" className="micro-label">Password</label>
          <input
            id="ibkr-password"
            type="password"
            autoComplete="current-password"
            placeholder="your IBKR password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="ibkr-totp" className="micro-label">
            2FA key (TOTP) — required
          </label>
          <input
            id="ibkr-totp"
            type="password"
            autoComplete="off"
            placeholder="base32 secret from your authenticator"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            className="mt-1"
          />
          <p className="muted fs-2xs m-0 mt-1 lh-relaxed">
            Keeps the gateway logged in through IBKR&apos;s daily reset. From IBKR →
            Secure Login Settings.
          </p>
        </div>

        <button
          type="submit"
          className="primary"
          disabled={!ready}
          style={{ alignSelf: "flex-start" }}
        >
          {phase.kind === "connecting" ? "Connecting…" : "Connect"}
        </button>
      </form>

      {phase.kind === "error" && (
        <div className="banner err mono mt-2 lh-relaxed">{phase.message}</div>
      )}
    </div>
  );
}
