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
  /** Release notes from the update manifest (raw text — render as
   *  plain text only, never as HTML). The Rust struct has always
   *  carried this; the interface omitted it, which is why no view
   *  ever rendered it. */
  notes?: string | null;
}

// ── Launcher-managed Auracle IDE updates ────────────────────────
//
// Mirrors commands/ide_update.rs. The launcher is the single update
// conduit for the native IDE (the IDE no longer self-updates): it
// checks GitHub Releases, then downloads + installs the .dmg into
// /Applications. macOS aarch64 only for now — `unsupported_platform`
// flags everything else so the UI degrades honestly.

export interface IdeUpdateInfo {
  /** Installed IDE version, from the launcher's install marker, or null
   *  when not installed OR installed out-of-band (version untrusted). */
  installed_version?: string | null;
  /** True iff installed_version is trustworthy (came from our marker). */
  version_tracked: boolean;
  /** Newest published IDE version, or null when nothing matching is
   *  published yet. */
  latest_version?: string | null;
  /** True iff latest is strictly newer than installed (or the IDE
   *  isn't installed) AND the platform is supported AND a .dmg exists. */
  update_available: boolean;
  /** True iff the IDE is installed here (drives "update" vs "install"). */
  installed: boolean;
  /** Browser-download URL of the .dmg, when present. Pass to install. */
  asset_url?: string | null;
  /** Declared byte size of the .dmg (for a size display + integrity check). */
  asset_size?: number | null;
  /** Release notes — render as PLAIN TEXT only, never HTML. */
  notes?: string | null;
  /** True on platforms we can't auto-install on yet (non-macOS-aarch64). */
  unsupported_platform: boolean;
}

/** Payload for the `ide-update-progress` event during download/install. */
export interface IdeUpdateProgressEvent {
  /** "downloading" | "installing" | "done" | "error" */
  phase: string;
  message: string;
  /** 0-100 best-effort. */
  percent: number;
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

// ── GitHub device-flow sign-in ──────────────────────────────────
//
// Mirrors commands/github_auth.rs. This is the user's OWN GitHub,
// used purely so git push/pull is authenticated everywhere — it is
// unrelated to (and never touches) the IDE's account/collab sign-in.
// The access token is stored in the system git credential helper by
// the Rust side and NEVER crosses this boundary.

export interface GithubAuthStatus {
  /** A non-empty client_id is compiled into this build. */
  configured: boolean;
  /** A github.com https git credential already exists. */
  connected: boolean;
  /** The stored git username for github.com, when known. */
  login?: string | null;
}

export interface GithubDeviceStart {
  /** Short code the user types on the verification page (e.g. ABCD-1234). */
  user_code: string;
  /** Page the user opens to enter the code (github.com/login/device). */
  verification_uri: string;
  /** Opaque code passed back to githubDevicePoll. Treat as a secret —
   *  never render it. */
  device_code: string;
  /** Minimum seconds to wait between polls. */
  interval: number;
  /** Seconds until the code pair expires. */
  expires_in: number;
}

export interface GithubDevicePoll {
  /** "pending" (keep polling), "authorized" (done), or "error" (retry). */
  status: "pending" | "authorized" | "error";
  /** The signed-in GitHub login, present only on "authorized". */
  login?: string | null;
}

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
  /** Force-remove a Docker container by name (whitelisted to the
   *  bundled IBKR gateway containers). Bypasses compose, so works
   *  even when the stack's .env is incomplete. */
  dockerRemoveContainer: (name: string) =>
    invoke<void>("docker_remove_container", { name }),
  /** Legacy alias for dockerRemoveContainer — retained until any
   *  cached frontend bundle stops calling it. */
  stackStopService: (name: string) =>
    invoke<void>("stack_stop_service", { name }),
  /** First name from `names` that's currently a running Docker
   *  container, or null. Used by Broker Connections to detect when
   *  Houston's bundled gateway would conflict with ibeam. */
  dockerContainerRunning: (names: string[]) =>
    invoke<string | null>("docker_container_running", { names }),

  // Installer
  isInstalled: () => invoke<boolean>("is_installed"),
  runFirstInstall: () => invoke<void>("run_first_install"),
  installPath: () => invoke<string>("install_path"),
  preflightCheck: (expectPortsInUse?: boolean) =>
    invoke<PreflightReport>("preflight_check", { expectPortsInUse }),

  // Keychain (license)
  licenseGet: () => invoke<string | null>("license_get"),
  licenseSet: (value: string) => invoke<void>("license_set", { value }),
  licenseClear: () => invoke<void>("license_clear"),
  /** Best-effort: ask the running engine to activate the key now so the
   *  tier updates without a restart. Returns the new tier, or null if the
   *  engine isn't reachable yet (the key still persists in the vault). */
  licenseActivateEngine: (value: string) =>
    invoke<string | null>("license_activate_engine", { value }),

  // Updates
  checkForUpdate: () => invoke<UpdateInfo>("check_for_update"),
  installUpdate: () => invoke<void>("install_update"),
  currentVersion: () => invoke<string>("current_version"),

  // Launch the native Auracle IDE — the primary workspace app the
  // launcher now hands the user into. Rejects with a plain message
  // when the IDE isn't installed on this machine.
  openAuracleIDE: () => invoke<void>("open_auracle_ide"),

  // ── Launcher-managed IDE updates ──────────────────────────────
  //
  // The launcher detects + installs Auracle IDE updates (the IDE no
  // longer self-updates). `ideCheckUpdate` is an unauthenticated
  // GitHub Releases query; `ideDownloadAndInstall` streams the .dmg
  // and swaps the .app into /Applications, emitting 'ide-update-progress'
  // events. See commands/ide_update.rs.
  /** Check whether a newer IDE is published vs the installed one. */
  ideCheckUpdate: () => invoke<IdeUpdateInfo>("ide_check_update"),
  /** Download + install the IDE .dmg (macOS aarch64). Verifies the
   *  download against the release's published SHA-256 before installing
   *  and rejects on a mismatch. Returns the installed version on success;
   *  rejects with a plain message (incl. a drag-install hint on
   *  permission-denied). Subscribe to 'ide-update-progress' for progress
   *  while this runs. */
  ideDownloadAndInstall: (
    assetUrl: string,
    expectedSize: number | null | undefined,
    version: string,
  ) =>
    invoke<string>("ide_download_and_install", {
      assetUrl,
      expectedSize: expectedSize ?? null,
      version,
    }),

  // IBKR Client Portal login (embedded webview). IBKR connects in-app
  // — its login window opens inside the launcher, never bouncing out.
  openIbkrLogin: (url: string) => invoke<void>("open_ibkr_login", { url }),
  closeIbkrLogin: () => invoke<void>("close_ibkr_login"),

  // ── GitHub device-flow sign-in ────────────────────────────────
  //
  // The user's own GitHub for git push/pull. The Rust side stores the
  // access token in the system git credential helper; it never crosses
  // this boundary. See commands/github_auth.rs.
  githubAuthStatus: () => invoke<GithubAuthStatus>("github_auth_status"),
  githubDeviceStart: () => invoke<GithubDeviceStart>("github_device_start"),
  githubDevicePoll: (deviceCode: string) =>
    invoke<GithubDevicePoll>("github_device_poll", { deviceCode }),

  // ── IBKR connect (unified: the dockerized IB Gateway strategies use) ──
  //
  // The launcher's IBKR connect drives the engine's owner-gated
  // connections API (POST /ui/api/connections/ibkr/save, dockerized) so
  // the SAME ib_insync gateway serves data + execution for automated
  // strategies. TOTP is required by the engine (unattended-by-contract);
  // a missing-TOTP / vault error returns the engine's plain message.
  ibkrConnect: (username: string, password: string, totpKey: string, mode: "paper" | "live") =>
    invoke<unknown>("ibkr_connect", { username, password, totpKey, mode }),
  /** The engine's IBKR connection status (fields + state). No secrets. */
  ibkrConnectionStatus: () => invoke<unknown>("ibkr_connection_status"),

  // ── Broker connections ───────────────────────────────────────
  forgeBrokerStatus: () => invoke<BrokerStatus[]>("forge_broker_status"),
  forgeBrokerTest: (brokerId: string) =>
    invoke<string>("forge_broker_test", { brokerId }),

  // ── Data-provider API keys ───────────────────────────────────
  //
  // Native door for entering third-party DATA keys (Polygon, EODHD,
  // ...). Both call the engine's keys surface over loopback with the
  // owner key (on-box handoff) + double-submit CSRF. The key value
  // rides in the request body only — never a URL, never a log line.
  /** Save a data-provider key. Rejects with a plain message when the
   *  engine isn't connected, or when a paid install needs a vault key. */
  dataKeySave: (provider: string, key: string) =>
    invoke<void>("data_key_save", { provider, key }),
  /** Best-effort test of the saved key against the provider's real API.
   *  Resolves true only when the engine's test actually passed. */
  dataKeyTest: (provider: string) =>
    invoke<boolean>("data_key_test", { provider }),

  // ── Shared global settings ───────────────────────────────────
  //
  // One coherent read of the engine's owner-gated settings aggregate
  // (broker/data-key configured flags, the AI model, prefs, tier).
  // No key VALUES ever cross this boundary — only "configured" flags.
  settingsGet: () => invoke<SettingsAggregate>("settings_get"),
  /** Persist an AI-model or prefs change. A key in `ai_model.key` rides
   *  to the engine vault and never comes back. Pass the last-seen `etag`
   *  so a stale write is rejected (the engine sends If-Match → 409)
   *  instead of clobbering a change made in another surface. Rejects with
   *  a plain remediation message when the vault is unavailable (paid
   *  tier) or when the settings changed elsewhere. */
  settingsPut: (patch: SettingsPatch, etag?: string) =>
    invoke<SettingsAggregate>("settings_put", { patch, etag }),

  // ── Strategy lifecycle (read-only) ───────────────────────────
  //
  // Per-strategy lifecycle state for the home's lifecycle belt. Read-only
  // and owner-gated over loopback (mirrors settings_get). Rejects when the
  // engine has no states route yet OR isn't reachable — the belt then
  // degrades to labels-only and never fabricates a count. `from_houston`
  // is false when the engine served a cache rather than fresh truth.
  strategyStates: () => invoke<StrategyStates>("strategy_states"),

  // ── Broker data (launcher-global, callable from any view) ────
  //
  // Same code paths the Forge agent uses, exposed as first-class
  // IPC commands so the main Dashboard, the Forge widget refresh
  // loop, the tray menu, and anything else we build next can pull
  // broker data without going through the agent's tool surface.
  brokerAccountSummary: () =>
    invoke<BrokerAccountSummary>("broker_account_summary"),
  brokerOpenPositions: () =>
    invoke<BrokerPositionsPayload>("broker_open_positions"),
  brokerQuote: (symbol: string) =>
    invoke<BrokerQuote>("broker_quote", { symbol }),
  brokerHistoricalBars: (symbol: string, days?: number) =>
    invoke<BrokerHistoricalBars>("broker_historical_bars", { symbol, days }),
  brokerOptionsChain: (
    symbol: string,
    month: string,
    maxStrikes?: number,
  ) =>
    invoke<BrokerOptionsChain>("broker_options_chain", {
      symbol,
      month,
      maxStrikes,
    }),
  /** Returns the user's market-data subscription tier per asset
   *  class, derived from probing the gateway's response codes. */
  brokerMarketDataStatus: () =>
    invoke<BrokerMarketDataStatus>("broker_market_data_status"),

  // ── Real-time quote streaming ────────────────────────────────
  //
  // Subscribe via `brokerStreamSubscribe(symbol)`, then listen on
  // the 'broker-tick' Tauri event for {symbol, last, bid, ask,
  // data_quality, ts} payloads. Refcounted — call unsubscribe
  // when you're done so the underlying poll loop can stop.
  brokerStreamSubscribe: (symbol: string, intervalMs?: number) =>
    invoke<void>("broker_stream_subscribe", { symbol, intervalMs }),
  brokerStreamUnsubscribe: (symbol: string) =>
    invoke<void>("broker_stream_unsubscribe", { symbol }),
  brokerStreamStatus: () =>
    invoke<BrokerStreamStatus[]>("broker_stream_status"),

  // ── ibeam supervisor (auto-managed IBKR gateway) ─────────────
  //
  // Wraps the voyz/ibeam Docker container that keeps the IBKR
  // Client Portal Gateway session alive indefinitely (auto re-login
  // on the daily IBKR session reset). See commands/ibeam.rs for
  // the full background.
  ibeamStatus: () => invoke<IbeamStatus>("ibeam_status"),
  ibeamInstall: (creds: IbeamCredentials) =>
    invoke<void>("ibeam_install", { creds }),
  ibeamStart: () => invoke<void>("ibeam_start"),
  ibeamStop: () => invoke<void>("ibeam_stop"),
  ibeamRestart: () => invoke<void>("ibeam_restart"),
  ibeamLogs: (lines?: number) =>
    invoke<string>("ibeam_logs", { lines }),
  ibeamUninstall: () => invoke<void>("ibeam_uninstall"),
};

export type IbeamState =
  | { state: "not_installed" }
  | { state: "stopped"; reason: string }
  | { state: "running"; auth_ok: boolean }
  | { state: "docker_unavailable"; detail: string }
  | { state: "other"; detail: string };

export interface IbeamStatus {
  state: IbeamState;
  compose_dir: string;
  has_credentials: boolean;
}

export interface IbeamCredentials {
  username: string;
  password: string;
  /** "paper" | "live" — which IBKR environment the gateway logs into.
   *  Declared by the user at setup (login depends on it, so it can't be
   *  auto-detected first); defaults to paper. */
  trading_mode: "paper" | "live";
}

export interface ToolInvocationResult {
  result: string;
  ok: boolean;
}

// ── Forge types ─────────────────────────────────────────────────

export type StrategyFileKind = "py" | "notebook" | "other";

export interface StrategyFile {
  rel_path: string;
  name: string;
  size_bytes: number;
  /** Unix epoch seconds. */
  modified_at: number;
  kind: StrategyFileKind;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage_in: number;
  usage_out: number;
}

// ── Streaming event payloads ────────────────────────────────────
//
// These mirror what `forge_chat_stream` emits via Tauri events.
// Listen with onEvent<ChatChunkPayload>('forge-chat-chunk', ...).

export interface ChatChunkPayload {
  text: string;
}

export interface ChatDonePayload {
  model: string;
  full_text: string;
  usage_in: number;
  usage_out: number;
}

export interface ChatErrorPayload {
  message: string;
}

/** Emitted at the start of an agent tool call. */
export interface ChatToolCallPayload {
  tool_use_id: string;
  name: string;
  /** Short label (e.g. the rel_path for write_strategy) for the UI card title. */
  input_summary: string;
  /** Full input args as JSON — UI can show in a disclosure. */
  input: unknown;
}

/** Emitted when an agent tool call finishes (success or error). */
export interface ChatToolResultPayload {
  tool_use_id: string;
  name: string;
  /** One-line summary of the result. */
  result_summary: string;
  /** False when the tool errored — UI uses this for the pill color. */
  ok: boolean;
}

// ── Strategy lifecycle ──────────────────────────────────────────

// Lifecycle belt — matches Houston's auracle.framework.lifecycle.ORDER
// (+ archived) so the desktop and the web product share one lifecycle.
export type StrategyState =
  | "draft"
  | "research"
  | "backtested"
  | "paper"
  | "live"
  | "archived";

export const STRATEGY_STATES: StrategyState[] = [
  "draft",
  "research",
  "backtested",
  "paper",
  "live",
  "archived",
];

export interface StrategyStates {
  /** rel_path → state. Missing entries default to "draft" client-side. */
  states: Record<string, StrategyState>;
  /** True when freshly fetched from Houston; false on cache fallback. */
  from_houston: boolean;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
}

export type ForgeLayoutMode = "agent" | "code";

// ── Dashboards ──────────────────────────────────────────────────
//
// On-disk shape mirrors `commands/dashboards.rs::Dashboard`. The
// widget-type-specific fields are loose (per-widget config goes
// alongside the wrapper fields) — the WidgetRenderer in
// components/forge/dashboard/ validates per-renderer at runtime.

export interface DashboardWidget {
  /** Unique within the dashboard. Used as the React key + the
   *  refresh-loop subscription target. */
  id: string;
  /** Selects the renderer — see WidgetRenderer for the type table. */
  type:
    | "kpi_grid"
    | "data_table"
    | "line_chart"
    | "bar_chart"
    | "candlestick_chart"
    | "option_chain_table"
    | "payoff_diagram"
    | "tickers_grid"
    | "notes_md";
  // iv_surface_3d and scanner_table were declared here in an earlier
  // phase but never got renderers — removed from the union so the
  // type system stops promising shapes the WidgetRenderer can't
  // actually draw. Re-add to the union, the agent system prompt,
  // and the save_dashboard tool schema string in the same commit
  // that ships their renderers.
  title?: string;
  /** Where the data comes from. `tool` is the name of an agent
   *  broker/data tool; `args` are passed through to it on each
   *  refresh. Special-case: tool === "inline" + args.data is a
   *  literal payload for static widgets (e.g. notes). */
  data_source: { tool: string; args: Record<string, unknown> };
  /** Grid placement for layout === "grid". Optional otherwise. */
  grid?: { x: number; y: number; w: number; h: number };
  /** Catch-all for type-specific config (columns / fields / etc.). */
  [key: string]: unknown;
}

export interface Dashboard {
  slug: string;
  title: string;
  /** ISO-8601 UTC. */
  created_at: string;
  /** ISO-8601 UTC. */
  updated_at: string;
  /** 5..3600 seconds. */
  refresh_interval_seconds: number;
  layout: "grid" | "rows" | "tabs";
  widgets: DashboardWidget[];
}

export interface DashboardSummary {
  slug: string;
  title: string;
  updated_at: string;
  widget_count: number;
  refresh_interval_seconds: number;
}

// ── Broker connections ──────────────────────────────────────────
//
// Tagged union mirrors `commands/broker_connections.rs::BrokerState`.
// The frontend renders different controls per variant so the type
// describes UX intent, not just network status.

export type BrokerState =
  | { state: "offline"; hint: string }
  | { state: "unauthenticated"; login_url: string }
  | {
      state: "connected";
      account_id: string;
      account_label: string | null;
    }
  | { state: "error"; detail: string }
  | { state: "not_implemented" };

export interface BrokerStatus {
  id: string;
  label: string;
  description: string;
  capabilities: string[];
  /** Directory grouping: "broker" | "data" | "crypto". */
  category: "broker" | "data" | "crypto";
  /** Asset classes covered, rendered as chips. */
  assets: string[];
  /** Engine can ingest market data from this source today. */
  provides_data: boolean;
  /** A real execution adapter exists for this source. */
  provides_execution: boolean;
  /** How you connect from the launcher:
   *  "gateway" = in-launcher portal/gateway login flow exists (IBKR);
   *  "api_key" = connects by API key/secret; "wallet" = wallet-signed;
   *  "none" = data-only provider. Only "gateway" implies a portal. */
  connect_method: "gateway" | "api_key" | "wallet" | "none";
  state: BrokerState;
}

// ── Shared global settings ──────────────────────────────────────
//
// Mirrors the engine's owner-gated settings aggregate. The launcher and
// the IDE both read this so their views stay in sync. CONTRACT: this
// payload carries NO secret values — only "configured" flags for keys.

/** Whether a key/secret is on file for one provider (never the value). */
export interface ConfiguredFlag {
  configured: boolean;
}

export interface AiModelState {
  provider: string;
  model_id: string;
  /** True when an API key is on file in the engine vault. */
  configured: boolean;
}

export interface SettingsAggregate {
  /** Per-broker connection summary the engine reports. Opaque here —
   *  the launcher's own probes drive the Connections card; this is the
   *  shared cross-surface view. */
  brokers: Record<string, unknown>;
  /** Per data-provider: is a key on file? Keyed by provider id. */
  data_keys: Record<string, ConfiguredFlag>;
  ai_model: AiModelState;
  /** Free-form user preferences shared across surfaces. */
  prefs: Record<string, unknown>;
  /** Engine license tier (e.g. "community", "pro"). */
  tier: string;
  /** Opaque concurrency token — pass back via If-Match on writes. */
  etag: string;
}

/** A settings write. Send exactly one of the supported sub-objects. A
 *  key in `ai_model.key` rides to the engine vault and never returns. */
export interface SettingsPatch {
  ai_model?: { provider: string; model_id: string; key?: string };
  prefs?: Record<string, unknown>;
}

// ── Broker data payloads ────────────────────────────────────────
//
// Match what `commands/broker_bridge.rs` returns — numbers can be
// null on after-hours / illiquid instruments, so each one is
// optional. Keeping the typing loose-but-named is the right
// tradeoff for cross-broker data where Alpaca / Tradier / Hyper
// will eventually fill the same shapes from different upstreams.

export interface BrokerAccountSummary {
  account_id: string;
  currency: string;
  net_liquidation: number | null;
  buying_power: number | null;
  available_funds: number | null;
  excess_liquidity: number | null;
  total_cash: number | null;
  gross_position_value: number | null;
  maintenance_margin: number | null;
  initial_margin: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
}

export interface BrokerPosition {
  symbol: string;
  asset_class: string;
  quantity: number | null;
  avg_cost: number | null;
  market_price: number | null;
  market_value: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
  currency: string;
  conid: number | null;
}

export interface BrokerPositionsPayload {
  account_id: string;
  rows: BrokerPosition[];
}

export type BrokerDataQuality =
  | "realtime"
  | "delayed"
  | "frozen"
  | "closed"
  | "halted"
  | "unknown";

export interface BrokerQuote {
  symbol: string;
  conid: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
  ts: number;
  data_quality: BrokerDataQuality;
  /** Raw IBKR availability code (`R`, `D`, `Z`, `Y`, etc.) — for diagnostics. */
  data_quality_raw: string;
}

/** Emitted by the polling stream on each tick. Subscribe via the
 *  Tauri event 'broker-tick' after calling brokerStreamSubscribe. */
export interface BrokerTickEvent {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  data_quality: BrokerDataQuality;
  /** Unix milliseconds — note this is the LAUNCHER's clock when the
   *  snapshot returned, not the exchange's quote timestamp. */
  ts: number;
}

export interface BrokerStreamStatus {
  symbol: string;
  refcount: number;
  interval_ms: number;
}

// ── Tauri event payloads (centralized) ──────────────────────────
//
// All `app.emit(...)` event payload shapes the frontend listens to.
// Previously some of these (InstallerProgress, the forge-dashboard-open
// slug, broker-tick) lived inline in their consumer components. They
// belong here so adding a second listener for the same event doesn't
// require duplicating the type — and so the audit can grep one file
// to map every Rust `app.emit` to a typed consumer.
//
// Event name → payload type:
//   installer-progress        → InstallerProgressEvent
//   forge-chat-chunk          → ChatChunkPayload
//   forge-chat-done           → ChatDonePayload
//   forge-chat-error          → ChatErrorPayload
//   forge-chat-tool-call      → ChatToolCallPayload
//   forge-chat-tool-result    → ChatToolResultPayload
//   forge-dashboard-open      → string (the dashboard slug)
//   broker-tick               → BrokerTickEvent

export interface InstallerProgressEvent {
  phase?: string;
  percent?: number;
  message?: string;
  line?: string;
}

/** Payload for the `forge-dashboard-open` event — Rust emits the
 *  dashboard slug as a bare string. */
export type ForgeDashboardOpenEvent = string;

export interface BrokerMarketDataStatus {
  /** "realtime" | "delayed" | "frozen" | "unknown" — IBKR's
   *  availability tier for US equities, derived from a SPY probe. */
  us_equity: BrokerDataQuality;
  us_equity_raw: string;
  /** Reserved for future per-asset-class introspection (options,
   *  futures, FX); currently a constant marker until we add probes. */
  options: string;
  hint: string;
}

export interface BrokerBar {
  date: string;
  timestamp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface BrokerHistoricalBars {
  symbol: string;
  currency: string;
  rows: BrokerBar[];
  /** "ibkr" (user's subscription tier) or "yahoo" (free 15-min
   *  delayed daily fallback). UI uses this to render a source pill. */
  source?: "ibkr" | "yahoo";
  /** IBKR cadence label ('1d', '1h', '5mins', etc.) when source=ibkr;
   *  always '1d' for Yahoo. */
  bar?: string;
  /** Present on Yahoo path ('delayed'); IBKR path inherits the
   *  account's tier (real-time vs delayed). */
  data_quality?: BrokerDataQuality;
}

export interface BrokerOptionChainRow {
  strike: number;
  [k: string]: number | null;
}

export interface BrokerOptionsChain {
  symbol: string;
  month: string;
  spot: number;
  underlying_conid: number;
  rows: BrokerOptionChainRow[];
}

// ── Misc helpers ────────────────────────────────────────────────
//
// The launcher no longer opens any Houston HTML page. Workspace
// surfaces (blotter, strategies, schedules, incidents, runway, runs,
// validation, connections) are reached by deep-linking into the native
// Auracle IDE via `openIdePanel`; the only browser link that remains is
// the first-run /ui/setup bootstrap (Onboarding) and external docs.

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

/** The engine's first-run wizard — license activation, then create the
 *  owner account. Stays reachable even in the headless web profile (it's
 *  on the profile-gate allowlist). Every owner-gated launcher feature
 *  needs this done first. */
export const ENGINE_SETUP_URL = "http://127.0.0.1:1969/ui/setup";

export async function openEngineSetup(): Promise<void> {
  return openInBrowser(ENGINE_SETUP_URL);
}

/** True when an error is the "no on-box owner account" / "connect-sign-in"
 *  signal — i.e. the engine has no owner yet, so the user must finish
 *  first-run setup before any owner-gated action works. */
export function needsOwnerSetup(err: unknown): boolean {
  return /no on-box owner account|connect\/sign in to the engine/i.test(
    String(err),
  );
}

/**
 * Open the Auracle IDE focused on a native panel via the `auracle://`
 * deep-link scheme. The OS routes the URL to the IDE app, launching it if
 * needed. Replaces the old web-portal links now that the IDE is the home.
 * Valid panels: blotter, strategies, schedules, incidents, runway, runs,
 * validation, connections.
 */
export async function openIdePanel(panel: string): Promise<void> {
  const url = `auracle://panel/${panel}`;
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

/**
 * Open a native directory picker. Returns the absolute path the
 * user selected, or null if they cancelled. No-op stub when
 * running outside Tauri (returns null).
 */
export async function pickDirectory(
  options: { defaultPath?: string; title?: string } = {},
): Promise<string | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return null;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: options.title,
    defaultPath: options.defaultPath,
  });
  // open() returns string for single dir, string[] for multi, null on cancel.
  if (typeof selected === "string") return selected;
  return null;
}
