//! MCP sidecar supervisor.
//!
//! Auracle's MCP server is a Python program (auracle/mcp/server.py
//! in the main repo) that exposes 23 tools Claude can call. To
//! make Forge work standalone (without requiring the Docker stack
//! to be running), we bundle that server as a native binary via
//! PyInstaller and spawn it as a subprocess from Tauri.
//!
//! Phase 4c status: this module ships the SUPERVISOR — the Rust
//! code that spawns the binary, watches its stdout, and exposes
//! a status command to the frontend. The actual PyInstaller build
//! pipeline lives in the main Auracle repo (since the Python
//! source is there) and uploads binaries to GitHub Releases on
//! each tag.
//!
//! See docs/MCP-SIDECAR.md for the full architecture, the
//! cross-repo build flow, and the JSON-RPC tool-use loop that
//! the chat command will integrate against in Phase 4d.
//!
//! Until the sidecar binary is published, the commands here
//! degrade gracefully: status() returns "not_bundled", start()
//! returns an error message pointing the operator at the docs.
//! Forge keeps working without MCP — it just can't call tools
//! during chat turns.

use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::Manager;

use super::to_error_string;

/// Sidecar binary name. Tauri's resource resolver looks for this
/// under the app bundle's resource dir (.app/Contents/Resources
/// on macOS, similar on other platforms). The cross-platform build
/// in the main Auracle repo names its outputs to match.
const SIDECAR_BIN: &str = "auracle-mcp";

/// Process handle for the spawned sidecar. Lazy + Mutex because
/// the spawn + kill paths can run from different Tauri command
/// threads. None when the sidecar isn't currently running.
static SIDECAR_PROC: Lazy<Mutex<Option<Child>>> = Lazy::new(|| Mutex::new(None));

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SidecarStatus {
    /// Bundled binary present + process is running. PID included
    /// for diagnostics.
    Running { pid: u32 },
    /// Bundled binary present but not currently running. start()
    /// would succeed.
    Stopped,
    /// No binary found at the expected resource path. Likely a
    /// dev build (the build script only fetches the sidecar for
    /// release bundles) or an older Auracle Desktop version.
    /// Forge falls back to direct-Anthropic chat with no tools.
    NotBundled,
    /// Process is in the table but appears to have died. Caller
    /// should restart it.
    Crashed,
}

#[derive(Serialize)]
pub struct SidecarStatusPayload {
    pub status: SidecarStatus,
    /// Resolved path the binary was (or would be) loaded from.
    /// Surfaced so the operator can verify their build picked
    /// the right one.
    pub expected_path: String,
}

fn resolve_sidecar_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Tauri 2's resource resolver returns the correct path for
    // both dev (project root / resources) and bundled (.app /
    // Contents / Resources). The build script copies the
    // platform-specific binary into the resource dir at bundle
    // time; in dev, the operator either runs PyInstaller manually
    // or accepts the NotBundled status.
    let resource_dir = app.path().resource_dir().map_err(to_error_string)?;
    Ok(resource_dir.join(SIDECAR_BIN))
}

#[tauri::command]
pub async fn mcp_sidecar_status(app: tauri::AppHandle) -> Result<SidecarStatusPayload, String> {
    let path = resolve_sidecar_path(&app)?;
    let expected_path = path.to_string_lossy().into_owned();

    // First decide if the binary even exists.
    if !path.exists() {
        return Ok(SidecarStatusPayload {
            status: SidecarStatus::NotBundled,
            expected_path,
        });
    }

    // Then check whether we have it running. try_wait returns
    // Ok(Some(_)) when the child has exited, Ok(None) when still
    // running, Err on a kernel-level lookup failure.
    let mut guard = SIDECAR_PROC.lock().unwrap();
    let status = match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => SidecarStatus::Running { pid: child.id() },
            Ok(Some(_)) => {
                // Process exited — clear the slot so the next
                // start() attempt doesn't trip the already-running
                // guard.
                *guard = None;
                SidecarStatus::Crashed
            }
            Err(_) => SidecarStatus::Crashed,
        },
        None => SidecarStatus::Stopped,
    };

    Ok(SidecarStatusPayload {
        status,
        expected_path,
    })
}

#[tauri::command]
pub async fn mcp_sidecar_start(app: tauri::AppHandle) -> Result<(), String> {
    let path = resolve_sidecar_path(&app)?;
    if !path.exists() {
        return Err(format!(
            "MCP sidecar binary not found at {}. \
             Forge's chat will work without tool-calling. \
             See docs/MCP-SIDECAR.md for the build instructions.",
            path.display()
        ));
    }

    let mut guard = SIDECAR_PROC.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map(|s| s.is_none()).unwrap_or(false) {
            // Already running — idempotent return.
            return Ok(());
        }
    }

    // Spawn with piped stdio. Phase 4d will switch the stdio
    // handlers to a JSON-RPC reader/writer once we wire the
    // tool-use loop; for now Stdio::piped is enough to keep the
    // process alive without it filling its own stdout buffer.
    let child = std::process::Command::new(&path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn MCP sidecar: {e}"))?;

    *guard = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn mcp_sidecar_stop() -> Result<(), String> {
    let mut guard = SIDECAR_PROC.lock().unwrap();
    if let Some(mut child) = guard.take() {
        // SIGTERM via .kill() — for the Python sidecar, the MCP
        // server should handle SIGTERM gracefully and shut down
        // tools in flight. Phase 4d will switch to a JSON-RPC
        // shutdown notification first + wait briefly before kill.
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}
