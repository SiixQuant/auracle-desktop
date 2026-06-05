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
  // Open JupyterLab in its own top-level window (the inline iframe panel
  // doesn't render in WKWebView; a top-level window does).
  openJupyter: () => invoke<void>("open_jupyter"),

  // Local-CA trust (macOS) — trusting Caddy's per-install root lets the
  // embedded webview load https://localhost (the workspace + same-origin
  // Jupyter panel). open_embedded_auracle calls these automatically on
  // first open; exposed here for a Settings "trust certificate" action.
  caddyCaTrusted: () => invoke<boolean>("caddy_ca_trusted"),
  trustCaddyCa: () => invoke<void>("trust_caddy_ca"),

  // IBKR Client Portal login (embedded webview)
  openIbkrLogin: (url: string) => invoke<void>("open_ibkr_login", { url }),
  closeIbkrLogin: () => invoke<void>("close_ibkr_login"),

  // ── Forge — strategy authoring (Phase 1) ──────────────────────
  forgeStrategiesDir: () => invoke<string>("forge_strategies_dir"),
  forgeSetStrategiesDir: (path: string) =>
    invoke<void>("forge_set_strategies_dir", { path }),
  forgeListStrategies: () => invoke<StrategyFile[]>("forge_list_strategies"),
  forgeReadFile: (relPath: string) =>
    invoke<string>("forge_read_file", { relPath }),
  forgeWriteFile: (relPath: string, contents: string) =>
    invoke<void>("forge_write_file", { relPath, contents }),
  forgeChat: (messages: ChatMessage[]) =>
    invoke<ChatResponse>("forge_chat", { messages }),
  /**
   * Kick off a streaming chat. Returns immediately; progress
   * arrives via the `forge-chat-chunk` / `forge-chat-done` /
   * `forge-chat-error` events. Subscribe via `onEvent` before
   * calling this — events fired before listeners attach are
   * silently dropped.
   */
  forgeChatStream: (messages: ChatMessage[]) =>
    invoke<void>("forge_chat_stream", { messages }),
  /** Cancel the currently-running stream. No-op if nothing is streaming. */
  forgeChatCancel: () => invoke<void>("forge_chat_cancel"),

  /**
   * Run the full agent loop (Anthropic tool-use). Returns immediately;
   * progress arrives via the same chunk/done/error events as the plain
   * chat stream, PLUS two extra events:
   *   - forge-chat-tool-call   when Claude requests a tool
   *   - forge-chat-tool-result when the tool finishes (success or error)
   * Cancels are honored between iterations via forgeChatCancel.
   */
  forgeAgentRun: (messages: ChatMessage[]) =>
    invoke<void>("forge_agent_run", { messages }),

  // Model selection
  forgeAvailableModels: () => invoke<string[]>("forge_available_models"),
  forgeGetModel: () => invoke<string>("forge_get_model"),
  forgeSetModel: (model: string) =>
    invoke<void>("forge_set_model", { model }),

  // Layout mode — "agent" (2-pane CVForge-style) or "code" (3-pane classic)
  forgeGetLayoutMode: () => invoke<ForgeLayoutMode>("forge_get_layout_mode"),
  forgeSetLayoutMode: (mode: ForgeLayoutMode) =>
    invoke<void>("forge_set_layout_mode", { mode }),

  // Strategy lifecycle
  forgeStrategyStates: () => invoke<StrategyStates>("forge_strategy_states"),
  forgeSetStrategyState: (relPath: string, state: StrategyState) =>
    invoke<void>("forge_set_strategy_state", { relPath, state }),

  // File management
  forgeNewFile: (relPath: string, template: string) =>
    invoke<void>("forge_new_file", { relPath, template }),
  forgeRenameFile: (oldRelPath: string, newRelPath: string) =>
    invoke<void>("forge_rename_file", { oldRelPath, newRelPath }),
  forgeDeleteFile: (relPath: string) =>
    invoke<void>("forge_delete_file", { relPath }),
  forgeAvailableTemplates: () =>
    invoke<StrategyTemplate[]>("forge_available_templates"),

  // Anthropic API key — separate keychain slot from the license key
  anthropicKeyGet: () => invoke<string | null>("anthropic_key_get"),
  anthropicKeySet: (value: string) =>
    invoke<void>("anthropic_key_set", { value }),
  anthropicKeyClear: () => invoke<void>("anthropic_key_clear"),

  // ── Dashboards (CVForge-class persistent visual analytics) ────
  forgeDashboardsDir: () => invoke<string>("forge_dashboards_dir"),
  forgeListDashboards: () =>
    invoke<DashboardSummary[]>("forge_list_dashboards"),
  forgeReadDashboard: (slug: string) =>
    invoke<Dashboard>("forge_read_dashboard", { slug }),
  forgeSaveDashboard: (dashboard: Dashboard) =>
    invoke<DashboardSummary>("forge_save_dashboard", { dashboard }),
  forgeDeleteDashboard: (slug: string) =>
    invoke<void>("forge_delete_dashboard", { slug }),
  forgeOpenDashboard: (slug: string) =>
    invoke<void>("forge_open_dashboard", { slug }),
  /** One-shot dispatch of an agent tool from the frontend (used by
   *  the dashboard widget refresh loop). Returns the same string the
   *  agent would see as tool_result content. */
  forgeInvokeTool: (name: string, args: Record<string, unknown>) =>
    invoke<ToolInvocationResult>("forge_invoke_tool", { name, args }),

  // ── Broker connections ───────────────────────────────────────
  forgeBrokerStatus: () => invoke<BrokerStatus[]>("forge_broker_status"),
  forgeBrokerTest: (brokerId: string) =>
    invoke<string>("forge_broker_test", { brokerId }),

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
  state: BrokerState;
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

/**
 * The web product served through Caddy (TLS). The workspace must be
 * opened via this origin — NOT http://localhost:1969 — because the
 * embedded JupyterLab panel is only same-origin under Caddy, and
 * Jupyter's `frame-ancestors 'self'` refuses to be framed cross-origin.
 * (Direct :1969 redirects /jupyter to :8888, a different origin, which
 * the browser blocks → a blank panel.)
 *
 * Note: this is the DISPLAY origin (what a browser/webview loads). API
 * calls from the Rust core stay on http://localhost:1969 — they don't
 * need TLS and avoid the self-signed-cert hop.
 */
export const WORKSPACE_URL = "https://localhost";

/**
 * Open the unified Auracle workspace (the web shell) — optionally at a
 * sub-path. This is how the desktop reflects "we are one product": the
 * native launcher and the web UI are the same Auracle.
 *   openWorkspace()            → the shell (/ui)
 *   openWorkspace("/ui/forge") → Forge (composer + board + Seer)
 */
export async function openWorkspace(path = "/ui"): Promise<void> {
  return openInBrowser(`${WORKSPACE_URL}${path}`);
}

/** Open the unified Forge research surface (composer, board, Seer). */
export async function openResearch(): Promise<void> {
  return openWorkspace("/ui/forge");
}

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
