//! First-time install bootstrap.
//!
//! Mirrors the existing `install.sh` flow but in Rust so it can
//! be invoked from the Tauri frontend with structured progress
//! reporting instead of raw stdout. Steps:
//!
//!   1. Pick install path (~/auracle by default; user can override
//!      in Settings before running install).
//!   2. Clone the auracle-installer repo OR write the embedded
//!      docker-compose.yml + .env template.
//!   3. Generate AURACLE_INSTALL_UUID + a random POSTGRES_PASSWORD,
//!      write to .env.
//!   4. `docker compose pull` (long-running, frontend shows progress).
//!   5. `docker compose up -d`.
//!   6. Poll /healthz until ready or 120 s timeout.
//!
//! The MVP version below stubs steps 2-4 — the production
//! implementation downloads the installer payload from a known
//! URL. The stub creates the directory + writes a placeholder
//! .env so the rest of the launcher can be developed against
//! it.

use std::path::PathBuf;

use super::to_error_string;

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

#[tauri::command]
pub async fn run_first_install() -> Result<(), String> {
    let path = resolve_install_path().map_err(to_error_string)?;
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(to_error_string)?;
    }
    log::info!("first install bootstrap into {}", path.display());

    // STUB: production version downloads from
    //   https://github.com/SiixQuant/auracle-installer/raw/main/install.sh
    // and runs it. For the scaffold we write a placeholder marker
    // file so is_installed() flips to true and the rest of the UI
    // can be exercised.
    let marker = path.join(".launcher-bootstrap-pending");
    std::fs::write(
        &marker,
        b"Auracle Desktop Launcher first-install bootstrap stub.\n\
          Run install.sh from auracle-installer to materialize the stack.\n",
    )
    .map_err(to_error_string)?;
    Ok(())
}
