// Top-level app shell.
//
// Three responsibilities:
//   1. Run the first-launch gate — if the stack isn't installed
//      yet, force the Onboarding wizard and hide the tab nav.
//   2. Host the top bar (logo dot + version + tabs).
//   3. Route between Home / Settings via a tiny in-memory router.
//      Forge is a drill-in *under* Home (opened from a Home card),
//      not a top-level tab — the chrome stays minimal (two doors)
//      and the single platform door lives on Home as "Open Auracle".
//      No URL routing needed because the window is a single-page app.
//
// The 5-second poll of /current_health that paints the top-bar
// status dot lives here so the dot updates regardless of which
// view is mounted.

import { useEffect, useState } from "react";

import { cmd, type HealthSnapshot } from "@/lib/tauri";
import Dashboard from "@/views/Dashboard";
import Forge from "@/views/Forge";
import Onboarding from "@/views/Onboarding";
import Settings from "@/views/Settings";

type View = "dashboard" | "forge" | "settings" | "onboarding";

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [bootstrapped, setBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [version, setVersion] = useState<string>("?");
  const [health, setHealth] = useState<HealthSnapshot | null>(null);

  // First-launch gate. If the stack isn't installed, the onboarding
  // wizard owns the whole window — the tab nav stays hidden until
  // install completes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const installed = await cmd.isInstalled();
        if (cancelled) return;
        if (!installed) {
          setNeedsOnboarding(true);
          setView("onboarding");
        }
      } catch {
        // Backend unavailable — fall through to dashboard so the
        // user at least sees a (failing) status instead of a blank
        // screen.
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Launcher version label in the top bar.
  useEffect(() => {
    cmd.currentVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion("?"));
  }, []);

  // Top-bar health dot. Polls every 5s. The Rust core has its own
  // 30s probe against Houston; this 5s tick just refreshes the
  // cached snapshot in the UI without round-tripping to localhost.
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

  if (!bootstrapped) {
    // Brief flash; the bootstrap check completes in well under a
    // frame in practice. Render nothing rather than a spinner —
    // the Tauri window's own splash handles the gap.
    return null;
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span
            className={`logo-dot ${health?.state ?? ""}`}
            title={health?.state ? `Stack: ${health.state}` : "Stack health"}
          />
          <strong>Auracle</strong>
          <span className="version">v{version}</span>
        </div>

        {/* Minimal chrome: two doors only. Forge is reached from a
            Home card (a drill-in under Home), and the one door into
            the web product is Home's "Open Auracle" — so the top bar
            never re-lists destinations the platform already owns.
            Home stays lit while drilled into Forge. */}
        {!needsOnboarding && (
          <nav className="tabs">
            <button
              type="button"
              className={`tab ${
                view === "dashboard" || view === "forge" ? "active" : ""
              }`}
              onClick={() => setView("dashboard")}
            >
              Home
            </button>
            <button
              type="button"
              className={`tab ${view === "settings" ? "active" : ""}`}
              onClick={() => setView("settings")}
            >
              Settings
            </button>
          </nav>
        )}
      </header>

      {/* Forge uses a different layout — it fills the viewport
          rather than the centered max-width column. Render it
          outside <main> so it can claim full width. */}
      {view === "forge" ? (
        <Forge onExit={() => setView("dashboard")} />
      ) : (
        <main>
          {view === "onboarding" && (
            <Onboarding
              onDone={() => {
                setNeedsOnboarding(false);
                setView("dashboard");
              }}
            />
          )}
          {view === "dashboard" && (
            <Dashboard onOpenForge={() => setView("forge")} />
          )}
          {view === "settings" && <Settings />}
        </main>
      )}
    </>
  );
}
