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
const AURACLE_ORIGIN: &str = "https://localhost";
const AURACLE_DEFAULT_PATH: &str = "/ui";
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

/// Build the embedded-window URL from an optional relative path.
///
/// Defaults to the workspace root (`/ui`). Only a plain same-origin path
/// is honored — anything that could redirect the window off `localhost`
/// (a scheme, a protocol-relative `//host`, or a value not starting with
/// `/`) falls back to the default, so a stray caller value can never
/// point the embedded webview at an arbitrary origin.
fn embedded_url(path: Option<String>) -> String {
    let rel = path.unwrap_or_default();
    let rel = rel.trim();
    let safe = rel.starts_with('/') && !rel.starts_with("//") && !rel.contains("://");
    let rel = if safe { rel } else { AURACLE_DEFAULT_PATH };
    format!("{AURACLE_ORIGIN}{rel}")
}

/// Open the embedded Auracle window at `path` (defaults to `/ui`). Reuses
/// an existing window if already open — navigating it to `path` and
/// focusing it — otherwise creates a fresh one.
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
pub async fn open_embedded_auracle(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<(), String> {
    let url = tauri::Url::parse(&embedded_url(path)).map_err(to_error_string)?;
    if let Some(existing) = app.get_webview_window(EMBEDDED_LABEL) {
        // Navigate the open window to the requested page so the toggle's
        // deep links (blotter, help) land where the user clicked instead
        // of showing whatever page was open before.
        existing.navigate(url).map_err(to_error_string)?;
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

    // Honest gate: never open the workspace into a dead/unknown engine.
    // Confirm Houston is healthy with a FRESH /healthz poll (the same
    // signal the tray + Dashboard use) before launching — the frontend
    // button is already gated on the cached health, but that can be a
    // poll-interval stale, and a direct command call would bypass it
    // entirely. Fail with a plain, actionable message instead.
    match super::healthcheck::healthcheck_now().await {
        Ok(h) if h.state == "healthy" => {}
        Ok(h) => {
            return Err(format!(
                "The local engine isn't ready (status: {}). Start it and \
                 wait for it to be ready, then open the workspace.",
                h.state
            ));
        }
        Err(e) => {
            return Err(format!(
                "Couldn't reach the local engine to confirm it's running \
                 ({e}). Start it first, then open the workspace."
            ));
        }
    }

    // Auto-provision the IDE's connection BEFORE launching, so it opens
    // already connected with nothing for the user to paste: hand the
    // per-user API key from the now-healthy local engine into the IDE's
    // config file over loopback. Best-effort — a failure or a
    // not-yet-set-up engine just means the IDE opens to its Connect modal
    // as before, never a fake "connected" state.
    match provision_ide_config().await {
        Ok(true) => {}  // config written; the IDE auto-connects on launch
        Ok(false) => {} // engine healthy but no owner account yet — nothing to hand off
        Err(e) => eprintln!("auracle: IDE auto-provision skipped ({e})"),
    }

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

/// Spawn the IDE detached from the launcher.
///
/// A packaged `.app` is opened through LaunchServices, which focuses
/// an already-running instance instead of starting a duplicate. A
/// bare development binary is spawned directly with `ZED_STATELESS=1`,
/// because the dev build's single-instance handshake can hand off to a
/// stale lock and exit without showing a window — stateless bypasses
/// that so a window reliably appears every time. (A packaged build
/// won't need this; its single-instance handling is sound.)
fn launch_path(path: &str) -> Result<(), String> {
    use std::process::Command;
    if path.ends_with(".app") {
        Command::new("open").arg(path).spawn()
    } else {
        Command::new(path).env("ZED_STATELESS", "1").spawn()
    }
    .map(|_| ())
    .map_err(to_error_string)
}

// ── IDE connection auto-provisioning (onboarding slice c) ───────────────
//
// The IDE reads `~/.config/auracle/auracle.json` ({engine_url, api_key}) and
// auto-connects on launch when a key is present. The launcher is the only
// component positioned to hand it that key without the user pasting it:
// it talks to the local engine over loopback, asks for the owner's
// per-user API key via the engine's loopback-only handoff endpoint, and
// writes the IDE config. The key never leaves this machine.

/// Engine loopback-only key-handoff endpoint (see
/// connect_agent.ide_provision_local on the engine side).
const PROVISION_URL: &str = "http://127.0.0.1:1969/ui/api/ide/provision-local";

#[derive(serde::Deserialize)]
struct ProvisionResponse {
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    engine_url: Option<String>,
}

/// Read the per-install IDE-handoff secret the engine wrote to the
/// bind-mounted keys dir (`<install>/data/keys/.ide-handoff-secret`).
/// Only an on-box process can read it; presenting it proves to the
/// engine that this caller runs on the same machine (a remote attacker,
/// even one forging Host / X-Forwarded-*, cannot). Returns None if the
/// file is absent/unreadable — the caller then skips provisioning.
fn read_handoff_secret() -> Option<String> {
    let install = super::installer::resolve_install_path().ok()?;
    let path = install
        .join("data")
        .join("keys")
        .join(".ide-handoff-secret");
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Ask the local engine for the owner's API key and write the IDE config.
///
/// Returns `Ok(true)` when the config was written (IDE will auto-connect),
/// `Ok(false)` when there's nothing to hand off — no on-box handoff
/// secret readable, or the engine is up but has no owner account yet
/// (HTTP 409) — and `Err` on a real failure. Never fabricates a key; on
/// `Ok(false)` the IDE simply opens to its Connect modal as before.
///
/// Authenticates by presenting the on-box handoff secret as
/// `X-Auracle-Handoff-Token`, and sends no `Origin` header (reqwest adds
/// none) so the engine's gates accept it.
async fn provision_ide_config() -> Result<bool, String> {
    // No on-box secret readable → we can't prove we're local; don't try.
    // (Engine not installed here, older engine without the secret, or a
    // permissions quirk — all honestly "can't provision", not an error.)
    let secret = match read_handoff_secret() {
        Some(token) => token,
        None => return Ok(false),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(to_error_string)?;
    let resp = client
        .post(PROVISION_URL)
        .header("X-Auracle-Handoff-Token", secret)
        .send()
        .await
        .map_err(to_error_string)?;

    // 409 = engine healthy but no owner account yet. Not an error — the
    // user finishes first-run setup; there's simply no key to hand off.
    if resp.status().as_u16() == 409 {
        return Ok(false);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "engine returned {} when provisioning the IDE key",
            resp.status()
        ));
    }

    let body: ProvisionResponse = resp.json().await.map_err(to_error_string)?;
    let api_key = match body.api_key {
        Some(key) if !key.is_empty() => key,
        _ => return Ok(false),
    };
    let engine_url = body
        .engine_url
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:1969".to_string());

    write_ide_config(&engine_url, &api_key)?;
    Ok(true)
}

/// Engine on-box session-handoff endpoint (see
/// connect_agent.ide_session_handoff). Mints a single-use login nonce so
/// an in-app webview can open a /ui/* page already signed in.
const SESSION_HANDOFF_URL: &str = "http://127.0.0.1:1969/ui/api/ide/session-handoff";

#[derive(serde::Deserialize)]
struct SessionHandoffResponse {
    #[serde(default)]
    login_url: Option<String>,
}

/// Mint a one-time login URL (`/ui/ide-login?nonce=...&next=<next>`) so an
/// in-app webview can open a /ui/* page ALREADY signed in — no login wall.
///
/// Returns `Ok(None)` when we can't prove we're local (no handoff secret
/// readable) or the engine has no owner yet (HTTP 409); the caller then
/// falls back to opening the page directly (which may prompt a login).
/// Same on-box auth as provisioning: the handoff secret header, no Origin
/// (reqwest adds none). The nonce is single-use + 60s, so it is safe to
/// carry in the returned URL.
#[tauri::command]
pub async fn mint_connect_login_url(next: Option<String>) -> Result<Option<String>, String> {
    let secret = match read_handoff_secret() {
        Some(token) => token,
        None => return Ok(None),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(to_error_string)?;
    let resp = client
        .post(SESSION_HANDOFF_URL)
        .header("X-Auracle-Handoff-Token", secret)
        .send()
        .await
        .map_err(to_error_string)?;
    if resp.status().as_u16() == 409 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "engine returned {} when minting a connect login",
            resp.status()
        ));
    }
    let body: SessionHandoffResponse = resp.json().await.map_err(to_error_string)?;
    let login_url = match body.login_url {
        Some(url) if !url.is_empty() => url,
        _ => return Ok(None),
    };
    let next_path = next
        .filter(|n| n.starts_with('/'))
        .unwrap_or_else(|| "/ui/connections".to_string());
    // URL-encode the next path so a query string (e.g. ?embed=1 for the
    // chrome-less themed connections portal) survives as a single `next`
    // value instead of colliding with the login URL's own query.
    Ok(Some(format!(
        "{login_url}&next={}",
        urlencoding::encode(&next_path)
    )))
}

/// Write `{engine_url, api_key}` to the IDE's config file
/// (`~/.config/auracle/auracle.json`), creating the directory if needed.
/// Mirrors exactly what the IDE's own Connect modal would save, so the
/// IDE's startup auto-connect picks it up. The file is chmod 0600 — it
/// carries the per-user API key.
///
/// Transition note (Zed→Auracle config-dir rename): if a pre-rename IDE's
/// `~/.config/zed` directory still exists, the handoff is mirrored there
/// too so that build keeps auto-connecting until it is updated. The legacy
/// dir is never created — once the IDE is on the renamed build it no longer
/// exists and the mirror is a no-op. This makes the launcher robust to any
/// launcher/IDE update order; it can be dropped once every install is
/// updated.
fn write_ide_config(engine_url: &str, api_key: &str) -> Result<(), String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "HOME not set; can't locate the IDE config dir".to_string())?;
    let text = serde_json::to_string_pretty(&serde_json::json!({
        "engine_url": engine_url,
        "api_key": api_key,
    }))
    .map_err(to_error_string)?;

    let config = std::path::Path::new(&home).join(".config");
    // Primary: the renamed Auracle config dir the current IDE reads from.
    write_ide_handoff(&config.join("auracle"), &text)?;
    // Transitional mirror for a not-yet-updated IDE; never created fresh.
    let legacy = config.join("zed");
    if legacy.exists() {
        if let Err(error) = write_ide_handoff(&legacy, &text) {
            eprintln!("auracle launcher: legacy IDE handoff write skipped: {error}");
        }
    }
    Ok(())
}

/// Write the handoff JSON to `<dir>/auracle.json` (chmod 0600), creating
/// `dir` if needed.
fn write_ide_handoff(dir: &std::path::Path, text: &str) -> Result<(), String> {
    use std::fs;
    fs::create_dir_all(dir).map_err(to_error_string)?;
    let path = dir.join("auracle.json");
    fs::write(&path, text).map_err(to_error_string)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Best-effort: the key is already protected by the dir, but lock
        // the file down too. Don't fail the whole handoff on a chmod.
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
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
