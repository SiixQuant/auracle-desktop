// The sign-in gate — what the pre-auth screen may claim, and when.
//
// The launcher's only way in is the engine's HOSTED sign-in page, and that
// page is served by the local engine on loopback. So the whole flow depends
// on a machine that may not be running: with the stack down, opening the
// browser lands on a connection error, and the card would sit on "Waiting
// for browser sign-in…" for something that can never complete — a waiting
// state for a state the machine is not in (DESIGN.md §4).
//
// The decision lives here, pure and tested (DESIGN.md §8.1); App.tsx runs
// the probe and the one timer, and the sign-in card draws the result.
//
// Reachability itself is `onboarding.engineIsUp` — any health answer other
// than "down" means the engine responded, which is all the sign-in route
// needs. A 401 or a degraded stack still serves it; only a connection
// error means there is nothing to sign in to.

/** Where the pre-auth screen is in the browser sign-in flow. */
export type SignInPhase =
  /** Nothing in flight — the button is the next move. */
  | "idle"
  /** The browser is open; we're polling for the shared session. */
  | "waiting"
  /** The engine isn't answering, so sign-in cannot start. */
  | "engine-down";

/** The verdict shown when the engine isn't answering. Says what happened —
 *  the browser was NOT opened — rather than narrating a wait. */
export const ENGINE_DOWN_LINE = "The engine isn't running, so sign-in can't start.";

/** The next move. The launcher's own start verb lives on the home, behind
 *  this screen, and the two most likely reasons the engine is unreachable
 *  here (no Docker, nothing installed yet) are not things this screen can
 *  fix — so it names the move instead of offering a control that would
 *  mostly fail (DESIGN.md §4.7: no dead controls). */
export const ENGINE_DOWN_DETAIL = "Start Auracle's engine first, then try again.";

/** How often to re-probe while a phase is live. Matches the session poll
 *  cadence this timer replaced. */
export const SIGN_IN_POLL_MS = 3_000;

/** Give up waiting after this many ticks (~5 min at the poll cadence), the
 *  same ceiling the flow has always had. */
export const SIGN_IN_MAX_TICKS = 100;

/**
 * The phase a sign-in click produces. Reachable → we open the browser and
 * wait; unreachable → we open nothing and say so.
 */
export function phaseOnStart(reachable: boolean): SignInPhase {
  return reachable ? "waiting" : "engine-down";
}

/**
 * The phase after a reachability probe.
 *
 *  - waiting + unreachable → the sign-in it was waiting on can no longer
 *    complete, so the wait is retired and the card explains why.
 *  - engine-down + reachable → hand the screen back to the user. It does
 *    NOT return to "waiting": nothing may re-open the browser without a
 *    click.
 *  - everything else is unchanged.
 */
export function phaseOnProbe(
  phase: SignInPhase,
  reachable: boolean,
): SignInPhase {
  if (phase === "waiting" && !reachable) return "engine-down";
  if (phase === "engine-down" && reachable) return "idle";
  return phase;
}

/** Whether this phase needs the engine probe running. Idle needs no timer —
 *  the click probes for itself. */
export function shouldProbe(phase: SignInPhase): boolean {
  return phase === "waiting" || phase === "engine-down";
}
