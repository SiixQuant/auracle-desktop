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
use std::time::UNIX_EPOCH;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

use super::to_error_string;

// ── Strategies directory resolution ─────────────────────────────

const STORE_FILE: &str = "forge.json";
const KEY_STRATEGIES_DIR: &str = "strategies_dir";

const ANTHROPIC_KEY_SERVICE: &str = "com.auracle.desktop";
const ANTHROPIC_KEY_ACCOUNT: &str = "anthropic-api-key";

const ANTHROPIC_DEFAULT_MODEL: &str = "claude-sonnet-4-20250514";
const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

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
pub async fn forge_chat(messages: Vec<ChatMessage>) -> Result<ChatResponse, String> {
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

    let body = AnthropicRequest {
        model: ANTHROPIC_DEFAULT_MODEL,
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

    // Spawn the HTTP + SSE-parse task. The command itself returns
    // immediately; progress goes through Tauri events.
    let app2 = app.clone();
    tokio::spawn(async move {
        if let Err(e) = run_stream(app2.clone(), api_key, messages).await {
            let _ = app2.emit(
                "forge-chat-error",
                ChatErrorPayload { message: &e },
            );
        }
    });
    Ok(())
}

async fn run_stream(
    app: AppHandle,
    api_key: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let body = AnthropicStreamRequest {
        model: ANTHROPIC_DEFAULT_MODEL,
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

    let mut resp = client
        .post(ANTHROPIC_API_URL)
        .header("x-api-key", &api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .header("accept", "text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;

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
    let mut model = String::from(ANTHROPIC_DEFAULT_MODEL);
    let mut usage_in: u32 = 0;
    let mut usage_out: u32 = 0;

    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("stream read: {e}"))? {
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
                        model = m.to_string();
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
                            model: &model,
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
            model: &model,
            full_text: &full_text,
            usage_in,
            usage_out,
        },
    );
    Ok(())
}
