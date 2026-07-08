// Onboarding — first-run wizard. Three named steps:
//   1. Environment — Docker runtime check (auto-detects once a
//      download link is clicked; no relaunch needed)
//   2. License — key entry (skip lands on Community)
//   3. Install — pre-flight, then an EXPLICIT install start with
//      live progress. The installer never starts itself: pulling
//      gigabytes is a consented action, and an explicit gate is
//      also what keeps a failed install from auto-retrying forever.
//
// Auto-shown by App.tsx when cmd.isInstalled() returns false.
// Subscribes to the 'installer-progress' Tauri event for live
// stepper updates while install.sh runs.

import { useEffect, useRef, useState } from "react";

import { engineIsUp, waitForEngineHealthy } from "@/lib/onboarding";
import {
  cmd,
  onEvent,
  openInBrowser,
  type DockerStatus,
  // Aliased locally so existing references in this file don't churn —
  // the canonical name lives in @/lib/tauri.ts.
  type InstallerProgressEvent as InstallerProgress,
  type PreflightReport,
} from "@/lib/tauri";

interface OnboardingProps {
  onDone: () => void;
  onGoogleSignIn?: () => void;
  googleWaiting?: boolean;
}

const STEPS = ["Environment", "Sign in", "Install"] as const;

export default function Onboarding({
  onDone,
  onGoogleSignIn,
  googleWaiting,
}: OnboardingProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [licenseKey, setLicenseKey] = useState("");

  // Pre-fill license input if a key was previously stored (re-run case).
  useEffect(() => {
    cmd.licenseGet()
      .then((v) => {
        if (v) setLicenseKey(v);
      })
      .catch(() => {});
  }, []);

  return (
    <div
      className="ob-shell"
      style={{ maxWidth: 640, margin: "48px auto", padding: 32 }}
    >
      <div className="hstack" style={{ marginBottom: 24 }}>
        <span className="logo-dot healthy" style={{ width: 12, height: 12 }} />
        <h1 className="ob-title m-0">Welcome to Auracle Desktop</h1>
      </div>

      <Stepper current={step} />

      <div>
        {step === 1 && (
          <Step1
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <Step2
            licenseKey={licenseKey}
            setLicenseKey={setLicenseKey}
            onBack={() => setStep(1)}
            onSkip={() => {
              cmd.licenseClear().catch(() => {});
              setStep(3);
            }}
            onNext={() => setStep(3)}
            onGoogleSignIn={onGoogleSignIn}
            googleWaiting={googleWaiting}
          />
        )}
        {step === 3 && (
          <Step3
            licenseKey={licenseKey}
            onBack={() => setStep(2)}
            onDone={onDone}
          />
        )}
      </div>
    </div>
  );
}

// ── Stepper bar ─────────────────────────────────────────────────

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="stepper">
      {STEPS.map((name, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "";
        return (
          <div key={name} className={`step ${state}`}>
            {name}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Environment (Docker check) ─────────────────────────

function Step1({ onNext }: { onNext: () => void }) {
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const pollRef = useRef<number | null>(null);

  const probe = async () => {
    try {
      const s = await cmd.dockerStatus();
      setDocker(s);
      if (s.installed && s.running && pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch {
      // transient errors during poll are fine; keep trying
    }
  };

  useEffect(() => {
    probe();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // T-83: once the user heads off to install Docker, poll every 5s so
  // the status flips on its own — no relaunch, no re-check button.
  const startPoll = () => {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(probe, 5_000);
  };

  const ready = !!docker?.installed && !!docker?.running;

  return (
    <Actions
      canNext={ready}
      onNext={onNext}
      nextDisabledReason={
        docker === null
          ? "Checking Docker…"
          : !docker.installed
            ? "Waiting for Docker Desktop to be installed — auto-detects every few seconds."
            : !docker.running
              ? `Waiting for ${runtimeName(docker.runtime)} to start.`
              : undefined
      }
    >
      <div className="step-head">Let&apos;s get you set up</div>
      <p className="muted">
        Auracle Desktop manages a self-hosted algorithmic-trading platform
        that runs locally on your machine. The first thing it needs is a
        working Docker runtime.
      </p>

      <span className="ob-label">Docker runtime</span>
      <DockerCheck docker={docker} onTriggerPoll={startPoll} />

      <span className="ob-label">What you&apos;ll get after install</span>
      <ul className="ob-values">
        <li>
          The <strong>Auracle platform</strong> at <code>localhost:1969</code>{" "}
          — Home, Build, Research, and Trade in one place: backtests,
          schedules, brokers, live runs
        </li>
        <li>
          The <strong>Auracle IDE</strong> — an AI engineer inside Build that
          drafts, edits, and backtests strategies with you
        </li>
        <li>
          <strong>MCP server</strong> so Claude / Cursor can drive Auracle as
          an agent
        </li>
        <li>
          <strong>TimescaleDB</strong> for tick-level price storage
        </li>
      </ul>
    </Actions>
  );
}

function DockerCheck({
  docker,
  onTriggerPoll,
}: {
  docker: DockerStatus | null;
  onTriggerPoll: () => void;
}) {
  if (!docker) {
    return (
      <div className="ob-status">
        <span className="chip neutral">checking</span>
      </div>
    );
  }

  if (!docker.installed) {
    return (
      <>
        <div className="ob-status">
          <span className="chip err">not installed</span>
          <span className="muted fs-sm">
            Install Docker Desktop, leave this window open — the status
            flips on its own once it&apos;s running.
          </span>
        </div>
        <div className="wrap-row mt-2">
          <button
            type="button"
            className="ghost btn-sm"
            onClick={async () => {
              await openInBrowser(
                docker.install_url ||
                  "https://www.docker.com/products/docker-desktop/",
              );
              onTriggerPoll();
            }}
          >
            Download Docker Desktop
          </button>
          <button
            type="button"
            className="ghost btn-sm"
            onClick={async () => {
              try {
                const landing = await cmd.dockerInstallLandingUrl();
                await openInBrowser(landing);
              } catch {
                await openInBrowser(
                  "https://www.docker.com/products/docker-desktop/",
                );
              }
              onTriggerPoll();
            }}
          >
            Verify the source ↗
          </button>
        </div>
      </>
    );
  }

  if (!docker.running) {
    return (
      <div className="ob-status">
        <span className="chip warn">installed · not running</span>
        <span className="muted fs-sm">
          Start <strong>{runtimeName(docker.runtime)}</strong> — this updates
          on its own once the daemon is up.
        </span>
      </div>
    );
  }

  return (
    <div className="ob-status">
      <span className="chip ok">running</span>
      <span className="muted mono">
        {docker.version || "docker"} · {runtimeName(docker.runtime)}
      </span>
    </div>
  );
}

function runtimeName(r?: string) {
  return (
    ({
      "docker-desktop": "Docker Desktop",
      orbstack: "OrbStack",
      colima: "Colima",
      rancher: "Rancher Desktop",
      engine: "Docker Engine",
    } as Record<string, string>)[r ?? ""] || "Docker"
  );
}

// ── Step 2: License key ─────────────────────────────────────────

function Step2({
  licenseKey,
  setLicenseKey,
  onBack,
  onSkip,
  onNext,
  onGoogleSignIn,
  googleWaiting,
}: {
  licenseKey: string;
  setLicenseKey: (v: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onGoogleSignIn?: () => void;
  googleWaiting?: boolean;
}) {
  return (
    <Actions
      canNext
      onBack={onBack}
      onSkip={onSkip}
      onNext={onNext}
      nextLabel="Next →"
      skipLabel="Skip for Community tier"
    >
      <div className="step-head">Sign in</div>
      <p className="muted">
        Sign in with your Auracle account and your subscription is your license
        — there&apos;s no key to paste. Have an enterprise or offline key
        instead? Add it below.
      </p>
      {onGoogleSignIn && (
        <>
          <button
            type="button"
            onClick={() => onGoogleSignIn()}
            disabled={googleWaiting}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              background: "#fff",
              color: "#111",
              fontWeight: 500,
              border: "none",
              borderRadius: 8,
              padding: "11px 16px",
              cursor: googleWaiting ? "default" : "pointer",
              opacity: googleWaiting ? 0.6 : 1,
            }}
          >
            {!googleWaiting && (
              <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
            )}
            {googleWaiting ? "Waiting for browser sign-in…" : "Continue with Google"}
          </button>
          {googleWaiting && (
            <p className="muted fs-xs mt-2">
              Finish signing in in your browser, then return here.
            </p>
          )}
          <div
            className="hstack"
            style={{ gap: 12, margin: "18px 0", alignItems: "center" }}
          >
            <span
              style={{ height: 1, flex: 1, background: "var(--line, rgba(255,255,255,0.12))" }}
            />
            <span className="muted fs-xs">or with a license key</span>
            <span
              style={{ height: 1, flex: 1, background: "var(--line, rgba(255,255,255,0.12))" }}
            />
          </div>
        </>
      )}
      <input
        type="password"
        placeholder="akey_… or polar_… or eyJ…"
        autoComplete="off"
        value={licenseKey}
        onChange={(e) => setLicenseKey(e.target.value)}
      />
      {licenseKey ? (
        <div className="muted mono fs-xs mt-2">
          {licenseKey.length >= 16
            ? "Will be saved when you click Next."
            : "Looks short — check the key for typos."}
        </div>
      ) : null}
      <p className="muted fs-xs mt-4">
        Don&apos;t have a key yet? Click <strong>Skip for Community tier</strong>
        {" "}below — you can add one anytime from Settings → License Key.
        Community gives you 1 strategy + 3 schedules + IBKR data.
      </p>
    </Actions>
  );
}

// ── Step 3: Pre-flight + install ─────────────────────────────────

function Step3({
  licenseKey,
  onBack,
  onDone,
}: {
  licenseKey: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [alreadyRunning, setAlreadyRunning] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [finished, setFinished] = useState(false);
  // null = not yet checked, true = engine answered health, false = the
  // install completed but the engine hasn't answered within the window.
  const [engineHealthy, setEngineHealthy] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<InstallerProgress>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  // Initial pre-flight on mount.
  useEffect(() => {
    runPreflight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll log pane on new lines.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const runPreflight = async () => {
    setPreflightError(null);
    setPreflight(null);
    try {
      // When the Auracle stack is already up — e.g. re-running setup on a
      // live install — its own containers legitimately hold the required
      // ports, so an "in use" port is expected, not a conflict. Probe both
      // the install marker and live engine health (the health probe also
      // catches a stack started outside the launcher's install path) and
      // tell the pre-flight to treat held ports as ours rather than telling
      // the user to kill their own stack.
      const [installed, health] = await Promise.all([
        cmd.isInstalled().catch(() => false),
        cmd.healthcheckNow().catch(() => null),
      ]);
      const engineUp = engineIsUp(health);
      const stackUp = installed || engineUp;
      // If the engine is already answering, a fresh install would only
      // collide with the running stack (it owns the required ports). Surface
      // an "open it" path instead of an "Install" button that's doomed.
      setAlreadyRunning(engineUp);
      const report = await cmd.preflightCheck(stackUp);
      setPreflight(report);
    } catch (err) {
      setPreflightError(String(err));
    }
  };

  const beginInstall = async () => {
    setInstalling(true);
    setInstallError(null);

    // Save the license key if the user entered one (≥16 chars is
    // the loosest valid-key heuristic; server validates the actual
    // format). Anything shorter is almost certainly a typo.
    const trimmed = licenseKey.trim();
    if (trimmed.length >= 16) {
      try {
        await cmd.licenseSet(trimmed);
      } catch {
        // best-effort; don't block install on keychain errors
      }
    }

    const unlisten = await onEvent<InstallerProgress>(
      "installer-progress",
      (payload) => {
        setProgress((prev) => ({ ...prev, ...payload }));
        if (payload.line) {
          setLogLines((prev) => [...prev, payload.line!]);
        }
      },
    );

    try {
      await cmd.runFirstInstall();
      setFinished(true);
      setProgress((prev) => ({
        ...prev,
        percent: 100,
        message: "Waiting for the engine to answer…",
      }));
      // Don't claim "the stack is up" just because the installer process
      // exited — the containers may still be starting (or Houston may have
      // failed to come up). Poll the real health probe until the engine is
      // actually serving, THEN bounce to the browser. On timeout, leave an
      // honest "installed but not answering yet" banner instead of opening
      // a page that won't load.
      const healthy = await waitForEngineHealthy(() => cmd.healthcheckNow());
      setEngineHealthy(healthy);
      setProgress((prev) => ({ ...prev, message: "" }));
      if (!healthy) {
        unlisten();
        return;
      }
      window.setTimeout(async () => {
        try {
          // Retained first-run bootstrap: /ui/setup is allowlisted under
          // the engine's headless profile — this is the only Houston page
          // the launcher still opens.
          await openInBrowser("http://localhost:1969/ui/setup");
        } catch {
          // ignore
        }
        unlisten();
        onDone();
      }, 1_800);
    } catch (err) {
      setInstallError(String(err));
      setInstalling(false);
      unlisten();
    }
  };

  const canInstall =
    !!preflight?.can_install && !installing && !finished && !alreadyRunning;

  return (
    <Actions canNext={false} hideSkip>
      <div className="step-head">Pre-flight check</div>
      <p className="muted">
        Verifying your machine is ready. Nothing is downloaded until you
        start the install.
      </p>

      <div style={{ margin: "16px 0" }}>
        {preflightError ? (
          <div className="banner err mono">
            <strong>Pre-flight check failed.</strong> {preflightError}
          </div>
        ) : preflight ? (
          <PreflightResults report={preflight} />
        ) : (
          <div className="ob-status">
            <span className="chip neutral">running checks</span>
          </div>
        )}
      </div>

      {preflight && !preflight.can_install && (
        <div className="mt-2">
          <p className="muted fs-xs" style={{ margin: "12px 0" }}>
            Fix the items above and re-check. The install can&apos;t run while
            critical checks are failing.
          </p>
          <button type="button" className="primary" onClick={runPreflight}>
            Re-check
          </button>
          <button type="button" className="ghost ml-2" onClick={onBack}>
            ← Back
          </button>
        </div>
      )}

      {alreadyRunning && !installing && !finished && (
        <div className="mt-2">
          <div className="banner info">
            <strong>Auracle is already running.</strong> The platform is up and
            answering at <code>localhost:1969</code> — there&apos;s nothing to
            install. Re-installing over a live stack would only collide with it.
          </div>
          <button type="button" className="primary" onClick={onDone}>
            Open Auracle
          </button>
          <button type="button" className="ghost ml-2" onClick={onBack}>
            ← Back
          </button>
        </div>
      )}

      {canInstall && (
        <div className="mt-2">
          <p className="muted fs-xs" style={{ margin: "12px 0" }}>
            Ready. The install pulls the platform&apos;s Docker images and
            starts the stack — typically 3–8 minutes on a fresh machine.
          </p>
          <button type="button" className="primary" onClick={beginInstall}>
            Install Auracle
          </button>
          <button type="button" className="ghost ml-2" onClick={onBack}>
            ← Back
          </button>
        </div>
      )}

      {/* Failure is its own state — visible regardless of the
          installing flag, with explicit Retry. (Previously the error
          UI lived inside the installing block, which the failure
          handler unmounted — an invisible error.) */}
      {installError && !installing && (
        <div className="mt-4">
          <div className="banner err mono">
            <strong>Install failed.</strong> {installError}
          </div>
          <button type="button" className="primary" onClick={beginInstall}>
            Retry install
          </button>
          <button type="button" className="ghost ml-2" onClick={onBack}>
            ← Back
          </button>
        </div>
      )}

      {(installing || finished) && (
        <>
          <span className="ob-label">
            {finished ? "Install complete" : "Setting up Auracle"}
          </span>
          {!finished && (
            <p className="muted">
              Pulling Docker images and starting services. Safe to leave this
              window in the background — progress continues either way.
            </p>
          )}
          <div style={{ margin: "24px 0" }}>
            <div className="muted mono fs-xs mb-2">
              {finished
                ? "done"
                : progress.phase
                  ? progress.phase.replace(/_/g, " ")
                  : "starting…"}
            </div>
            <div className="progress">
              <div style={{ transform: `scaleX(${(progress.percent ?? 0) / 100})` }} />
            </div>
          </div>
          {finished && engineHealthy === true ? (
            <div className="banner info">
              <strong>The stack is up.</strong> Finishing first-run setup in
              your browser at <code>localhost:1969</code> — the launcher stays
              here for engine status and updates; brokers connect in the
              workspace.
            </div>
          ) : finished && engineHealthy === false ? (
            <div className="banner warn">
              <strong>Containers installed, but the engine hasn't answered
              yet.</strong> It can take a minute on first boot. Give it a
              moment, then open <code>localhost:1969</code> — or check the
              installer log below if it doesn't come up.
              <div className="mt-2">
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    const healthy = await waitForEngineHealthy(
                      () => cmd.healthcheckNow(),
                      { attempts: 10 },
                    );
                    setEngineHealthy(healthy);
                    if (healthy) {
                      try {
                        await openInBrowser("http://localhost:1969/ui/setup");
                      } catch {
                        // ignore
                      }
                      onDone();
                    }
                  }}
                >
                  Retry health check
                </button>
              </div>
            </div>
          ) : finished ? (
            <div className="muted fs-sm" style={{ minHeight: 20 }}>
              Waiting for the engine to answer…
            </div>
          ) : (
            <div className="muted fs-sm" style={{ minHeight: 20 }}>
              {progress.message || ""}
            </div>
          )}
          <details className="mt-4">
            <summary className="muted fs-xs" style={{ cursor: "pointer" }}>
              Show installer log
            </summary>
            <pre ref={logRef} className="logs logs-compact mt-2 fs-2xs">
              {logLines.join("\n")}
            </pre>
          </details>
        </>
      )}
    </Actions>
  );
}

function PreflightResults({ report }: { report: PreflightReport }) {
  return (
    <>
      {report.checks.map((c, i) => {
        const variant = c.passed ? "ok" : c.level === "warning" ? "warn" : "err";
        const label = c.passed ? "pass" : c.level === "warning" ? "warn" : "fail";
        return (
          <div key={i} className="ob-check">
            <div className="ob-check__head">
              <span className={`chip ${variant}`}>{label}</span>
              <span className="ob-check__name">{c.name}</span>
            </div>
            <div className="muted fs-xs mt-1">{c.message}</div>
            {c.remediation && (
              <div className="muted fs-xs mt-1">{c.remediation}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── Action button row ───────────────────────────────────────────

function Actions({
  children,
  canNext,
  onNext,
  onBack,
  onSkip,
  nextLabel,
  skipLabel,
  hideSkip,
  nextDisabledReason,
}: {
  children: React.ReactNode;
  canNext: boolean;
  onNext?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  skipLabel?: string;
  hideSkip?: boolean;
  nextDisabledReason?: string;
}) {
  return (
    <>
      <div>{children}</div>
      <div className="step-footer">
        {onBack ? (
          <button type="button" className="ghost" onClick={onBack}>
            ← Back
          </button>
        ) : (
          <div />
        )}
        <div className="hstack" style={{ gap: 8 }}>
          {!hideSkip && onSkip && (
            <button type="button" className="ghost" onClick={onSkip}>
              {skipLabel || "Skip"}
            </button>
          )}
          {onNext &&
            (canNext ? (
              <button type="button" className="primary" onClick={onNext}>
                {nextLabel || "Next →"}
              </button>
            ) : (
              <div className="hstack" style={{ gap: 8 }}>
                {nextDisabledReason && (
                  <span className="muted fs-xs">{nextDisabledReason}</span>
                )}
                <button type="button" className="primary" disabled>
                  {nextLabel || "Next →"}
                </button>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
