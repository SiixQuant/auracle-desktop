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

/**
 * True when the engine is actually SERVING — Houston answered a health
 * probe with a real status. Stricter than engineIsUp(): "starting" means
 * containers launched but Houston isn't ready, so it is NOT serving yet.
 * Used to gate the post-install "the stack is up" claim on real
 * reachability instead of "the installer process exited".
 */
export function engineServing(
  health: HealthSnapshot | null | undefined,
): boolean {
  return !!health && (health.state === "healthy" || health.state === "degraded");
}

/**
 * Poll ``probe`` until the engine is serving (engineServing) or the
 * attempts run out. Returns true once the engine answers, false on
 * timeout. Pure + injectable (probe/sleep) so it's unit-testable without
 * a real engine or wall-clock. Defaults: 45 attempts × 2s ≈ 90s, which
 * comfortably covers a cold container start.
 */
export async function waitForEngineHealthy(
  probe: () => Promise<HealthSnapshot | null>,
  opts: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 45);
  const intervalMs = opts.intervalMs ?? 2_000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    let health: HealthSnapshot | null = null;
    try {
      health = await probe();
    } catch {
      health = null;
    }
    if (engineServing(health)) return true;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return false;
}
