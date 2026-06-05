//! Trust Caddy's per-install local CA so the launcher's embedded webview
//! can load `https://localhost` — the unified workspace and, crucially,
//! its same-origin JupyterLab panel. Without this, WKWebView rejects the
//! self-signed cert and the embedded shell fails to load.
//!
//! Caddy's `tls internal` mints a root CA at
//! `/data/caddy/pki/authorities/local/root.crt` inside the caddy
//! container. We extract it and add it to the System keychain as a
//! trusted root via an admin-elevated `security add-trusted-cert`
//! (osascript shows the native privilege prompt — once).
//!
//! macOS-only: on other platforms `caddy_ca_trusted` returns true (don't
//! gate the embed) and `trust_caddy_ca` returns a clear message.

use tokio::process::Command;

use super::docker::resolve_docker_bin;
use super::to_error_string;

const CADDY_CONTAINER: &str = "auracle-caddy";
const CADDY_CA_PATH: &str = "/data/caddy/pki/authorities/local/root.crt";
const CA_NAME: &str = "Caddy Local Authority";

/// Best-effort: is a Caddy local-CA root already in the System keychain?
/// Lets callers skip the admin prompt when trust is already established.
#[tauri::command]
pub async fn caddy_ca_trusted() -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Ok(true);
    }
    let out = Command::new("security")
        .args([
            "find-certificate",
            "-a",
            "-c",
            CA_NAME,
            "/Library/Keychains/System.keychain",
        ])
        .output()
        .await
        .map_err(to_error_string)?;
    Ok(out.status.success() && !out.stdout.is_empty())
}

/// Extract Caddy's local CA from the running caddy container and add it
/// to the System keychain as a trusted root. Prompts for admin once.
/// Idempotent — re-adding an already-trusted root is harmless.
#[tauri::command]
pub async fn trust_caddy_ca() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Automated certificate trust is only available on macOS.".into());
    }
    let bin = resolve_docker_bin()
        .await
        .ok_or_else(|| "Docker not found — start the Auracle stack first.".to_string())?;

    // 1) Pull the CA out of the running caddy container.
    let ca = Command::new(&bin)
        .args(["exec", CADDY_CONTAINER, "cat", CADDY_CA_PATH])
        .output()
        .await
        .map_err(to_error_string)?;
    if !ca.status.success() || ca.stdout.is_empty() {
        return Err("Couldn't read Caddy's local certificate — is the stack \
                    running? Start it and try again."
            .into());
    }

    // 2) Write to a temp file (the `security` tool needs a path).
    let tmp = std::env::temp_dir().join("auracle-caddy-root.crt");
    std::fs::write(&tmp, &ca.stdout).map_err(to_error_string)?;

    // 3) Add as a trusted root in the System keychain. This needs admin,
    //    so route through osascript for the native privilege prompt. The
    //    temp path contains no quotes, so the single-quote wrap is safe.
    let inner = format!(
        "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain '{}'",
        tmp.display()
    );
    let script = format!("do shell script \"{inner}\" with administrator privileges");
    let out = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .await
        .map_err(to_error_string)?;

    let _ = std::fs::remove_file(&tmp);
    if !out.status.success() {
        // A cancelled prompt also lands here — surface it plainly.
        return Err(format!(
            "Certificate trust did not complete: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}
