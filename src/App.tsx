// Top-level app shell.
//
// Responsibilities (kept minimal — the Shell owns the live surface):
//   1. First-launch gate — if the stack isn't installed, Onboarding owns
//      the whole window.
//   2. Provide SharedSettings and render the single-surface Shell ("The
//      Standby" home + right-docked inspectors). There is no rail.
//   3. Drive the first-run Tutorial (once, gated on localStorage),
//      re-openable from the Shell's Help control.

import { lazy, Suspense, useEffect, useState } from "react";

import Shell from "@/components/Shell";
import Tutorial from "@/components/Tutorial";
import { needsOnboarding as shouldOnboard } from "@/lib/onboarding";
import { SettingsProvider } from "@/lib/settings";
import { cmd } from "@/lib/tauri";
import Onboarding from "@/views/Onboarding";

// Lazy so the WebGL/animation deps (three, @react-three/fiber, framer-motion)
// only load on the sign-in screen, never in the signed-in app bundle.
const SignInScreen = lazy(() =>
  import("@/components/ui/sign-in-flow-1").then((m) => ({
    default: m.SignInPage,
  })),
);

const TUTORIAL_SEEN_KEY = "auracle_tutorial_seen";
const SIGNED_IN_KEY = "auracle_signed_in";

export default function App() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIGNED_IN_KEY) === "1";
    } catch {
      return false;
    }
  });

  // First-launch gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const installed = await cmd.isInstalled();
        if (cancelled) return;
        // The install marker is necessary but not sufficient: a stack can
        // be up without it (installed out-of-band, a dev stack, or a prior
        // run that wrote the compose file but isn't the live one). If the
        // engine is already answering, there is nothing to onboard — go
        // straight to the Shell rather than offering a fresh install that
        // would collide with the running stack.
        let health = null;
        if (!installed) {
          health = await cmd.healthcheckNow().catch(() => null);
          if (cancelled) return;
        }
        if (shouldOnboard(installed, health)) setNeedsOnboarding(true);
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

  const completeSignIn = () => {
    setSignedIn(true);
    try {
      localStorage.setItem(SIGNED_IN_KEY, "1");
    } catch {
      // ignore
    }
  };

  if (!bootstrapped) return null;

  // Sign-in is the first screen until completed once. The flow resolves
  // client-side (the email step also fires the engine's magic-link send),
  // so a user is never locked out of the launcher if the engine is down.
  if (!signedIn) {
    return (
      <Suspense
        fallback={<div style={{ minHeight: "100vh", background: "#000" }} />}
      >
        <SignInScreen
          onComplete={completeSignIn}
          onRequestLink={(email) => {
            void cmd.signInStart(email).catch(() => {});
          }}
        />
      </Suspense>
    );
  }

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
