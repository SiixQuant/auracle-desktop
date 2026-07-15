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

use std::path::{Path, PathBuf};
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
    // Never recreate a stack a different working_dir already owns under our
    // project name (a dev checkout at ~/Downloads/auracle). Adopt it instead.
    ensure_home_unclaimed(&bin, &dir).await?;
    run_in(&bin, &["compose", "up", "-d"], &dir)
        .await
        .map_err(to_error_string)?;
    Ok(())
}

#[tauri::command]
pub async fn stack_stop() -> Result<(), String> {
    let dir = installer::resolve_install_path().map_err(to_error_string)?;
    let bin = docker_bin_or_err().await?;
    // Don't tear down a stack we don't manage — a dev checkout sharing our
    // project name would otherwise be `compose down`ed from under the user.
    ensure_home_unclaimed(&bin, &dir).await?;
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
    // This is the "Update Auracle" path that clobbered the dev stack in
    // production. Refuse to pull+recreate over a foreign stack under our name.
    ensure_home_unclaimed(&bin, &dir).await?;
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
    // Only restart containers in a stack we manage — not a dev checkout that
    // happens to hold our project name.
    ensure_home_unclaimed(&bin, &dir).await?;
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

// ─── Stack-collision guard ──────────────────────────────────────────────
//
// The launcher manages a Docker Compose stack in its engine home
// (`installer::resolve_install_path()`, default `~/auracle`). Compose derives
// the *project name* from that directory's basename — `auracle` — which is
// the SAME name a developer's own checkout at e.g. `~/Downloads/auracle`
// resolves to. The project name is the identity Compose uses for a stack, so
// a `compose up` / `pull` the launcher runs from `~/auracle` RECREATES the
// dev stack's containers (and re-points its named volumes) using the launcher
// home's compose file + `.env` — a different POSTGRES_PASSWORD, none of the
// dev-only mounts/overrides — downing a running engine. This happened in
// production: opening the workspace fired the engine-start path and clobbered
// the dev stack three times.
//
// Guard: before any *mutating* compose command, ask Docker which working_dir
// currently owns our project name. If it's a DIFFERENT directory than our
// engine home, a foreign stack is live under our name — ADOPT it (skip the
// mutation, tell the user the engine is already running from <path>) rather
// than clobber it. A fresh machine (nothing owns the name) proceeds, so
// first-run provisioning is unchanged. Fails SAFE: if Docker is installed but
// its state can't be read (daemon down), abort rather than recreate blind.
//
// Escape hatch (option B): point the launcher at the dev checkout by setting
// `AURACLE_INSTALL_DIR=/path/to/checkout` — the working_dir then matches the
// engine home, the guard sees "ours", and the launcher co-manages it.
//
// Rejected (option C): a distinct project name (`-p auracle-launcher`) for
// launcher installs. A rename orphans the EXISTING `auracle` named volumes
// (Postgres data, ingested bars, audit logs) for the whole installed base —
// so it's only safe for genuinely fresh installs and is left to the install
// pipeline, not retrofitted here where it would silently abandon customer data.

/// Compose sanitizes a project name to `[a-z0-9_-]`, lowercased, with any
/// leading non-alphanumeric characters stripped. Replicated so we can ask
/// Docker for the exact project name a `compose` command from a directory
/// would use. Pure — unit-tested.
fn normalize_compose_name(basename: &str) -> String {
    let kept: String = basename
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    // Compose requires the first character to be a lowercase letter or digit.
    kept.trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_string()
}

/// The Compose project name a stack command run from `home` operates on:
/// `COMPOSE_PROJECT_NAME` when set, else the normalized basename of `home`.
fn project_name_for(home: &Path) -> String {
    if let Ok(name) = std::env::var("COMPOSE_PROJECT_NAME") {
        let name = name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    let base = home
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    normalize_compose_name(&base)
}

/// Canonicalize a directory for comparison, tolerating a path that no longer
/// exists on disk (fall back to a trailing-slash-trimmed lexical form). Both
/// sides of a comparison go through this, so symlink resolution is consistent.
fn canonical_dir(p: &Path) -> String {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string_lossy().trim_end_matches('/').to_string())
}

/// Given the stdout of `docker ps … --format '{{.Label "…working_dir"}}'`
/// and our engine home, return the first working_dir that ISN'T our home —
/// i.e. a foreign stack holding our project name. Pure — unit-tested.
fn first_foreign_working_dir(ps_stdout: &str, home: &Path) -> Option<String> {
    let home_canon = canonical_dir(home);
    ps_stdout
        .lines()
        .map(str::trim)
        .filter(|wd| !wd.is_empty())
        .find(|wd| canonical_dir(Path::new(wd)) != home_canon)
        .map(str::to_string)
}

/// User-facing message when a foreign stack owns our Compose project name.
fn foreign_stack_message(foreign_dir: &str, home: &Path) -> String {
    format!(
        "The Auracle engine is already running from {foreign_dir}, which this \
         launcher doesn't manage (it manages {}). Leaving it running instead of \
         recreating it — open the workspace to use the engine that's already up. \
         To have the launcher manage that install, set AURACLE_INSTALL_DIR to it \
         and reopen the launcher.",
        home.display()
    )
}

/// Query Docker for the working_dir of any container currently holding the
/// Compose project name our stack commands use from `home`. Returns:
/// - `Ok(None)` when no foreign stack owns the name (unclaimed, or the running
///   stack is our own) — safe to proceed.
/// - `Ok(Some(path))` when a DIFFERENT working_dir owns our project name.
/// - `Err(msg)` when Docker state couldn't be read (daemon down / command
///   failed) — the caller must fail safe.
///
/// `bin` is a resolved docker path. Uses `ps -a` so a *stopped* foreign stack
/// (containers present but not running) is caught too — `up` would otherwise
/// recreate it.
async fn foreign_stack_working_dir(bin: &str, home: &Path) -> Result<Option<String>, String> {
    let project = project_name_for(home);
    if project.is_empty() {
        // No derivable project name — can't reason about a collision; let the
        // normal command path proceed.
        return Ok(None);
    }
    let out = Command::new(bin)
        .args([
            "ps",
            "-a",
            "--filter",
            &format!("label=com.docker.compose.project={project}"),
            "--format",
            "{{.Label \"com.docker.compose.project.working_dir\"}}",
        ])
        .output()
        .await
        .map_err(|e| format!("couldn't run Docker to check for a running Auracle stack: {e}"))?;
    if !out.status.success() {
        // Docker CLI present but state unreadable (usually the daemon isn't
        // running). Fail safe — don't recreate blind.
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "couldn't read Docker's state to make sure the launcher won't clobber \
             another Auracle stack ({}). Start Docker and try again.",
            stderr.lines().next().unwrap_or("unknown error").trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(first_foreign_working_dir(&stdout, home))
}

/// Guard a mutating compose command that runs from `home` against clobbering a
/// foreign stack. `bin` is an already-resolved docker path. `Ok(())` = safe to
/// proceed; `Err` = adopt (a foreign stack owns the name) or fail-safe (state
/// unreadable). The Err string is user-facing.
async fn ensure_home_unclaimed(bin: &str, home: &Path) -> Result<(), String> {
    match foreign_stack_working_dir(bin, home).await? {
        Some(foreign) => Err(foreign_stack_message(&foreign, home)),
        None => Ok(()),
    }
}

/// Same guard for callers that don't already hold a resolved docker path (the
/// tray restart handler, the first-install bootstrap). Resolves docker itself;
/// if Docker isn't installed at all there can be no running stack to clobber,
/// so it's a no-op.
pub(crate) async fn ensure_engine_home_unclaimed(home: &Path) -> Result<(), String> {
    match resolve_docker_bin().await {
        Some(bin) => ensure_home_unclaimed(&bin, home).await,
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_compose_name_matches_compose_rules() {
        // The real case: `~/auracle` and `~/Downloads/auracle` both normalize
        // to the same project name — which is exactly why they collide.
        assert_eq!(normalize_compose_name("auracle"), "auracle");
        assert_eq!(normalize_compose_name("Auracle"), "auracle");
        // Non-[a-z0-9_-] stripped; leading non-alphanumerics trimmed.
        assert_eq!(normalize_compose_name("My.Stack!"), "mystack");
        assert_eq!(normalize_compose_name("_leading"), "leading");
        assert_eq!(normalize_compose_name("123abc"), "123abc");
        assert_eq!(normalize_compose_name("---"), "");
    }

    #[test]
    fn foreign_dir_detected_when_working_dir_differs() {
        // Use a definitely-nonexistent root so canonicalize fails on both
        // sides and the lexical fallback governs — deterministic on any host.
        let home = Path::new("/nonexistent-auracle-test/home/auracle");
        let ps = "/nonexistent-auracle-test/downloads/auracle\n";
        assert_eq!(
            first_foreign_working_dir(ps, home).as_deref(),
            Some("/nonexistent-auracle-test/downloads/auracle"),
        );
    }

    #[test]
    fn our_own_stack_is_not_foreign() {
        let home = Path::new("/nonexistent-auracle-test/home/auracle");
        // Same dir (plus a stray trailing slash / blank line) → not foreign.
        let ps = "\n/nonexistent-auracle-test/home/auracle/\n";
        assert_eq!(first_foreign_working_dir(ps, home), None);
    }

    #[test]
    fn no_containers_means_free() {
        let home = Path::new("/nonexistent-auracle-test/home/auracle");
        assert_eq!(first_foreign_working_dir("", home), None);
        assert_eq!(first_foreign_working_dir("\n  \n", home), None);
    }

    #[test]
    fn mixed_rows_reports_first_foreign() {
        // Ours first, then a foreign row → still flags the foreign one.
        let home = Path::new("/nonexistent-auracle-test/home/auracle");
        let ps = "/nonexistent-auracle-test/home/auracle\n/nonexistent-auracle-test/elsewhere/auracle\n";
        assert_eq!(
            first_foreign_working_dir(ps, home).as_deref(),
            Some("/nonexistent-auracle-test/elsewhere/auracle"),
        );
    }
}
