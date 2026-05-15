//! Docker / docker-compose CLI wrapper.
//!
//! All commands invoke the user's installed `docker` binary via
//! tokio's `Command`. We never talk to the Docker socket directly —
//! that would require the launcher to hold socket privileges, and
//! the CLI already implements the user-namespace + group checks
//! we'd otherwise reimplement.
//!
//! Path resolution: `which docker` at command time. If Docker is
//! missing the CLI returns a clear error which we forward; the
//! frontend's onboarding flow then prompts the user to install
//! Docker Desktop.
//!
//! Compose file location: `~/auracle/docker-compose.yml` —
//! materialized by the first-install flow (see installer.rs).

use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use super::to_error_string;
use crate::commands::installer;

/// Status of the Docker runtime on the user's machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerStatus {
    /// True iff `docker --version` exits 0.
    pub installed: bool,
    /// True iff `docker info` exits 0 (daemon is reachable).
    pub running: bool,
    /// Free-form version string — e.g. "Docker version 27.0.3".
    /// None when not installed.
    pub version: Option<String>,
}

/// Per-container status row in the stack overview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackContainer {
    pub name: String,
    pub state: String,
    /// "healthy" | "unhealthy" | "starting" | "" (no healthcheck)
    pub health: String,
    pub uptime_seconds: u64,
    /// Last 5 lines of stderr from this container — useful when
    /// state=exited so the UI can show "why did this die?" without
    /// a separate logs round-trip.
    pub last_error: Option<String>,
}

/// Aggregate stack status — the union of per-container rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackStatus {
    pub containers: Vec<StackContainer>,
    /// Convenience flag for the tray icon color.
    pub overall: String, // "healthy" | "degraded" | "down" | "starting"
}

#[tauri::command]
pub async fn docker_status() -> Result<DockerStatus, String> {
    let installed = check_binary("docker", &["--version"]).await?;
    if !installed {
        return Ok(DockerStatus {
            installed: false,
            running: false,
            version: None,
        });
    }

    let version_out = run_capture("docker", &["--version"]).await.map_err(to_error_string)?;
    let version = version_out.lines().next().map(|s| s.to_string());

    // `docker info` exits non-zero when the daemon is unreachable —
    // even when the CLI is installed. Use that as the running
    // signal rather than parsing `ps` or talking to the socket.
    let running = run_capture("docker", &["info"]).await.is_ok();

    Ok(DockerStatus {
        installed: true,
        running,
        version,
    })
}

/// OS-aware Docker Desktop install URL. The frontend's onboarding
/// "Install Docker" button calls opener::open_url with this so we
/// don't have to know which downloads link is current — Docker
/// Desktop's own download page picks the right artifact.
#[tauri::command]
pub fn docker_install_url() -> String {
    "https://www.docker.com/products/docker-desktop/".to_string()
}

#[tauri::command]
pub async fn stack_status() -> Result<StackStatus, String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    let compose_file = dir.join("docker-compose.yml");
    if !compose_file.exists() {
        return Ok(StackStatus {
            containers: vec![],
            overall: "down".to_string(),
        });
    }

    // `docker compose ps --format json` emits one JSON object per
    // line (NDJSON). Parse line-by-line so a malformed entry
    // doesn't drop the whole status — we'd rather show 5 healthy
    // containers + 1 "?" than a blank dashboard.
    let raw = run_capture_in(
        "docker",
        &["compose", "ps", "--format", "json"],
        &dir,
    )
    .await
    .map_err(to_error_string)?;

    let mut containers = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let name = v
            .get("Name")
            .and_then(|x| x.as_str())
            .unwrap_or("?")
            .to_string();
        let state = v
            .get("State")
            .and_then(|x| x.as_str())
            .unwrap_or("?")
            .to_string();
        let health = v
            .get("Health")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        // RunningFor = "5 minutes ago" — humanized. We don't try
        // to parse it into seconds; the frontend renders it as is.
        let uptime_seconds = 0;
        containers.push(StackContainer {
            name,
            state,
            health,
            uptime_seconds,
            last_error: None,
        });
    }

    let overall = derive_overall(&containers);
    Ok(StackStatus { containers, overall })
}

fn derive_overall(containers: &[StackContainer]) -> String {
    if containers.is_empty() {
        return "down".to_string();
    }
    let any_down = containers.iter().any(|c| c.state != "running");
    let any_unhealthy = containers
        .iter()
        .any(|c| c.health == "unhealthy");
    let any_starting = containers
        .iter()
        .any(|c| c.health == "starting");
    if any_down {
        "degraded".to_string()
    } else if any_unhealthy {
        "degraded".to_string()
    } else if any_starting {
        "starting".to_string()
    } else {
        "healthy".to_string()
    }
}

#[tauri::command]
pub async fn stack_start() -> Result<(), String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    run_in("docker", &["compose", "up", "-d"], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn stack_stop() -> Result<(), String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    run_in("docker", &["compose", "down"], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn stack_pull_update() -> Result<(), String> {
    // The "update" UX in §4.5 of the launcher plan: pull new
    // images then `up -d` to recreate only changed containers.
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    run_in("docker", &["compose", "pull"], &dir)
        .await
        .map_err(to_error_string)?;
    run_in("docker", &["compose", "up", "-d"], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn stack_restart_container(name: String) -> Result<(), String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    // Whitelist — never let the frontend pass an arbitrary
    // container name (which would let it manipulate compose
    // services we don't own). The Auracle stack ships with a
    // fixed roster; reject anything else.
    const ALLOWED: &[&str] = &[
        "houston", "scheduler", "mcp", "jupyter", "db", "caddy",
    ];
    if !ALLOWED.contains(&name.as_str()) {
        return Err(format!("unknown container: {name}"));
    }
    run_in("docker", &["compose", "restart", &name], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn container_logs(name: String, tail: u32) -> Result<Vec<String>, String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    let tail_arg = format!("--tail={}", tail.min(2000));
    let out = run_capture_in(
        "docker",
        &["compose", "logs", "--no-color", &tail_arg, &name],
        &dir,
    )
    .await
    .map_err(to_error_string)?;
    Ok(out.lines().map(|l| l.to_string()).collect())
}

// ─── Internal subprocess helpers ────────────────────────────────────

async fn check_binary(bin: &str, args: &[&str]) -> Result<bool, String> {
    let status = Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| format!("spawning {bin}: {e}"))?;
    Ok(status.success())
}

async fn run_capture(bin: &str, args: &[&str]) -> anyhow::Result<String> {
    let out = Command::new(bin).args(args).output().await?;
    if !out.status.success() {
        anyhow::bail!(
            "{bin} {} failed (exit {:?}): {}",
            args.join(" "),
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim(),
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn run_capture_in(
    bin: &str,
    args: &[&str],
    cwd: &PathBuf,
) -> anyhow::Result<String> {
    let out = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .output()
        .await?;
    if !out.status.success() {
        anyhow::bail!(
            "{bin} {} (in {}) failed: {}",
            args.join(" "),
            cwd.display(),
            String::from_utf8_lossy(&out.stderr).trim(),
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn run_in(bin: &str, args: &[&str], cwd: &PathBuf) -> anyhow::Result<()> {
    let status = Command::new(bin)
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await?;
    if !status.success() {
        anyhow::bail!(
            "{bin} {} (in {}) failed (exit {:?})",
            args.join(" "),
            cwd.display(),
            status.code(),
        );
    }
    Ok(())
}
