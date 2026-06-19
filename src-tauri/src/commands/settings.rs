//! Shared global-settings surface.
//!
//! The launcher and the IDE both read one owner-gated settings aggregate
//! from the local engine so their views stay in sync. Two commands:
//!
//!   * `settings_get` — GET the aggregate (broker/data-key configured
//!     flags, the AI model, prefs, tier, an etag). NO secret VALUES are
//!     ever in this payload — only "configured" flags.
//!   * `settings_put` — PUT a change (the AI model, or prefs). A key in
//!     `ai_model.key` rides to the engine vault and never comes back. The
//!     write echoes the caller's etag via `If-Match` so a stale write is
//!     rejected with 409 rather than silently clobbering a concurrent
//!     change made in the IDE.
//!
//! Auth: owner key (on-box handoff) + double-submit CSRF — the same
//! proven loopback path the data-keys surface uses (see `engine_auth`).
//!
//! Honesty + secrecy laws:
//!   * a key value is never logged and never placed in an error string;
//!   * no on-box owner key readable → a clear "connect/sign in" error,
//!     never a fake success;
//!   * a 409 from a stale etag maps to a plain "settings changed
//!     elsewhere — reload and retry" message;
//!   * a 409 from a fail-closed vault (paid tier, no vault key) maps to
//!     a plain remediation line (set AURACLE_VAULT_KEY + restart), never
//!     a raw engine body and never an optimistic "saved".

use serde_json::Value;

use super::engine_auth::{fetch_csrf, fetch_owner_api_key, ENGINE_BASE};
use super::to_error_string;

const SETTINGS_PATH: &str = "/ui/api/settings";
const TIMEOUT_SECS: u64 = 8;

/// Shared client: short timeout, no proxy. reqwest sends no `Origin`
/// header, which keeps the engine's CSRF/origin gates happy for an
/// on-box caller.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(to_error_string)
}

/// Read the shared settings aggregate. The returned JSON is passed
/// straight through to the frontend (it owns the typed shape). NO key
/// values are present — the engine only reports "configured" flags.
#[tauri::command]
pub async fn settings_get() -> Result<Value, String> {
    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;

    let resp = client
        .get(format!("{ENGINE_BASE}{SETTINGS_PATH}"))
        .header("X-API-Key", &owner_key)
        .header("Cookie", format!("auracle_session={owner_key}"))
        .send()
        .await
        .map_err(to_error_string)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("the engine couldn't return settings ({status})"));
    }
    resp.json::<Value>().await.map_err(to_error_string)
}

/// Persist a settings change. `patch` is the JSON the frontend built —
/// either `{"ai_model": {"provider", "model_id", "key"?}}` or
/// `{"prefs": {...}}`. The key (when present) rides in the body only —
/// never a URL, never a log line — and the engine stores it in its vault.
///
/// The caller's last-seen etag is echoed via `If-Match` so a stale write
/// is rejected (409) instead of clobbering a concurrent change. On
/// success the fresh aggregate is returned so the caller can refresh
/// without a second round-trip.
#[tauri::command]
pub async fn settings_put(patch: Value, etag: Option<String>) -> Result<Value, String> {
    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;
    let csrf = fetch_csrf(&client, &owner_key).await?;

    let mut req = client
        .put(format!("{ENGINE_BASE}{SETTINGS_PATH}"))
        .header("Content-Type", "application/json")
        .header("X-API-Key", &owner_key)
        .header("X-CSRF-Token", &csrf)
        .header(
            "Cookie",
            format!("auracle_session={owner_key}; auracle_csrf={csrf}"),
        );
    if let Some(tag) = etag.as_deref().filter(|t| !t.is_empty()) {
        req = req.header("If-Match", tag);
    }

    let resp = req
        .body(serde_json::to_string(&patch).map_err(to_error_string)?)
        .send()
        .await
        .map_err(to_error_string)?;

    let status = resp.status();
    if status.is_success() {
        log::info!("settings_put: saved a settings change");
        return resp.json::<Value>().await.map_err(to_error_string);
    }

    // 409 covers two distinct cases; disambiguate from the body so the
    // remediation is actionable. The body is small and carries no secret.
    if status.as_u16() == 409 {
        let body = resp.text().await.unwrap_or_default();
        // A fail-closed vault (paid install without a vault key) is the
        // case that needs an env-var fix. The engine tags it; match on a
        // stable marker, otherwise treat 409 as a stale-etag conflict.
        if body.contains("VaultFailClosed") || body.to_lowercase().contains("vault") {
            return Err(
                "this install needs a vault key (paid tier): set AURACLE_VAULT_KEY in your \
                 .env and restart the engine, then save again"
                    .to_string(),
            );
        }
        return Err(
            "these settings changed somewhere else — reload Settings and try again".to_string(),
        );
    }
    Err(format!("the engine rejected the change ({status})"))
}
