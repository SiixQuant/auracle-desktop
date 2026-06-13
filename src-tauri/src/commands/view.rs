//! View-mode preference + embedded Auracle window.
//!
//! The customer can choose between two ways of seeing Auracle:
//!
//!   - **browser** (default) — `tauri-plugin-opener` hands the
//!     `http://localhost:1969/ui/dashboard` URL to whatever the
//!     system has registered as the default browser. Smallest
//!     memory footprint; customer can use any browser they want.
//!
//!   - **embedded** — a second Tauri `WebviewWindow` whose entire
//!     content is the Houston web UI. Customer sees one native
//!     app instead of "launcher window + browser tab." Costs an
//!     extra ~150-200 MB of RAM (second WebView instance) and
//!     means we render in Tauri's WebKit rather than the system
//!     browser engine.
//!
//! Preference is persisted via `tauri-plugin-store` in a file
//! named `view-mode.json`. Default is `browser` so a fresh install
//! behaves identically to the previous launcher version — opting
//! into the embedded mode is explicit.
//!
//! The embedded window is reused when already open: clicking
//! "Open Auracle" a second time focuses the existing window
//! instead of spawning a duplicate. Closing the embedded window
//! doesn't affect the launcher (the main window keeps running).

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;

use super::to_error_string;

const STORE_FILE: &str = "view-mode.json";
const KEY_MODE: &str = "mode";
const DEFAULT_MODE: &str = "browser";
const EMBEDDED_LABEL: &str = "auracle-embedded";
// Load the workspace through Caddy (TLS), NOT http://localhost:1969 —
// the embedded JupyterLab panel is only same-origin under Caddy, and
// Jupyter refuses cross-origin framing, so a direct :1969 embed leaves
// the notebooks panel blank. Requires Caddy's local CA to be trusted on
// the host (see the launcher's first-run cert step / docs).
const AURACLE_URL: &str = "https://localhost/ui";
// JupyterLab opens as its OWN top-level window (not an iframe inside the
// workspace): WKWebView renders a heavy SPA like Lab reliably as a top-level
// page but not nested in an iframe, so the inline Research panel goes blank in
// the embed. A dedicated window sidesteps that — same Caddy origin so the SSO
// cookie still authenticates it.
const JUPYTER_LABEL: &str = "auracle-jupyter";
const JUPYTER_URL: &str = "https://localhost/jupyter/lab";

#[tauri::command]
pub async fn get_view_mode(app: tauri::AppHandle) -> Result<String, String> {
    let store = app.store(STORE_FILE).map_err(to_error_string)?;
    let mode = store
        .get(KEY_MODE)
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| DEFAULT_MODE.to_string());
    Ok(mode)
}

#[tauri::command]
pub async fn set_view_mode(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    // Whitelist accepted values so a typo from the frontend (or a
    // future enum value) doesn't silently get persisted and then
    // crash open_embedded_auracle later.
    if mode != "browser" && mode != "embedded" {
        return Err(format!(
            "invalid view mode: {mode}. expected 'browser' or 'embedded'"
        ));
    }
    let store = app.store(STORE_FILE).map_err(to_error_string)?;
    store.set(KEY_MODE, mode);
    store.save().map_err(to_error_string)?;
    Ok(())
}

/// Script injected into the embedded WebView before any page JS runs.
///
/// Two things it fixes vs a stock WebView pointing at Houston:
///
///   1. **`target="_blank"` links** — without this, clicking a link
///      that opens in a new tab (the JupyterLab nav item is the
///      canonical example) does nothing in Tauri's WebView, because
///      there's no browser to open a tab in. Override every click
///      so target="_blank" becomes a same-window navigation. The
///      customer still gets to JupyterLab; just inside the existing
///      embedded window. Browser-style back button works as expected.
///
///   2. **Anchors with rel="noopener"** — those usually also imply
///      "open in new window." Same treatment.
const EMBEDDED_INIT_SCRIPT: &str = r#"
(function () {
  // Capture-phase so we beat Houston's own click handlers.
  document.addEventListener('click', function (e) {
    var a = e.target;
    while (a && a.tagName !== 'A') a = a.parentElement;
    if (!a) return;
    if (a.target === '_blank') {
      // Force same-window navigation. Customer can use browser back
      // to return to the previous page.
      e.preventDefault();
      e.stopPropagation();
      window.location.href = a.href;
    }
  }, true);
})();
"#;

/// Open the embedded Auracle window. Reuses an existing window if
/// already open (focuses it); otherwise creates a fresh one.
///
/// Frontend calls this only when `get_view_mode()` returned
/// `embedded`. Browser mode is handled in JS via the opener plugin
/// directly — no Rust round-trip needed.
///
/// Persistence: WebView state (cookies, localStorage) is kept in
/// the platform-default app-data directory by Tauri. Session cookies
/// from Houston's 30-day Max-Age login should therefore survive
/// launcher restarts — customer doesn't have to re-enter credentials
/// every time they reopen the launcher.
#[tauri::command]
pub async fn open_embedded_auracle(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(EMBEDDED_LABEL) {
        existing.show().map_err(to_error_string)?;
        existing.set_focus().map_err(to_error_string)?;
        return Ok(());
    }
    // The embedded window loads https://localhost (Caddy) so the Jupyter
    // panel is same-origin. WKWebView needs Caddy's local CA trusted —
    // do it once, on first embed-open (native admin prompt).
    if !super::cert_trust::caddy_ca_trusted().await.unwrap_or(false) {
        super::cert_trust::trust_caddy_ca().await?;
    }
    let url = tauri::Url::parse(AURACLE_URL).map_err(to_error_string)?;
    WebviewWindowBuilder::new(&app, EMBEDDED_LABEL, WebviewUrl::External(url))
        .title("Auracle")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .decorations(true)
        .initialization_script(EMBEDDED_INIT_SCRIPT)
        .build()
        .map_err(to_error_string)?;
    Ok(())
}

/// Launch the Auracle IDE — the native workspace app — and bring it
/// to the front. This is now the launcher's primary door: the
/// launcher boots the engine and then hands the user into the IDE.
///
/// Resolution order (first hit wins):
///   1. `AURACLE_IDE_PATH` env override (a binary or a .app bundle).
///   2. The installed app bundle: `/Applications/Auracle IDE.app`.
///   3. A local development build under the user's home.
///
/// Honest failure: if no IDE is found, returns a plain message the
/// UI shows as-is — never a silent no-op, never a fake success.
#[tauri::command]
pub async fn open_auracle_ide() -> Result<(), String> {
    use std::path::Path;
    use std::process::Command;

    // 1. Explicit override.
    if let Ok(custom) = std::env::var("AURACLE_IDE_PATH") {
        let custom = custom.trim().to_string();
        if !custom.is_empty() && Path::new(&custom).exists() {
            return launch_path(&custom);
        }
    }

    // 2. Installed bundle.
    let bundle = "/Applications/Auracle IDE.app";
    if Path::new(bundle).exists() {
        return Command::new("open")
            .arg(bundle)
            .spawn()
            .map(|_| ())
            .map_err(to_error_string);
    }

    // 3. Local development build.
    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        for rel in [
            "Downloads/auracle-ide/target/release/zed",
            "Downloads/auracle-ide/target/debug/zed",
        ] {
            let candidate = home.join(rel);
            if candidate.exists() {
                return launch_path(&candidate.to_string_lossy());
            }
        }
    }

    Err("Auracle IDE isn't installed yet on this machine.".to_string())
}

/// Spawn a binary (or `open` a .app bundle) detached from the launcher.
fn launch_path(path: &str) -> Result<(), String> {
    use std::process::Command;
    if path.ends_with(".app") {
        Command::new("open").arg(path).spawn()
    } else {
        Command::new(path).spawn()
    }
    .map(|_| ())
    .map_err(to_error_string)
}

/// Open JupyterLab in its own top-level window. The inline iframe panel in
/// the workspace's Research view doesn't render in WKWebView (heavy nested
/// SPA), but a top-level window does. Same Caddy origin so the Auracle
/// session cookie authenticates Lab — no second login. Reuses an existing
/// window if already open (focuses it).
#[tauri::command]
pub async fn open_jupyter(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(JUPYTER_LABEL) {
        existing.show().map_err(to_error_string)?;
        existing.set_focus().map_err(to_error_string)?;
        return Ok(());
    }
    // Same Caddy CA trust the embedded window needs (one-time native prompt).
    if !super::cert_trust::caddy_ca_trusted().await.unwrap_or(false) {
        super::cert_trust::trust_caddy_ca().await?;
    }
    let url = tauri::Url::parse(JUPYTER_URL).map_err(to_error_string)?;
    WebviewWindowBuilder::new(&app, JUPYTER_LABEL, WebviewUrl::External(url))
        .title("Auracle — JupyterLab")
        .inner_size(1280.0, 860.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .decorations(true)
        .initialization_script(EMBEDDED_INIT_SCRIPT)
        .build()
        .map_err(to_error_string)?;
    Ok(())
}
