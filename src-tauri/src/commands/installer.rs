//! First-time install bootstrap.
//!
//! Mirrors the existing `install.sh` flow but in Rust so it can
//! be invoked from the Tauri frontend with structured progress
//! reporting instead of raw stdout. Steps:
//!
//!   1. Pick install path (~/auracle by default; user can override
//!      in Settings before running install).
//!   2. Download install.sh from auracle-installer GitHub repo (the
//!      same script power users curl | bash today). Sanity-check
//!      the response starts with a `#!` shebang before writing it
//!      to disk so a cached HTML 404 page can't be executed by
//!      mistake. (TODO P3 in AUDIT_REPORT.md: pin a SHA-256 of the
//!      installer in the launcher and verify before exec. Today we
//!      rely on the HTTPS chain + GitHub's host security.)
//!   3. Run the installer with the user's chosen license key in
//!      env (set AURACLE_LICENSE_KEY before invoking) so the
//!      install.sh's prompt-for-key step skips.
//!   4. Poll /healthz to know when the stack came up.
//!
//! Long-running steps (docker compose pull is multi-minute) emit
//! structured progress via Tauri events the frontend can subscribe
//! to (`installer-progress` event with {phase, message, percent}).

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::to_error_string;
use crate::commands::keychain;

/// URL of the install.sh script that materializes a fresh Auracle
/// stack. Matches the public auracle-installer repo's main branch.
const INSTALLER_SCRIPT_URL: &str =
    "https://raw.githubusercontent.com/SiixQuant/auracle-installer/main/install.sh";

/// Resolve the install path — either AURACLE_INSTALL_DIR env (for
/// dev / power users) or the default ~/auracle.
pub fn resolve_install_path() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("AURACLE_INSTALL_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home = dirs_home()?;
    Ok(home.join("auracle"))
}

fn dirs_home() -> anyhow::Result<PathBuf> {
    // std::env::home_dir() was deprecated then un-deprecated in 1.85.
    // For safety + cross-platform, prefer the env vars directly.
    if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .map_err(|_| anyhow::anyhow!("USERPROFILE env var not set"))
    } else {
        std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| anyhow::anyhow!("HOME env var not set"))
    }
}

#[tauri::command]
pub async fn is_installed() -> Result<bool, String> {
    let path = resolve_install_path().map_err(to_error_string)?;
    Ok(path.join("docker-compose.yml").exists())
}

#[tauri::command]
pub fn install_path() -> Result<String, String> {
    resolve_install_path()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(to_error_string)
}

/// Per-phase progress event emitted to the frontend during install.
/// The frontend's onboarding view subscribes via window.__TAURI__.
/// event.listen('installer-progress', ...) and renders a stepper.
#[derive(Debug, Clone, Serialize)]
pub struct InstallerProgress {
    pub phase: String,        // "download_script" | "run_installer" | "wait_healthy"
    pub message: String,      // human-readable status line
    pub percent: u8,          // 0-100 (best-effort)
    pub line: Option<String>, // raw subprocess output line, when relevant
}

#[tauri::command]
pub async fn run_first_install(app: AppHandle) -> Result<(), String> {
    let path = resolve_install_path().map_err(to_error_string)?;
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(to_error_string)?;
    }
    log::info!("first install bootstrap into {}", path.display());

    emit_progress(
        &app,
        "download_script",
        "Downloading installer script…",
        5,
        None,
    );

    // 1. Download install.sh into the install dir
    let script_path = path.join("install.sh");
    download_installer(&script_path)
        .await
        .map_err(to_error_string)?;
    emit_progress(
        &app,
        "download_script",
        "Installer script downloaded.",
        15,
        None,
    );

    // Make executable (chmod +x equivalent on Unix; no-op on Windows
    // where bash isn't available anyway — see WINDOWS note below).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)
            .map_err(to_error_string)?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).map_err(to_error_string)?;
    }

    // WINDOWS: the launcher itself runs natively (.msi installs to
    // Program Files); the Auracle Docker stack underneath the
    // launcher requires Docker Desktop, which on Windows uses WSL2
    // as its backend. install.sh runs in bash, which is provided by
    // Git Bash (typically already installed via Git for Windows) OR
    // WSL2's bash.exe.
    //
    // Check for bash availability before invoking. If neither Git
    // Bash nor WSL2 bash is present, surface a clear instruction.
    #[cfg(windows)]
    {
        use std::process::Command as StdCommand;
        let bash_available = StdCommand::new("where")
            .arg("bash")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !bash_available {
            return Err(
                "Bash not found on PATH. Auracle's install.sh requires bash, \
                 typically provided by Git for Windows (https://git-scm.com/) \
                 OR WSL2 (https://learn.microsoft.com/en-us/windows/wsl/install). \
                 Install either + restart Auracle Desktop to continue."
                    .into(),
            );
        }
    }

    // 2. Pull license key from the secret store, set in env so the
    //    installer script's prompt-for-key step skips. Operator who
    //    wants to install without a key (Community tier) can clear
    //    the key in Settings before running install.
    let license = keychain::license_get(app.clone()).ok().flatten().unwrap_or_default();

    emit_progress(
        &app,
        "run_installer",
        "Running install.sh — pulling Docker images and starting services. \
         This usually takes 3–8 minutes on a fresh machine.",
        20,
        None,
    );

    // 3. Spawn install.sh with stdout/stderr piped so we can
    //    forward each line to the frontend as a progress event.
    let mut cmd = Command::new("bash");
    cmd.arg(&script_path)
        .current_dir(&path)
        .env("AURACLE_LICENSE_KEY", &license)
        .env("AURACLE_NONINTERACTIVE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("install.sh spawn failed: {e}"))?;

    // Drain stdout in a background task so the pipe doesn't fill.
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(&app_clone, "run_installer", "", 50, Some(line));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("installer stderr: {line}");
                emit_progress(&app_clone, "run_installer", "", 50, Some(line));
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("install.sh wait: {e}"))?;
    if !status.success() {
        return Err(format!(
            "install.sh exited with code {:?} — check the logs panel for details",
            status.code(),
        ));
    }
    emit_progress(&app, "run_installer", "Installer completed.", 80, None);

    // 4. Wait for /healthz to come up (max 120 s). The healthcheck
    //    poll runs continuously in the background; here we just
    //    block until it reports healthy.
    emit_progress(
        &app,
        "wait_healthy",
        "Waiting for the Auracle stack to become healthy…",
        85,
        None,
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(to_error_string)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get("http://localhost:1969/healthz").send().await {
            if resp.status().is_success() {
                emit_progress(&app, "wait_healthy", "Auracle is up.", 100, None);
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err(
        "Stack didn't reach healthy state within 2 minutes. Check Diagnostics → \
         container logs to see what's stuck."
            .into(),
    )
}

/// Helper: emit one InstallerProgress event to the main window.
fn emit_progress(app: &AppHandle, phase: &str, message: &str, percent: u8, line: Option<String>) {
    let _ = app.emit(
        "installer-progress",
        InstallerProgress {
            phase: phase.to_string(),
            message: message.to_string(),
            percent,
            line,
        },
    );
}

/// Download the installer script. Verifies content-type looks
/// shell-script-like as a basic sanity check (a cached HTML
/// "404 Not Found" page from a reverse proxy would otherwise
/// land in install.sh and bash would fail with a confusing
/// syntax error).
async fn download_installer(target: &PathBuf) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client
        .get(INSTALLER_SCRIPT_URL)
        .header("User-Agent", "Auracle-Desktop-Launcher/0.1")
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!(
            "installer download HTTP {} from {}",
            resp.status(),
            INSTALLER_SCRIPT_URL,
        );
    }
    let body = resp.text().await?;
    // Sanity: the first line should be a shebang. If we got HTML
    // back from a misconfigured CDN, refuse to write the file.
    let first_line = body.lines().next().unwrap_or("");
    if !first_line.starts_with("#!") {
        anyhow::bail!(
            "installer download didn't look like a shell script (first line: {:?}). \
             Refusing to write — re-check INSTALLER_SCRIPT_URL.",
            &first_line[..first_line.len().min(80)],
        );
    }
    std::fs::write(target, body.as_bytes())?;
    Ok(())
}
