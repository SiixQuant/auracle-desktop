//! Launch the native Auracle IDE and auto-provision its connection.
//!
//! The launcher's primary door is the native Auracle IDE: the launcher
//! boots the engine and then hands the user into the IDE, having already
//! written the IDE's connection config over loopback so it opens already
//! connected. There is no longer any embedded Houston web window or
//! view-mode preference — workspace surfaces are reached by deep-linking
//! into the IDE via the `auracle://` scheme (see `openIdePanel` on the
//! frontend).

use super::to_error_string;

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

/// Engine JSON license-activation endpoint (owner X-API-Key; CSRF-exempt).
const LICENSE_ACTIVATE_URL: &str = "http://127.0.0.1:1969/api/license/activate";

#[derive(serde::Deserialize)]
struct ProvisionResponse {
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    engine_url: Option<String>,
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
async fn fetch_provision() -> Result<Option<ProvisionResponse>, String> {
    // No on-box secret readable → we can't prove we're local; don't try.
    // (Engine not installed here, older engine without the secret, or a
    // permissions quirk — all honestly "can't provision", not an error.)
    let secret = match super::engine_auth::read_handoff_secret() {
        Some(token) => token,
        None => return Ok(None),
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
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "engine returned {} when handing off the owner key",
            resp.status()
        ));
    }

    let body: ProvisionResponse = resp.json().await.map_err(to_error_string)?;
    Ok(Some(body))
}

async fn provision_ide_config() -> Result<bool, String> {
    let body = match fetch_provision().await? {
        Some(body) => body,
        None => return Ok(false),
    };
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

/// Flip the running engine's license tier to match a freshly-saved key.
///
/// Best-effort companion to `license_set` (which stores the key in the
/// launcher vault): asks the local engine — authenticated as the owner via
/// the on-box handoff key — to activate the license NOW, so the tier updates
/// without a container restart, exactly as the old web License page did.
/// Returns the new tier on success; `Ok(None)` when the engine isn't
/// reachable or has no owner yet (the key still persists in the vault and
/// applies once the engine is up). The token value is never logged.
#[tauri::command]
pub async fn license_activate_engine(value: String) -> Result<Option<String>, String> {
    let api_key = match fetch_provision().await? {
        Some(body) => match body.api_key {
            Some(key) if !key.is_empty() => key,
            _ => return Ok(None),
        },
        None => return Ok(None),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(to_error_string)?;
    let resp = client
        .post(LICENSE_ACTIVATE_URL)
        .header("X-API-Key", api_key)
        .json(&serde_json::json!({ "token": value.trim() }))
        .send()
        .await
        .map_err(to_error_string)?;

    if !resp.status().is_success() {
        return Err(format!("engine rejected the license ({})", resp.status()));
    }

    #[derive(serde::Deserialize)]
    struct ActivateResponse {
        #[serde(default)]
        tier: Option<String>,
    }
    let body: ActivateResponse = resp.json().await.map_err(to_error_string)?;
    Ok(body.tier)
}

/// Write the IDE's config file (`~/.config/auracle/auracle.json`), creating
/// the directory if needed. `engine_url` + `api_key` are refreshed from this
/// handoff; the canonical `workspace_path` is merged in only when the config
/// doesn't already carry one (the launcher is the single writer of that field
/// and never overwrites a user-set / first-install value). Every other
/// existing key is preserved, so the JSON shape stays backward-compatible.
/// The file is chmod 0600 — it carries the per-user API key.
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

    // The launcher is the single writer of `workspace_path`. Resolve the
    // canonical Workspace so it can be inserted when absent; best-effort — if
    // it can't be resolved we still write the engine_url + api_key handoff.
    let workspace = crate::commands::workspace::canonical_workspace_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    let config = std::path::Path::new(&home).join(".config");
    // Primary: the renamed Auracle config dir the current IDE reads from.
    write_ide_handoff(
        &config.join("auracle"),
        engine_url,
        api_key,
        workspace.as_deref(),
    )?;
    // Transitional mirror for a not-yet-updated IDE; never created fresh.
    let legacy = config.join("zed");
    if legacy.exists() {
        if let Err(error) = write_ide_handoff(&legacy, engine_url, api_key, workspace.as_deref()) {
            eprintln!("auracle launcher: legacy IDE handoff write skipped: {error}");
        }
    }
    Ok(())
}

/// Merge the handoff JSON into `<dir>/auracle.json` (chmod 0600), creating
/// `dir` if needed. Reads any existing config first so a previously-persisted
/// `workspace_path` (or other keys) survives — `engine_url` + `api_key` are
/// refreshed, `workspace_path` is inserted only when absent.
fn write_ide_handoff(
    dir: &std::path::Path,
    engine_url: &str,
    api_key: &str,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    use std::fs;
    fs::create_dir_all(dir).map_err(to_error_string)?;
    let path = dir.join("auracle.json");
    let existing = fs::read_to_string(&path).ok();
    let text = crate::commands::workspace::merge_provisioning_config(
        existing.as_deref(),
        Some(engine_url),
        Some(api_key),
        workspace_path,
    )
    .map_err(to_error_string)?;
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
