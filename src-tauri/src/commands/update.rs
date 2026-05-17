//! Auto-updater for the launcher itself.
//!
//! Tauri's updater plugin handles the download + signature
//! verification + install flow. We wrap it with three thin commands:
//!
//!   - `current_version()` for the Settings → About panel
//!   - `check_for_update()` polls latest.json + returns whether a
//!     newer version exists (doesn't download anything)
//!   - `install_update()` actually downloads the new bundle,
//!     verifies the Ed25519 signature against the pubkey in
//!     `tauri.conf.json`, swaps it into /Applications, then
//!     restarts. Without this second step the "Check for Update"
//!     badge is purely informational — many shipping versions
//!     pre-v0.1.11 had only the check, which led users to think
//!     restarting the launcher would apply the update on its own.
//!
//! Update endpoint + Ed25519 pubkey are configured in
//! `tauri.conf.json` → `plugins.updater`.

use serde::Serialize;

use super::to_error_string;

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub current: String,
}

#[tauri::command]
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(to_error_string)?;
    match updater.check().await.map_err(to_error_string)? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            current: env!("CARGO_PKG_VERSION").to_string(),
        }),
        None => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
            current: env!("CARGO_PKG_VERSION").to_string(),
        }),
    }
}

/// Download + verify + install the latest version, then restart.
///
/// Process: re-runs `updater.check()` (the previous `check_for_update`
/// call's `Update` handle can't be carried across IPC boundaries, so
/// we re-fetch), then calls `download_and_install` which streams the
/// bundle from `latest.json`'s platform-specific URL, verifies the
/// minisign signature against the pubkey baked into the binary at
/// build time, and atomically swaps the .app in /Applications.
///
/// On success this calls `app.restart()` — which never returns. The
/// IPC channel sees a connection-closed error on the frontend; treat
/// that as "update applied, relaunching" not as a failure.
///
/// On failure (no update, signature mismatch, network error) returns
/// the error string so the frontend can surface it.
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(to_error_string)?;
    let Some(update) = updater.check().await.map_err(to_error_string)? else {
        return Err("No update available".to_string());
    };

    // Progress callbacks are noisy by design — every chunk fires the
    // first closure. We log start + finish only; mid-stream chunks
    // are dropped because writing a log line per HTTP chunk on a
    // ~6 MB download produces hundreds of lines for no real value.
    update
        .download_and_install(
            |_chunk_length, _content_length| {
                // intentional no-op — see above
            },
            || {
                log::info!("update download complete; installing + restarting");
            },
        )
        .await
        .map_err(to_error_string)?;

    // Never returns — replaces the running process with the new
    // binary. The IPC call on the frontend sees a connection-closed
    // error, which the frontend handler treats as success (since the
    // restart is the expected end state).
    app.restart();
}
