//! Forge — strategy authoring inside the launcher.
//!
//! Phase 1 surface:
//!
//!   * file I/O bounded to the configured strategies directory
//!     (default `~/auracle/strategies/`). Every path argument is
//!     resolved against the configured root and rejected if it
//!     would escape that root — this is the trust boundary for
//!     anything user-typed (e.g. an AI-suggested filename) before
//!     it reaches the filesystem.
//!
//!   * `forge_chat` — single-shot call to Anthropic's Messages API
//!     using the user's stored API key. Returns the full response
//!     text. Streaming + tool use lands in Phase 2.
//!
//! Phase 2 will add: bundled MCP sidecar binary, walk-forward
//! preview, backtest button wiring, schedule deployment.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use keyring::Entry;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;
use tokio::sync::Notify;

use super::to_error_string;

// ── Strategies directory resolution ─────────────────────────────

const STORE_FILE: &str = "forge.json";
const KEY_STRATEGIES_DIR: &str = "strategies_dir";
const KEY_MODEL: &str = "model";
const KEY_LAYOUT_MODE: &str = "layout_mode";

/// Forge's two top-level layouts:
///
///   * "agent" — CVForge-style 2-pane (chat + live preview). The
///     default for fresh installs since it's the more guided UX.
///   * "code"  — classic 3-pane (file tree + editor + chat). Power
///     users who want manual control of files + the editor stick
///     with this.
const LAYOUT_MODES: &[&str] = &["agent", "code"];

const ANTHROPIC_KEY_SERVICE: &str = "com.auracle.desktop";
const ANTHROPIC_KEY_ACCOUNT: &str = "anthropic-api-key";

const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";
const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Model whitelist. Adding a new Anthropic model means appending it
/// here; the frontend reads via `forge_available_models` so the
/// dropdown stays in lockstep with the Rust enforcement layer (we
/// reject anything outside this list to prevent a typo / stale
/// store entry from sending an undefined model to Anthropic and
/// getting an opaque 400).
const ANTHROPIC_MODELS: &[&str] = &[
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20250514",
];

/// Single global cancellation handle for the active chat stream.
/// Phase 3 only supports one concurrent stream (the frontend
/// disables Send during streaming). Phase 4 will key this by a
/// per-request stream_id when we add multi-tab support.
static CHAT_CANCEL: Lazy<Arc<Notify>> = Lazy::new(|| Arc::new(Notify::new()));

/// Return the path the operator has configured (or the default).
/// Doesn't create the directory if it's missing — listing returns
/// an empty result so the UI can render a "no strategies yet"
/// state, and the operator can pick a different directory in
/// Settings → Forge.
fn resolve_strategies_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY_STRATEGIES_DIR).and_then(|v| v.as_str().map(String::from)) {
            if !v.is_empty() {
                return Ok(PathBuf::from(v));
            }
        }
    }
    // Default search order — the first that exists wins. New installs
    // typically have ~/auracle/strategies/ from the bash installer;
    // dev-local installs may have ~/Downloads/auracle/strategies/.
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        "HOME environment variable unset — can't resolve strategies directory".to_string()
    })?;
    for candidate in [
        home.join("auracle").join("strategies"),
        home.join("Downloads").join("auracle").join("strategies"),
    ] {
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    // Neither default exists — return the canonical one even though
    // it's missing. The list command will return an empty list and
    // the UI shows the configure-a-directory prompt.
    Ok(home.join("auracle").join("strategies"))
}

/// Reject any path that escapes the configured strategies root.
/// This is the SECURITY boundary for file I/O — paths come from the
/// frontend (user-typed OR AI-suggested), so we treat them as untrusted.
fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Reject anything obviously suspect before we even build the path.
    if rel.contains('\0') {
        return Err("invalid path: contains NUL byte".to_string());
    }

    let joined = root.join(rel);

    // Walk components and reject parent-dir hops. This is the simple
    // way to catch `..` traversal that survives even with symlinks.
    for c in Path::new(rel).components() {
        if matches!(c, Component::ParentDir) {
            return Err(format!("invalid path: parent-dir reference in {rel:?}"));
        }
    }

    // Canonicalize what we can — if the path exists, the canonical
    // form is the authoritative check; if it doesn't exist (yet)
    // we use the lexical form, which the ParentDir check above
    // already guarded.
    let candidate = if joined.exists() {
        joined.canonicalize().map_err(to_error_string)?
    } else {
        joined.clone()
    };
    let root_canonical = if root.exists() {
        root.canonicalize().map_err(to_error_string)?
    } else {
        root.to_path_buf()
    };
    if !candidate.starts_with(&root_canonical) {
        return Err(format!(
            "invalid path: {rel:?} resolves outside the strategies directory"
        ));
    }
    Ok(candidate)
}

// ── DTOs ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct StrategyFile {
    /// Path relative to the strategies root (forward-slash separated
    /// for stable display across platforms).
    pub rel_path: String,
    pub name: String,
    pub size_bytes: u64,
    /// Unix epoch seconds of last modification.
    pub modified_at: u64,
    pub kind: StrategyFileKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyFileKind {
    Py,
    Notebook,
    /// Reserved for Phase 2 when we surface non-code files (README,
    /// data config, CSV input fixtures). Today walk_into skips
    /// anything that isn't .py / .ipynb so this variant is unused
    /// in practice — the renderer's TS types still anticipate it
    /// so we don't break the wire contract when Phase 2 lands.
    #[allow(dead_code)]
    Other,
}

#[derive(Debug, Deserialize)]
pub struct ChatMessage {
    /// "user" or "assistant"
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
pub struct ChatResponse {
    pub text: String,
    pub model: String,
    pub usage_in: u32,
    pub usage_out: u32,
}

// ── File I/O commands ───────────────────────────────────────────

fn resolve_model(app: &tauri::AppHandle) -> String {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY_MODEL).and_then(|v| v.as_str().map(String::from)) {
            if ANTHROPIC_MODELS.iter().any(|&m| m == v) {
                return v;
            }
        }
    }
    ANTHROPIC_DEFAULT_MODEL.to_string()
}

#[tauri::command]
pub async fn forge_available_models() -> Result<Vec<String>, String> {
    Ok(ANTHROPIC_MODELS.iter().map(|s| s.to_string()).collect())
}

#[tauri::command]
pub async fn forge_get_model(app: tauri::AppHandle) -> Result<String, String> {
    Ok(resolve_model(&app))
}

#[tauri::command]
pub async fn forge_set_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    if !ANTHROPIC_MODELS.iter().any(|&m| m == model) {
        return Err(format!(
            "unknown model {model:?} — must be one of {:?}",
            ANTHROPIC_MODELS
        ));
    }
    let store = app.store(STORE_FILE).map_err(to_error_string)?;
    store.set(KEY_MODEL, model);
    store.save().map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn forge_get_layout_mode(app: tauri::AppHandle) -> Result<String, String> {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY_LAYOUT_MODE).and_then(|v| v.as_str().map(String::from)) {
            if LAYOUT_MODES.iter().any(|&m| m == v) {
                return Ok(v);
            }
        }
    }
    // Default to agent layout for new installs — that's the new
    // headline UX. Customers who were already using the old 3-pane
    // and persisted "code" in their store keep getting "code" on
    // next launch.
    Ok("agent".to_string())
}

#[tauri::command]
pub async fn forge_set_layout_mode(
    app: tauri::AppHandle,
    mode: String,
) -> Result<(), String> {
    if !LAYOUT_MODES.iter().any(|&m| m == mode) {
        return Err(format!(
            "unknown layout mode {mode:?} — must be one of {:?}",
            LAYOUT_MODES
        ));
    }
    let store = app.store(STORE_FILE).map_err(to_error_string)?;
    store.set(KEY_LAYOUT_MODE, mode);
    store.save().map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn forge_strategies_dir(app: tauri::AppHandle) -> Result<String, String> {
    let p = resolve_strategies_dir(&app)?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn forge_set_strategies_dir(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let store = app.store(STORE_FILE).map_err(to_error_string)?;
    store.set(KEY_STRATEGIES_DIR, path);
    store.save().map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn forge_list_strategies(
    app: tauri::AppHandle,
) -> Result<Vec<StrategyFile>, String> {
    let root = resolve_strategies_dir(&app)?;
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    walk_into(&root, &root, &mut out, 0)?;
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

fn walk_into(
    root: &Path,
    dir: &Path,
    out: &mut Vec<StrategyFile>,
    depth: usize,
) -> Result<(), String> {
    // Bound the depth so a wildly-nested or symlink-loop directory
    // can't run away.
    if depth > 6 {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(to_error_string)?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        // Skip hidden + cache + venv noise — Phase 1 only surfaces
        // user-visible strategy files.
        if name.starts_with('.')
            || name == "__pycache__"
            || name == "node_modules"
            || name == ".venv"
            || name == "venv"
        {
            continue;
        }

        if path.is_dir() {
            walk_into(root, &path, out, depth + 1)?;
            continue;
        }

        let kind = match path.extension().and_then(|s| s.to_str()) {
            Some("py") => StrategyFileKind::Py,
            Some("ipynb") => StrategyFileKind::Notebook,
            _ => continue, // skip non-code files in the listing
        };

        let meta = entry.metadata().map_err(to_error_string)?;
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let rel = path
            .strip_prefix(root)
            .map_err(to_error_string)?
            .to_string_lossy()
            .replace('\\', "/");

        out.push(StrategyFile {
            rel_path: rel,
            name,
            size_bytes: meta.len(),
            modified_at,
            kind,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn forge_read_file(
    app: tauri::AppHandle,
    rel_path: String,
) -> Result<String, String> {
    let root = resolve_strategies_dir(&app)?;
    let abs = safe_resolve(&root, &rel_path)?;
    fs::read_to_string(&abs).map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
pub async fn forge_write_file(
    app: tauri::AppHandle,
    rel_path: String,
    contents: String,
) -> Result<(), String> {
    let root = resolve_strategies_dir(&app)?;
    let abs = safe_resolve(&root, &rel_path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(to_error_string)?;
    }
    fs::write(&abs, contents).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

// ── File management (Phase 4c-1) ────────────────────────────────
//
// Three operations: create, rename, delete. Each goes through the
// same path-safety gate (safe_resolve) so untrusted input — like
// a user-typed filename or a future drag-and-drop — can't reach
// outside the strategies root.
//
// Delete moves the file to <root>/.archive/<timestamp>-<name>
// rather than fs::remove_file. The archive is invisible in the
// tree (walk_into skips dotfiles) but recoverable from Finder
// in case a customer deletes the wrong file at 2am. Same pattern
// Houston uses for its own delete_strategy().

#[tauri::command]
pub async fn forge_new_file(
    app: tauri::AppHandle,
    rel_path: String,
    template: String,
) -> Result<(), String> {
    let root = resolve_strategies_dir(&app)?;
    let abs = safe_resolve(&root, &rel_path)?;
    if abs.exists() {
        return Err(format!("file already exists: {rel_path}"));
    }
    // Reject if the path resolves to a non-.py / non-.ipynb leaf —
    // Forge's tree only renders those two types, so creating
    // anything else produces an invisible file the user can't see.
    let ext_ok = matches!(
        abs.extension().and_then(|s| s.to_str()),
        Some("py") | Some("ipynb")
    );
    if !ext_ok {
        return Err(
            "new strategy files must end in .py or .ipynb".to_string(),
        );
    }

    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(to_error_string)?;
    }
    let contents = template_for(&template, &rel_path);
    fs::write(&abs, contents).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn forge_rename_file(
    app: tauri::AppHandle,
    old_rel_path: String,
    new_rel_path: String,
) -> Result<(), String> {
    let root = resolve_strategies_dir(&app)?;
    let from = safe_resolve(&root, &old_rel_path)?;
    let to = safe_resolve(&root, &new_rel_path)?;
    if !from.exists() {
        return Err(format!("source does not exist: {old_rel_path}"));
    }
    if to.exists() {
        return Err(format!("destination already exists: {new_rel_path}"));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(to_error_string)?;
    }
    fs::rename(&from, &to).map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn forge_delete_file(
    app: tauri::AppHandle,
    rel_path: String,
) -> Result<(), String> {
    let root = resolve_strategies_dir(&app)?;
    let abs = safe_resolve(&root, &rel_path)?;
    if !abs.exists() {
        return Err(format!("file does not exist: {rel_path}"));
    }

    // Move to <root>/.archive/<ts>-<flattened-name> rather than
    // delete outright. The archive is invisible in the tree but
    // recoverable from Finder.
    let archive_root = root.join(".archive");
    fs::create_dir_all(&archive_root).map_err(to_error_string)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let flat = rel_path.replace('/', "__");
    let archived = archive_root.join(format!("{stamp}-{flat}"));
    fs::rename(&abs, &archived).map_err(|e| format!("archive failed: {e}"))?;
    Ok(())
}

// ── Strategy templates ──────────────────────────────────────────
//
// Hardcoded into the binary so a fresh install has working
// templates without depending on a templates/ directory the user
// might not have synced. Each template is a complete runnable
// strategy — the user can hit Run Backtest immediately after
// creation. New templates added here automatically appear in the
// NewStrategyModal's dropdown (the frontend fetches the list via
// forge_available_templates).

#[derive(Serialize)]
pub struct StrategyTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[tauri::command]
pub async fn forge_available_templates() -> Result<Vec<StrategyTemplate>, String> {
    Ok(vec![
        StrategyTemplate {
            id: "blank".into(),
            name: "Blank".into(),
            description: "Empty Strategy subclass with method stubs. Start from scratch.".into(),
        },
        StrategyTemplate {
            id: "ma_crossover".into(),
            name: "MA Crossover".into(),
            description: "Classic 50/200 simple-moving-average crossover on SPY. Long when 50 > 200.".into(),
        },
        StrategyTemplate {
            id: "rsi_mean_reversion".into(),
            name: "RSI Mean-Reversion".into(),
            description: "Buy when 14-day RSI < 30, sell when RSI > 70. Liquid US ETFs.".into(),
        },
        StrategyTemplate {
            id: "momentum".into(),
            name: "Cross-Sectional Momentum".into(),
            description: "Top-N 12-1 momentum on a US equities universe. Equal-weight, monthly rebalance.".into(),
        },
    ])
}

fn template_for(id: &str, rel_path: &str) -> String {
    // Strip directory + extension to derive a class name. The
    // user-typed filename becomes the class identifier so it's
    // immediately discoverable from auracle's scheduler.
    let stem = std::path::Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("MyStrategy");
    let class_name = to_pascal_case(stem);

    match id {
        "ma_crossover" => format!(
            r#"""""MA Crossover — 50/200 simple moving average crossover on SPY."""

from __future__ import annotations
import pandas as pd

from auracle.backtest import Strategy, run_backtest
from auracle.db import get_engine


class {class_name}(Strategy):
    universe = [("SPY", "ARCA")]

    fast = 50
    slow = 200

    def prices_to_signals(self, prices: pd.DataFrame) -> pd.DataFrame:
        close = prices.xs("close", level=1, axis=1)
        fast = close.rolling(self.fast).mean()
        slow = close.rolling(self.slow).mean()
        # 1 when fast crosses above slow, else 0 (flat). One signal
        # per symbol; long-only.
        return (fast > slow).astype(int)


if __name__ == "__main__":
    print(run_backtest(get_engine(), {class_name}))
"#,
            class_name = class_name
        ),

        "rsi_mean_reversion" => format!(
            r#"""""RSI mean-reversion — buy oversold, sell overbought on a liquid ETF basket."""

from __future__ import annotations
import pandas as pd

from auracle.backtest import Strategy, run_backtest
from auracle.db import get_engine


def _rsi(close: pd.Series, window: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(window).mean()
    loss = (-delta.clip(upper=0)).rolling(window).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


class {class_name}(Strategy):
    universe = [
        ("SPY", "ARCA"), ("QQQ", "NASDAQ"), ("IWM", "ARCA"),
        ("XLF", "ARCA"), ("XLE", "ARCA"), ("XLK", "ARCA"),
    ]

    rsi_window = 14
    buy_below = 30
    sell_above = 70

    def prices_to_signals(self, prices: pd.DataFrame) -> pd.DataFrame:
        close = prices.xs("close", level=1, axis=1)
        rsi = close.apply(_rsi, window=self.rsi_window)
        # +1 buy, -1 sell, 0 hold. Long-only flavor — clip floor at 0.
        signal = pd.DataFrame(0, index=close.index, columns=close.columns)
        signal[rsi < self.buy_below] = 1
        signal[rsi > self.sell_above] = -1
        return signal.clip(lower=0)


if __name__ == "__main__":
    print(run_backtest(get_engine(), {class_name}))
"#,
            class_name = class_name
        ),

        "momentum" => format!(
            r#"""""Cross-sectional momentum — top-N 12-1 momentum on US equities."""

from __future__ import annotations
import pandas as pd

from auracle.backtest import Strategy, run_backtest
from auracle.db import get_engine


class {class_name}(Strategy):
    universe = [
        ("AAPL", "NASDAQ"), ("MSFT", "NASDAQ"), ("NVDA", "NASDAQ"),
        ("AMZN", "NASDAQ"), ("META", "NASDAQ"), ("GOOGL", "NASDAQ"),
        ("TSLA", "NASDAQ"), ("BRK.B", "NYSE"), ("JPM", "NYSE"),
        ("UNH", "NYSE"),
    ]

    lookback_months = 12
    skip_months = 1
    top_n = 3

    def prices_to_signals(self, prices: pd.DataFrame) -> pd.DataFrame:
        close = prices.xs("close", level=1, axis=1)
        # 12-1 momentum: trailing 12-month return excluding the
        # most recent month. ~252 trading days for 12m, ~21 for 1m.
        mom = close.pct_change(252 - 21) - close.pct_change(21)
        rank = mom.rank(axis=1, ascending=False)
        return (rank <= self.top_n).astype(int)

    def signals_to_target_weights(self, signals: pd.DataFrame) -> pd.DataFrame:
        # Equal-weight across the selected names; refresh once per
        # month (resample to month-end, then forward-fill).
        weights = signals.div(signals.sum(axis=1).replace(0, 1), axis=0)
        return weights.resample("ME").last().reindex(signals.index).ffill().fillna(0)


if __name__ == "__main__":
    print(run_backtest(get_engine(), {class_name}))
"#,
            class_name = class_name
        ),

        // "blank" or unknown -> blank template
        _ => format!(
            r#"""""{class_name} — Auracle strategy template.

Fill in `universe` and `prices_to_signals` to get started. The
default below is empty long/short; running this as-is produces
zero trades.
"""

from __future__ import annotations
import pandas as pd

from auracle.backtest import Strategy, run_backtest
from auracle.db import get_engine


class {class_name}(Strategy):
    universe = [
        # ("SPY", "ARCA"),
    ]

    def prices_to_signals(self, prices: pd.DataFrame) -> pd.DataFrame:
        close = prices.xs("close", level=1, axis=1)
        # Replace with your signal logic. Return a DataFrame of the
        # same shape as `close` with values in [-1, 1] or {{0, 1}}.
        return pd.DataFrame(0, index=close.index, columns=close.columns)


if __name__ == "__main__":
    print(run_backtest(get_engine(), {class_name}))
"#,
            class_name = class_name
        ),
    }
}

fn to_pascal_case(s: &str) -> String {
    // file_stem -> FileStem. Splits on _ - and whitespace.
    let mut out = String::new();
    let mut capitalize_next = true;
    for ch in s.chars() {
        if ch == '_' || ch == '-' || ch.is_whitespace() {
            capitalize_next = true;
        } else if capitalize_next {
            out.extend(ch.to_uppercase());
            capitalize_next = false;
        } else {
            out.push(ch);
        }
    }
    if out.is_empty() { "MyStrategy".to_string() } else { out }
}

// ── Anthropic API key (separate keychain slot from license) ─────

#[tauri::command]
pub fn anthropic_key_get() -> Result<Option<String>, String> {
    let entry = Entry::new(ANTHROPIC_KEY_SERVICE, ANTHROPIC_KEY_ACCOUNT)
        .map_err(to_error_string)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(to_error_string(e)),
    }
}

#[tauri::command]
pub fn anthropic_key_set(value: String) -> Result<(), String> {
    let v = value.trim().to_string();
    if v.is_empty() {
        return Err("paste a key first".to_string());
    }
    // Loosest shape check — server validates the actual format. Real
    // Anthropic keys start with `sk-ant-` and are >50 chars; reject
    // anything obviously not-a-key without locking out edge cases.
    if v.len() < 24 {
        return Err(
            "API key looks too short — full Anthropic keys start with sk-ant- and are >50 chars"
                .to_string(),
        );
    }
    let entry = Entry::new(ANTHROPIC_KEY_SERVICE, ANTHROPIC_KEY_ACCOUNT)
        .map_err(to_error_string)?;
    entry.set_password(&v).map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub fn anthropic_key_clear() -> Result<(), String> {
    let entry = Entry::new(ANTHROPIC_KEY_SERVICE, ANTHROPIC_KEY_ACCOUNT)
        .map_err(to_error_string)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(to_error_string(e)),
    }
}

// ── Chat (single-shot, non-streaming MVP) ──────────────────────

#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<AnthropicMessage<'a>>,
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<AnthropicBlock>,
    model: String,
    usage: AnthropicUsage,
}

#[derive(Deserialize)]
struct AnthropicBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

const SYSTEM_PROMPT: &str = concat!(
    "You generate Python trading-strategy code for the Auracle platform. ",
    "Auracle's Strategy ABC lives at `auracle.backtest.Strategy`. ",
    "Subclasses declare `universe: list[tuple[symbol, exchange]]` (canonical ",
    "exchanges like NASDAQ, NYSE, ARCA — never SMART) and implement ",
    "`prices_to_signals(self, prices: pd.DataFrame) -> pd.DataFrame`. ",
    "Optionally override `signals_to_target_weights(signals)` for non-trivial sizing.\n\n",
    "Output rules:\n",
    "* For code requests: emit ONE fenced python block, nothing else.\n",
    "* For questions: a tight paragraph + a code block when relevant.\n",
    "* Always import: `from auracle.backtest import Strategy`.\n",
    "* End strategy code with a `run_backtest(...)` call using `auracle.db.get_engine()` ",
    "so the user can execute the cell + see results immediately.\n",
    "* Universe defaults to liquid US ETFs/equities unless the user specifies ",
    "otherwise. Prefer pandas-native rolling calcs over external libraries."
);

#[tauri::command]
pub async fn forge_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<ChatResponse, String> {
    let entry = Entry::new(ANTHROPIC_KEY_SERVICE, ANTHROPIC_KEY_ACCOUNT)
        .map_err(to_error_string)?;
    let api_key = match entry.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => {
            return Err(
                "Anthropic API key not set — open Settings → Forge and paste your key (sk-ant-…)"
                    .to_string(),
            );
        }
        Err(e) => return Err(to_error_string(e)),
    };

    // Validate roles before sending — Anthropic 400s on anything
    // outside {user, assistant} and the error JSON it returns is
    // dense; better to fail clearly here.
    for m in &messages {
        if m.role != "user" && m.role != "assistant" {
            return Err(format!(
                "invalid chat role {:?} — must be 'user' or 'assistant'",
                m.role
            ));
        }
    }
    if messages.is_empty() {
        return Err("empty chat — provide at least one user message".to_string());
    }

    let model = resolve_model(&app);
    let body = AnthropicRequest {
        model: &model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: messages
            .iter()
            .map(|m| AnthropicMessage {
                role: m.role.as_str(),
                content: m.content.as_str(),
            })
            .collect(),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(to_error_string)?;

    let resp = client
        .post(ANTHROPIC_API_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_else(|_| String::from("(no body)"));
        // Anthropic returns clear structured error bodies — surface
        // the message verbatim so the user can act on it (rate
        // limits, expired key, etc.).
        return Err(format!("Anthropic API {status}: {text}"));
    }

    let parsed: AnthropicResponse = resp.json().await.map_err(|e| format!("decode failed: {e}"))?;

    let mut text = String::new();
    for block in parsed.content {
        if block.block_type == "text" {
            if let Some(t) = block.text {
                text.push_str(&t);
            }
        }
    }

    Ok(ChatResponse {
        text,
        model: parsed.model,
        usage_in: parsed.usage.input_tokens,
        usage_out: parsed.usage.output_tokens,
    })
}

// ── Streaming chat ──────────────────────────────────────────────
//
// Same Anthropic Messages API, but with `stream: true` so we can
// paint tokens into the chat panel as they arrive. The Rust task
// stays alive for the duration of the HTTP response; we emit three
// Tauri event types the frontend subscribes to:
//
//   * `forge-chat-chunk`  — { text: "..." }     one or more per delta
//   * `forge-chat-done`   — { model, usage_in, usage_out, full_text }
//   * `forge-chat-error`  — { message: "..." }  network / API / decode
//
// SSE parsing: Anthropic emits text/event-stream with lines like
//   event: content_block_delta
//   data:  {"type":"content_block_delta","index":0,
//            "delta":{"type":"text_delta","text":"Hello"}}
//   (blank line terminator)
// We only care about `data:` lines whose JSON has a `delta.text` —
// everything else (event headers, message_start, message_stop,
// pings) is structural and the frontend doesn't need it.

#[derive(Serialize)]
struct AnthropicStreamRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: Vec<AnthropicMessage<'a>>,
    stream: bool,
}

#[derive(Serialize, Clone)]
struct ChatChunkPayload<'a> {
    text: &'a str,
}

#[derive(Serialize, Clone)]
struct ChatDonePayload<'a> {
    model: &'a str,
    full_text: &'a str,
    usage_in: u32,
    usage_out: u32,
}

#[derive(Serialize, Clone)]
struct ChatErrorPayload<'a> {
    message: &'a str,
}

#[tauri::command]
pub async fn forge_chat_stream(
    app: AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    // Resolve the API key up-front so we can fail synchronously
    // with a clear message — by the time the task is spawned the
    // frontend has already committed to the streaming UI path and
    // a delayed error feels jarring.
    let entry = Entry::new(ANTHROPIC_KEY_SERVICE, ANTHROPIC_KEY_ACCOUNT)
        .map_err(to_error_string)?;
    let api_key = match entry.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => {
            return Err(
                "Anthropic API key not set — open Settings → Forge and paste your key (sk-ant-…)"
                    .to_string(),
            );
        }
        Err(e) => return Err(to_error_string(e)),
    };

    for m in &messages {
        if m.role != "user" && m.role != "assistant" {
            return Err(format!(
                "invalid chat role {:?} — must be 'user' or 'assistant'",
                m.role
            ));
        }
    }
    if messages.is_empty() {
        return Err("empty chat — provide at least one user message".to_string());
    }

    // Reset the cancel handle before kicking off the new stream so
    // a notify() from a previous turn that arrived after the task
    // exited doesn't immediately cancel this one. tokio::Notify's
    // semantics: if notify_one is called before notified() is
    // awaited, the next notified() call resolves immediately. We
    // drain that pending permit here.
    let cancel = CHAT_CANCEL.clone();
    cancel.notify_waiters();        // wake any stale waiters first
    let _drain = cancel.notified(); // and consume any stored permit

    // Spawn the HTTP + SSE-parse task. The command itself returns
    // immediately; progress goes through Tauri events.
    let app2 = app.clone();
    let cancel_for_task = cancel.clone();
    tokio::spawn(async move {
        if let Err(e) = run_stream(app2.clone(), api_key, messages, cancel_for_task).await {
            let _ = app2.emit(
                "forge-chat-error",
                ChatErrorPayload { message: &e },
            );
        }
    });
    Ok(())
}

/// Tell the active chat stream to stop. Idempotent — calling when
/// nothing is streaming is a no-op (the next stream that starts
/// will drain the stale notify in its setup path).
#[tauri::command]
pub fn forge_chat_cancel() -> Result<(), String> {
    CHAT_CANCEL.notify_waiters();
    Ok(())
}

// ── Strategy lifecycle (Phase 4b) ──────────────────────────────
//
// Each strategy has a state that moves through:
//
//   draft → backtested → paper → live → archived
//
// Houston is the authoritative source — when the stack is up we
// fetch + update through its REST API. When it's down (or hasn't
// implemented the endpoints yet) we fall back to a local cache in
// forge.json so the pills still render and edits persist locally;
// the next time Houston is reachable, we push the cache to it.
//
// Expected Houston endpoints (documented in docs/houston-api.md):
//
//   GET    /api/forge/strategies                  → { states: { "rel_path": "paper", ... } }
//   PATCH  /api/forge/strategies/{rel_path}       → body { state: "paper" } → 204
//
// If Houston returns 404 for these (running an older Auracle that
// pre-dates the endpoint), we treat it the same as offline — pure
// local cache. No crash, no broken UI.

const KEY_STATE_CACHE: &str = "strategy_state_cache";
const HOUSTON_BASE_URL: &str = "http://localhost:1969";

const VALID_STATES: &[&str] = &[
    "draft",
    "backtested",
    "paper",
    "live",
    "archived",
];

fn read_cache(app: &tauri::AppHandle) -> serde_json::Map<String, serde_json::Value> {
    if let Ok(store) = app.store(STORE_FILE) {
        if let Some(v) = store.get(KEY_STATE_CACHE) {
            if let Some(obj) = v.as_object() {
                return obj.clone();
            }
        }
    }
    serde_json::Map::new()
}

fn write_cache_entry(app: &tauri::AppHandle, rel_path: &str, state: &str) {
    if let Ok(store) = app.store(STORE_FILE) {
        let mut cache = read_cache(app);
        cache.insert(rel_path.to_string(), serde_json::Value::String(state.to_string()));
        store.set(KEY_STATE_CACHE, serde_json::Value::Object(cache));
        let _ = store.save();
    }
}

fn write_cache_bulk(app: &tauri::AppHandle, states: &serde_json::Map<String, serde_json::Value>) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(KEY_STATE_CACHE, serde_json::Value::Object(states.clone()));
        let _ = store.save();
    }
}

#[derive(Serialize)]
pub struct StrategyStates {
    /// Map of rel_path → state. Includes ONLY strategies for which
    /// we have a known state; absent files default to "draft" on
    /// the frontend.
    pub states: serde_json::Map<String, serde_json::Value>,
    /// True when the data came from Houston, false when we fell
    /// back to the local cache. UI can use this to grey out the
    /// pills slightly + show a "offline (cached)" hint.
    pub from_houston: bool,
}

#[tauri::command]
pub async fn forge_strategy_states(app: tauri::AppHandle) -> Result<StrategyStates, String> {
    // Try Houston first.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(to_error_string)?;

    match client
        .get(format!("{HOUSTON_BASE_URL}/api/forge/strategies"))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            // Houston has the endpoint and returned data — refresh
            // the local cache so we have something to serve when
            // the stack next goes offline.
            let parsed: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(_) => return Ok(StrategyStates {
                    states: read_cache(&app),
                    from_houston: false,
                }),
            };
            let states = parsed
                .get("states")
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            write_cache_bulk(&app, &states);
            Ok(StrategyStates { states, from_houston: true })
        }
        // 404 (Auracle pre-dates the endpoint) or any non-success
        // status → cache fallback, same as offline.
        _ => Ok(StrategyStates {
            states: read_cache(&app),
            from_houston: false,
        }),
    }
}

#[tauri::command]
pub async fn forge_set_strategy_state(
    app: tauri::AppHandle,
    rel_path: String,
    state: String,
) -> Result<(), String> {
    if !VALID_STATES.iter().any(|&s| s == state) {
        return Err(format!(
            "invalid state {state:?} — must be one of {:?}",
            VALID_STATES
        ));
    }

    // Optimistically write to the local cache so the UI updates
    // immediately. If the Houston call below fails, the cache is
    // still authoritative for the operator's local view.
    write_cache_entry(&app, &rel_path, &state);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(to_error_string)?;

    let url = format!(
        "{HOUSTON_BASE_URL}/api/forge/strategies/{}",
        urlencoding::encode(&rel_path)
    );
    let body = serde_json::json!({ "state": state });

    // Push to Houston. Best-effort — if it fails (offline, 404,
    // 5xx) the local cache write above stands. Logging the failure
    // would be useful but we don't want to surface "Houston is
    // offline" as a chat-level error every time someone tweaks
    // a state; that's a normal state when the stack isn't running.
    let _ = client.patch(&url).json(&body).send().await;

    Ok(())
}

async fn run_stream(
    app: AppHandle,
    api_key: String,
    messages: Vec<ChatMessage>,
    cancel: Arc<Notify>,
) -> Result<(), String> {
    let model = resolve_model(&app);
    let body = AnthropicStreamRequest {
        model: &model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: messages
            .iter()
            .map(|m| AnthropicMessage {
                role: m.role.as_str(),
                content: m.content.as_str(),
            })
            .collect(),
        stream: true,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(to_error_string)?;

    // Race the initial request against a cancel — if the user
    // hits Stop while the connection is still being established
    // (DNS, TLS handshake), bail out before we even read a byte.
    let send_fut = client
        .post(ANTHROPIC_API_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&body)
        .send();
    let mut resp = tokio::select! {
        r = send_fut => r.map_err(|e| format!("network error: {e}"))?,
        _ = cancel.notified() => {
            let _ = app.emit(
                "forge-chat-done",
                ChatDonePayload {
                    model: &model,
                    full_text: "",
                    usage_in: 0,
                    usage_out: 0,
                },
            );
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp
            .text()
            .await
            .unwrap_or_else(|_| String::from("(no body)"));
        return Err(format!("Anthropic API {status}: {text}"));
    }

    // Buffered SSE parser. Anthropic doesn't guarantee one event
    // per chunk — a single TCP read can contain partial events or
    // multiple events, so we accumulate into a line buffer and
    // dispatch on each \n\n boundary.
    let mut buf = String::new();
    let mut full_text = String::new();
    let mut response_model = model.clone(); // overwritten by message_start if Anthropic returns a different alias
    let mut usage_in: u32 = 0;
    let mut usage_out: u32 = 0;

    loop {
        let chunk_result = tokio::select! {
            r = resp.chunk() => r,
            _ = cancel.notified() => {
                // Drop the response — closes the TCP connection on
                // Anthropic's side so we stop being billed for any
                // remaining output tokens. The done event still
                // fires below so the UI settles.
                drop(resp);
                let _ = app.emit(
                    "forge-chat-done",
                    ChatDonePayload {
                        model: &response_model,
                        full_text: &full_text,
                        usage_in,
                        usage_out,
                    },
                );
                return Ok(());
            }
        };
        let Some(chunk) = chunk_result.map_err(|e| format!("stream read: {e}"))? else { break };
        let s = match std::str::from_utf8(&chunk) {
            Ok(s) => s,
            // Anthropic claims UTF-8 throughout; non-UTF8 means we
            // either lost framing or hit a network garbage path —
            // skip the chunk rather than crashing the stream.
            Err(_) => continue,
        };
        buf.push_str(s);

        // Pull out complete events (terminated by blank line, i.e. \n\n).
        while let Some(end) = buf.find("\n\n") {
            let event_block = buf[..end].to_string();
            buf.drain(..end + 2);

            // An event block can have multiple `data:` lines per
            // the SSE spec — concatenate them. Anthropic only ever
            // sends one in practice but the parser stays correct.
            let mut data_payload = String::new();
            for line in event_block.lines() {
                if let Some(rest) = line.strip_prefix("data:") {
                    let trimmed = rest.trim_start();
                    if !data_payload.is_empty() {
                        data_payload.push('\n');
                    }
                    data_payload.push_str(trimmed);
                }
            }
            if data_payload.is_empty() {
                continue;
            }
            // Anthropic uses a final `data: [DONE]`-style sentinel
            // on some endpoints, but Messages streaming uses the
            // `message_stop` event instead. Either way, ignore.
            if data_payload == "[DONE]" {
                continue;
            }

            let parsed: serde_json::Value = match serde_json::from_str(&data_payload) {
                Ok(v) => v,
                Err(_) => continue, // malformed event — skip
            };
            let event_type = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match event_type {
                "message_start" => {
                    if let Some(m) = parsed
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                    {
                        response_model = m.to_string();
                    }
                    if let Some(u) = parsed
                        .get("message")
                        .and_then(|m| m.get("usage"))
                    {
                        if let Some(n) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                            usage_in = n as u32;
                        }
                        if let Some(n) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                            usage_out = n as u32;
                        }
                    }
                }
                "content_block_delta" => {
                    if let Some(text) = parsed
                        .get("delta")
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        full_text.push_str(text);
                        let _ = app.emit(
                            "forge-chat-chunk",
                            ChatChunkPayload { text },
                        );
                    }
                }
                "message_delta" => {
                    // The final usage update lands here — Anthropic
                    // updates output_tokens to the actual final count.
                    if let Some(u) = parsed.get("usage") {
                        if let Some(n) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                            usage_out = n as u32;
                        }
                    }
                }
                "message_stop" => {
                    // End of stream — emit the consolidated done
                    // event so the frontend can swap from streaming
                    // to settled state.
                    let _ = app.emit(
                        "forge-chat-done",
                        ChatDonePayload {
                            model: &response_model,
                            full_text: &full_text,
                            usage_in,
                            usage_out,
                        },
                    );
                    return Ok(());
                }
                _ => {
                    // content_block_start, content_block_stop, ping,
                    // and any future event types — structural only,
                    // the frontend doesn't need them.
                }
            }
        }
    }

    // Stream ended without an explicit message_stop (network blip
    // mid-response). Still emit done so the UI isn't stuck on the
    // streaming spinner; full_text holds whatever we got.
    let _ = app.emit(
        "forge-chat-done",
        ChatDonePayload {
            model: &response_model,
            full_text: &full_text,
            usage_in,
            usage_out,
        },
    );
    Ok(())
}
