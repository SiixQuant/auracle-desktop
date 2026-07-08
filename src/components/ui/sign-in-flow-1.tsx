import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { AuracleGlyph } from "@/components/AuracleGlyph";
import { CanvasRevealEffect } from "@/components/ui/canvas-reveal-effect";

// The animated dot-matrix backdrop lives in canvas-reveal-effect.tsx so the
// launcher home (ShellBackground) renders the EXACT same motion from one
// source. Re-export it so any external importer of this module keeps working.
export { CanvasRevealEffect };

interface SignInPageProps {
  className?: string;
  /** Continue with Google — open the engine's hosted Clerk sign-in in the
   *  browser. This is the ONLY sign-in path: authorization is mandatory so
   *  every user resolves to a plan (there is no skip / anonymous entry). */
  onGoogleSignIn?: () => void;
  /** True while waiting for the browser sign-in to complete. */
  googleWaiting?: boolean;
}

/** Minimal Auracle wordmark — the orbital mark from the design, no nav chrome. */
function AuracleMark() {
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2.5">
      <AuracleGlyph className="w-6 h-6 text-white/90" />
      <span className="text-sm font-semibold tracking-wide text-white/90">
        Auracle
      </span>
    </div>
  );
}

export const SignInPage = ({
  className,
  onGoogleSignIn,
  googleWaiting,
}: SignInPageProps) => {
  return (
    <div
      className={cn(
        "auracle-signin flex w-[100%] flex-col min-h-screen bg-black relative",
        className
      )}
    >
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0">
          <CanvasRevealEffect
            animationSpeed={3}
            containerClassName="bg-black"
            colors={[
              [255, 255, 255],
              [255, 255, 255],
            ]}
            dotSize={6}
            reverse={false}
          />
        </div>

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,0,0,1)_0%,_transparent_100%)]" />
        <div className="absolute top-0 left-0 right-0 h-1/3 bg-gradient-to-b from-black to-transparent" />
      </div>

      {/* Content Layer */}
      <div className="relative z-10 flex flex-col flex-1">
        <AuracleMark />

        <div className="flex flex-1 flex-col lg:flex-row ">
          <div className="flex-1 flex flex-col justify-center items-center">
            <div className="w-full mt-[150px] max-w-sm">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="space-y-6 text-center"
              >
                <div className="space-y-1">
                  <h1 className="text-[2.5rem] font-bold leading-[1.1] tracking-tight text-white">
                    Welcome to Auracle
                  </h1>
                  <p className="text-[1.8rem] text-white/70 font-light">
                    Sign in to your workspace
                  </p>
                </div>

                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={() => onGoogleSignIn?.()}
                    disabled={googleWaiting || !onGoogleSignIn}
                    className="w-full flex items-center justify-center gap-3 bg-white text-black font-medium rounded-full py-3.5 px-4 hover:bg-white/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                  <p className="text-xs text-white/45">
                    {googleWaiting
                      ? "Finish signing in in your browser, then return here."
                      : "Opens a secure Auracle sign-in in your browser."}
                  </p>
                </div>

                <p className="text-xs text-white/40 pt-10">
                  By continuing, you agree to the{" "}
                  <a
                    href="https://auracle-engine.com/terms"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-white/40 hover:text-white/60 transition-colors"
                  >
                    Terms
                  </a>{" "}
                  and{" "}
                  <a
                    href="https://auracle-engine.com/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-white/40 hover:text-white/60 transition-colors"
                  >
                    Privacy Policy
                  </a>
                  .
                </p>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
