// Top-level app shell.
//
// Responsibilities (kept minimal — the Shell owns the live surface):
//   1. First-launch gate — if the stack isn't installed, Onboarding owns
//      the whole window.
//   2. Provide SharedSettings and render the single-surface Shell ("The
//      Standby" home + right-docked inspectors). There is no rail.
//   3. Drive the first-run Tutorial (once, gated on localStorage),
//      re-openable from the Shell's Help control.

import { lazy, Suspense, useEffect, useRef, useState } from "react";

import Shell from "@/components/Shell";
import Tutorial from "@/components/Tutorial";
import { engineIsUp, needsOnboarding as shouldOnboard } from "@/lib/onboarding";
import { SettingsProvider } from "@/lib/settings";
import {
  phaseOnProbe,
  phaseOnStart,
  shouldProbe,
  SIGN_IN_MAX_TICKS,
  SIGN_IN_POLL_MS,
  type SignInPhase,
} from "@/lib/signin";
import { cmd, openClerkSignIn } from "@/lib/tauri";
import Onboarding from "@/views/Onboarding";

// Lazy so the sign-in screen's own weight stays out of the signed-in app
// bundle. Its ambient backdrop is now shared code (src/fx/DotField.tsx) that
// the home loads anyway, so what defers here is just this screen.
const SignInScreen = lazy(() =>
  import("@/components/ui/sign-in-flow-1").then((m) => ({
    default: m.SignInPage,
  })),
);

const TUTORIAL_SEEN_KEY = "auracle_tutorial_seen";

/** Is the local engine answering right now? Any health answer other than
 *  "down" counts — the hosted sign-in only needs the engine to respond, and
 *  a failed probe is not an engine. Same ladder the install gate uses. */
async function engineReachable(): Promise<boolean> {
  return engineIsUp(await cmd.healthcheckNow().catch(() => null));
}

export default function App() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  // Gated on a real cached session credential (resolved during bootstrap),
  // not a bare flag — see cmd.signInStatus.
  const [signedIn, setSignedIn] = useState(false);

  // First-launch gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Signed in iff a session credential is cached on this machine, OR the
        // engine already holds a hosted sign-in session (e.g. done in the IDE).
        const hasSession = await cmd.signInStatus().catch(() => false);
        const clerk = hasSession ? null : await cmd.clerkSession().catch(() => null);
        if (cancelled) return;
        if (hasSession || clerk?.signed_in) setSignedIn(true);

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
    // The verify step already persisted the session token to the keychain;
    // sign_in_status reads it on the next launch. Just reveal the app now.
    setSignedIn(true);
  };

  // Continue with Google: the engine opens its hosted sign-in in the browser
  // and persists the shared session; we poll it until it appears, then reveal
  // the app. The engine (or the IDE) may complete it — either way we see it.
  //
  // That page is served by the LOCAL engine, so the whole flow is gated on
  // the engine answering (see @/lib/signin). Opening the browser at a
  // stopped engine can only land on a connection error, so we don't open it
  // and the card says why instead of waiting for something that cannot
  // happen.
  const [phase, setPhase] = useState<SignInPhase>("idle");
  const starting = useRef(false);

  const startGoogleSignIn = async () => {
    // The probe is a round trip; ignore a second click while it's out.
    if (starting.current) return;
    starting.current = true;
    try {
      const next = phaseOnStart(await engineReachable());
      setPhase(next);
      if (next !== "waiting") return; // engine down — nothing was opened
      try {
        await openClerkSignIn();
      } catch {
        setPhase("idle");
      }
    } finally {
      starting.current = false;
    }
  };

  // One timer, driven by the phase — never two, which would race each other
  // onto the same state. While waiting it watches both the shared session
  // appearing and the engine still being there to complete it; while the
  // engine is down it watches only for the engine to come back, and then
  // hands the screen back to the user. Returning never re-opens the browser:
  // the next move stays a click.
  useEffect(() => {
    if (!shouldProbe(phase)) return;
    let cancelled = false;
    let ticks = 0;
    const id = window.setInterval(() => {
      void (async () => {
        const reachable = await engineReachable();
        if (cancelled) return;
        const next = phaseOnProbe(phase, reachable);
        if (next !== phase) {
          setPhase(next);
          return;
        }
        if (phase !== "waiting") return;
        ticks += 1;
        if (ticks > SIGN_IN_MAX_TICKS) {
          setPhase("idle");
          return;
        }
        const s = await cmd.clerkSession().catch(() => null);
        if (!cancelled && s?.signed_in) {
          setPhase("idle");
          completeSignIn();
        }
      })();
    }, SIGN_IN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase]);

  if (!bootstrapped) return null;

  // Sign-in is the first screen until completed once. The only way in is
  // "Continue with Google" — it opens the engine's hosted Clerk sign-in in
  // the browser and we poll the shared session until it appears. A sign-in
  // done on the IDE (or the browser) resolves here too, so the two apps
  // stay in step.
  if (!signedIn) {
    return (
      <Suspense
        fallback={<div style={{ minHeight: "100vh", background: "#000" }} />}
      >
        <SignInScreen
          onGoogleSignIn={startGoogleSignIn}
          googleWaiting={phase === "waiting"}
          engineDown={phase === "engine-down"}
        />
      </Suspense>
    );
  }

  if (needsOnboarding) {
    return (
      <Onboarding
        onDone={() => setNeedsOnboarding(false)}
        onGoogleSignIn={startGoogleSignIn}
        googleWaiting={phase === "waiting"}
        engineDown={phase === "engine-down"}
      />
    );
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
