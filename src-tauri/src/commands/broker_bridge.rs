//! Broker / market-data bridge.
//!
//! Replaces the prior pattern of routing every broker-data tool
//! through Houston (which doesn't expose the matching endpoints
//! today, see commit 235336b) with launcher-local HTTP clients
//! against the two sources that work TODAY:
//!
//!   * IBKR Client Portal Gateway — runs on the user's machine at
//!     https://localhost:5000/v1/api/, self-signed cert. The
//!     gateway is what Auracle's IBKR integration already uses for
//!     order flow; we hit it directly for read-only account state.
//!   * Yahoo Finance public chart endpoint — free, no auth, no key.
//!     Used for historical OHLCV bars so dashboards can render even
//!     when the IBKR gateway isn't logged in (the common case for
//!     "show me SPY over 90 days" type prompts).
//!
//! All tools return JSON shaped to match what the WidgetRenderer
//! expects out of the box:
//!
//!   * get_account_summary → `{net_liquidation, buying_power,
//!     available_funds, ...}` — feeds kpi_grid widgets directly.
//!   * get_open_positions → `{rows: [{symbol, quantity, avg_cost,
//!     market_value, unrealized_pnl, ...}, ...]}` — feeds data_table.
//!   * get_quote → `{symbol, last, bid, ask, volume, ts}` — feeds
//!     kpi_grid or scanner_table.
//!   * get_historical_bars → `{rows: [{date, open, high, low,
//!     close, volume}, ...]}` — feeds line_chart / candlestick_chart.
//!
//! Every function in this module returns a `BrokerError` on
//! failure. The dispatch layer in forge.rs maps each variant to a
//! user-readable string that tells Claude what to do next.

use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const IBKR_GATEWAY_BASE: &str = "https://localhost:5000/v1/api";
const YAHOO_CHART_BASE: &str = "https://query1.finance.yahoo.com/v8/finance/chart";

/// Per-request timeout. Generous because the IBKR gateway can be
/// slow on first hit (it lazily loads market data subscriptions).
const HTTP_TIMEOUT_SECS: u64 = 12;

/// Symbol → contract id cache. IBKR uses conid as the primary
/// identifier; symbol lookups are a separate roundtrip and stable
/// per (symbol, exchange), so cache aggressively.
static SYMBOL_CONID_CACHE: Lazy<Mutex<std::collections::HashMap<String, i64>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

#[derive(Debug)]
pub enum BrokerError {
    /// Source isn't reachable (connection refused, DNS, etc.).
    /// Includes which source so the dispatcher can render a useful
    /// "start X" instruction.
    Offline { source: &'static str, detail: String },
    /// IBKR gateway is up but the session isn't authenticated.
    NotAuthenticated,
    /// Source returned a non-2xx HTTP status.
    BadStatus { source: &'static str, status: u16, body: String },
    /// Source returned 2xx but the response shape is wrong (missing
    /// expected fields, can't parse JSON, etc.).
    BadResponse(String),
    /// Symbol doesn't resolve at the source.
    UnknownSymbol(String),
}

impl BrokerError {
    /// Render an error string Claude can relay to the user. Includes
    /// the actionable next step.
    pub fn to_user_string(&self) -> String {
        match self {
            BrokerError::Offline { source, detail } => format!(
                "{source} isn't reachable ({detail}). For IBKR data: \
                 start the IB Client Portal Gateway at https://localhost:5000 \
                 and log in. For Yahoo Finance data: check your internet \
                 connection."
            ),
            BrokerError::NotAuthenticated => {
                "IBKR Client Portal Gateway is up but not logged in. \
                 Open https://localhost:5000 in a browser and log in to \
                 your IBKR account, then retry."
                    .to_string()
            }
            BrokerError::BadStatus { source, status, body } => format!(
                "{source} returned HTTP {status}. Body: {body}"
            ),
            BrokerError::BadResponse(s) => format!("upstream returned unexpected shape: {s}"),
            BrokerError::UnknownSymbol(s) => format!("symbol {s:?} not recognized by the data source"),
        }
    }
}

/// Build an HTTP client tuned for the IBKR gateway: self-signed
/// cert (so disable verification), short timeout, no follow-redirects.
fn ibkr_client() -> Result<reqwest::Client, BrokerError> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| BrokerError::BadResponse(format!("client setup: {e}")))
}

fn public_client() -> Result<reqwest::Client, BrokerError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("Auracle-Desktop/0.2")
        .build()
        .map_err(|e| BrokerError::BadResponse(format!("client setup: {e}")))
}

/// Classify a reqwest error into the right BrokerError variant.
fn classify(source: &'static str, e: reqwest::Error) -> BrokerError {
    if e.is_connect() || e.is_timeout() {
        BrokerError::Offline {
            source,
            detail: e.to_string(),
        }
    } else {
        BrokerError::BadResponse(format!("{source}: {e}"))
    }
}

// ── IBKR Client Portal Gateway ───────────────────────────────────

/// GET /iserver/auth/status — returns `{authenticated: bool, ...}`.
async fn ibkr_check_auth(client: &reqwest::Client) -> Result<(), BrokerError> {
    let url = format!("{IBKR_GATEWAY_BASE}/iserver/auth/status");
    let resp = client.post(&url).send().await.map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let v: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("auth/status JSON: {e}")))?;
    if v.get("authenticated").and_then(|x| x.as_bool()) != Some(true) {
        return Err(BrokerError::NotAuthenticated);
    }
    Ok(())
}

/// GET /iserver/accounts → pick the first account id.
async fn ibkr_first_account(client: &reqwest::Client) -> Result<String, BrokerError> {
    let url = format!("{IBKR_GATEWAY_BASE}/iserver/accounts");
    let resp = client.get(&url).send().await.map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let v: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("accounts JSON: {e}")))?;
    let accounts = v
        .get("accounts")
        .and_then(|a| a.as_array())
        .ok_or_else(|| BrokerError::BadResponse("missing `accounts` array".to_string()))?;
    let first = accounts
        .first()
        .and_then(|a| a.as_str())
        .ok_or_else(|| BrokerError::BadResponse("`accounts` is empty".to_string()))?;
    Ok(first.to_string())
}

/// GET /portfolio/{account}/summary — returns named metric rows like
/// `{accountready: {amount: ...}, availablefunds: {amount: ...}, ...}`.
/// We flatten to a CVForge-friendly shape: `{net_liquidation: <num>,
/// buying_power: <num>, ...}`.
pub async fn get_account_summary() -> Result<Value, BrokerError> {
    let client = ibkr_client()?;
    ibkr_check_auth(&client).await?;
    let account = ibkr_first_account(&client).await?;
    let url = format!("{IBKR_GATEWAY_BASE}/portfolio/{account}/summary");
    let resp = client.get(&url).send().await.map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let raw: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("summary JSON: {e}")))?;
    // IBKR's summary shape: `{netliquidation: {amount: 12345, currency: "USD", ...}, ...}`.
    let pluck = |key: &str| -> Option<f64> {
        raw.get(key)
            .and_then(|v| v.get("amount"))
            .and_then(|v| v.as_f64())
    };
    let currency = raw
        .get("netliquidation")
        .and_then(|v| v.get("currency"))
        .and_then(|v| v.as_str())
        .unwrap_or("USD")
        .to_string();
    let out = json!({
        "account_id": account,
        "currency": currency,
        "net_liquidation": pluck("netliquidation"),
        "buying_power": pluck("buyingpower"),
        "available_funds": pluck("availablefunds"),
        "excess_liquidity": pluck("excessliquidity"),
        "total_cash": pluck("totalcashvalue"),
        "gross_position_value": pluck("grosspositionvalue"),
        "maintenance_margin": pluck("maintmarginreq"),
        "initial_margin": pluck("initmarginreq"),
        "unrealized_pnl": pluck("unrealizedpnl"),
        "realized_pnl": pluck("realizedpnl"),
    });
    Ok(out)
}

/// GET /portfolio/{account}/positions/0 — first page of positions.
/// IBKR returns an array of rich row objects; we trim to the
/// fields a data_table widget renders nicely + a `raw` field with
/// the full IBKR payload for power-user dashboards.
pub async fn get_open_positions() -> Result<Value, BrokerError> {
    let client = ibkr_client()?;
    ibkr_check_auth(&client).await?;
    let account = ibkr_first_account(&client).await?;
    let url = format!("{IBKR_GATEWAY_BASE}/portfolio/{account}/positions/0");
    let resp = client.get(&url).send().await.map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let raw: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("positions JSON: {e}")))?;
    let arr = raw
        .as_array()
        .ok_or_else(|| BrokerError::BadResponse("positions response not an array".to_string()))?;
    let rows: Vec<Value> = arr
        .iter()
        .map(|r| {
            json!({
                "symbol": r.get("contractDesc").or(r.get("ticker")).and_then(|v| v.as_str()).unwrap_or(""),
                "asset_class": r.get("assetClass").and_then(|v| v.as_str()).unwrap_or(""),
                "quantity": r.get("position").and_then(|v| v.as_f64()),
                "avg_cost": r.get("avgCost").and_then(|v| v.as_f64()),
                "market_price": r.get("mktPrice").and_then(|v| v.as_f64()),
                "market_value": r.get("mktValue").and_then(|v| v.as_f64()),
                "unrealized_pnl": r.get("unrealizedPnl").and_then(|v| v.as_f64()),
                "realized_pnl": r.get("realizedPnl").and_then(|v| v.as_f64()),
                "currency": r.get("currency").and_then(|v| v.as_str()).unwrap_or("USD"),
                "conid": r.get("conid").and_then(|v| v.as_i64()),
            })
        })
        .collect();
    Ok(json!({
        "account_id": account,
        "rows": rows,
    }))
}

/// POST /iserver/secdef/search?symbol=X → first matching conid for
/// a stock-like symbol. Cached per process so repeat quote/bar calls
/// don't pay the lookup.
async fn ibkr_resolve_conid(client: &reqwest::Client, symbol: &str) -> Result<i64, BrokerError> {
    {
        let cache = SYMBOL_CONID_CACHE.lock().unwrap();
        if let Some(&conid) = cache.get(symbol) {
            return Ok(conid);
        }
    }
    let url = format!("{IBKR_GATEWAY_BASE}/iserver/secdef/search");
    let resp = client
        .post(&url)
        .json(&json!({"symbol": symbol, "name": false, "secType": "STK"}))
        .send()
        .await
        .map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let arr: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("secdef/search JSON: {e}")))?;
    let conid = arr
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.get("conid"))
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .ok_or_else(|| BrokerError::UnknownSymbol(symbol.to_string()))?;
    SYMBOL_CONID_CACHE.lock().unwrap().insert(symbol.to_string(), conid);
    Ok(conid)
}

/// GET /iserver/marketdata/snapshot?conids=X&fields=31,84,86,7295 →
/// last/bid/ask/volume. IBKR returns rows like `[{"31": "503.21",
/// "84": "503.19", ...}]` where the keys are field codes. We map
/// them back to readable names.
pub async fn get_quote(symbol: &str) -> Result<Value, BrokerError> {
    let client = ibkr_client()?;
    ibkr_check_auth(&client).await?;
    let conid = ibkr_resolve_conid(&client, symbol).await?;
    // Field codes per IBKR docs: 31=last, 84=bid, 86=ask, 7295=volume,
    // 7762=high, 7763=low, 7637=open.
    let url = format!(
        "{IBKR_GATEWAY_BASE}/iserver/marketdata/snapshot?conids={conid}&fields=31,84,86,7295,7762,7763,7637"
    );
    let resp = client.get(&url).send().await.map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let arr: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("snapshot JSON: {e}")))?;
    let row = arr
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| BrokerError::BadResponse("snapshot empty".to_string()))?;
    let num = |k: &str| -> Option<f64> {
        row.get(k).and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        })
    };
    Ok(json!({
        "symbol": symbol,
        "conid": conid,
        "last": num("31"),
        "bid": num("84"),
        "ask": num("86"),
        "volume": num("7295"),
        "high": num("7762"),
        "low": num("7763"),
        "open": num("7637"),
        "ts": chrono::Utc::now().timestamp(),
    }))
}

/// GET /iserver/secdef/strikes?conid=X&sectype=OPT&month=YYYYMM
/// → `{call: [strikes...], put: [strikes...]}`. We pick the nearest
/// expiry in the same month if `expiry` is omitted.
async fn ibkr_option_strikes(
    client: &reqwest::Client,
    underlying_conid: i64,
    month: &str,
) -> Result<Vec<f64>, BrokerError> {
    let url = format!(
        "{IBKR_GATEWAY_BASE}/iserver/secdef/strikes?conid={underlying_conid}&sectype=OPT&month={month}"
    );
    let resp = client.get(&url).send().await.map_err(|e| classify("IBKR gateway", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "IBKR gateway",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let v: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("strikes JSON: {e}")))?;
    // Combine call + put strikes into one sorted unique list.
    let mut strikes: Vec<f64> = Vec::new();
    for key in &["call", "put"] {
        if let Some(arr) = v.get(*key).and_then(|x| x.as_array()) {
            for s in arr {
                if let Some(n) = s.as_f64() {
                    strikes.push(n);
                }
            }
        }
    }
    strikes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    strikes.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    Ok(strikes)
}

/// Fetch an option chain snapshot for a symbol. Returns calls + puts
/// across the nearest available strikes for the requested expiry
/// month. Shape designed for the option_chain_table widget AND for
/// downstream IV-surface aggregation.
///
/// Args:
///   - symbol: underlying ticker (e.g. "SPY")
///   - month:  YYYYMM (e.g. "202606"). Required — IBKR doesn't
///             accept a default. Caller can compute "next monthly
///             expiry" client-side or in the agent prompt.
///   - max_strikes: hard cap on returned strikes (default 30). Each
///                  strike requires its own conid lookup + snapshot
///                  roundtrip, so this is the right knob to keep
///                  latency bounded.
pub async fn get_options_chain(
    symbol: &str,
    month: &str,
    max_strikes: usize,
) -> Result<Value, BrokerError> {
    if !is_yyyymm(month) {
        return Err(BrokerError::BadResponse(format!(
            "expiry month {month:?} doesn't look like YYYYMM"
        )));
    }
    let client = ibkr_client()?;
    ibkr_check_auth(&client).await?;
    let underlying_conid = ibkr_resolve_conid(&client, symbol).await?;
    let strikes = ibkr_option_strikes(&client, underlying_conid, month).await?;
    if strikes.is_empty() {
        return Err(BrokerError::UnknownSymbol(format!(
            "{symbol} {month}: no option strikes found"
        )));
    }

    // Pick the center N strikes (closest to the underlying's current
    // price) so we don't waste roundtrips on deep OTM tails. Quote
    // the underlying first to get spot.
    let spot_quote = get_quote(symbol).await?;
    let spot = spot_quote.get("last").and_then(|v| v.as_f64()).unwrap_or_else(|| {
        // Fall back to median strike if no quote (after-hours edge
        // case). Better than refusing to render.
        strikes[strikes.len() / 2]
    });

    let mut strikes_with_dist: Vec<(f64, f64)> = strikes
        .iter()
        .map(|&k| (k, (k - spot).abs()))
        .collect();
    strikes_with_dist.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut picked: Vec<f64> = strikes_with_dist
        .iter()
        .take(max_strikes)
        .map(|(k, _)| *k)
        .collect();
    picked.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    // Resolve each (strike, right) into a conid via secdef/info. This
    // is the heaviest part of the chain fetch — N strikes × 2 rights
    // × 1 roundtrip each. We could parallelize but IBKR rate-limits
    // and a synchronous loop with a small N (default 30) finishes in
    // a few seconds on a warm gateway.
    let mut rows: Vec<Value> = Vec::with_capacity(picked.len());
    for strike in &picked {
        let mut row = serde_json::Map::new();
        row.insert("strike".to_string(), Value::from(*strike));
        for right in &["C", "P"] {
            let info_url = format!(
                "{IBKR_GATEWAY_BASE}/iserver/secdef/info?conid={underlying_conid}&sectype=OPT&month={month}&strike={strike}&right={right}"
            );
            let info_resp = match client.get(&info_url).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            if !info_resp.status().is_success() {
                continue;
            }
            let info: Value = match info_resp.json().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let opt_conid = info
                .as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.get("conid"))
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
            let Some(opt_conid) = opt_conid else { continue };
            // Snapshot fields: 31=last, 84=bid, 86=ask, 7295=volume,
            // 7280=imp vol, 7283=delta, 7308=gamma, 7311=theta, 7310=vega.
            let snap_url = format!(
                "{IBKR_GATEWAY_BASE}/iserver/marketdata/snapshot?conids={opt_conid}&fields=31,84,86,7295,7280,7283,7308,7311,7310"
            );
            let snap_resp = match client.get(&snap_url).send().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            let snap: Value = match snap_resp.json().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let snap_row = snap.as_array().and_then(|a| a.first()).cloned().unwrap_or_default();
            let pull = |k: &str| -> Option<f64> {
                snap_row.get(k).and_then(|v| match v {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.parse().ok(),
                    _ => None,
                })
            };
            let prefix = if *right == "C" { "call" } else { "put" };
            row.insert(format!("{prefix}_conid"), Value::from(opt_conid));
            row.insert(format!("{prefix}_last"), pull("31").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_bid"), pull("84").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_ask"), pull("86").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_volume"), pull("7295").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_iv"), pull("7280").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_delta"), pull("7283").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_gamma"), pull("7308").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_theta"), pull("7311").map(Value::from).unwrap_or(Value::Null));
            row.insert(format!("{prefix}_vega"), pull("7310").map(Value::from).unwrap_or(Value::Null));
        }
        rows.push(Value::Object(row));
    }

    Ok(serde_json::json!({
        "symbol": symbol,
        "month": month,
        "spot": spot,
        "underlying_conid": underlying_conid,
        "rows": rows,
    }))
}

fn is_yyyymm(s: &str) -> bool {
    s.len() == 6 && s.chars().all(|c| c.is_ascii_digit())
}

// ── Yahoo Finance (free, no auth) ────────────────────────────────

/// GET /v8/finance/chart/{symbol}?range={range}&interval=1d
/// → daily OHLCV bars over the requested window. No API key
/// required. Used as the default historical-bars path because
/// it works even when the IBKR gateway isn't logged in.
pub async fn get_historical_bars(symbol: &str, days: u32) -> Result<Value, BrokerError> {
    let client = public_client()?;
    let range = days_to_yahoo_range(days);
    let url = format!(
        "{YAHOO_CHART_BASE}/{}?range={range}&interval=1d&includePrePost=false&events=div,splits",
        urlencoding::encode(symbol),
    );
    let resp = client.get(&url).send().await.map_err(|e| classify("Yahoo Finance", e))?;
    if !resp.status().is_success() {
        return Err(BrokerError::BadStatus {
            source: "Yahoo Finance",
            status: resp.status().as_u16(),
            body: resp.text().await.unwrap_or_default(),
        });
    }
    let raw: Value = resp.json().await.map_err(|e| BrokerError::BadResponse(format!("yahoo JSON: {e}")))?;
    // Shape: chart.result[0] has timestamp[] + indicators.quote[0].{open, high, low, close, volume}.
    let result = raw
        .get("chart")
        .and_then(|c| c.get("result"))
        .and_then(|r| r.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| BrokerError::UnknownSymbol(symbol.to_string()))?;
    let timestamps = result
        .get("timestamp")
        .and_then(|t| t.as_array())
        .cloned()
        .unwrap_or_default();
    let quote = result
        .get("indicators")
        .and_then(|i| i.get("quote"))
        .and_then(|q| q.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| BrokerError::BadResponse("missing indicators.quote[0]".to_string()))?;
    let opens = quote.get("open").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let highs = quote.get("high").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let lows = quote.get("low").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let closes = quote.get("close").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let volumes = quote.get("volume").and_then(|a| a.as_array()).cloned().unwrap_or_default();

    let rows: Vec<Value> = timestamps
        .iter()
        .enumerate()
        .filter_map(|(i, ts)| {
            let t = ts.as_i64()?;
            // Skip rows where close is null (Yahoo returns null for
            // half-trading-day holidays etc.)
            let close = closes.get(i).and_then(|v| v.as_f64())?;
            let date = chrono::DateTime::<chrono::Utc>::from_timestamp(t, 0)?
                .format("%Y-%m-%d")
                .to_string();
            Some(json!({
                "date": date,
                "timestamp": t,
                "open": opens.get(i).and_then(|v| v.as_f64()),
                "high": highs.get(i).and_then(|v| v.as_f64()),
                "low": lows.get(i).and_then(|v| v.as_f64()),
                "close": close,
                "volume": volumes.get(i).and_then(|v| v.as_i64()),
            }))
        })
        .collect();

    Ok(json!({
        "symbol": symbol,
        "rows": rows,
        "currency": result
            .get("meta")
            .and_then(|m| m.get("currency"))
            .and_then(|c| c.as_str())
            .unwrap_or("USD"),
    }))
}

/// Translate "days" into a Yahoo `range` parameter. Yahoo accepts:
/// 1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max. We pick the
/// smallest one that covers the requested window so we don't waste
/// bandwidth.
fn days_to_yahoo_range(days: u32) -> &'static str {
    match days {
        0..=1 => "1d",
        2..=5 => "5d",
        6..=31 => "1mo",
        32..=93 => "3mo",
        94..=186 => "6mo",
        187..=370 => "1y",
        371..=740 => "2y",
        741..=1850 => "5y",
        1851..=3700 => "10y",
        _ => "max",
    }
}

// ── Direct Tauri commands ────────────────────────────────────────
//
// Broker data is a launcher-global resource: it shouldn't be tunneled
// through Forge's agent-tool surface to reach a frontend view that
// just wants a number. These thin wrappers expose the same module
// functions above as first-class Tauri commands so any view in the
// app — the main launcher Dashboard, a future tray menu, a settings
// readout — can pull broker data directly via `cmd.brokerXxx()`.
//
// The agent's dispatcher in commands/forge.rs ALSO calls into the
// same module functions, so there's exactly one source of truth for
// each read.

#[tauri::command]
pub async fn broker_account_summary() -> Result<serde_json::Value, String> {
    get_account_summary().await.map_err(|e| e.to_user_string())
}

#[tauri::command]
pub async fn broker_open_positions() -> Result<serde_json::Value, String> {
    get_open_positions().await.map_err(|e| e.to_user_string())
}

#[tauri::command]
pub async fn broker_quote(symbol: String) -> Result<serde_json::Value, String> {
    if !is_valid_symbol_for_command(&symbol) {
        return Err(format!("symbol {symbol:?} doesn't look like a valid ticker"));
    }
    get_quote(&symbol).await.map_err(|e| e.to_user_string())
}

#[tauri::command]
pub async fn broker_historical_bars(
    symbol: String,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    if !is_valid_symbol_for_command(&symbol) {
        return Err(format!("symbol {symbol:?} doesn't look like a valid ticker"));
    }
    let days = days.unwrap_or(252).clamp(5, 2520);
    get_historical_bars(&symbol, days)
        .await
        .map_err(|e| e.to_user_string())
}

#[tauri::command]
pub async fn broker_options_chain(
    symbol: String,
    month: String,
    max_strikes: Option<usize>,
) -> Result<serde_json::Value, String> {
    if !is_valid_symbol_for_command(&symbol) {
        return Err(format!("symbol {symbol:?} doesn't look like a valid ticker"));
    }
    let max_strikes = max_strikes.unwrap_or(20).clamp(5, 80);
    get_options_chain(&symbol, &month, max_strikes)
        .await
        .map_err(|e| e.to_user_string())
}

/// Mirror of forge::is_valid_ticker — duplicated locally so this
/// module doesn't reach back into a sibling for input validation.
fn is_valid_symbol_for_command(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '/' | ':'))
}

// ── Module-internal types ────────────────────────────────────────
//
// (Reserved for shape constants the frontend can introspect if we
// later expose a `forge_broker_capabilities()` command. Not used
// yet — kept here to keep the module's surface obvious from the top.)

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct BrokerCapability {
    pub name: &'static str,
    pub source: &'static str,
    pub requires_auth: bool,
}
