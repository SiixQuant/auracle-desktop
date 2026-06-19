// Top-level app shell (v7.1 hub).
//
// Responsibilities:
//   1. First-launch gate — if the stack isn't installed, the
//      Onboarding wizard owns the whole window.
//   2. Host the left nav rail (brand + Home/Settings/Help + health
//      dot + version) and route the content area between views.
//   3. Run the 5s health poll that paints the rail's status dot.
//   4. Drive the first-run Tutorial (once, gated on localStorage),
//      re-openable from Home and Help.

import { useEffect, useState } from "react";

import Flame from "@/components/Flame";
import Tutorial from "@/components/Tutorial";
import { SettingsProvider } from "@/lib/settings";
import { cmd, type HealthSnapshot } from "@/lib/tauri";
import Dashboard from "@/views/Dashboard";
import Onboarding from "@/views/Onboarding";
import Settings from "@/views/Settings";

type View = "dashboard" | "settings" | "help";

const TUTORIAL_SEEN_KEY = "auracle_tutorial_seen";

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [bootstrapped, setBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [version, setVersion] = useState<string>("?");
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [licensed, setLicensed] = useState<boolean | null>(null);
  const [showTutorial, setShowTutorial] = useState(false);

  // First-launch gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const installed = await cmd.isInstalled();
        if (cancelled) return;
        if (!installed) {
          setNeedsOnboarding(true);
        }
      } catch {
        // Backend unavailable — fall through to the hub so the user
        // sees a (failing) status rather than a blank screen.
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Version label + license tier (rail).
  useEffect(() => {
    cmd.currentVersion().then(setVersion).catch(() => setVersion("?"));
    cmd.licenseGet()
      .then((v) => setLicensed(!!v))
      .catch(() => setLicensed(null));
  }, []);

  // Rail health dot. Polls every 5s.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const snap = await cmd.currentHealth();
        if (!cancelled) setHealth(snap);
      } catch {
        if (!cancelled) setHealth(null);
      }
    };
    refresh();
    const handle = window.setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  // First-run tutorial — once, after install completes.
  useEffect(() => {
    if (!bootstrapped || needsOnboarding) return;
    try {
      if (!localStorage.getItem(TUTORIAL_SEEN_KEY)) setShowTutorial(true);
    } catch {
      // localStorage unavailable — skip the auto-tour silently.
    }
  }, [bootstrapped, needsOnboarding]);

  const closeTutorial = () => {
    setShowTutorial(false);
    try {
      localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    } catch {
      // ignore
    }
  };

  if (!bootstrapped) return null;

  if (needsOnboarding) {
    return (
      <Onboarding
        onDone={() => {
          setNeedsOnboarding(false);
          setView("dashboard");
        }}
      />
    );
  }

  return (
    <SettingsProvider>
    <div className="shell">
      <nav className="rail">
        <div className="rail__brand">
          <Flame size={22} />
          <strong>Auracle</strong>
        </div>
        <span className="tier-chip">{licensed ? "Licensed" : "Community"}</span>

        <button
          type="button"
          className={`nav-item${view === "dashboard" ? " active" : ""}`}
          onClick={() => setView("dashboard")}
        >
          <NavIcon name="home" /> Home
        </button>
        <button
          type="button"
          className={`nav-item${view === "settings" ? " active" : ""}`}
          onClick={() => setView("settings")}
        >
          <NavIcon name="settings" /> Settings
        </button>
        <button
          type="button"
          className={`nav-item${view === "help" ? " active" : ""}`}
          onClick={() => setView("help")}
        >
          <NavIcon name="help" /> Help
        </button>

        <div className="rail__foot">
          <span
            className={`logo-dot ${health?.state ?? ""}`}
            title={health?.state ? `Engine: ${health.state}` : "Engine status"}
          />
          <span className="version">v{version}</span>
        </div>
      </nav>

      <div className="content">
        {view === "dashboard" && (
          <Dashboard
            onOpenTutorial={() => setShowTutorial(true)}
            onGotoSettings={() => setView("settings")}
          />
        )}
        {view === "settings" && <Settings />}
        {view === "help" && <Help onOpenTutorial={() => setShowTutorial(true)} />}
      </div>

      {showTutorial && <Tutorial onClose={closeTutorial} />}
    </div>
    </SettingsProvider>
  );
}

// ── Help view ───────────────────────────────────────────────────────

function Help({ onOpenTutorial }: { onOpenTutorial: () => void }) {
  return (
    <div className="view-narrow">
      <h1>Help</h1>
      <div className="card">
        <div className="row">
          <div>
            <div>Take the tour</div>
            <div className="muted fs-sm mt-1">A 4-step walkthrough of the launcher.</div>
          </div>
          <button type="button" className="ghost" onClick={onOpenTutorial}>
            Open tour
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rail icons (inline, no icon-font dependency) ────────────────────

function NavIcon({ name }: { name: "home" | "settings" | "help" }) {
  const common = {
    width: 17,
    height: 17,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "home") {
    return (
      <svg {...common}>
        <path d="M3 9.5 L10 4 L17 9.5" />
        <path d="M5 8.5 V16 H15 V8.5" />
      </svg>
    );
  }
  if (name === "settings") {
    return (
      <svg {...common}>
        <path d="M3 6 H17 M3 10 H17 M3 14 H17" />
        <circle cx="7" cy="6" r="1.7" fill="currentColor" stroke="none" />
        <circle cx="13" cy="10" r="1.7" fill="currentColor" stroke="none" />
        <circle cx="8" cy="14" r="1.7" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="10" cy="10" r="7" />
      <path d="M8.2 8 a2 2 0 1 1 2.6 2 c-0.6 0.35 -0.8 0.8 -0.8 1.4" />
      <circle cx="10" cy="14.3" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
