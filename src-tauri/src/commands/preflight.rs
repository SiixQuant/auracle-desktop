//! Pre-flight install checks (T-02).
//!
//! Runs BEFORE `installer::run_first_install` to catch the failure
//! modes that previously surfaced as cryptic mid-install errors:
//!
//!   - Port already in use (Caddy / Postgres / Houston ports)
//!   - Insufficient disk space for Docker image pulls
//!   - Docker daemon installed but not actually responsive
//!   - No network connectivity to github.com (installer pulls from there)
//!
//! Each check returns a structured `PreflightCheck` with a level
//! (`critical` blocks install; `warning` allows but flags). The
//! frontend renders each as a green/red row + only enables the
//! "Install" button when zero criticals fail.
//!
//! Conservative on the warning side: we'd rather over-warn at install
//! time than have the customer hit a confusing failure mid-`docker
//! compose pull`. Better support outcomes either way.

use std::net::TcpListener;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use super::installer::resolve_install_path;
use super::to_error_string;

/// Per-check result. `passed=false` + `level="critical"` blocks install.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightCheck {
    pub name: String,
    pub passed: bool,
    pub level: String, // "critical" | "warning"
    pub message: String,
    pub remediation: Option<String>,
}

/// Roll-up: `can_install=true` iff every critical check passed.
/// Warnings don't block install but are surfaced to the user.
#[derive(Debug, Clone, Serialize)]
pub struct PreflightResult {
    pub can_install: bool,
    pub checks: Vec<PreflightCheck>,
}

/// Ports the Auracle stack will bind on the host. Must match the
/// `ports:` entries in the customer-facing docker-compose.yml.
///
/// 80 + 443 (Caddy reverse proxy) are the most-commonly-conflicting
/// — anyone running nginx / Apache / any local web app will collide.
/// 5432 conflicts with a local Postgres install. 1969 is unusual
/// enough to rarely conflict; 7777 + 8888 occasionally clash with
/// dev tools (Jupyter unrelated installs, etc.).
const REQUIRED_PORTS: &[u16] = &[80, 443, 1969, 5432, 7777, 8888];

/// Auracle's Docker images + initial DB + a bit of buffer.
/// Houston ~600MB, scheduler ~400MB, jupyter ~1.8GB, mcp ~150MB,
/// postgres+timescale ~300MB, caddy ~50MB → ~3.3GB images +
/// growth budget for ingested bars + audit logs.
const REQUIRED_DISK_KB: u64 = 10 * 1024 * 1024; // 10 GB in KB

#[tauri::command]
pub async fn preflight_check() -> Result<PreflightResult, String> {
    let install_path = resolve_install_path().map_err(to_error_string)?;
    let install_path_str = install_path.to_string_lossy().to_string();

    let mut checks = Vec::with_capacity(REQUIRED_PORTS.len() + 3);

    // ── Docker daemon ─────────────────────────────────────────────────
    checks.push(check_docker_daemon());

    // ── Disk space at install path ───────────────────────────────────
    checks.push(check_disk_space(&install_path_str));

    // ── Network connectivity ─────────────────────────────────────────
    checks.push(check_network().await);

    // ── Each required port ───────────────────────────────────────────
    for port in REQUIRED_PORTS {
        checks.push(check_port(*port));
    }

    let can_install = checks.iter().all(|c| c.passed || c.level != "critical");

    Ok(PreflightResult {
        can_install,
        checks,
    })
}

// ─── Individual checks ─────────────────────────────────────────────────

fn check_docker_daemon() -> PreflightCheck {
    // `docker info` returns non-zero if the daemon isn't reachable.
    // This is a stronger signal than `docker --version` (which just
    // confirms the binary is on PATH).
    let output = Command::new("docker")
        .arg("info")
        .arg("--format")
        .arg("{{.ServerVersion}}")
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            PreflightCheck {
                name: "Docker daemon".to_string(),
                passed: true,
                level: "critical".to_string(),
                message: if version.is_empty() {
                    "Docker daemon responsive.".to_string()
                } else {
                    format!("Docker daemon responsive (server v{version}).")
                },
                remediation: None,
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.lines().next().unwrap_or("(no error detail)");
            PreflightCheck {
                name: "Docker daemon".to_string(),
                passed: false,
                level: "critical".to_string(),
                message: format!("Docker is installed but the daemon isn't responding: {detail}"),
                remediation: Some(
                    "Open Docker Desktop / OrbStack / Colima and wait for the icon to turn green, then re-check."
                        .to_string(),
                ),
            }
        }
        Err(_) => PreflightCheck {
            name: "Docker daemon".to_string(),
            passed: false,
            level: "critical".to_string(),
            message: "Docker not found on PATH.".to_string(),
            remediation: Some(
                "Install Docker Desktop from https://docker.com/products/docker-desktop, then re-check."
                    .to_string(),
            ),
        },
    }
}

fn check_disk_space(install_path_str: &str) -> PreflightCheck {
    // Use the install path's parent if the path doesn't exist yet — the
    // install dir is created during install but we need to know whether
    // its filesystem has room BEFORE we start.
    let probe_path = if Path::new(install_path_str).exists() {
        install_path_str.to_string()
    } else {
        Path::new(install_path_str)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string())
    };

    // Cross-platform note: this implementation is Unix-only (df).
    // Windows install is blocked at run_first_install anyway, so
    // not handling it here. When Windows ships (T-22) add a separate
    // GetDiskFreeSpaceEx call via winapi.
    #[cfg(unix)]
    {
        let output = Command::new("df").arg("-k").arg(&probe_path).output();
        match output {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout);
                // df -k output: header line then one or two data lines.
                // The 4th column is "Available" (in KB). Some `df`s
                // wrap long device names onto a second line, in which
                // case the data starts on the next line. We pick the
                // last non-empty line and parse columns from it.
                let data_line = s.lines().rfind(|l| !l.trim().is_empty()).unwrap_or("");
                let available_kb: Option<u64> = data_line
                    .split_whitespace()
                    .nth(3)
                    .and_then(|s| s.parse().ok());

                match available_kb {
                    Some(kb) if kb >= REQUIRED_DISK_KB => PreflightCheck {
                        name: "Disk space".to_string(),
                        passed: true,
                        level: "critical".to_string(),
                        message: format!(
                            "{:.1} GB available at {} (need {:.0} GB).",
                            kb as f64 / 1024.0 / 1024.0,
                            install_path_str,
                            REQUIRED_DISK_KB as f64 / 1024.0 / 1024.0,
                        ),
                        remediation: None,
                    },
                    Some(kb) => PreflightCheck {
                        name: "Disk space".to_string(),
                        passed: false,
                        level: "critical".to_string(),
                        message: format!(
                            "Only {:.1} GB free at {} — Auracle needs at least {:.0} GB for Docker images + database growth.",
                            kb as f64 / 1024.0 / 1024.0,
                            install_path_str,
                            REQUIRED_DISK_KB as f64 / 1024.0 / 1024.0,
                        ),
                        remediation: Some(
                            "Free up space (Docker → Settings → Resources → Clean up disk space is a quick way to recover ~5 GB from old images)."
                                .to_string(),
                        ),
                    },
                    None => PreflightCheck {
                        name: "Disk space".to_string(),
                        passed: true,
                        level: "warning".to_string(),
                        message: "Couldn't parse `df` output to verify disk space.".to_string(),
                        remediation: Some(
                            "Manually verify you have at least 10 GB free on the install drive before installing."
                                .to_string(),
                        ),
                    },
                }
            }
            _ => PreflightCheck {
                name: "Disk space".to_string(),
                passed: true,
                level: "warning".to_string(),
                message: "Couldn't run `df` to check disk space.".to_string(),
                remediation: Some(
                    "Manually verify you have at least 10 GB free on the install drive."
                        .to_string(),
                ),
            },
        }
    }

    #[cfg(not(unix))]
    {
        let _ = probe_path;
        PreflightCheck {
            name: "Disk space".to_string(),
            passed: true,
            level: "warning".to_string(),
            message: "Disk-space check not yet implemented on Windows.".to_string(),
            remediation: Some(
                "Manually verify you have at least 10 GB free on the install drive.".to_string(),
            ),
        }
    }
}

async fn check_network() -> PreflightCheck {
    let client_result = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();
    let client = match client_result {
        Ok(c) => c,
        Err(e) => {
            return PreflightCheck {
                name: "Network connectivity".to_string(),
                passed: false,
                level: "warning".to_string(),
                message: format!("Couldn't construct HTTP client: {e}"),
                remediation: Some("This is unusual — restart the launcher and retry.".to_string()),
            };
        }
    };

    // Probe two places the install needs: raw.githubusercontent.com
    // (where install.sh lives) and Docker Hub (where images come from).
    // A HEAD request to github.com is sufficient — we don't actually
    // need 200, just "we can reach this host."
    match client.head("https://raw.githubusercontent.com").send().await {
        Ok(_) => PreflightCheck {
            name: "Network connectivity".to_string(),
            passed: true,
            level: "critical".to_string(),
            message: "Reachable: raw.githubusercontent.com.".to_string(),
            remediation: None,
        },
        Err(e) => PreflightCheck {
            name: "Network connectivity".to_string(),
            passed: false,
            level: "critical".to_string(),
            message: format!("Can't reach raw.githubusercontent.com: {e}"),
            remediation: Some(
                "Check your internet connection. The installer downloads scripts from GitHub and Docker images from Docker Hub — both must be reachable."
                    .to_string(),
            ),
        },
    }
}

fn check_port(port: u16) -> PreflightCheck {
    let name = format!("Port {port} availability");

    // For ports < 1024, binding may fail with PermissionDenied on
    // unprivileged processes — that doesn't mean the port is in use,
    // just that we can't test it from here. Fall back to lsof for
    // those ports so we don't show a false-positive "port in use"
    // error to the user.
    let needs_lsof = port < 1024;

    if !needs_lsof {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(_listener) => PreflightCheck {
                name,
                passed: true,
                level: "critical".to_string(),
                message: format!("Port {port} is free."),
                remediation: None,
            },
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                let occupant = identify_port_occupant(port);
                PreflightCheck {
                    name,
                    passed: false,
                    level: "critical".to_string(),
                    message: format!(
                        "Port {port} is already in use{}.",
                        occupant
                            .as_ref()
                            .map(|s| format!(" by {s}"))
                            .unwrap_or_default(),
                    ),
                    remediation: Some(format!(
                        "Stop whatever is using port {port} (try: `lsof -i :{port}` to identify it), then re-check."
                    )),
                }
            }
            Err(e) => PreflightCheck {
                name,
                passed: true,
                level: "warning".to_string(),
                message: format!("Couldn't test port {port}: {e}"),
                remediation: None,
            },
        }
    } else {
        // Privileged port — use lsof to see if anything's listening.
        match Command::new("lsof")
            .args(["-nP", "-iTCP:", "-sTCP:LISTEN"])
            .arg(format!("-iTCP:{port}"))
            .output()
        {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout);
                // lsof prints a header line + N data lines. If only the
                // header is present (or output is empty), nothing is
                // bound. Non-empty = something listening.
                let data_lines: Vec<&str> = s.lines().skip(1).filter(|l| !l.trim().is_empty()).collect();
                if data_lines.is_empty() {
                    PreflightCheck {
                        name,
                        passed: true,
                        level: "critical".to_string(),
                        message: format!("Port {port} is free."),
                        remediation: None,
                    }
                } else {
                    // First column of lsof is COMMAND
                    let occupant = data_lines[0]
                        .split_whitespace()
                        .next()
                        .unwrap_or("(unknown)")
                        .to_string();
                    PreflightCheck {
                        name,
                        passed: false,
                        level: "critical".to_string(),
                        message: format!("Port {port} is already in use by `{occupant}`."),
                        remediation: Some(format!(
                            "Stop whatever is using port {port} (try: `sudo lsof -i :{port}` for details), then re-check."
                        )),
                    }
                }
            }
            _ => PreflightCheck {
                name,
                passed: true,
                level: "warning".to_string(),
                message: format!(
                    "Couldn't check port {port} (lsof unavailable). Install may still fail if the port is in use."
                ),
                remediation: None,
            },
        }
    }
}

/// Best-effort: shell out to lsof to identify what's holding a port.
/// Falls through to `None` if lsof isn't available — the user gets a
/// less-specific message but the check still works.
fn identify_port_occupant(port: u16) -> Option<String> {
    let out = Command::new("lsof")
        .args(["-nP", "-sTCP:LISTEN"])
        .arg(format!("-iTCP:{port}"))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let first_data = s.lines().skip(1).find(|l| !l.trim().is_empty())?;
    let cmd = first_data.split_whitespace().next()?;
    Some(format!("`{cmd}`"))
}
