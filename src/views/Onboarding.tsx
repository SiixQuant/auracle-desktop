// Onboarding — first-run wizard. Three screens (per launcher plan §4.1):
//   1. Welcome + Docker check
//   2. License key entry (optional — skip lands you on Community)
//   3. Pre-flight + run installer with live progress
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
      className="card"
      style={{ maxWidth: 640, margin: "48px auto", padding: 32 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <span
          className="logo-dot"
          style={{ background: "var(--accent)", width: 14, height: 14 }}
        />
        <h1 style={{ margin: 0 }}>Welcome to Auracle Desktop</h1>
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
    <div style={{ display: "flex", gap: 12, marginBottom: 32 }}>
      {[1, 2, 3].map((n) => {
        const active = n <= current;
        return (
          <div
            key={n}
            style={{
              flex: 1,
              padding: "8px 0",
              borderTop: `3px solid ${
                active ? "var(--accent)" : "var(--line)"
              }`,
              textAlign: "center",
              fontSize: 11,
              color: active ? "var(--fg-dim)" : "var(--fg-muted)",
            }}
          >
            Step {n}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Welcome + Docker check ─────────────────────────────

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

  // T-83: when the user clicks the direct-download link, kick off a
  // 5s poll so the badge auto-flips to "running" without them
  // having to come back and click anything.
  const startPoll = () => {
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(probe, 5_000);
  };

  return (
    <>
      <Actions
        canNext={!!docker?.installed && !!docker?.running}
        onNext={onNext}
      >
        <h2 className="mt-0">Let&apos;s get you set up</h2>
        <p>
          Auracle Desktop manages a self-hosted algorithmic-trading platform
          that runs locally on your machine. The first thing it needs is a
          working Docker runtime.
        </p>

        <h2>Docker check</h2>
        <DockerCheck docker={docker} onTriggerPoll={startPoll} />

        <h2>What you&apos;ll get after install</h2>
        <ul
          style={{
            paddingLeft: 20,
            color: "var(--fg-dim)",
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <li>
            Web dashboard at <code>localhost:1969</code> for backtests + live
            strategy management
          </li>
          <li>
            JupyterLab at <code>localhost:1969/jupyter</code> for research
            notebooks
          </li>
          <li>MCP server so Claude / Cursor can drive Auracle as an agent</li>
          <li>TimescaleDB for tick-level price storage</li>
        </ul>
      </Actions>
    </>
  );
}

function DockerCheck({
  docker,
  onTriggerPoll,
}: {
  docker: DockerStatus | null;
  onTriggerPoll: () => void;
}) {
  if (!docker) return <div className="muted mono">checking…</div>;

  if (!docker.installed) {
    return (
      <div className="muted mono">
        <span className="badge err">not installed</span>
        {" — "}
        <a
          href="#"
          onClick={async (e) => {
            e.preventDefault();
            await openInBrowser(
              docker.install_url ||
                "https://www.docker.com/products/docker-desktop/",
            );
            onTriggerPoll();
          }}
        >
          download Docker Desktop directly
        </a>
        {" ("}
        <a
          href="#"
          className="fs-xs"
          onClick={async (e) => {
            e.preventDefault();
            try {
              const landing = await cmd.dockerInstallLandingUrl();
              await openInBrowser(landing);
            } catch {
              await openInBrowser(
                "https://www.docker.com/products/docker-desktop/",
              );
            }
          }}
        >
          verify the source
        </a>
        {"), then re-launch to continue. We'll auto-detect when it's installed."}
      </div>
    );
  }

  if (!docker.running) {
    return (
      <div className="muted mono">
        <span className="badge warn">installed but not running</span> — start{" "}
        <strong>{runtimeName(docker.runtime)}</strong> first, then come back.
      </div>
    );
  }

  return (
    <div className="muted mono">
      <span className="badge ok">running</span>{" "}
      {docker.version || "docker"} (<strong>{runtimeName(docker.runtime)}</strong>)
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
      <h2 className="mt-0">License key</h2>
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
        <div
          className="muted mono"
          style={{ fontSize: 11, marginTop: 8 }}
        >
          {licenseKey.length >= 16
            ? "Will be saved when you click Next."
            : "Looks short — check the key for typos."}
        </div>
      ) : null}
      <p
        className="muted"
        style={{ fontSize: 12, marginTop: 24 }}
      >
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
  const [progress, setProgress] = useState<InstallerProgress>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  // Initial pre-flight on mount.
  useEffect(() => {
    runPreflight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-advance when pre-flight passes — short pause so the user
  // can read the green checkmarks before the screen swaps.
  useEffect(() => {
    if (preflight?.can_install && !installing) {
      const t = window.setTimeout(beginInstall, 1_200);
      return () => window.clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preflight, installing]);

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
      setProgress((prev) => ({
        ...prev,
        message: "Auracle is running. Opening dashboard…",
      }));
      window.setTimeout(async () => {
        try {
          await openInBrowser("http://localhost:1969/ui/setup");
        } catch {
          // ignore
        }
        unlisten();
        onDone();
      }, 1_500);
    } catch (err) {
      setInstallError(String(err));
      setInstalling(false);
      unlisten();
    }
  };

  return (
    <Actions canNext={false} hideSkip>
      <h2 className="mt-0">Pre-flight check</h2>
      <p className="muted">
        Verifying your machine is ready before we pull anything. This takes a
        few seconds.
      </p>

      <div style={{ margin: "16px 0" }}>
        {preflightError ? (
          <div className="muted mono">
            <span className="badge err">Pre-flight check failed</span>{" "}
            {preflightError}
          </div>
        ) : preflight ? (
          <PreflightResults report={preflight} />
        ) : (
          <div className="muted mono">running checks…</div>
        )}
      </div>

      {preflight && !preflight.can_install && (
        <div style={{ marginTop: 12 }}>
          <p className="muted" style={{ fontSize: 12, margin: "12px 0" }}>
            Fix the items above and re-check. The install can&apos;t run while
            critical checks are failing.
          </p>
          <button type="button" className="primary" onClick={runPreflight}>
            Re-check
          </button>
          <button
            type="button"
            className="ghost ml-2"
            onClick={onBack}
          >
            ← Back
          </button>
        </div>
      )}

      {installing && (
        <>
          <h2 style={{ marginTop: 24 }}>Setting up Auracle</h2>
          <p className="muted">
            Pulling Docker images and starting services. This typically takes
            3–8 minutes on a fresh machine.
          </p>
          <div style={{ margin: "24px 0" }}>
            <div
              className="muted mono fs-xs mb-2"
            >
              {progress.phase ? progress.phase.replace(/_/g, " ") : "starting…"}
            </div>
            <div
              style={{
                height: 6,
                background: "var(--bg)",
                borderRadius: 3,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${progress.percent ?? 0}%`,
                  background: "var(--accent)",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
          </div>
          <div
            className="muted"
            style={{ fontSize: 13, minHeight: 40 }}
          >
            {installError ? (
              <>
                <span className="badge err">Install failed</span>{" "}
                {installError}
                <br />
                <br />
                <button
                  type="button"
                  className="ghost"
                  onClick={beginInstall}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="ghost ml-2"
                  onClick={onBack}
                >
                  Back
                </button>
              </>
            ) : (
              progress.message || ""
            )}
          </div>
          <details className="mt-4">
            <summary
              className="muted"
              style={{ cursor: "pointer", fontSize: 12 }}
            >
              Show installer log
            </summary>
            <pre
              ref={logRef}
              className="logs"
              style={{
                marginTop: 8,
                fontSize: 10,
                maxHeight: 200,
              }}
            >
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
        const icon = c.passed ? "✓" : c.level === "warning" ? "!" : "✗";
        const badgeClass = c.passed
          ? "ok"
          : c.level === "warning"
            ? "warn"
            : "err";
        return (
          <div key={i} style={{ margin: "8px 0" }}>
            <span
              className={`badge ${badgeClass}`}
              style={{
                display: "inline-block",
                minWidth: 18,
                textAlign: "center",
              }}
            >
              {icon}
            </span>
            <strong style={{ marginLeft: 6 }}>{c.name}</strong>
            <div
              className="muted"
              style={{ fontSize: 12, marginLeft: 24 }}
            >
              {c.message}
            </div>
            {c.remediation && (
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  marginLeft: 24,
                  marginTop: 4,
                }}
              >
                {c.remediation}
              </div>
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
}: {
  children: React.ReactNode;
  canNext: boolean;
  onNext?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  skipLabel?: string;
  hideSkip?: boolean;
}) {
  return (
    <>
      <div>{children}</div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 32,
          paddingTop: 24,
          borderTop: "1px solid var(--line)",
        }}
      >
        {onBack ? (
          <button
            type="button"
            className="ghost"
            onClick={onBack}
          >
            ← Back
          </button>
        ) : (
          <div />
        )}
        <div style={{ display: "flex", gap: 8 }}>
          {!hideSkip && onSkip && (
            <button
              type="button"
              className="ghost"
              onClick={onSkip}
            >
              {skipLabel || "Skip"}
            </button>
          )}
          {canNext && onNext && (
            <button
              type="button"
              className="primary"
              onClick={onNext}
            >
              {nextLabel || "Next →"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
