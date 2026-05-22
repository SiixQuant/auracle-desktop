// Typed bridge to the Rust backend.
//
// The Rust side registers commands in src-tauri/src/lib.rs via
// `tauri::generate_handler![...]`. Calling anything not in that
// list throws. Every typed binding below corresponds 1:1 to a
// registered handler — if you add a command in Rust, mirror it here.
//
// We don't depend on the `@tauri-apps/api/core` import path
// directly from view code; everything goes through this module so
// the typing is centralized and a non-Tauri context (running the
// Vite dev server in a normal browser tab) fails with a clear
// runtime error instead of an undefined-is-not-a-function crash.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/**
 * Wrap a Tauri invoke call with a typed return + a clear "not in
 * Tauri" error when running outside the launcher (e.g. opening the
 * Vite dev URL in a regular browser for design work).
 */
async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error(
      `Tauri backend not available — running outside the launcher? (cmd=${cmd})`,
    );
  }
  return tauriInvoke<T>(cmd, args);
}

// ── Domain types ────────────────────────────────────────────────
//
// These mirror what the Rust commands return. Keep them in sync
// with src-tauri/src/commands/* — if Rust adds a field, mirror it
// here so callers can read it without `any`.

export type HealthState = "healthy" | "degraded" | "down" | "starting";

export interface HealthSnapshot {
  state: HealthState;
  /** ISO-8601 timestamp of the last successful probe. */
  last_ok_at?: string | null;
  /** Last error message, if any. */
  last_error?: string | null;
}

export interface ContainerStatus {
  name: string;
  state: string;
  health?: string;
}

export interface StackStatus {
  containers: ContainerStatus[];
}

export interface DockerStatus {
  installed: boolean;
  running: boolean;
  version?: string;
  /** Which Docker runtime: docker-desktop / orbstack / colima / engine / rancher */
  runtime?: string;
  /** OS+arch-specific direct download URL when not installed. */
  install_url?: string;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  version?: string;
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  level: "info" | "warning" | "error";
  message: string;
  remediation?: string;
}

export interface PreflightReport {
  can_install: boolean;
  checks: PreflightCheck[];
}

export type ViewMode = "browser" | "embedded";

// ── Command bindings ────────────────────────────────────────────

export const cmd = {
  // Health
  currentHealth: () => invoke<HealthSnapshot | null>("current_health"),
  healthcheckNow: () => invoke<HealthSnapshot>("healthcheck_now"),

  // Docker
  dockerStatus: () => invoke<DockerStatus>("docker_status"),
  dockerInstallUrl: () => invoke<string>("docker_install_url"),
  dockerInstallLandingUrl: () => invoke<string>("docker_install_landing_url"),

  // Stack
  stackStatus: () => invoke<StackStatus>("stack_status"),
  stackStart: () => invoke<void>("stack_start"),
  stackStop: () => invoke<void>("stack_stop"),
  stackPullUpdate: () => invoke<void>("stack_pull_update"),
  stackRestartContainer: (name: string) =>
    invoke<void>("stack_restart_container", { name }),
  containerLogs: (name: string, lines = 200) =>
    invoke<string>("container_logs", { name, lines }),

  // Installer
  isInstalled: () => invoke<boolean>("is_installed"),
  runFirstInstall: () => invoke<void>("run_first_install"),
  installPath: () => invoke<string>("install_path"),
  preflightCheck: () => invoke<PreflightReport>("preflight_check"),

  // Keychain (license)
  licenseGet: () => invoke<string | null>("license_get"),
  licenseSet: (value: string) => invoke<void>("license_set", { value }),
  licenseClear: () => invoke<void>("license_clear"),

  // Updates
  checkForUpdate: () => invoke<UpdateInfo>("check_for_update"),
  installUpdate: () => invoke<void>("install_update"),
  currentVersion: () => invoke<string>("current_version"),

  // View mode
  getViewMode: () => invoke<ViewMode>("get_view_mode"),
  setViewMode: (mode: ViewMode) => invoke<void>("set_view_mode", { mode }),
  openEmbeddedAuracle: () => invoke<void>("open_embedded_auracle"),

  // IBKR Client Portal login (embedded webview)
  openIbkrLogin: (url: string) => invoke<void>("open_ibkr_login", { url }),
  closeIbkrLogin: () => invoke<void>("close_ibkr_login"),
};

// ── Misc helpers ────────────────────────────────────────────────

/**
 * Open a URL in the user's default browser via the opener plugin.
 * Falls back to a regular window.open() when running outside Tauri.
 */
export async function openInBrowser(url: string): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    return openUrl(url);
  }
  window.open(url, "_blank", "noopener");
}

/**
 * Subscribe to a Tauri event (e.g. 'installer-progress'). Returns
 * an unsubscribe function. No-op when running outside Tauri.
 */
export async function onEvent<P = unknown>(
  event: string,
  handler: (payload: P) => void,
): Promise<() => void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<P>(event, (e) => handler(e.payload));
  return unlisten;
}
