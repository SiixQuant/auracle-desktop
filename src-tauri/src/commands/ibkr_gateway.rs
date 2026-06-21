//! Dockerized IB Gateway connect — the launcher's thin client over the
//! engine's owner-gated connections API.
//!
//! This is the UNIFIED IBKR connection: it drives the same `ib_insync` IB
//! Gateway (`auracle-ibgateway`) that automated strategies use for data +
//! execution, via the engine's existing
//! `POST /ui/api/connections/ibkr/save` (connection_method = dockerized).
//! Replaces the launcher's old ibeam/Client-Portal path, which set up a
//! DIFFERENT gateway strategies never used.
//!
//! Auth: owner key (on-box handoff) + double-submit CSRF — the same
//! loopback path settings.rs / data_keys.rs use. Credentials (incl. the
//! TOTP secret) ride in the request body only — never a URL, never a log
//! line — and the engine vaults them. The engine refuses without a TOTP
//! secret (unattended-by-contract), surfaced here as a plain message.

use serde_json::{json, Value};

use super::engine_auth::{fetch_csrf, fetch_owner_api_key, ENGINE_BASE};
use super::to_error_string;

const SAVE_PATH: &str = "/ui/api/connections/ibkr/save";
const STATUS_PATH: &str = "/ui/api/connections/ibkr";
// Generous: starting the dockerized gateway (compose up) can take a while.
const TIMEOUT_SECS: u64 = 40;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(to_error_string)
}

/// Pull the operator-facing `detail` out of a FastAPI error body so the
/// engine's instructive message (e.g. "a TOTP secret is required …")
/// reaches the user instead of a bare status code.
fn detail_or(body: &str, fallback: String) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("detail").and_then(Value::as_str).map(str::to_string))
        .unwrap_or(fallback)
}

/// Connect IBKR via the dockerized IB Gateway. `mode` is "paper" | "live"
/// (anything not "live" is treated as paper). On success the engine has
/// vaulted the credentials and started the gateway; strategies then use
/// the same connection. Rejects with the engine's plain message (e.g. the
/// TOTP requirement, or a vault-fail-closed remediation).
#[tauri::command]
pub async fn ibkr_connect(
    username: String,
    password: String,
    totp_key: String,
    mode: String,
) -> Result<Value, String> {
    let login_type = if mode.eq_ignore_ascii_case("live") {
        "Live Trading"
    } else {
        "Paper Trading"
    };

    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;
    let csrf = fetch_csrf(&client, &owner_key).await?;

    let body = json!({
        "username": username,
        "password": password,
        "totp_key": totp_key,
        "login_type": login_type,
        "connection_method": "dockerized",
    });

    let resp = client
        .post(format!("{ENGINE_BASE}{SAVE_PATH}"))
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
        log::info!("ibkr_connect: saved IBKR credentials + started the dockerized gateway");
        return resp.json::<Value>().await.map_err(to_error_string);
    }
    let raw = resp.text().await.unwrap_or_default();
    Err(detail_or(
        &raw,
        format!("the engine rejected the connection ({status})"),
    ))
}

/// Read the engine's IBKR connection status (fields + state). The JSON is
/// passed straight to the frontend, which owns the typed shape. NO secret
/// values are present — the engine reports configured flags + state only.
#[tauri::command]
pub async fn ibkr_connection_status() -> Result<Value, String> {
    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;

    let resp = client
        .get(format!("{ENGINE_BASE}{STATUS_PATH}"))
        .header("X-API-Key", &owner_key)
        .header("Cookie", format!("auracle_session={owner_key}"))
        .send()
        .await
        .map_err(to_error_string)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("the engine couldn't return IBKR status ({status})"));
    }
    resp.json::<Value>().await.map_err(to_error_string)
}
