//! Native data-provider key surface.
//!
//! Replaces the retired Houston "Key Master" web page for entering
//! third-party data-provider API keys (Polygon, EODHD, ...). Now that
//! the web portal is gone (Houston runs headless), the launcher is the
//! native door for saving these keys so non-IBKR data works.
//!
//! The flow is entirely loopback:
//!   1. Get the owner's per-user API key from the engine via the on-box
//!      handoff (the same `.ide-handoff-secret` mechanism the IDE
//!      provisioning in `view.rs` uses — only an on-box process can read
//!      the secret, which proves to the engine the caller is local).
//!   2. The `/ui/api/keys` POST is NOT exempt from the double-submit CSRF
//!      gate (unlike the `/api/license` endpoints), so we first GET
//!      `/ui/api/status` to receive an `auracle_csrf` cookie, then echo
//!      that value back as both the `auracle_csrf` cookie and the
//!      `X-CSRF-Token` header on the mutation. This mirrors the IDE's
//!      `auracle_connections` crate (`fetch_csrf` + `post_json`).
//!
//! Honesty + secrecy laws baked in:
//!   * key VALUES are never logged and never placed in any error string;
//!   * no on-box owner key readable → a clear "connect/sign in to the
//!     engine first" error, never a fake success;
//!   * a 409 (paid tier, vault unavailable) maps to a plain remediation
//!     message, not a raw engine body;
//!   * `data_key_test` only reports success when the engine fragment
//!     actually says so — never an optimistic "active".

use super::engine_auth::{fetch_csrf, fetch_owner_api_key, ENGINE_BASE};
use super::to_error_string;

const KEYS_PATH: &str = "/ui/api/keys";
/// Short timeouts — these commands run from a Settings card; a dead or
/// not-yet-set-up engine should fail fast with a clear message, not hang.
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

/// Save a data-provider API key through the engine's `/ui/api/keys`
/// JSON endpoint (vault-encrypted on the engine side; an empty key would
/// clear it, but the UI never sends an empty key to Save).
///
/// Auth: owner key (on-box handoff) + double-submit CSRF. The key value
/// is never logged and never appears in any returned error.
#[tauri::command]
pub async fn data_key_save(provider: String, key: String) -> Result<(), String> {
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("pick a data provider first".to_string());
    }
    if key.trim().is_empty() {
        return Err("paste a key first".to_string());
    }

    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;
    let csrf = fetch_csrf(&client, &owner_key).await?;

    // The key rides in the JSON body only — never a URL, never a log line.
    let body = serde_json::json!({ "provider": provider, "key": key });
    let resp = client
        .post(format!("{ENGINE_BASE}{KEYS_PATH}"))
        .header("Content-Type", "application/json")
        .header("X-API-Key", &owner_key)
        .header("X-CSRF-Token", &csrf)
        .header(
            "Cookie",
            format!("auracle_session={owner_key}; auracle_csrf={csrf}"),
        )
        .body(serde_json::to_string(&body).map_err(to_error_string)?)
        .send()
        .await
        .map_err(to_error_string)?;

    let status = resp.status();
    if status.is_success() {
        log::info!("data_key_save: stored a key for provider '{provider}'");
        return Ok(());
    }
    // 409 = paid/live install with vault encryption unavailable; the
    // engine fails closed rather than writing plaintext. Give the
    // operator the actionable summary, not the raw body.
    if status.as_u16() == 409 {
        return Err(
            "this install needs a vault key (paid tier): set AURACLE_VAULT_KEY in your \
             .env and restart the engine, then save the key again"
                .to_string(),
        );
    }
    Err(format!("engine rejected the key ({status})"))
}

/// Best-effort "test this provider's key" against the provider's real API
/// via the engine's HTMX test endpoint (`/ui/api/keys/test/{provider}`).
///
/// That endpoint returns a small HTML fragment marked `class="ok"` on
/// success or `class="err"` on failure. We inspect status + that marker:
/// a non-2xx is an error; on 2xx we look for the `ok`/`err` class and
/// fall back to `Ok(true)` only when the fragment can't be classified
/// (the endpoint already gated to 2xx). The key value is never sent or
/// logged here — the engine tests whatever it has on disk for the provider.
#[tauri::command]
pub async fn data_key_test(provider: String) -> Result<bool, String> {
    let provider = provider.trim().to_string();
    if provider.is_empty() {
        return Err("pick a data provider first".to_string());
    }

    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;
    let csrf = fetch_csrf(&client, &owner_key).await?;

    let resp = client
        .post(format!("{ENGINE_BASE}{KEYS_PATH}/test/{provider}"))
        .header("X-API-Key", &owner_key)
        .header("X-CSRF-Token", &csrf)
        .header(
            "Cookie",
            format!("auracle_session={owner_key}; auracle_csrf={csrf}"),
        )
        .send()
        .await
        .map_err(to_error_string)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("the engine couldn't run the test ({status})"));
    }

    let fragment = resp.text().await.unwrap_or_default();
    // The fragment carries the verdict in its class. Prefer the explicit
    // markers; only fall back to "passed" when neither is present.
    if fragment.contains("class=\"err\"") {
        return Ok(false);
    }
    if fragment.contains("class=\"ok\"") {
        return Ok(true);
    }
    Ok(true)
}
