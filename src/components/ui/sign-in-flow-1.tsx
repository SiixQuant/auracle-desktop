import { useRef } from "react";

import { cn } from "@/lib/utils";
import { AuracleGlyph } from "@/components/AuracleGlyph";
import DotField from "@/fx/DotField";
import { DUR, enter, useGSAP } from "@/fx/motion";
import { ENGINE_DOWN_DETAIL, ENGINE_DOWN_LINE } from "@/lib/signin";

interface SignInPageProps {
  className?: string;
  /** Continue with Google — open the engine's hosted Clerk sign-in in the
   *  browser. This is the ONLY sign-in path: authorization is mandatory so
   *  every user resolves to a plan (there is no skip / anonymous entry). */
  onGoogleSignIn?: () => void;
  /** True while waiting for the browser sign-in to complete. */
  googleWaiting?: boolean;
  /** True when the local engine isn't answering — the hosted sign-in it
   *  serves cannot start, and nothing was opened. Mutually exclusive with
   *  `googleWaiting`: see @/lib/signin. */
  engineDown?: boolean;
}

/** Minimal Auracle wordmark — the orbital mark from the design, no nav chrome.
 *
 *  The utilities here name TOKENS rather than colours (`text-[var(--fg)]`), so
 *  this screen turns with the rest of the product instead of holding a private
 *  palette. It is the same law the hand-built stylesheet follows; Tailwind is
 *  only how this one component spells it. */
function AuracleMark() {
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2.5">
      <AuracleGlyph className="w-6 h-6 text-[var(--fg)]" />
      <span className="text-sm font-semibold tracking-wide text-[var(--fg)]">
        Auracle
      </span>
    </div>
  );
}

export const SignInPage = ({
  className,
  onGoogleSignIn,
  googleWaiting,
  engineDown,
}: SignInPageProps) => {
  const cardRef = useRef<HTMLDivElement>(null);

  // The one entrance on this screen: the card lifts in on the house enter
  // curve. useGSAP runs it in a layout effect scoped to the card, so the
  // "from" state is applied before the first paint (no flash) and StrictMode's
  // double-mount reverts cleanly. Under prefers-reduced-motion the duration
  // collapses to 0 inside `enter` — the card is simply there.
  useGSAP(
    () => {
      enter(cardRef.current, { y: 20, duration: DUR.long });
    },
    { scope: cardRef },
  );

  return (
    <div
      className={cn(
        "auracle-signin flex w-[100%] flex-col min-h-screen bg-[var(--bg)] relative",
        className
      )}
    >
      {/* Ambient stage — the same canvas, ink and power law the home runs, so
          the threshold and the room behind it read as one chamber. The veil +
          vignette that used to sit on top of it are gone with the shader they
          were tuned against: the field is a whisper of ink on the cream
          ground and needs no taming. */}
      <DotField className="z-0" />

      {/* Content Layer */}
      <div className="relative z-10 flex flex-col flex-1">
        <AuracleMark />

        <div className="flex flex-1 flex-col lg:flex-row ">
          <div className="flex-1 flex flex-col justify-center items-center">
            <div className="w-full mt-[150px] max-w-sm">
              <div ref={cardRef} className="space-y-6 text-center">
                <div className="space-y-1">
                  {/* The display register (§2.2): this h1 inherits the
                      display face from the element rule in app.css, and the
                      weight it is set at — 500, tight — is the same one the
                      home's verdict takes. Never bolder. */}
                  <h1 className="text-[2.5rem] font-medium leading-[1.1] tracking-tight text-[var(--fg)]">
                    Welcome to Auracle
                  </h1>
                  <p className="text-[1.8rem] text-[var(--fg-dim)] font-normal">
                    Sign in to your workspace
                  </p>
                </div>

                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={() => onGoogleSignIn?.()}
                    disabled={googleWaiting || !onGoogleSignIn}
                    className="w-full flex items-center justify-center gap-3 bg-[var(--paper)] text-[var(--fg)] border border-[var(--line)] font-medium rounded-full py-3.5 px-4 hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {!googleWaiting && (
                      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                      </svg>
                    )}
                    {googleWaiting
                      ? "Waiting for browser sign-in…"
                      : "Continue with Google"}
                  </button>
                  {/* Truth over ceremony: with the engine down nothing was
                      opened, so the card says what happened and what the next
                      move is instead of narrating a wait that can't end. The
                      button above stays live — pressing it re-checks the
                      engine, and the check runs on its own too, so this line
                      clears itself the moment the engine answers. */}
                  {engineDown ? (
                    <div className="space-y-1" role="status">
                      <p className="text-sm text-[var(--fg-dim)]">
                        {ENGINE_DOWN_LINE}
                      </p>
                      <p className="text-xs text-[var(--fg-muted)]">
                        {ENGINE_DOWN_DETAIL}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--fg-muted)]">
                      {googleWaiting
                        ? "Finish signing in in your browser, then return here."
                        : "Opens a secure Auracle sign-in in your browser."}
                    </p>
                  )}
                </div>

                <p className="text-xs text-[var(--fg-muted)] pt-10">
                  By continuing, you agree to the{" "}
                  <a
                    href="https://auracle-engine.com/terms"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors"
                  >
                    Terms
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://auracle-engine.com/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors"
                  >
                    Privacy Policy
                  </a>
                  .
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
