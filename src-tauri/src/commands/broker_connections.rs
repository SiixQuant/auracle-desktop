//! Broker connection orchestration — the layer that decides
//! "is the user actually connected to a broker, and if not, what
//! do they need to do?"
//!
//! Wraps two existing pieces:
//!
//!   * `commands/broker_bridge.rs` — the actual HTTP clients for
//!     reading account data from each broker.
//!   * `commands/ibkr_login.rs` — the embedded webview that opens
//!     the IBKR Client Portal Gateway login page.
//!
//! Frontend renders a single Broker Connections card driven by
//! `forge_broker_status()`. Each entry tells the UI exactly which
//! action is appropriate next (e.g. "gateway not running →
//! show a Start instructions panel"; "gateway running but not
//! authenticated → show a Connect button that opens the login
//! window"; "connected → show a Test Connection button + an
//! account ID readout").
//!
//! Not a security boundary — the broker clients enforce their own
//! auth + path checks. This module's job is purely UX wayfinding.

use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;

const IBKR_GATEWAY_BASE: &str = "https://localhost:5000/v1/api";
/// Short timeout — this command runs every time the user opens
/// Settings; we don't want it blocking the page render.
const PROBE_TIMEOUT_SECS: u64 = 3;

/// Possible states a single broker connection can be in. The frontend
/// renders different controls per state, so the variants describe
/// what the UI should DO rather than just the network status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum BrokerState {
    /// Gateway / service isn't reachable at all. Frontend shows
    /// install / start instructions (per-broker).
    Offline { hint: String },
    /// Gateway is up but no session. Frontend shows a "Connect"
    /// button that triggers the embedded login flow.
    Unauthenticated { login_url: String },
    /// Logged in. Frontend shows account id + a "Test connection"
    /// button + a "Disconnect" link.
    Connected {
        account_id: String,
        /// Human-readable label of the connected account (e.g. the
        /// broker's display name for the user).
        account_label: Option<String>,
    },
    /// Probe completed but the response shape was unexpected. Almost
    /// always means the broker's API changed under us; surface the
    /// raw detail in case the user wants to file a bug.
    Error { detail: String },
    /// The broker is recognized in the catalog but no integration
    /// has been wired yet. Frontend shows a "coming soon" pill so
    /// the user knows it's on the roadmap.
    NotImplemented,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrokerStatus {
    /// Stable identifier (lowercase, hyphen-separated). Used as a
    /// React key and routed to action handlers.
    pub id: String,
    /// Display name.
    pub label: String,
    /// Short tagline shown under the label.
    pub description: String,
    /// Which capabilities this broker exposes (used to filter the
    /// agent's tool advertising in a future phase — e.g. don't
    /// offer get_options_chain when only Alpaca is connected).
    pub capabilities: Vec<&'static str>,
    pub state: BrokerState,
}

#[tauri::command]
pub async fn forge_broker_status(_app: AppHandle) -> Result<Vec<BrokerStatus>, String> {
    // Run all broker probes concurrently — settings page load shouldn't
    // serialize on the slowest one. tokio::join! returns once all are done.
    let (ibkr,) = tokio::join!(probe_ibkr(),);
    Ok(vec![
        ibkr,
        // Placeholders for brokers that will land later. Surfacing
        // them in "coming soon" state is intentional UX — it tells
        // the user what's on the roadmap without requiring them to
        // hunt through docs.
        BrokerStatus {
            id: "alpaca".to_string(),
            label: "Alpaca".to_string(),
            description: "API-key stocks + options + crypto. Free paper trading.".to_string(),
            capabilities: vec!["positions", "account", "quotes", "bars"],
            state: BrokerState::NotImplemented,
        },
        BrokerStatus {
            id: "tradier".to_string(),
            label: "Tradier".to_string(),
            description: "API-key equities + options. Sandbox + live tiers.".to_string(),
            capabilities: vec!["positions", "account", "quotes", "options_chain"],
            state: BrokerState::NotImplemented,
        },
        BrokerStatus {
            id: "hyperliquid".to_string(),
            label: "Hyperliquid".to_string(),
            description: "Wallet-signed perps + spot. No API key.".to_string(),
            capabilities: vec!["positions", "account", "quotes"],
            state: BrokerState::NotImplemented,
        },
    ])
}

/// Build the IBKR status entry. Three roundtrips at most:
///
///   1. POST /v1/api/iserver/auth/status → reachable + authenticated?
///   2. GET  /v1/api/iserver/accounts    → first account id (only if auth'd)
///
/// Both behind a 3s timeout so the Settings page load isn't held up
/// when the gateway is stuck.
async fn probe_ibkr() -> BrokerStatus {
    let base = BrokerStatus {
        id: "ibkr".to_string(),
        label: "Interactive Brokers".to_string(),
        description: "Your market data and trading account.".to_string(),
        capabilities: vec!["positions", "account", "quotes", "bars", "options_chain"],
        state: BrokerState::Offline {
            hint: "default".to_string(),
        },
    };

    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return BrokerStatus {
                state: BrokerState::Error {
                    detail: format!("http client build: {e}"),
                },
                ..base
            };
        }
    };

    let auth_url = format!("{IBKR_GATEWAY_BASE}/iserver/auth/status");
    let auth_resp = match client.post(&auth_url).send().await {
        Ok(r) => r,
        Err(e) => {
            // Distinguish "gateway not running" from "gateway up but
            // broken" — the message we give the user differs.
            let detail = if e.is_connect() {
                "Client Portal Gateway isn't running. Download it from \
                 IBKR (https://www.interactivebrokers.com/en/trading/ib-api.php#client-portal-api) \
                 and run `bash clientportal.gw/bin/run.sh root/conf.yaml`."
                    .to_string()
            } else if e.is_timeout() {
                format!(
                    "Gateway didn't respond within {PROBE_TIMEOUT_SECS}s. It may be stuck \
                     starting up — wait a moment and refresh."
                )
            } else {
                format!("Connection error: {e}")
            };
            return BrokerStatus {
                state: BrokerState::Offline { hint: detail },
                ..base
            };
        }
    };

    if !auth_resp.status().is_success() {
        return BrokerStatus {
            state: BrokerState::Error {
                detail: format!(
                    "auth/status returned HTTP {} — gateway may need restart",
                    auth_resp.status()
                ),
            },
            ..base
        };
    }

    let auth_json: serde_json::Value = match auth_resp.json().await {
        Ok(v) => v,
        Err(e) => {
            return BrokerStatus {
                state: BrokerState::Error {
                    detail: format!("auth/status JSON: {e}"),
                },
                ..base
            };
        }
    };

    let authenticated = auth_json
        .get("authenticated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !authenticated {
        return BrokerStatus {
            state: BrokerState::Unauthenticated {
                login_url: "https://localhost:5000".to_string(),
            },
            ..base
        };
    }

    // Logged in — fetch the first account id for the readout. If this
    // fails the user is still effectively connected (just no label).
    let accounts_url = format!("{IBKR_GATEWAY_BASE}/iserver/accounts");
    let account_id = (async {
        let resp = client.get(&accounts_url).send().await.ok()?;
        let v: serde_json::Value = resp.json().await.ok()?;
        v.get("accounts")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first())
            .and_then(|a| a.as_str())
            .map(String::from)
    })
    .await
    .unwrap_or_else(|| "unknown".to_string());

    BrokerStatus {
        state: BrokerState::Connected {
            account_id,
            account_label: None,
        },
        ..base
    }
}

/// Convenience command for the "Test connection" button. Calls
/// `broker_bridge::get_account_summary` and returns the result as
/// a JSON string the frontend can render verbatim.
#[tauri::command]
pub async fn forge_broker_test(broker_id: String) -> Result<String, String> {
    match broker_id.as_str() {
        "ibkr" => match super::broker_bridge::get_account_summary().await {
            Ok(v) => Ok(v.to_string()),
            Err(e) => Err(e.to_user_string()),
        },
        other => Err(format!("broker {other:?} not yet supported")),
    }
}
