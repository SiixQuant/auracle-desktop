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
///
/// `runtime` distinguishes Docker Desktop / OrbStack / Colima /
/// Rancher Desktop — they all provide the `docker` CLI but their
/// install URLs / lifecycle commands differ. The frontend uses
/// this to show the right "install Docker" button per OS, OR
/// "start <runtime>" if it's installed but not running.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
    pub runtime: String, // "docker-desktop" | "orbstack" | "colima" | "rancher" | "engine" | "unknown"
    pub install_url: String, // OS+runtime-aware URL to install / start
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

/// Locate the docker binary. macOS apps launched from Finder / Dock
/// inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — Docker
/// CLI lives outside that, so a plain `Command::new("docker")` fails
/// to spawn even when Docker Desktop is installed.
///
/// Returns the first path that successfully runs `docker --version`,
/// or None when Docker really isn't installed.
pub(crate) async fn resolve_docker_bin() -> Option<String> {
    let candidates = [
        "docker", // PATH (works in dev / when launched from terminal)
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
        "/usr/bin/docker",
    ];
    for path in candidates {
        if check_binary(path, &["--version"]).await {
            return Some(path.to_string());
        }
    }
    None
}

/// Resolve docker for a stack command, mapping a missing CLI to a
/// user-facing error. Stack mutation/inspection commands run in the
/// Finder-launched app context, whose minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) omits Docker's CLI dir — so they
/// must resolve the absolute docker path the same way the status
/// probe does. Spawning a bare `docker` there fails before it can run
/// with "No such file or directory (os error 2)", which is exactly
/// what surfaced on the in-app "Update Auracle" button.
async fn docker_bin_or_err() -> Result<String, String> {
    resolve_docker_bin().await.ok_or_else(|| {
        "Docker CLI not found. Make sure Docker Desktop is installed and running, \
         then try again."
            .to_string()
    })
}

#[tauri::command]
pub async fn docker_status() -> Result<DockerStatus, String> {
    let Some(bin) = resolve_docker_bin().await else {
        return Ok(DockerStatus {
            installed: false,
            running: false,
            version: None,
            runtime: "unknown".to_string(),
            install_url: docker_install_url(),
        });
    };

    let version_out = run_capture(&bin, &["--version"])
        .await
        .map_err(to_error_string)?;
    let version = version_out.lines().next().map(|s| s.to_string());

    // `docker info` exits non-zero when the daemon is unreachable —
    // even when the CLI is installed. Use that as the running
    // signal rather than parsing `ps` or talking to the socket.
    let info_out = run_capture(
        &bin,
        &[
            "info",
            "--format",
            "{{.OperatingSystem}}|{{.ServerVersion}}",
        ],
    )
    .await;
    let running = info_out.is_ok();
    let runtime = detect_runtime(info_out.as_deref().unwrap_or(""));

    Ok(DockerStatus {
        installed: true,
        running,
        version,
        runtime,
        install_url: docker_install_url(),
    })
}

/// Inspect `docker info`'s OperatingSystem string to figure out
/// which container runtime is in use. The frontend renders the
/// right "open <X>" button per runtime instead of always saying
/// "Docker Desktop" (which is wrong for OrbStack / Colima users).
fn detect_runtime(docker_info_summary: &str) -> String {
    let s = docker_info_summary.to_ascii_lowercase();
    if s.contains("docker desktop") {
        "docker-desktop".to_string()
    } else if s.contains("orbstack") {
        "orbstack".to_string()
    } else if s.contains("colima") {
        "colima".to_string()
    } else if s.contains("rancher") {
        "rancher".to_string()
    } else if s.is_empty() {
        // CLI present but daemon unreachable — we can still guess
        // by checking for known CLI sibling binaries in PATH.
        if std::process::Command::new("orb")
            .arg("version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            "orbstack".to_string()
        } else if std::process::Command::new("colima")
            .arg("version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            "colima".to_string()
        } else {
            "unknown".to_string()
        }
    } else {
        "engine".to_string() // Linux Docker Engine, no Desktop wrapper
    }
}

/// Get the right install / start URL for the user's OS + runtime.
///
/// T-83 (2026-05-16): returns the DIRECT installer download URL
/// rather than the marketing page when possible. The launcher's
/// onboarding flow then triggers the download via the OS shell
/// (Tauri opener plugin → user's default browser), shaving the
/// "find the download button on docker.com" step from the install
/// funnel. The download landing page is still surfaced as a
/// fallback for the user to verify the source before running the
/// installer.
///
/// Architecture-aware: returns the right binary for Apple Silicon
/// vs Intel Mac via `cfg!(target_arch)`.
#[tauri::command]
pub fn docker_install_url() -> String {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            // Apple Silicon (M-series) direct DMG download — Docker
            // Desktop's official URL per
            // https://docs.docker.com/desktop/install/mac-install/
            "https://desktop.docker.com/mac/main/arm64/Docker.dmg".to_string()
        } else {
            // Intel Mac
            "https://desktop.docker.com/mac/main/amd64/Docker.dmg".to_string()
        }
    } else if cfg!(target_os = "windows") {
        // Windows 64-bit installer. Docker Desktop only supports
        // x64 + ARM64 (Windows on Apple Silicon via Parallels).
        if cfg!(target_arch = "aarch64") {
            "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe".to_string()
        } else {
            "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe".to_string()
        }
    } else {
        // Linux: prefer Docker Desktop's .deb for Ubuntu/Debian, but
        // since we can't sniff the distro reliably from Rust without
        // shell-out, fall back to the install-instructions page —
        // the user picks deb/rpm/Arch/etc.
        "https://docs.docker.com/desktop/install/linux-install/".to_string()
    }
}

/// Returns the download page (vs direct binary URL) for the OS, so
/// the launcher can surface "verify the source" alongside the direct
/// download.
#[tauri::command]
pub fn docker_install_landing_url() -> String {
    if cfg!(target_os = "linux") {
        "https://docs.docker.com/engine/install/".to_string()
    } else {
        "https://www.docker.com/products/docker-desktop/".to_string()
    }
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
    let bin = docker_bin_or_err().await?;
    let raw = run_capture_in(&bin, &["compose", "ps", "--format", "json"], &dir)
        .await
        .map_err(to_error_string)?;

    let mut containers = Vec::new();
    // Track parse failures so a corrupted/garbled `docker compose ps`
    // output (newer / older docker versions sometimes emit slightly
    // different JSON shapes, or a non-JSON warning line gets mixed in)
    // doesn't silently render an empty stack. If we fail to parse
    // even one line we log it; if EVERY line fails we surface that
    // as a hard error so the UI can show "stack status unreadable"
    // instead of "stack is empty."
    let mut total_lines = 0usize;
    let mut parse_failures = 0usize;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        total_lines += 1;
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                parse_failures += 1;
                log::warn!("stack_status: ps line parse failed: {e} on {line:?}");
                continue;
            }
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

    // If every non-empty line failed to parse AND we had at least
    // one line to parse, that's an unreadable upstream — surface
    // it instead of returning an empty container list (which the
    // frontend would render as "stack is down").
    if total_lines > 0 && parse_failures == total_lines {
        return Err(format!(
            "docker compose ps emitted {total_lines} lines, none of which parsed as JSON — \
             stack status is unreadable on this docker version. Check the launcher log \
             for the raw output."
        ));
    }
    let overall = derive_overall(&containers);
    Ok(StackStatus {
        containers,
        overall,
    })
}

fn derive_overall(containers: &[StackContainer]) -> String {
    if containers.is_empty() {
        return "down".to_string();
    }
    let any_down = containers.iter().any(|c| c.state != "running");
    let any_unhealthy = containers.iter().any(|c| c.health == "unhealthy");
    let any_starting = containers.iter().any(|c| c.health == "starting");
    if any_down || any_unhealthy {
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
    let bin = docker_bin_or_err().await?;
    run_in(&bin, &["compose", "up", "-d"], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn stack_stop() -> Result<(), String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    let bin = docker_bin_or_err().await?;
    run_in(&bin, &["compose", "down"], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn stack_pull_update() -> Result<(), String> {
    // The "update" UX in §4.5 of the launcher plan: pull new
    // images then `up -d` to recreate only changed containers.
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    let bin = docker_bin_or_err().await?;
    run_in(&bin, &["compose", "pull"], &dir)
        .await
        .map_err(to_error_string)?;
    run_in(&bin, &["compose", "up", "-d"], &dir)
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
    const ALLOWED: &[&str] = &["houston", "scheduler", "mcp", "jupyter", "db", "caddy"];
    if !ALLOWED.contains(&name.as_str()) {
        return Err(format!("unknown container: {name}"));
    }
    let bin = docker_bin_or_err().await?;
    run_in(&bin, &["compose", "restart", &name], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}
// ─── Internal subprocess helpers ────────────────────────────────────

/// Returns true iff `bin` is present AND running `bin <args>` exits 0.
///
/// Spawn failure (binary not found, permission denied, etc.) is
/// treated as "not installed" — we return false rather than
/// propagating an error. Previously this used `?` on the spawn
/// result, which caused docker_status to surface a "spawning docker"
/// error string when Docker wasn't on the launcher's restricted
/// macOS-app PATH; the frontend then never resolved its promise
/// and the Settings UI sat on "checking..." indefinitely.
async fn check_binary(bin: &str, args: &[&str]) -> bool {
    match Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
    {
        Ok(status) => status.success(),
        Err(_) => false,
    }
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

async fn run_capture_in(bin: &str, args: &[&str], cwd: &PathBuf) -> anyhow::Result<String> {
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
