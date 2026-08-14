// Onboarding — the commissioning sequence. Three named stations:
//   1. Environment — Docker runtime check (auto-detects once a
//      download link is clicked; no relaunch needed)
//   2. Sign in — account or license key (skip lands on Community)
//   3. Install — pre-flight, then an EXPLICIT install start with
//      live progress. The installer never starts itself: pulling
//      gigabytes is a consented action, and an explicit gate is
//      also what keeps a failed install from auto-retrying forever.
//
// Auto-shown by App.tsx when cmd.isInstalled() returns false, and re-openable
// from the home's "Re-run setup" ghost line. Subscribes to the
// 'installer-progress' Tauri event for live progress while install.sh runs.
//
// ─── What slice 8 changed, and what it did not ────────────────────
//
// Design authority: launcher-redesign-direction.md §3.2. The horizontal
// stepper becomes a commissioning rail down the left with three stations, and
// the wizard's card becomes the same cream chamber the sign-in and the home
// stand in — with the instrument itself at the top, being BUILT. The ring is
// dim until a real Docker runtime answers; the arc is the installer's own
// percent; the core stays unlit through the entire build and ignites only when
// the engine answers a real health probe, at which point the containers the
// install actually produced take their seats and the mechanism turns for the
// first time. That frame is the home's frame, which is why the handover a
// second later is a continuation and not a cut.
//
// NOTHING ABOUT THE FLOW MOVED. Every command, poll, event subscription,
// gate, retry, consent point and endpoint below is the one that was here
// before: the 5s Docker poll and both of its triggers, the license save
// heuristic and the skip-clears-it path, the pre-flight's stack-up argument,
// the explicit install gate, `waitForEngineHealthy` and its retry, the 1.8s
// bounce to /ui/setup and `onDone()`. What changed is what they look like.
//
// The one new read is `stackStatus()` — the same call the home makes to draw
// the same bodies. It runs after the installer has already finished, purely so
// the instrument can seat the containers the install produced rather than
// inventing two. If it fails or comes back empty, the instrument falls back to
// the mark's own two chrome dots, which carry nothing.

import { useCallback, useEffect, useRef, useState } from "react";

import { AuracleGlyph } from "@/components/AuracleGlyph";
import CommissioningInstrument from "@/components/CommissioningInstrument";
import IncidentCard from "@/components/IncidentCard";
import DotField from "@/fx/DotField";
import {
  commissioningView,
  type CommissioningReading,
  type CommissioningView,
  type PreflightVerdict,
  type Station as RailStation,
} from "@/fx/commissioning";
import { DUR, gsap, mech, revealWords, useGSAP } from "@/fx/motion";
import { orreryFrame, type OrreryFrame } from "@/fx/orrery";
import { engineIsUp, waitForEngineHealthy } from "@/lib/onboarding";
import { ENGINE_DOWN_DETAIL, ENGINE_DOWN_LINE } from "@/lib/signin";
import {
  cmd,
  onEvent,
  openInBrowser,
  type ContainerStatus,
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
  /** True when the local engine isn't answering, so the browser sign-in
   *  can't start. Station 2 carries the same verdict the threshold does. */
  engineDown?: boolean;
}

/** Where the instrument's core sits down the window, as a fraction of the
 *  height — the focus point of the ambient field's brightness ramp, measured
 *  the same way the Shell measures its own: the field is there to seat the
 *  instrument, so it points at it. The commissioning stage runs a little
 *  higher than the home's because the sequence takes the room underneath. */
const INSTRUMENT_FOCUS_Y = 0.3;

/** Everything the sequence's own state machine reports up to the instrument.
 *  `step` and the browser sign-in live on the parent already; `phase` rides
 *  along because the word under the arc is the installer's, even though the
 *  staging never reads it. */
type StationReading = Omit<CommissioningReading, "step" | "signInWaiting"> & {
  phase?: string;
};

/** Station 3 as it is before it has asked anything. Re-applied whenever the
 *  install station is (re-)entered, so a reading from a previous visit can
 *  never stage the instrument ahead of a pre-flight that has not run yet. */
const UNASKED: StationReading = {
  dockerRunning: false,
  preflight: "pending",
  alreadyRunning: false,
  installing: false,
  finished: false,
  engineHealthy: null,
  installFailed: false,
  percent: undefined,
};

export default function Onboarding({
  onDone,
  onGoogleSignIn,
  googleWaiting,
  engineDown,
}: OnboardingProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [licenseKey, setLicenseKey] = useState("");
  const [reading, setReading] = useState<StationReading>(UNASKED);
  const [containers, setContainers] = useState<ContainerStatus[]>([]);

  // Pre-fill license input if a key was previously stored (re-run case).
  useEffect(() => {
    cmd.licenseGet()
      .then((v) => {
        if (v) setLicenseKey(v);
      })
      .catch(() => {});
  }, []);

  /** The stations publish facts; the instrument reads them. One direction, and
   *  the sequence's own components keep owning their state. */
  const report = useCallback((patch: Partial<StationReading>) => {
    setReading((prev) => ({ ...prev, ...patch }));
  }, []);

  const goto = useCallback(
    (next: 1 | 2 | 3) => {
      // Entering the install station clears every station-3 fact: the pre-
      // flight is about to be run again, and until it answers the honest
      // reading is "we have not been told".
      if (next === 3) {
        setReading((prev) => ({ ...UNASKED, dockerRunning: prev.dockerRunning }));
      }
      setStep(next);
    },
    [],
  );

  const view = commissioningView({
    ...reading,
    step,
    signInWaiting: !!googleWaiting,
  });

  // The bodies of the ceremony: the containers the install actually produced.
  // Read once the installer has finished and again when the engine answers —
  // in parallel with the health poll, never in front of it, so nothing the
  // user needs to READ waits on a call made for the instrument's benefit.
  useEffect(() => {
    if (!reading.finished) return;
    cmd.stackStatus()
      .then((s) => setContainers(s.containers))
      .catch(() => {});
  }, [reading.finished, reading.engineHealthy]);

  const frame = view.assembled ? orreryFrame("ready", containers) : null;

  return (
    <div className="commissioning">
      {/* The same ambient stage the threshold and the home stand on, at the
          same ink and under the same power law (the component owns it): the
          first run is the third room in one chamber, not a different app. */}
      <DotField focusY={INSTRUMENT_FOCUS_Y} />

      {/* The window carries no title bar of its own, so this strip is what you
          drag it by — on first run as much as on the home. `deep` is Tauri's
          own value for "anything in this subtree drags": with the bare
          attribute the mark and the title were inert, which is the whole of
          what this strip has to grab. A clickable child would still block the
          drag, so a control up here (there is none) would keep its click. */}
      <header className="topbar" data-tauri-drag-region="deep">
        <div className="topbar__brand">
          <AuracleGlyph className="topbar__mark" />
          <span className="commissioning__title">Commissioning your desk</span>
        </div>
      </header>

      <main
        className="commissioning__stage"
        data-phase={view.assembled ? "handover" : view.stage}
      >
        <Stage view={view} frame={frame} phase={phaseWord(reading)} />

        {view.assembled ? (
          <Handover />
        ) : (
          <div className="commissioning__sequence">
            <Rail stations={view.stations} />
            <div className="comm-station">
              {step === 1 && (
                <Station1 onNext={() => goto(2)} publish={report} />
              )}
              {step === 2 && (
                <Station2
                  licenseKey={licenseKey}
                  setLicenseKey={setLicenseKey}
                  onBack={() => goto(1)}
                  onSkip={() => {
                    cmd.licenseClear().catch(() => {});
                    goto(3);
                  }}
                  onNext={() => goto(3)}
                  onGoogleSignIn={onGoogleSignIn}
                  googleWaiting={googleWaiting}
                  engineDown={engineDown}
                />
              )}
              {step === 3 && (
                <Station3
                  licenseKey={licenseKey}
                  onBack={() => goto(2)}
                  onDone={onDone}
                  publish={report}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/** The installer's own phase word, under the arc (§3.2). Its words, with the
 *  underscores it sends turned into spaces and nothing else changed — which is
 *  why a failed install keeps the phase it died in rather than being handed a
 *  word of ours. */
function phaseWord(reading: StationReading): string | null {
  // At the handover the installer has nothing left to say that the verdict
  // underneath does not say better, and the frame is meant to BE the home's —
  // which has no phase line. Everywhere else its last word stands.
  if (reading.finished) return reading.engineHealthy === true ? null : "done";
  if (!reading.installing && !reading.installFailed) return null;
  return reading.phase ? reading.phase.replace(/_/g, " ") : "starting…";
}

// ── Band 1 — the instrument, being built ────────────────────────

function Stage({
  view,
  frame,
  phase,
}: {
  view: CommissioningView;
  frame: OrreryFrame | null;
  phase: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** The instrument's height as of the previous render, so the growth into the
   *  room the sequence vacates can be a MOVE rather than a jump. */
  const wasTall = useRef(0);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const now = el.getBoundingClientRect().height;
      const before = wasTall.current;
      wasTall.current = now;
      // The band opens up twice — when an install actually starts, and at the
      // handover — and never the other way. Anything else is a resize, which
      // is not a move and is not animated.
      if (before <= 0 || now <= before) return;
      // Transform-only, so the mechanism grows on the compositor and the §4
      // budget is untouched. Under reduced motion the time is zero and the
      // instrument is simply already this size.
      gsap.set(el, { scale: before / now, transformOrigin: "center" });
      mech(el, { scale: 1, duration: DUR.long });
    },
    { dependencies: [view.stage] },
  );

  return (
    <div className="commissioning__band">
      <div className="commissioning__instrument" ref={ref}>
        <CommissioningInstrument view={view} frame={frame} />
      </div>
      {phase && <div className="commission-phase">{phase}</div>}
    </div>
  );
}

// ── The commissioning rail (§3.2) ───────────────────────────────

function Rail({ stations }: { stations: RailStation[] }) {
  return (
    <ol className="comm-rail" aria-label="Commissioning stations">
      {stations.map((s) => (
        <li
          key={s.key}
          className="comm-rail__station"
          data-state={s.state}
          aria-current={s.state === "current" ? "step" : undefined}
        >
          <span className="comm-rail__tick" aria-hidden="true" />
          <span className="comm-rail__label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

// ── The handover (§3.2 — the ceremony's last frame) ─────────────

/** What the chamber says at the moment it becomes the home: one display
 *  line and the sentence that has always followed it. The wizard's own 1.8s
 *  timer bounces the browser and calls `onDone()` from where it always did —
 *  this surface is what is on screen while that happens, and it is not a gate
 *  on anything. */
function Handover() {
  const ref = useRef<HTMLHeadingElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      return revealWords(el);
    },
    { scope: ref },
  );

  return (
    <div className="commissioning__handover">
      <h1 className="commissioning__verdict" ref={ref}>
        The stack is up.
      </h1>
      <p className="comm-lede">
        Finishing first-run setup in your browser at <code>localhost:1969</code>{" "}
        — the launcher stays here for engine status and updates; brokers
        connect in the workspace.
      </p>
    </div>
  );
}

// ── Station 1: Environment (Docker check) ───────────────────────

function Station1({
  onNext,
  publish,
}: {
  onNext: () => void;
  publish: (patch: Partial<StationReading>) => void;
}) {
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

  // The instrument's ring lifts from dim to chrome on exactly this fact.
  useEffect(() => publish({ dockerRunning: ready }), [ready, publish]);

  return (
    <Station
      title="First, a Docker runtime."
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
      <p className="comm-lede">
        Auracle Desktop runs a self-hosted algorithmic-trading platform on this
        machine. Everything it installs needs a working Docker runtime.
      </p>

      <span className="comm-label">Docker runtime</span>
      <DockerCheck docker={docker} onTriggerPoll={startPoll} />

      <span className="comm-label">What you&apos;ll get after install</span>
      <div className="comm-rows">
        <Row k="platform">
          Backtests, schedules, brokers and live runs at{" "}
          <code>localhost:1969</code>
        </Row>
        <Row k="ide">An AI engineer that drafts and backtests with you</Row>
        <Row k="mcp">Claude and Cursor can drive Auracle directly</Row>
        <Row k="timescaledb">Tick-level price storage</Row>
      </div>
    </Station>
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
      <div className="comm-row">
        <span className="comm-row__key">docker</span>
        <span className="chip neutral">checking</span>
      </div>
    );
  }

  if (!docker.installed) {
    return (
      <>
        <div className="comm-row">
          <span className="comm-row__key">docker</span>
          <span className="chip err">not installed</span>
        </div>
        <p className="comm-note">
          Install Docker Desktop, leave this window open — the status flips on
          its own once it&apos;s running.
        </p>
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
      <>
        <div className="comm-row">
          <span className="comm-row__key">docker</span>
          <span className="comm-row__value">{runtimeName(docker.runtime)}</span>
          <span className="chip warn">installed · not running</span>
        </div>
        <p className="comm-note">
          Start <strong>{runtimeName(docker.runtime)}</strong> — this updates on
          its own once the daemon is up.
        </p>
      </>
    );
  }

  return (
    <div className="comm-row">
      <span className="comm-row__key">docker</span>
      <span className="comm-row__value">
        {docker.version || "docker"} · {runtimeName(docker.runtime)}
      </span>
      <span className="chip ok">running</span>
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

// ── Station 2: Sign in / license key ────────────────────────────

function Station2({
  licenseKey,
  setLicenseKey,
  onBack,
  onSkip,
  onNext,
  onGoogleSignIn,
  googleWaiting,
  engineDown,
}: {
  licenseKey: string;
  setLicenseKey: (v: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onGoogleSignIn?: () => void;
  googleWaiting?: boolean;
  engineDown?: boolean;
}) {
  return (
    <Station
      title="Sign in, or bring a key."
      canNext
      onBack={onBack}
      onSkip={onSkip}
      onNext={onNext}
      nextLabel="Next →"
      skipLabel="Skip for Community tier"
    >
      <p className="comm-lede">
        Sign in with your Auracle account and your subscription is your license
        — there&apos;s no key to paste. Have an enterprise or offline key
        instead? Add it below.
      </p>
      {onGoogleSignIn && (
        <>
          {/* The threshold's own control, unchanged: the Google affordance
              is a trust signal, so the pill is reproduced as its owner draws
              it — white, with the unmodified mark (§3.1). */}
          <button
            type="button"
            className="comm-google"
            onClick={() => onGoogleSignIn()}
            disabled={googleWaiting}
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
            <p className="comm-note mt-2">
              Finish signing in in your browser, then return here.
            </p>
          )}
          {/* The sign-in page is served by the local engine, so with the
              engine down the click opens nothing (see @/lib/signin) — the
              same verdict the threshold gives, in this station's voice. */}
          {engineDown && (
            <p className="comm-note mt-2" role="status">
              {ENGINE_DOWN_LINE} {ENGINE_DOWN_DETAIL}
            </p>
          )}
          <div className="comm-divider">
            <span>or with a license key</span>
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
        <div className="comm-note mono mt-2">
          {licenseKey.length >= 16
            ? "Will be saved when you click Next."
            : "Looks short — check the key for typos."}
        </div>
      ) : null}
      {/* HONESTY: these numbers are the engine's, not marketing's — they trace
          to auracle/license.py `_TIER_FEATURES["community"]` (schedule_cap 3,
          user_cap 1, broker_pinned "ibkr", live_orders False) and
          auracle/live/tiers.py (max_live_deployments 3, allowed_modes
          ("paper",)). This line previously claimed "1 strategy + 3 schedules +
          IBKR data": nothing in the engine caps the number of strategies, and
          the IBKR pin is an EXECUTION pin, not a data grant. Do not restate a
          cap here that you have not read out of those two files. */}
      <p className="comm-note mt-4">
        Don&apos;t have a key yet? Click <strong>Skip for Community tier</strong>
        {" "}below — you can add one anytime from System → License. Community is
        paper trading on IBKR: up to 3 paper deployments, 3 schedules and one
        user. Live orders need a paid plan.
      </p>
    </Station>
  );
}

// ── Station 3: Pre-flight + install ─────────────────────────────

function Station3({
  licenseKey,
  onBack,
  onDone,
  publish,
}: {
  licenseKey: string;
  onBack: () => void;
  onDone: () => void;
  publish: (patch: Partial<StationReading>) => void;
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

  // Everything the instrument is allowed to know about this station, and
  // nothing it isn't: the pre-flight's verdict, the two install flags, the
  // health answer, and the installer's own percent and phase.
  const verdict: PreflightVerdict = preflightError
    ? "failed"
    : !preflight
      ? "pending"
      : preflight.can_install
        ? "clear"
        : "blocked";
  useEffect(() => {
    publish({
      preflight: verdict,
      alreadyRunning,
      installing,
      finished,
      engineHealthy,
      installFailed: !!installError,
      percent: progress.percent,
      phase: progress.phase,
    });
  }, [
    publish,
    verdict,
    alreadyRunning,
    installing,
    finished,
    engineHealthy,
    installError,
    progress.percent,
    progress.phase,
  ]);

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
      const checks = await cmd.preflightCheck(stackUp);
      setPreflight(checks);
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

  // `Retry install` IS this action once an install has failed (§3.2), so the
  // consent block stands down rather than offering the same verb twice.
  const canInstall =
    !!preflight?.can_install &&
    !installing &&
    !finished &&
    !alreadyRunning &&
    !installError;

  return (
    <Station
      title={installTitle(
        installing,
        finished,
        engineHealthy,
        installError,
        alreadyRunning,
      )}
    >
      {!installing && !finished && !installError && !alreadyRunning && (
        <p className="comm-lede">
          Verifying your machine is ready. Nothing is downloaded until you
          start the install.
        </p>
      )}

      {/* The headline answer comes first. When a live stack already owns the
          ports there is nothing to install, and a column of green ticks about a
          machine that is already running is not the news. */}
      {alreadyRunning && !installing && !finished && (
        <div className="mt-2">
          <IncidentCard
            severity="info"
            cause="Auracle is already running."
            detail="The platform is up and answering at localhost:1969 — there's nothing to install. Re-installing over a live stack would only collide with it."
            action={{ label: "Open Auracle", onClick: onDone, primary: true }}
          />
          <button type="button" className="ghost" onClick={onBack}>
            ← Back
          </button>
        </div>
      )}

      {/* The checks belong to the moment BEFORE a download: while one is
          running they are noise, and after one has failed they are a list of
          green ticks next to a red card. The verdict they produced still gates
          the install below. */}
      {!installing && !finished && !installError && (
        <div className="comm-checks">
          {preflightError ? (
            <IncidentCard severity="err" cause="Pre-flight check failed.">
              <div className="mono err-text mt-2">{preflightError}</div>
            </IncidentCard>
          ) : preflight ? (
            <PreflightResults report={preflight} />
          ) : (
            <div className="comm-row">
              <span className="comm-row__key">pre-flight</span>
              <span className="chip neutral">running checks</span>
            </div>
          )}
        </div>
      )}

      {preflight && !preflight.can_install && (
        <div className="mt-2">
          <p className="comm-note" style={{ margin: "12px 0" }}>
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
          <p className="comm-note" style={{ margin: "12px 0" }}>
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
          <IncidentCard
            severity="err"
            cause="Install failed."
            action={{ label: "Retry install", onClick: beginInstall, primary: true }}
          >
            <div className="mono err-text mt-2">{installError}</div>
          </IncidentCard>
          <button type="button" className="ghost" onClick={onBack}>
            ← Back
          </button>
        </div>
      )}

      {installing && !finished && (
        <p className="comm-lede">
          Pulling Docker images and starting services. Safe to leave this
          window in the background — progress continues either way.
        </p>
      )}

      {finished && engineHealthy === false && (
        <IncidentCard
          severity="warn"
          cause="Containers installed, but the engine hasn't answered yet."
          detail="It can take a minute on first boot. Give it a moment, then open localhost:1969 — or check the installer log below if it doesn't come up."
          action={{
            label: "Retry health check",
            onClick: async () => {
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
            },
          }}
        />
      )}

      {(installing || finished) && progress.message && (
        <div className="comm-note">{progress.message}</div>
      )}

      {/* The installer's own words. Shown whenever it has said anything —
          which now includes a failed install, where they are the only
          account of what went wrong. */}
      {logLines.length > 0 && (
        <details className="mt-4">
          <summary className="comm-note" style={{ cursor: "pointer" }}>
            Show installer log
          </summary>
          <pre ref={logRef} className="logs logs-compact mt-2 fs-2xs">
            {logLines.join("\n")}
          </pre>
        </details>
      )}
    </Station>
  );
}

/** The install station's display line, one per real situation. */
function installTitle(
  installing: boolean,
  finished: boolean,
  engineHealthy: boolean | null,
  installError: string | null,
  alreadyRunning: boolean,
): string {
  if (installError && !installing) return "The install stopped.";
  if (finished && engineHealthy === false) return "Built, but not answering yet.";
  if (installing || finished) return "Building your desk.";
  if (alreadyRunning) return "Nothing to install.";
  return "Nothing is downloaded yet.";
}

function PreflightResults({ report }: { report: PreflightReport }) {
  return (
    <>
      {report.checks.map((c, i) => {
        const variant = c.passed ? "ok" : c.level === "warning" ? "warn" : "err";
        const label = c.passed ? "pass" : c.level === "warning" ? "warn" : "fail";
        return (
          <div key={i} className="comm-check">
            <div className="comm-row">
              <span className={`chip ${variant}`}>{label}</span>
              <span className="comm-check__name">{c.name}</span>
            </div>
            <div className="comm-note mt-1">{c.message}</div>
            {c.remediation && (
              <div className="comm-note mt-1">{c.remediation}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── Station shell — title, body, and the back/next rail ─────────

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="comm-row">
      <span className="comm-row__key">{k}</span>
      <span className="comm-row__value">{children}</span>
    </div>
  );
}

function Station({
  title,
  children,
  canNext,
  onNext,
  onBack,
  onSkip,
  nextLabel,
  skipLabel,
  nextDisabledReason,
}: {
  title: string;
  children: React.ReactNode;
  canNext?: boolean;
  onNext?: () => void;
  onBack?: () => void;
  onSkip?: () => void;
  nextLabel?: string;
  skipLabel?: string;
  nextDisabledReason?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);

  // The station title arrives word by word, like the home's verdict — the same
  // helper, so it reveals words that are already in the DOM and can do nothing
  // else. The `key` retires the element when the line changes, which is what
  // keeps the split markup from outliving the sentence it was made from.
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      return revealWords(el);
    },
    { dependencies: [title], scope: ref },
  );

  return (
    <>
      <h2 key={title} ref={ref} className="comm-station__title">
        {title}
      </h2>
      <div className="comm-station__body">{children}</div>
      {(onBack || onNext) && (
        <div className="comm-foot">
          {onBack ? (
            <button type="button" className="ghost" onClick={onBack}>
              ← Back
            </button>
          ) : (
            <div />
          )}
          <div className="hstack" style={{ gap: 8 }}>
            {onSkip && (
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
                    <span className="comm-note">{nextDisabledReason}</span>
                  )}
                  <button type="button" className="primary" disabled>
                    {nextLabel || "Next →"}
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}
    </>
  );
}
