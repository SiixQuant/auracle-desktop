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
    /// Directory grouping for the compact connections UI:
    /// "broker" | "data" | "crypto".
    pub category: &'static str,
    /// Asset classes this source covers, rendered as chips. Use the
    /// short canonical set: equities, options, futures, forex, crypto,
    /// indices, metals.
    pub assets: Vec<&'static str>,
    /// True when Auracle's ENGINE can pull market data from this source
    /// today (a real ingestor exists: see auracle/ingest/*). Drives the
    /// "Data" capability badge — must reflect shipped reality, not
    /// roadmap.
    pub provides_data: bool,
    /// True when a real execution adapter exists for this source
    /// (auracle/brokers/*). Drives the "Trade" capability badge.
    pub provides_execution: bool,
    pub state: BrokerState,
}

/// Build a catalog entry for a source that has no launcher connect flow
/// yet (state = NotImplemented). Capability flags still reflect real
/// engine/adapter support so the badges stay honest — a "coming soon"
/// connection can still truthfully advertise that the engine ingests
/// its data.
fn catalog_entry(
    id: &str,
    label: &str,
    description: &str,
    category: &'static str,
    assets: Vec<&'static str>,
    provides_data: bool,
    provides_execution: bool,
) -> BrokerStatus {
    BrokerStatus {
        id: id.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        capabilities: vec![],
        category,
        assets,
        provides_data,
        provides_execution,
        state: BrokerState::NotImplemented,
    }
}

#[tauri::command]
pub async fn forge_broker_status(_app: AppHandle) -> Result<Vec<BrokerStatus>, String> {
    // Run all broker probes concurrently — settings page load shouldn't
    // serialize on the slowest one. tokio::join! returns once all are done.
    let (ibkr,) = tokio::join!(probe_ibkr(),);
    // The catalog below is the enterprise connections directory. IBKR
    // is the one source with a one-click launcher connect flow today
    // (probed live above); the rest are catalog entries whose Data /
    // Trade badges reflect REAL engine + adapter support (auracle/ingest
    // and auracle/brokers), with a "coming soon" launcher-connect state.
    // Honesty rule: provides_data / provides_execution must track what
    // actually ships, never the roadmap.
    Ok(vec![
        ibkr,
        // ── Brokers (data + execution) ──────────────────────────────
        catalog_entry(
            "alpaca",
            "Alpaca",
            "Commission-free US stocks, options & crypto. Free real-time data.",
            "broker",
            vec!["equities", "options", "crypto"],
            true,
            true,
        ),
        catalog_entry(
            "tradier",
            "Tradier",
            "Equities & options with a clean options chain.",
            "broker",
            vec!["equities", "options"],
            false,
            true,
        ),
        catalog_entry(
            "oanda",
            "OANDA",
            "Dedicated forex & metals with streaming prices.",
            "broker",
            vec!["forex", "metals"],
            false,
            false,
        ),
        catalog_entry(
            "tradovate",
            "Tradovate",
            "Flat-fee futures and futures options.",
            "broker",
            vec!["futures"],
            false,
            true,
        ),
        // ── Crypto exchanges (data via ccxt; execution on the roadmap) ─
        catalog_entry(
            "coinbase",
            "Coinbase",
            "US-regulated crypto spot. Data via ccxt.",
            "crypto",
            vec!["crypto"],
            true,
            false,
        ),
        catalog_entry(
            "kraken",
            "Kraken",
            "Crypto spot & futures. Data via ccxt.",
            "crypto",
            vec!["crypto", "futures"],
            true,
            false,
        ),
        catalog_entry(
            "binance",
            "Binance",
            "Largest crypto venue — spot, futures, options. Data via ccxt.",
            "crypto",
            vec!["crypto", "futures", "options"],
            true,
            false,
        ),
        catalog_entry(
            "bybit",
            "Bybit",
            "Crypto perpetuals, futures & options. Data via ccxt.",
            "crypto",
            vec!["crypto", "futures", "options"],
            true,
            false,
        ),
        catalog_entry(
            "okx",
            "OKX",
            "Full-spectrum crypto — spot, perps, options. Data via ccxt.",
            "crypto",
            vec!["crypto", "futures", "options"],
            true,
            false,
        ),
        catalog_entry(
            "hyperliquid",
            "Hyperliquid",
            "On-chain perps DEX. Wallet-signed, no API key.",
            "crypto",
            vec!["crypto", "futures"],
            false,
            true,
        ),
        // ── Market-data providers (data only) ───────────────────────
        catalog_entry(
            "polygon",
            "Polygon.io",
            "Normalized US equities, options, forex & crypto data.",
            "data",
            vec!["equities", "options", "forex", "crypto", "indices"],
            true,
            false,
        ),
        catalog_entry(
            "databento",
            "Databento",
            "Institutional L2/L3 depth for equities, futures & options.",
            "data",
            vec!["equities", "futures", "options"],
            false,
            false,
        ),
        catalog_entry(
            "finnhub",
            "Finnhub",
            "Equities, forex & crypto quotes with a free tier.",
            "data",
            vec!["equities", "forex", "crypto"],
            false,
            false,
        ),
        catalog_entry(
            "tiingo",
            "Tiingo",
            "Low-cost real-time US equities & crypto (IEX feed).",
            "data",
            vec!["equities", "crypto", "forex"],
            false,
            false,
        ),
        catalog_entry(
            "twelvedata",
            "Twelve Data",
            "Multi-asset quotes — equities, forex, crypto, indices.",
            "data",
            vec!["equities", "forex", "crypto", "indices"],
            false,
            false,
        ),
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
        category: "broker",
        assets: vec!["equities", "options", "futures", "forex"],
        provides_data: true,
        provides_execution: true,
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
