//! Auto-updater for the launcher itself.
//!
//! Tauri's updater plugin handles the download + signature
//! verification + install flow. We wrap it with two thin commands:
//!
//!   - `current_version()` for the Settings → About panel
//!   - `check_for_update()` triggered from Settings → Update
//!     button (auto-update also runs daily at 09:00 from a
//!     background tokio task — TODO once we wire it).
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
