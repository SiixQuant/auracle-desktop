// IbkrConnect — the unified IBKR connect form (dockerized IB Gateway).
//
// Drives the engine's owner-gated connections API, which sets up the SAME
// ib_insync IB Gateway that automated strategies use for data + execution
// — so "connected" finally means "my strategies can pull data and place
// trades."
//
// Fields: IBKR username + password + an OPTIONAL TOTP reconnect key +
// paper/live. With a TOTP secret the gateway re-logs in unattended through
// IBKR's daily reset (hands-off). Without it the connection is attended:
// paper accounts need no 2FA; live prompts an IBKR Mobile approval, and
// strategies pause at the daily reset until you reconnect. Credentials ride
// to the engine vault and are never displayed or logged. Choosing Live
// takes an explicit confirm; connecting places ZERO orders by itself.

import { useState } from "react";

import { cmd } from "@/lib/tauri";

type Phase =
  | { kind: "form" }
  | { kind: "connecting" }
  | { kind: "done"; unattended: boolean }
  | { kind: "error"; message: string };

export default function IbkrConnect({
  onStateChange,
  onLater,
}: {
  onStateChange: () => void;
  /** "Set up later" — dismiss the connect surface without connecting. */
  onLater?: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  // TOTP is optional — only username + password (+ the live confirm) are
  // required to connect. With TOTP the gateway reconnects unattended;
  // without it, sign-in is attended.
  const ready =
    username.trim().length > 0 &&
    password.length > 0 &&
    (mode === "paper" || liveConfirmed) &&
    phase.kind !== "connecting";

  const connect = async () => {
    const hasTotp = totp.trim().length > 0;
    setPhase({ kind: "connecting" });
    try {
      await cmd.ibkrConnect(username.trim(), password, totp.trim(), mode);
      setPhase({ kind: "done", unattended: hasTotp });
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
          <strong>Gateway starting.</strong> Flips to connected when it&apos;s up.{" "}
          {phase.unattended
            ? "Your 2FA key keeps it logged in automatically."
            : "Approve the sign-in on IBKR Mobile if it asks."}
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
            2FA key (TOTP) — optional
          </label>
          <input
            id="ibkr-totp"
            type="password"
            autoComplete="off"
            placeholder="base32 secret (leave blank if you don't have it)"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            className="mt-1"
          />
          <p className="muted fs-2xs m-0 mt-1 lh-relaxed">
            {totp.trim().length > 0
              ? "The gateway reconnects on its own through IBKR's daily reset — fully hands-off."
              : "No TOTP? Paper needs no 2FA. For live you'll approve on IBKR Mobile, and strategies pause at IBKR's daily reset until you reconnect. Add a key later for hands-off reconnect."}
          </p>
        </div>

        <div className="hstack" style={{ gap: 8 }}>
          <button
            type="submit"
            className="primary"
            disabled={!ready}
            style={{ alignSelf: "flex-start" }}
          >
            {phase.kind === "connecting" ? "Connecting…" : "Connect"}
          </button>
          {onLater && (
            <button
              type="button"
              className="ghost btn-sm"
              onClick={onLater}
              disabled={phase.kind === "connecting"}
            >
              Set up later
            </button>
          )}
        </div>
      </form>

      {phase.kind === "error" && (
        <div className="banner err mono mt-2 lh-relaxed">{phase.message}</div>
      )}
    </div>
  );
}
