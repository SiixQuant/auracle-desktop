//! Real-time quote streaming surface.
//!
//! Why polling instead of WebSocket: IBKR's Client Portal Gateway
//! exposes both a REST snapshot endpoint AND a WebSocket at
//! `/v1/api/ws`. The WS path requires a separate session
//! authentication ritual + persistent connection management +
//! per-symbol subscription bookkeeping over a shared socket. For
//! the dashboard widgets this module powers, polling the snapshot
//! at 1–5s intervals gives identical UX (a tick every N ms emitted
//! as a Tauri event) with a fraction of the implementation surface.
//!
//! The user's IBKR subscription tier still governs what they get:
//!
//!   * Real-time subscription → each snapshot returns real-time
//!     prices, so a 1-second poll = 1-second-latency real-time.
//!   * Delayed-only → each snapshot returns 15-min-delayed prices.
//!     The stream still fires every interval; the price just moves
//!     when the delayed feed updates.
//!
//! Each stream is identified by its symbol. Multiple subscribers
//! (e.g. two dashboards both watching SPY) share one underlying
//! poll loop — refcounted on subscribe / unsubscribe.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Per-symbol active subscription. The poll loop runs as long as
/// `refcount > 0`; on unsubscribe-to-zero the task is aborted.
struct ActiveStream {
    handle: JoinHandle<()>,
    refcount: usize,
    interval_ms: u64,
}

/// All currently-active poll loops, keyed by uppercase symbol.
static ACTIVE: Lazy<Arc<Mutex<HashMap<String, ActiveStream>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Payload emitted on each tick. Frontend listens via
/// `onEvent('broker-tick', ...)` and updates the widget.
#[derive(Debug, Clone, Serialize)]
pub struct TickEvent {
    pub symbol: String,
    pub last: Option<f64>,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub data_quality: String,
    pub ts: i64,
}

/// Subscribe to a symbol's quote stream. Idempotent + refcounted —
/// calling twice for the same symbol returns immediately and increments
/// the refcount, so the stream stays alive until every subscriber has
/// called `broker_stream_unsubscribe`.
///
/// `interval_ms` is clamped to [500, 60000]. The floor exists because
/// the IBKR gateway will rate-limit aggressive polling; 500ms is the
/// fastest sustainable cadence without triggering throttling.
#[tauri::command]
pub async fn broker_stream_subscribe(
    app: AppHandle,
    symbol: String,
    interval_ms: Option<u64>,
) -> Result<(), String> {
    let interval_ms = interval_ms.unwrap_or(2000).clamp(500, 60_000);
    let key = symbol.to_uppercase();
    let mut active = ACTIVE.lock().await;
    if let Some(existing) = active.get_mut(&key) {
        existing.refcount += 1;
        // If the new requester wants a faster cadence than the
        // existing loop, swap in a new one at the tighter interval.
        // Simpler than trying to retune the running task.
        if interval_ms < existing.interval_ms {
            existing.handle.abort();
            existing.handle = spawn_poll_loop(app.clone(), key.clone(), interval_ms);
            existing.interval_ms = interval_ms;
        }
        return Ok(());
    }
    let handle = spawn_poll_loop(app.clone(), key.clone(), interval_ms);
    active.insert(
        key,
        ActiveStream {
            handle,
            refcount: 1,
            interval_ms,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn broker_stream_unsubscribe(symbol: String) -> Result<(), String> {
    let key = symbol.to_uppercase();
    let mut active = ACTIVE.lock().await;
    let Some(stream) = active.get_mut(&key) else {
        return Ok(()); // already not subscribed — idempotent
    };
    if stream.refcount > 1 {
        stream.refcount -= 1;
        return Ok(());
    }
    // Last subscriber dropped — kill the loop.
    stream.handle.abort();
    active.remove(&key);
    Ok(())
}

/// Returns the set of currently-active streams + their refcounts +
/// chosen interval. Useful for a diagnostics readout AND for the
/// frontend to render "● live" indicators on widgets that map to
/// active streams.
#[derive(Debug, Clone, Serialize)]
pub struct StreamStatus {
    pub symbol: String,
    pub refcount: usize,
    pub interval_ms: u64,
}

#[tauri::command]
pub async fn broker_stream_status() -> Result<Vec<StreamStatus>, String> {
    let active = ACTIVE.lock().await;
    let mut out: Vec<StreamStatus> = active
        .iter()
        .map(|(k, v)| StreamStatus {
            symbol: k.clone(),
            refcount: v.refcount,
            interval_ms: v.interval_ms,
        })
        .collect();
    out.sort_by(|a, b| a.symbol.cmp(&b.symbol));
    Ok(out)
}

/// Spawn the poll loop. Aborts cleanly when the JoinHandle is dropped
/// or aborted from the outside (the unsubscribe path).
fn spawn_poll_loop(app: AppHandle, symbol: String, interval_ms: u64) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));
        // First tick fires immediately (so subscribers see data
        // without waiting interval_ms). Subsequent ticks at cadence.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            match super::broker_bridge::get_quote(&symbol).await {
                Ok(payload) => {
                    let tick = TickEvent {
                        symbol: symbol.clone(),
                        last: payload.get("last").and_then(|v| v.as_f64()),
                        bid: payload.get("bid").and_then(|v| v.as_f64()),
                        ask: payload.get("ask").and_then(|v| v.as_f64()),
                        data_quality: payload
                            .get("data_quality")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string(),
                        ts: chrono::Utc::now().timestamp_millis(),
                    };
                    let _ = app.emit("broker-tick", &tick);
                }
                Err(_) => {
                    // Quietly skip — the loop will retry on the next
                    // interval. A short-lived gateway hiccup
                    // shouldn't spam the event channel with errors.
                }
            }
        }
    })
}
