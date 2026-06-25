// First-run decision helpers.
//
// The launcher must NOT push a fresh install when an Auracle stack is
// already up — a fresh install re-runs install.sh, which brings up a second
// stack that collides with the running one on the shared ports (1969, 5432,
// 80/443, …). These two predicates are the single source of truth for that
// decision, used by both the App first-launch gate and the Onboarding
// install step.

import type { HealthSnapshot } from "@/lib/tauri";

/**
 * True when the engine is reachable (the health probe got any response other
 * than "down"). "starting" / "degraded" still mean a stack exists and owns
 * the ports — so for install purposes the stack is up.
 */
export function engineIsUp(health: HealthSnapshot | null | undefined): boolean {
  return !!health && health.state !== "down";
}

/**
 * Whether first-run onboarding should be shown. Onboarding installs the
 * stack, so it's only needed when there is no install marker AND no live
 * engine. Either signal alone means "nothing to install".
 */
export function needsOnboarding(
  installed: boolean,
  health: HealthSnapshot | null | undefined,
): boolean {
  return !installed && !engineIsUp(health);
}
