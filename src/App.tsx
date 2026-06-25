// Top-level app shell.
//
// Responsibilities (kept minimal — the Shell owns the live surface):
//   1. First-launch gate — if the stack isn't installed, Onboarding owns
//      the whole window.
//   2. Provide SharedSettings and render the single-surface Shell ("The
//      Standby" home + right-docked inspectors). There is no rail.
//   3. Drive the first-run Tutorial (once, gated on localStorage),
//      re-openable from the Shell's Help control.

import { useEffect, useState } from "react";

import Shell from "@/components/Shell";
import Tutorial from "@/components/Tutorial";
import { SettingsProvider } from "@/lib/settings";
import { cmd } from "@/lib/tauri";
import Onboarding from "@/views/Onboarding";

const TUTORIAL_SEEN_KEY = "auracle_tutorial_seen";

export default function App() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  // First-launch gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const installed = await cmd.isInstalled();
        if (cancelled) return;
        if (!installed) setNeedsOnboarding(true);
      } catch {
        // Backend unavailable — fall through to the Shell so the user
        // sees a (failing) status rather than a blank screen.
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    })();
    return () => {
      cancelled = true;
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
    return <Onboarding onDone={() => setNeedsOnboarding(false)} />;
  }

  return (
    <SettingsProvider>
      <Shell
        onOpenTutorial={() => setShowTutorial(true)}
        onRerunSetup={() => setNeedsOnboarding(true)}
      />
      {showTutorial && <Tutorial onClose={closeTutorial} />}
    </SettingsProvider>
  );
}
