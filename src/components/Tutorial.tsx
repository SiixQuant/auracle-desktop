// Tutorial — a short, dismissible first-run walkthrough.
//
// A handful of steps, no jargon. Shown once after install (gated on a
// localStorage flag in App), and re-openable any time from Help.
// Most steps are pure presentational copy; one ("Connect GitHub")
// renders an interactive device-flow sign-in via the `render` hook on
// the step shape. Skip and Done both call onClose.

import { useCallback, useEffect, useRef, useState } from "react";

import { cmd, openInBrowser, type GithubDeviceStart } from "@/lib/tauri";

type Step = {
  title: string;
  body: string;
  /** Optional interactive content rendered under the body (e.g. the
   *  GitHub connect flow). Presentational steps omit it. */
  render?: () => React.ReactNode;
};

const STEPS: Step[] = [
  {
    title: "Welcome to Auracle",
    body: "This launcher runs your local engine and opens the Auracle IDE — your quant workspace for taking an idea from research to live.",
  },
  {
    title: "Start, then open the workspace",
    body: "The home screen has one primary button. If your engine isn't running it reads Start engine; once it's up it becomes Open workspace and launches the IDE. The status line under it always tells you the engine's real state.",
  },
  {
    title: "Your hub, at a glance",
    body: "The launcher is your hub: the lamp and status line show the engine's real state, and the cards take you to Updates, Changelog, FAQ, and Support. Brokers and data sources connect inside the workspace itself.",
  },
  {
    title: "Connect GitHub",
    body: "Sign in with GitHub so the IDE and terminal can push and pull your strategy repos. This uses your own GitHub account — type a short code on github.com and you're set. You can skip this and do it later.",
    render: () => <GithubConnect />,
  },
  {
    title: "Settings & help",
    body: "Manage your license, choose your agent, and control the engine in Settings. Need help? The FAQ and Support cards on the home screen answer common questions and let you copy diagnostics. Reopen this tour any time from Help.",
  },
];

export default function Tutorial({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const last = i === STEPS.length - 1;
  const step = STEPS[i];

  return (
    <div className="tut-overlay" role="dialog" aria-modal="true" aria-label="Getting started">
      <div className="tut-card">
        <div className="tut-step-label">
          Step {i + 1} of {STEPS.length}
        </div>
        <div className="tut-title">{step.title}</div>
        <p className="tut-body">{step.body}</p>
        {step.render?.()}
        <div className="tut-foot">
          <div className="tut-dots" aria-hidden="true">
            {STEPS.map((_, n) => (
              <span key={n} className={`tut-dot${n === i ? " on" : ""}`} />
            ))}
          </div>
          <div className="hstack">
            <button type="button" className="ghost btn-sm" onClick={onClose}>
              {last ? "Close" : "Skip"}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => (last ? onClose() : setI(i + 1))}
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── GitHub device-flow connect ──────────────────────────────────
//
// Self-contained: checks status, starts the device flow on demand,
// shows the user code + a button that opens the verification page,
// then polls until the flow resolves. NEVER renders the token — only
// the resolved @login. Honest "not set up for this build" path when no
// client_id is compiled in. The user can always Skip past this step.

type Phase =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "already"; login?: string | null }
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "awaiting"; start: GithubDeviceStart }
  | { kind: "connected"; login?: string | null }
  | { kind: "error"; message: string };

function GithubConnect() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Holds the active poll timer so we can cancel it on unmount / restart.
  const pollRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Initial status probe — is sign-in configured, and is the user
  // already connected?
  useEffect(() => {
    mountedRef.current = true;
    cmd.githubAuthStatus()
      .then((s) => {
        if (!mountedRef.current) return;
        if (!s.configured) {
          setPhase({ kind: "not_configured" });
        } else if (s.connected) {
          setPhase({ kind: "already", login: s.login });
        } else {
          setPhase({ kind: "idle" });
        }
      })
      .catch(() => {
        if (mountedRef.current) setPhase({ kind: "idle" });
      });
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll]);

  // Poll githubDevicePoll on a backing-off cadence until the flow
  // resolves. `intervalSec` honors GitHub's requested interval and grows
  // on a slow_down (surfaced to us as another "pending").
  const poll = useCallback(
    (deviceCode: string, intervalSec: number) => {
      clearPoll();
      pollRef.current = window.setTimeout(async () => {
        try {
          const res = await cmd.githubDevicePoll(deviceCode);
          if (!mountedRef.current) return;
          if (res.status === "authorized") {
            setPhase({ kind: "connected", login: res.login });
            clearPoll();
          } else if (res.status === "pending") {
            // Keep waiting; nudge the interval up slightly so repeated
            // slow_down responses don't trip GitHub's rate limit.
            poll(deviceCode, intervalSec + 1);
          } else {
            setPhase({
              kind: "error",
              message: "Sign-in didn't complete. Please try again.",
            });
            clearPoll();
          }
        } catch {
          if (!mountedRef.current) return;
          setPhase({
            kind: "error",
            message: "Sign-in didn't complete. Please try again.",
          });
          clearPoll();
        }
      }, intervalSec * 1000);
    },
    [clearPoll],
  );

  const start = useCallback(async () => {
    setPhase({ kind: "starting" });
    try {
      const s = await cmd.githubDeviceStart();
      if (!mountedRef.current) return;
      setPhase({ kind: "awaiting", start: s });
      // Open the verification page right away so the user lands on the
      // code-entry screen; the code is also shown here to copy.
      openInBrowser(s.verification_uri).catch(() => {});
      // Respect GitHub's minimum interval (≥1s as a floor).
      poll(s.device_code, Math.max(1, s.interval));
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = String(err);
      // The honest not-configured signal can also arrive here if the
      // build's client_id is empty.
      if (msg.toLowerCase().includes("isn't configured")) {
        setPhase({ kind: "not_configured" });
      } else {
        setPhase({
          kind: "error",
          message: "Couldn't start GitHub sign-in. Please try again.",
        });
      }
    }
  }, [poll]);

  switch (phase.kind) {
    case "loading":
      return <div className="muted fs-sm mt-2">Checking GitHub…</div>;

    case "not_configured":
      return (
        <div className="banner info mt-2">
          GitHub sign-in isn&apos;t set up for this build yet. You can connect
          GitHub later from your IDE or terminal — skip this step for now.
        </div>
      );

    case "already":
      return (
        <div className="ob-status mt-2">
          <span className="chip ok">connected</span>
          {phase.login ? (
            <span className="muted mono">@{phase.login}</span>
          ) : (
            <span className="muted fs-sm">GitHub is already linked.</span>
          )}
        </div>
      );

    case "connected":
      return (
        <div className="ob-status mt-2">
          <span className="chip ok">connected</span>
          <span className="muted mono">
            {phase.login ? `Connected as @${phase.login}` : "Connected"}
          </span>
        </div>
      );

    case "idle":
      return (
        <div className="mt-2">
          <button type="button" className="primary btn-sm" onClick={start}>
            Sign in with GitHub
          </button>
        </div>
      );

    case "starting":
      return <div className="muted fs-sm mt-2">Starting GitHub sign-in…</div>;

    case "awaiting":
      return (
        <div className="mt-2">
          <span className="ob-label">Enter this code on GitHub</span>
          <div className="hstack" style={{ gap: 12, alignItems: "center" }}>
            <code className="mono" style={{ fontSize: 20, letterSpacing: 2 }}>
              {phase.start.user_code}
            </code>
            <button
              type="button"
              className="ghost btn-sm"
              onClick={() =>
                openInBrowser(phase.start.verification_uri).catch(() => {})
              }
            >
              Open GitHub ↗
            </button>
          </div>
          <p className="muted fs-xs mt-2">
            Waiting for you to approve in your browser. This window updates on
            its own once you&apos;re done.
          </p>
        </div>
      );

    case "error":
      return (
        <div className="mt-2">
          <div className="banner err">{phase.message}</div>
          <button
            type="button"
            className="primary btn-sm mt-2"
            onClick={start}
          >
            Try again
          </button>
        </div>
      );
  }
}
