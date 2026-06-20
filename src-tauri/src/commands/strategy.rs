//! Strategy lifecycle (read-only).
//!
//! One command — `strategy_states` — GETs the engine's per-strategy
//! lifecycle map (`{rel_path: state}` + a `from_houston` freshness flag)
//! for the home's lifecycle belt. The belt is read-only: the launcher
//! reports lifecycle truth and routes every mutation to the IDE/engine
//! that own the strategy files and runs.
//!
//! Auth: owner key (on-box handoff) over loopback — the same proven path
//! `settings_get` uses. No secret values are in this payload.
//!
//! Honesty: a non-success status or an unreachable engine returns an
//! Err, so the belt degrades to labels-only rather than fabricating a
//! count. (Until the engine ships the states route this always errs, and
//! the belt's honest degrade is exactly the intended Phase-5 behavior.)

use serde_json::Value;

use super::engine_auth::{fetch_owner_api_key, ENGINE_BASE};
use super::to_error_string;

const STATES_PATH: &str = "/ui/api/strategies/states";
const TIMEOUT_SECS: u64 = 8;

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(to_error_string)
}

/// Read the per-strategy lifecycle map. The JSON is passed straight to
/// the frontend, which owns the typed `StrategyStates` shape.
#[tauri::command]
pub async fn strategy_states() -> Result<Value, String> {
    let client = client()?;
    let owner_key = fetch_owner_api_key(&client).await?.ok_or_else(|| {
        "connect/sign in to the engine first — no on-box owner account was found".to_string()
    })?;

    let resp = client
        .get(format!("{ENGINE_BASE}{STATES_PATH}"))
        .header("X-API-Key", &owner_key)
        .header("Cookie", format!("auracle_session={owner_key}"))
        .send()
        .await
        .map_err(to_error_string)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "the engine couldn't return strategy states ({status})"
        ));
    }
    resp.json::<Value>().await.map_err(to_error_string)
}
