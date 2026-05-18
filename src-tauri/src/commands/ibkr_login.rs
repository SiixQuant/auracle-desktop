//! IBKR Client Portal embedded login window.
//!
//! Two commands form a tiny pair that's driven from the frontend:
//!
//!   * `open_ibkr_login(url)` — spawns a child `WebviewWindow` pointed
//!     at the local clientportal.gw login page. The window has its own
//!     OS-level title bar; it isn't an iframe inside the main app.
//!     The frontend uses this when `window.__TAURI__` is present;
//!     otherwise it falls back to `window.open(...)` (a regular new
//!     browser tab).
//!
//!   * `close_ibkr_login()` — closes the child window. The frontend's
//!     existing /authstate poll calls this once `authenticated:true`
//!     comes back, so the user never has to dismiss the login window
//!     by hand.
//!
//! Self-signed cert note (read before debugging cert errors):
//! ----------------------------------------------------------
//! clientportal.gw uses a self-signed TLS cert. macOS / WKWebView
//! refuses self-signed certs by default — first time a customer
//! opens this window they may see a blank page or a "this site is
//! not secure" page rendered by WebKit. There are three remediation
//! paths in order of complexity:
//!
//!   1. (Easiest, current default.) Tell the user to first visit
//!      https://localhost:5000 in their system browser and accept
//!      the cert there. macOS persists the exception per-domain at
//!      the keychain level; the Tauri webview inherits the system
//!      cert trust on subsequent loads.
//!
//!   2. Wire WKWebView's navigation delegate via `with_webview` to
//!      auto-accept self-signed certs ONLY for the loopback host.
//!      Out of scope for v1 — adds unsafe ObjC bridge code.
//!
//!   3. At install time, generate a locally-trusted cert (mkcert
//!      style) + install it into the system keychain + mount into
//!      the cpgateway container. The cleanest UX, but requires
//!      platform-specific installer logic. Tracked as v2.
//!
//! The frontend offers a "Open in browser instead" link as a fallback
//! for customers who hit the cert wall.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use super::to_error_string;

/// Window label for the embedded login window. Reusing the same label
/// makes the command idempotent — a second invocation surfaces the
/// existing window rather than stacking a new one on top of it.
const LOGIN_WINDOW_LABEL: &str = "ibkr-login";

/// Spawn the embedded IBKR login window pointed at `url`.
///
/// `url` is normally `https://localhost:5000` (Auracle's cpgateway
/// service). We accept it as a parameter rather than hardcoding so
/// the frontend can swap in a custom URL for development (e.g. when
/// the gateway is bound to a non-default port).
#[tauri::command]
pub async fn open_ibkr_login(app: AppHandle, url: String) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        existing.set_focus().map_err(to_error_string)?;
        return Ok(());
    }

    let parsed = url::Url::parse(&url).map_err(|e| {
        format!("invalid login URL {url:?}: {e}")
    })?;

    WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW_LABEL,
        WebviewUrl::External(parsed),
    )
    .title("Interactive Brokers — Sign in")
    .inner_size(600.0, 760.0)
    .min_inner_size(480.0, 620.0)
    .center()
    .resizable(true)
    .build()
    .map_err(to_error_string)?;

    Ok(())
}

/// Close the embedded IBKR login window if it's open. No-op if the
/// frontend already dismissed it or it was never opened.
#[tauri::command]
pub async fn close_ibkr_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        window.close().map_err(to_error_string)?;
    }
    Ok(())
}
