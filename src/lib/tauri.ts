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
};

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

export type StrategyState =
  | "draft"
  | "backtested"
  | "paper"
  | "live"
  | "archived";

export const STRATEGY_STATES: StrategyState[] = [
  "draft",
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
    | "iv_surface_3d"
    | "payoff_diagram"
    | "scanner_table"
    | "notes_md";
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
