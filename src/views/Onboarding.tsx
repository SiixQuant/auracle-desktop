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
}

const STEPS = ["Environment", "License", "Install"] as const;

export default function Onboarding({ onDone }: OnboardingProps) {
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
          The <strong>Seer IDE</strong> — an AI engineer inside Build that
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
}: {
  licenseKey: string;
  setLicenseKey: (v: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
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
      <div className="step-head">License key</div>
      <p className="muted">
        Paste your license key from your Auracle purchase email — accepts{" "}
        <code>akey_…</code> (Stripe), <code>polar_…</code> (legacy Polar), or a
        JWT starting with <code>eyJ…</code> (enterprise / offline). Stored
        securely in your OS keychain — never on disk.
      </p>
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
  const [installing, setInstalling] = useState(false);
  const [finished, setFinished] = useState(false);
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
      const report = await cmd.preflightCheck();
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
        message: "",
      }));
      window.setTimeout(async () => {
        try {
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

  const canInstall = !!preflight?.can_install && !installing && !finished;

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
          {finished ? (
            <div className="banner info">
              <strong>The stack is up.</strong> Finishing first-run setup in
              your browser at <code>localhost:1969</code> — the launcher stays
              here for status, brokers, and updates.
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
