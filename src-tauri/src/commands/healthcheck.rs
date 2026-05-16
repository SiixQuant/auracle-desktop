//! Houston /healthz polling — drives the tray icon color.
//!
//! A background tokio task started in `lib.rs::run()` polls every
//! 30 s. Result lives in a `tokio::sync::Mutex<HealthSnapshot>`
//! so both the frontend (via `current_health` command) and the
//! tray-icon updater can read the latest state without coupling
//! their cadences.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use super::to_error_string;

/// Latest health snapshot. The tray icon and frontend Dashboard
/// both consume this; renderers compute their own visual state.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HealthSnapshot {
    /// "healthy" | "degraded" | "down" | "unknown"
    pub state: String,
    /// HTTP status code from /healthz, or 0 if no response.
    pub http_status: u16,
    /// ISO-8601 timestamp of the last successful response, or
    /// empty string if we've never seen one.
    pub last_ok_at: String,
    /// ISO-8601 of the most recent poll, success or failure.
    pub last_polled_at: String,
}

#[derive(Default)]
pub struct HealthState(Mutex<HealthSnapshot>);

const HEALTHZ_URL: &str = "http://localhost:1969/healthz";
const POLL_INTERVAL_SECS: u64 = 30;

/// Spawn the background poll task. Called once from `lib.rs::run()`'s
/// setup hook. Idempotent — calling twice spawns two pollers, which
/// would race; we manage the contract by only calling from setup.
pub fn start_background_poll(app: AppHandle) {
    let state = Arc::new(HealthState::default());
    app.manage(state.clone());

    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("reqwest client init");

        loop {
            let snapshot = poll_once(&client).await;
            {
                let mut guard = state.0.lock().await;
                *guard = snapshot;
            }
            tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    });
}

async fn poll_once(client: &reqwest::Client) -> HealthSnapshot {
    let now = chrono::Utc::now().to_rfc3339();
    match client.get(HEALTHZ_URL).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            let state = if (200..300).contains(&code) {
                "healthy"
            } else {
                "degraded"
            };
            HealthSnapshot {
                state: state.to_string(),
                http_status: code,
                last_ok_at: if state == "healthy" {
                    now.clone()
                } else {
                    String::new()
                },
                last_polled_at: now,
            }
        }
        Err(_) => HealthSnapshot {
            state: "down".to_string(),
            http_status: 0,
            last_ok_at: String::new(),
            last_polled_at: now,
        },
    }
}

#[tauri::command]
pub async fn healthcheck_now() -> Result<HealthSnapshot, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(to_error_string)?;
    Ok(poll_once(&client).await)
}

#[tauri::command]
pub async fn current_health(
    state: tauri::State<'_, Arc<HealthState>>,
) -> Result<HealthSnapshot, String> {
    let guard = state.0.lock().await;
    Ok(guard.clone())
}
