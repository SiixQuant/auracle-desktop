import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { CanvasRevealEffect } from "@/components/ui/canvas-reveal-effect";

// The animated dot-matrix backdrop lives in canvas-reveal-effect.tsx so the
// launcher home (ShellBackground) renders the EXACT same motion from one
// source. Re-export it so any external importer of this module keeps working.
export { CanvasRevealEffect };

interface SignInPageProps {
  className?: string;
  /** Called once the user finishes the flow ("Continue to Auracle"). */
  onComplete?: () => void;
  /** Email step — ask the engine to email a 6-digit sign-in code. */
  onRequestCode?: (email: string) => Promise<void> | void;
  /** Code step — verify the entered code. Resolve with the outcome
   *  status ("ready" | "invalid" | "expired" | "locked"). When omitted, the
   *  flow falls back to a local demo success (used outside the launcher). */
  onVerifyCode?: (
    email: string,
    code: string
  ) => Promise<{ status: string; tier?: string | null } | void>;
}

/** Minimal Auracle wordmark — the orbital mark from the design, no nav chrome. */
function AuracleMark() {
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2.5">
      <div className="relative w-5 h-5 flex items-center justify-center">
        <span className="absolute w-1.5 h-1.5 rounded-full bg-gray-200 top-0 left-1/2 -translate-x-1/2 opacity-80" />
        <span className="absolute w-1.5 h-1.5 rounded-full bg-gray-200 left-0 top-1/2 -translate-y-1/2 opacity-80" />
        <span className="absolute w-1.5 h-1.5 rounded-full bg-gray-200 right-0 top-1/2 -translate-y-1/2 opacity-80" />
        <span className="absolute w-1.5 h-1.5 rounded-full bg-gray-200 bottom-0 left-1/2 -translate-x-1/2 opacity-80" />
      </div>
      <span className="text-sm font-semibold tracking-wide text-white/90">
        Auracle
      </span>
    </div>
  );
}

export const SignInPage = ({
  className,
  onComplete,
  onRequestCode,
  onVerifyCode,
}: SignInPageProps) => {
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"email" | "code" | "success">("email");
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [initialCanvasVisible, setInitialCanvasVisible] = useState(true);
  const [reverseCanvasVisible, setReverseCanvasVisible] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || sending) return;
    setEmailError(null);
    // No requester wired (standalone demo) → just advance.
    if (!onRequestCode) {
      setStep("code");
      return;
    }
    // Only claim "we sent you a code" AFTER the engine confirms the send.
    // Previously this fired the request fire-and-forget and advanced
    // immediately, so a failed send (HQ down, bad address, rate-limited)
    // still showed "we sent you a code" and the user waited forever.
    setSending(true);
    try {
      await onRequestCode(email);
      setStep("code");
    } catch {
      setEmailError(
        "Couldn't send the code — check the email address and your " +
          "connection, then try again.",
      );
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (step === "code") {
      setTimeout(() => {
        codeInputRefs.current[0]?.focus();
      }, 500);
    }
  }, [step]);

  const playSuccess = () => {
    setReverseCanvasVisible(true);
    setTimeout(() => {
      setInitialCanvasVisible(false);
    }, 50);
    setTimeout(() => {
      setStep("success");
    }, 2000);
  };

  const submitCode = async (digits: string[]) => {
    const joined = digits.join("");
    if (joined.length !== 6 || verifying) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      // No verifier wired (e.g. standalone demo) → local success.
      if (!onVerifyCode) {
        playSuccess();
        return;
      }
      const result = await onVerifyCode(email, joined);
      const status = (result && "status" in result && result.status) || "ready";
      if (status === "ready") {
        playSuccess();
      } else {
        setVerifyError(
          status === "locked"
            ? "Too many attempts — start over to get a new code."
            : status === "expired"
              ? "That code expired — request a new one."
              : "That code didn't match. Try again."
        );
        setCode(["", "", "", "", "", ""]);
        codeInputRefs.current[0]?.focus();
      }
    } catch {
      setVerifyError("Couldn't reach Auracle. Make sure the engine is running.");
    } finally {
      setVerifying(false);
    }
  };

  const handleCodeChange = (index: number, value: string) => {
    if (value.length <= 1) {
      const newCode = [...code];
      newCode[index] = value;
      setCode(newCode);
      if (verifyError) setVerifyError(null);

      if (value && index < 5) {
        codeInputRefs.current[index + 1]?.focus();
      }

      // Auto-submit once all six are filled.
      if (index === 5 && value && newCode.every((digit) => digit.length === 1)) {
        void submitCode(newCode);
      }
    }
  };

  const handleKeyDown = (
    index: number,
    e: React.KeyboardEvent<HTMLInputElement>
  ) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      codeInputRefs.current[index - 1]?.focus();
    }
  };

  const handleBackClick = () => {
    setStep("email");
    setCode(["", "", "", "", "", ""]);
    setReverseCanvasVisible(false);
    setInitialCanvasVisible(true);
  };

  return (
    <div
      className={cn(
        "auracle-signin flex w-[100%] flex-col min-h-screen bg-black relative",
        className
      )}
    >
      <div className="absolute inset-0 z-0">
        {initialCanvasVisible && (
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
        )}

        {reverseCanvasVisible && (
          <div className="absolute inset-0">
            <CanvasRevealEffect
              animationSpeed={4}
              containerClassName="bg-black"
              colors={[
                [255, 255, 255],
                [255, 255, 255],
              ]}
              dotSize={6}
              reverse={true}
            />
          </div>
        )}

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,0,0,1)_0%,_transparent_100%)]" />
        <div className="absolute top-0 left-0 right-0 h-1/3 bg-gradient-to-b from-black to-transparent" />
      </div>

      {/* Content Layer */}
      <div className="relative z-10 flex flex-col flex-1">
        <AuracleMark />

        <div className="flex flex-1 flex-col lg:flex-row ">
          <div className="flex-1 flex flex-col justify-center items-center">
            <div className="w-full mt-[150px] max-w-sm">
              <AnimatePresence mode="wait">
                {step === "email" ? (
                  <motion.div
                    key="email-step"
                    initial={{ opacity: 0, x: -100 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -100 }}
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
                      <form onSubmit={handleEmailSubmit}>
                        <div className="relative">
                          <input
                            type="email"
                            placeholder="you@company.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full backdrop-blur-[1px] text-white border border-white/15 bg-white/5 rounded-full py-3 px-4 focus:outline-none focus:border-white/40 text-center placeholder:text-white/40"
                            required
                          />
                          <button
                            type="submit"
                            disabled={sending}
                            className="absolute right-1.5 top-1.5 text-white w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors group overflow-hidden disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {sending ? (
                              <span className="animate-spin">…</span>
                            ) : (
                              <span className="relative w-full h-full block overflow-hidden">
                                <span className="absolute inset-0 flex items-center justify-center transition-transform duration-300 group-hover:translate-x-full">
                                  →
                                </span>
                                <span className="absolute inset-0 flex items-center justify-center transition-transform duration-300 -translate-x-full group-hover:translate-x-0">
                                  →
                                </span>
                              </span>
                            )}
                          </button>
                        </div>
                        {emailError && (
                          <p className="text-sm text-red-400/90 mt-3">
                            {emailError}
                          </p>
                        )}
                      </form>
                    </div>

                    {onComplete && (
                      <button
                        onClick={() => onComplete()}
                        className="text-white/40 hover:text-white/70 text-sm transition-colors"
                      >
                        Skip for now &rarr;
                      </button>
                    )}

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
                ) : step === "code" ? (
                  <motion.div
                    key="code-step"
                    initial={{ opacity: 0, x: 100 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 100 }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className="space-y-6 text-center"
                  >
                    <div className="space-y-1">
                      <h1 className="text-[2.5rem] font-bold leading-[1.1] tracking-tight text-white">
                        We sent you a code
                      </h1>
                      <p className="text-[1.25rem] text-white/50 font-light">
                        Check {email || "your email"} and enter it below
                      </p>
                    </div>

                    <div className="w-full">
                      <div className="relative rounded-full py-4 px-5 border border-white/10 bg-transparent">
                        <div className="flex items-center justify-center">
                          {code.map((digit, i) => (
                            <div key={i} className="flex items-center">
                              <div className="relative">
                                <input
                                  ref={(el) => {
                                    codeInputRefs.current[i] = el;
                                  }}
                                  type="text"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  maxLength={1}
                                  value={digit}
                                  onChange={(e) =>
                                    handleCodeChange(i, e.target.value)
                                  }
                                  onKeyDown={(e) => handleKeyDown(i, e)}
                                  className="w-8 text-center text-xl bg-transparent text-white border-none focus:outline-none focus:ring-0 appearance-none"
                                  style={{ caretColor: "transparent" }}
                                />
                                {!digit && (
                                  <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center pointer-events-none">
                                    <span className="text-xl text-white">0</span>
                                  </div>
                                )}
                              </div>
                              {i < 5 && (
                                <span className="text-white/20 text-xl">|</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {verifyError && (
                      <p className="text-sm text-red-400/90">{verifyError}</p>
                    )}

                    <div>
                      <motion.p
                        onClick={() => {
                          setVerifyError(null);
                          setCode(["", "", "", "", "", ""]);
                          codeInputRefs.current[0]?.focus();
                          Promise.resolve(onRequestCode?.(email)).catch(
                            () => {}
                          );
                        }}
                        className="text-white/50 hover:text-white/70 transition-colors cursor-pointer text-sm"
                        whileHover={{ scale: 1.02 }}
                        transition={{ duration: 0.2 }}
                      >
                        Resend code
                      </motion.p>
                    </div>

                    <div className="flex w-full gap-3">
                      <motion.button
                        onClick={handleBackClick}
                        className="rounded-full bg-white text-black font-medium px-8 py-3 hover:bg-white/90 transition-colors w-[30%]"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        transition={{ duration: 0.2 }}
                      >
                        Back
                      </motion.button>
                      <motion.button
                        onClick={() => void submitCode(code)}
                        className={`flex-1 rounded-full font-medium py-3 border transition-all duration-300 ${
                          code.every((d) => d !== "") && !verifying
                            ? "bg-white text-black border-transparent hover:bg-white/90 cursor-pointer"
                            : "bg-[#111] text-white/50 border-white/10 cursor-not-allowed"
                        }`}
                        disabled={!code.every((d) => d !== "") || verifying}
                      >
                        {verifying ? "Verifying…" : "Continue"}
                      </motion.button>
                    </div>

                    {onComplete && (
                      <button
                        onClick={() => onComplete()}
                        className="text-white/40 hover:text-white/70 text-sm transition-colors"
                      >
                        Skip for now &rarr;
                      </button>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="success-step"
                    initial={{ opacity: 0, y: 50 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, ease: "easeOut", delay: 0.3 }}
                    className="space-y-6 text-center"
                  >
                    <div className="space-y-1">
                      <h1 className="text-[2.5rem] font-bold leading-[1.1] tracking-tight text-white">
                        You're in!
                      </h1>
                      <p className="text-[1.25rem] text-white/50 font-light">
                        Welcome to Auracle
                      </p>
                    </div>

                    <motion.div
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.5, delay: 0.5 }}
                      className="py-10"
                    >
                      <div className="mx-auto w-16 h-16 rounded-full bg-gradient-to-br from-white to-white/70 flex items-center justify-center">
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-8 w-8 text-black"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                    </motion.div>

                    <motion.button
                      onClick={() => onComplete?.()}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 1 }}
                      className="w-full rounded-full bg-white text-black font-medium py-3 hover:bg-white/90 transition-colors"
                    >
                      Continue to Auracle
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
