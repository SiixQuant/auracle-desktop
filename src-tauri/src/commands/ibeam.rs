//! ibeam supervisor — auto-managed IBKR Client Portal Gateway.
//!
//! Background: IBKR's Client Portal Gateway enforces a ~24-hour
//! session timeout that requires interactive re-login + 2FA. There
//! is no permanent API key on retail IBKR accounts; this is by
//! IBKR's design. The de-facto solution everyone uses is `ibeam`
//! (https://github.com/voyz/ibeam) — an open-source Docker image
//! that wraps the gateway with a Selenium-driven auto-login loop:
//!
//!   * Stores IBKR credentials + reads them on every re-auth.
//!   * Handles 2FA when the user has IBKR Mobile push enabled
//!     (user taps "Approve" once on first launch; subsequent
//!     re-auths use the cached cookie until IBKR forces a fresh
//!     2FA challenge).
//!   * Restarts the gateway after the daily ~5pm ET reset window.
//!   * Exposes the same `localhost:5000` REST surface our
//!     broker_bridge.rs already talks to — no client changes needed.
//!
//! This module is the launcher's supervisor for that container:
//!
//!   * Probes whether the container exists / is running / is healthy
//!     via `docker compose ps`.
//!   * Stages a tiny `docker-compose.yml` + `.env` under
//!     ~/auracle/ibeam/ (sibling to the main Auracle stack).
//!   * Stores IBKR credentials in the Stronghold vault — the
//!     compose `.env` is written with placeholders and the real
//!     values are injected at start time via `--env-file` from a
//!     short-lived tempfile that gets cleaned up post-start.
//!   * Owns start / stop / restart / logs commands the frontend
//!     drives.
//!
//! Why a separate compose project instead of folding into ~/auracle/:
//!
//!   Two reasons. (1) ibeam can be installed without the rest of the
//!   Auracle Docker stack — useful for users who only want the
//!   Forge surface and connect IBKR directly without the local
//!   research stack. (2) Decoupled lifecycle: `docker compose up`
//!   in ~/auracle/ shouldn't touch the broker session, and vice
//!   versa.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command;

use super::{secret_store, to_error_string};

const IBEAM_DIR: &str = "ibeam";
const IBEAM_COMPOSE_FILE: &str = "docker-compose.yml";
const IBEAM_CONTAINER: &str = "auracle-ibeam";
const IBEAM_IMAGE: &str = "voyz/ibeam:latest";

/// Vault slots — stored under the existing Stronghold secret store
/// (commit 6e13902) alongside the Anthropic key. Each prefixed so
/// we can rotate or extend the credential set later without
/// colliding with adjacent secrets.
const KEY_IBKR_USERNAME: &str = "ibkr_username";
const KEY_IBKR_PASSWORD: &str = "ibkr_password";
const KEY_IBKR_ACCOUNT: &str = "ibkr_account_id";
const KEY_IBKR_TRADING_MODE: &str = "ibkr_trading_mode"; // "paper" | "live"

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum IbeamState {
    /// docker-compose.yml hasn't been written yet — user needs to run setup.
    NotInstalled,
    /// Compose project exists but container isn't running.
    Stopped { reason: String },
    /// Container is up; gateway should be reachable at localhost:5000.
    /// `auth_ok` indicates whether /iserver/auth/status returned
    /// authenticated=true on the most recent probe.
    Running { auth_ok: bool },
    /// Docker isn't reachable — can't probe.
    DockerUnavailable { detail: String },
    /// Anything else (image pull mid-flight, container CrashLoopBackoff, etc.)
    /// Reserved for future probes that distinguish these from a plain
    /// stopped container.
    #[allow(dead_code)]
    Other { detail: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct IbeamStatus {
    pub state: IbeamState,
    /// Path to the compose project on disk. Useful for the
    /// "advanced: edit docker-compose.yml directly" escape hatch.
    pub compose_dir: String,
    /// True when all four credential slots are populated. We can
    /// show the user a different setup CTA depending on whether
    /// they've already entered credentials or not.
    pub has_credentials: bool,
}

/// Credential shape the user provides at setup: IBKR username +
/// password + the declared trading mode (paper vs live). Trading mode
/// is NOT auto-detected — the gateway login depends on it, so the user
/// must declare it; it defaults to paper.
#[derive(Debug, Deserialize)]
pub struct IbeamCredentials {
    pub username: String,
    pub password: String,
    /// "paper" | "live" — which IBKR environment the gateway authenticates
    /// against (drives IBEAM_TRADING_MODE). Safe default is paper; the
    /// user declares it at setup. It CANNOT be auto-detected before login
    /// because the login itself depends on the mode.
    #[serde(default = "default_trading_mode")]
    pub trading_mode: String,
}

fn default_trading_mode() -> String {
    "paper".to_string()
}

/// Coerce any user/cached value to exactly "paper" or "live" — anything
/// unrecognized falls back to the safe "paper" (never silently live).
fn normalize_trading_mode(raw: &str) -> &'static str {
    if raw.trim().eq_ignore_ascii_case("live") {
        "live"
    } else {
        "paper"
    }
}

fn auracle_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME env var not set".to_string())?;
    Ok(PathBuf::from(home).join("auracle"))
}

fn ibeam_dir() -> Result<PathBuf, String> {
    Ok(auracle_root()?.join(IBEAM_DIR))
}

/// Read the stored credentials. None if username or password is missing.
/// Trading mode is read from its own vault slot (defaulting to the safe
/// "paper" if unset) so a restart always feeds the gateway the mode the
/// user declared at setup.
async fn read_credentials(app: &AppHandle) -> Result<Option<IbeamCredentials>, String> {
    let username = secret_store::get(app, KEY_IBKR_USERNAME)?;
    let password = secret_store::get(app, KEY_IBKR_PASSWORD)?;
    let trading_mode =
        secret_store::get(app, KEY_IBKR_TRADING_MODE)?.unwrap_or_else(|| "paper".to_string());
    match (username, password) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => Ok(Some(IbeamCredentials {
            username: u,
            password: p,
            trading_mode: normalize_trading_mode(&trading_mode).to_string(),
        })),
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn ibeam_status(app: AppHandle) -> Result<IbeamStatus, String> {
    let dir = ibeam_dir()?;
    let compose_path = dir.join(IBEAM_COMPOSE_FILE);
    let has_credentials = read_credentials(&app).await?.is_some();

    if !compose_path.exists() {
        return Ok(IbeamStatus {
            state: IbeamState::NotInstalled,
            compose_dir: dir.to_string_lossy().to_string(),
            has_credentials,
        });
    }

    // Probe container state via `docker compose ps --format json`.
    // We pin --project-name so multiple compose projects in adjacent
    // dirs don't collide.
    let ps = Command::new("docker")
        .arg("compose")
        .arg("--project-name")
        .arg(IBEAM_CONTAINER)
        .arg("--project-directory")
        .arg(&dir)
        .arg("ps")
        .arg("--format")
        .arg("json")
        .output()
        .await
        .map_err(|e| format!("docker compose ps spawn failed: {e}"))?;

    if !ps.status.success() {
        let stderr = String::from_utf8_lossy(&ps.stderr);
        return Ok(IbeamStatus {
            state: IbeamState::DockerUnavailable {
                detail: stderr.trim().to_string(),
            },
            compose_dir: dir.to_string_lossy().to_string(),
            has_credentials,
        });
    }

    let stdout = String::from_utf8_lossy(&ps.stdout);
    // `docker compose ps --format json` emits one JSON object per line
    // (newer Docker) OR a JSON array (older). Handle both.
    let containers: Vec<serde_json::Value> = if stdout.trim_start().starts_with('[') {
        serde_json::from_str(&stdout).unwrap_or_default()
    } else {
        stdout
            .lines()
            .filter_map(|l| {
                let t = l.trim();
                if t.is_empty() {
                    None
                } else {
                    serde_json::from_str(t).ok()
                }
            })
            .collect()
    };

    let running_container = containers.iter().find(|c| {
        c.get("State")
            .and_then(|s| s.as_str())
            .map(|s| s.eq_ignore_ascii_case("running"))
            .unwrap_or(false)
    });

    if running_container.is_none() {
        let reason = containers
            .first()
            .and_then(|c| c.get("State").and_then(|s| s.as_str()))
            .unwrap_or("not started")
            .to_string();
        return Ok(IbeamStatus {
            state: IbeamState::Stopped { reason },
            compose_dir: dir.to_string_lossy().to_string(),
            has_credentials,
        });
    }

    // Container running — check whether ibeam's wrapped gateway is
    // actually serving + authenticated. Reuses the same probe the
    // broker_connections module does so the state matches what the
    // Settings card shows.
    let auth_ok = probe_auth_status().await.unwrap_or(false);

    Ok(IbeamStatus {
        state: IbeamState::Running { auth_ok },
        compose_dir: dir.to_string_lossy().to_string(),
        has_credentials,
    })
}

async fn probe_auth_status() -> Result<bool, ()> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|_| ())?;
    let resp = client
        .post("https://localhost:5000/v1/api/iserver/auth/status")
        .send()
        .await
        .map_err(|_| ())?;
    if !resp.status().is_success() {
        return Ok(false);
    }
    let v: serde_json::Value = resp.json().await.map_err(|_| ())?;
    Ok(v.get("authenticated").and_then(|x| x.as_bool()) == Some(true))
}

/// Store credentials + write the compose project to disk.
/// Idempotent: running this twice updates the credentials in
/// the vault and re-writes the compose file.
#[tauri::command]
pub async fn ibeam_install(app: AppHandle, creds: IbeamCredentials) -> Result<(), String> {
    if creds.username.is_empty() || creds.password.is_empty() {
        return Err("username and password are both required".to_string());
    }

    // Persist credentials to the vault BEFORE writing the compose
    // file — if vault writes fail, we don't want a half-installed
    // state with a compose file pointing at empty env vars.
    secret_store::put(&app, KEY_IBKR_USERNAME, &creds.username)?;
    secret_store::put(&app, KEY_IBKR_PASSWORD, &creds.password)?;
    // The user declares paper vs live at setup (the login depends on it,
    // so it can't be auto-detected first). Normalize to a safe value and
    // cache it; write_env_file feeds it to the gateway via
    // IBEAM_TRADING_MODE so a live account isn't silently run on paper.
    secret_store::put(
        &app,
        KEY_IBKR_TRADING_MODE,
        normalize_trading_mode(&creds.trading_mode),
    )?;

    let dir = ibeam_dir()?;
    std::fs::create_dir_all(&dir).map_err(to_error_string)?;
    let inputs_dir = dir.join("inputs");
    std::fs::create_dir_all(&inputs_dir).map_err(to_error_string)?;

    let compose_yml = compose_template();
    std::fs::write(dir.join(IBEAM_COMPOSE_FILE), compose_yml).map_err(to_error_string)?;

    // README so a user who SSHes in and finds this directory has
    // context about what it is + how to manage it manually.
    std::fs::write(dir.join("README.md"), readme_template()).map_err(to_error_string)?;

    Ok(())
}

/// RAII guard for the credential tempfile. Removes the file on Drop
/// no matter how the surrounding function exits (success, early Err,
/// panic). The previous pattern relied on a manually-placed
/// `remove_file` call at the end of `ibeam_start` plus a duplicate
/// in the one early-return branch, which left two-plus uncovered
/// failure paths (panics, future early returns) where the plaintext
/// IBKR credential file would persist in /tmp until the OS cleared
/// it. Wrapping the path in a Drop type makes that class of bug
/// impossible to reintroduce.
struct CredEnvFile {
    path: PathBuf,
}

impl Drop for CredEnvFile {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_file(&self.path) {
            // Don't fail the parent op for a cleanup failure — but
            // log it so an operator triaging "tempfile growing"
            // alerts has a thread to pull.
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!(
                    "ibeam: credential tempfile cleanup failed at {:?}: {e}",
                    self.path
                );
            }
        }
    }
}

/// Start (or recreate) the ibeam container. Credentials are injected
/// at start time via `--env-file` pointing at a tempfile so they
/// never land on disk in plaintext under the project dir.
///
/// Atomic port-conflict handling: if the user has the Auracle stack
/// running with its bundled IBKR gateway (`auracle-cpgateway` /
/// `auracle-ibgateway`) bound to port 5000, ibeam's `up -d` will
/// fail with `bind: address already in use`. Rather than punting
/// to the user, we detect the conflict, stop + remove the
/// conflicting container via `docker compose rm -sf`, then retry
/// once. The user sees a single "Start" click do the right thing.
#[tauri::command]
pub async fn ibeam_start(app: AppHandle) -> Result<(), String> {
    let dir = ibeam_dir()?;
    if !dir.join(IBEAM_COMPOSE_FILE).exists() {
        return Err("ibeam isn't installed — run ibeam_install first".to_string());
    }
    let creds = read_credentials(&app)
        .await?
        .ok_or_else(|| "ibeam credentials aren't set — run ibeam_install first".to_string())?;

    // Wrap the tempfile path in the RAII guard immediately on
    // creation. Every return path below — including the early-Err
    // branch when free_competing_gateway fails, and any future
    // refactor that adds another early return — gets cleanup for
    // free via Drop.
    let env_guard = CredEnvFile {
        path: write_env_file(&creds)?,
    };
    let env_path = &env_guard.path;

    // First try.
    let first = run_compose(&dir, &["up", "-d", "--remove-orphans"], Some(env_path)).await;

    match first {
        Ok(()) => Ok(()),
        Err(err) if err.contains("address already in use") || err.contains("port is already") => {
            // Port collision — almost always the Auracle stack's
            // bundled cpgateway/ibgateway container. Try to free
            // the port + retry once.
            log::info!("ibeam_start: port 5000 in use, attempting to free competing container");
            if let Err(free_err) = free_competing_gateway().await {
                return Err(format!(
                    "Port 5000 is held by another container and couldn't be freed automatically: {free_err}. \
                     Stop the container manually and try again."
                ));
            }
            // Brief pause for the kernel to release the port —
            // docker's "container removed" event fires before the
            // listening socket actually goes away.
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            run_compose(&dir, &["up", "-d", "--remove-orphans"], Some(env_path)).await
        }
        Err(other) => Err(other),
    }
    // env_guard drops here on every path → tempfile removed.
}

/// Look for the Auracle stack's bundled IBKR gateway containers and
/// `docker rm -sf` the first one we find. Best-effort; if nothing is
/// running with that name we return Ok (the port might be held by
/// something else entirely, in which case the user needs to handle
/// it manually).
async fn free_competing_gateway() -> Result<(), String> {
    const COMPETING: &[&str] = &[
        "auracle-cpgateway",
        "auracle-ibgateway",
        "cpgateway",
        "ibgateway",
    ];
    let out = Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .output()
        .await
        .map_err(|e| format!("docker ps spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "docker ps failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let running: std::collections::HashSet<&str> = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    for name in COMPETING {
        if running.contains(name) {
            log::info!("ibeam_start: removing competing container {name}");
            // `docker rm -f` is stop + force-remove for a running
            // container in one call. `-sf` was wrong — that's a
            // `docker compose rm` flag combo, not a `docker rm` one.
            let result = Command::new("docker")
                .args(["rm", "-f", name])
                .output()
                .await
                .map_err(|e| format!("docker rm spawn: {e}"))?;
            if !result.status.success() {
                let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
                // Already gone is fine — that's the goal state.
                if !stderr.contains("No such container") {
                    return Err(format!("docker rm -f {name}: {stderr}"));
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ibeam_stop() -> Result<(), String> {
    let dir = ibeam_dir()?;
    run_compose(&dir, &["down"], None).await
}

#[tauri::command]
pub async fn ibeam_restart(app: AppHandle) -> Result<(), String> {
    ibeam_stop().await?;
    ibeam_start(app).await
}

#[tauri::command]
pub async fn ibeam_logs(lines: Option<u32>) -> Result<String, String> {
    let dir = ibeam_dir()?;
    let lines = lines.unwrap_or(200).clamp(1, 5000);
    let output = Command::new("docker")
        .arg("compose")
        .arg("--project-name")
        .arg(IBEAM_CONTAINER)
        .arg("--project-directory")
        .arg(&dir)
        .arg("logs")
        .arg("--no-color")
        .arg("--tail")
        .arg(lines.to_string())
        .output()
        .await
        .map_err(|e| format!("docker compose logs spawn failed: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok(combined)
}

#[tauri::command]
pub async fn ibeam_uninstall(app: AppHandle) -> Result<(), String> {
    // Stop + remove containers first so we don't leave a stale one
    // referencing a freshly-deleted compose file.
    let dir = ibeam_dir()?;
    if dir.join(IBEAM_COMPOSE_FILE).exists() {
        let _ = run_compose(&dir, &["down", "--volumes"], None).await;
        let _ = std::fs::remove_file(dir.join(IBEAM_COMPOSE_FILE));
        let _ = std::fs::remove_file(dir.join("README.md"));
        let _ = std::fs::remove_dir_all(dir.join("inputs"));
        let _ = std::fs::remove_dir(&dir); // only succeeds if empty
    }
    // Clear vault slots. Best-effort — credential removal is the
    // explicit ask; if a slot was empty already that's fine.
    let _ = secret_store::delete(&app, KEY_IBKR_USERNAME);
    let _ = secret_store::delete(&app, KEY_IBKR_PASSWORD);
    let _ = secret_store::delete(&app, KEY_IBKR_ACCOUNT);
    let _ = secret_store::delete(&app, KEY_IBKR_TRADING_MODE);
    Ok(())
}

// ── helpers ──────────────────────────────────────────────────────

async fn run_compose(dir: &Path, args: &[&str], env_file: Option<&Path>) -> Result<(), String> {
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .arg("--project-name")
        .arg(IBEAM_CONTAINER)
        .arg("--project-directory")
        .arg(dir);
    if let Some(env_path) = env_file {
        cmd.arg("--env-file").arg(env_path);
    }
    for a in args {
        cmd.arg(a);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("docker compose {} spawn failed: {e}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "docker compose {} failed: {}",
            args.join(" "),
            stderr.trim()
        ));
    }
    Ok(())
}

/// Write the credentials to a 0600 tempfile in env-file format,
/// return its path. Caller is responsible for deleting the file
/// after docker has read it.
fn write_env_file(creds: &IbeamCredentials) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir();
    // Random-ish suffix so concurrent starts don't collide. PID +
    // nanos is plenty — these files live for milliseconds.
    let suffix = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let path = dir.join(format!("auracle-ibeam-env-{suffix}"));
    // Account + password + the declared trading mode. Writing
    // IBEAM_TRADING_MODE explicitly (rather than letting compose default
    // it to "paper") is what keeps a live account from being silently
    // run against the paper gateway.
    let contents = format!(
        "IBEAM_ACCOUNT={}\n\
         IBEAM_PASSWORD={}\n\
         IBEAM_TRADING_MODE={}\n",
        creds.username,
        creds.password,
        normalize_trading_mode(&creds.trading_mode),
    );
    std::fs::write(&path, contents).map_err(to_error_string)?;
    // Tighten perms on unix — Windows has different ACL semantics
    // and the tempdir there is already user-scoped.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(to_error_string)?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms).map_err(to_error_string)?;
    }
    Ok(path)
}

/// docker-compose.yml content. Pinned to the official ibeam image
/// (which itself pulls + wraps the IBKR Client Portal Gateway).
/// Health endpoint exposed on 5001 so we can probe ibeam's own
/// readiness independently of the gateway's auth state.
fn compose_template() -> String {
    format!(
        r#"# Auto-generated by Auracle Desktop. Edits will be preserved on
# subsequent installs, but DELETION is destructive — uninstall via
# Settings → Broker Connections → Disconnect.
#
# What this runs: voyz/ibeam (https://github.com/voyz/ibeam), an
# auto-login wrapper around the IBKR Client Portal Gateway.
# Maintains a persistent IBKR session by re-authing whenever the
# gateway's daily session expires.
#
# 2FA: requires IBKR Mobile push notifications. Approve the first
# push that lands on your phone after this container starts;
# subsequent re-auths use the cached cookie until IBKR forces a
# fresh challenge.

services:
  ibeam:
    image: {IBEAM_IMAGE}
    container_name: {IBEAM_CONTAINER}
    restart: unless-stopped
    ports:
      # REST gateway + health
      - "5000:5000"
      - "5001:5001"
    environment:
      IBEAM_ACCOUNT: ${{IBEAM_ACCOUNT}}
      IBEAM_PASSWORD: ${{IBEAM_PASSWORD}}
      IBEAM_TRADING_MODE: ${{IBEAM_TRADING_MODE:-paper}}
      # Health server lets us probe ibeam's own readiness without
      # going through the gateway. Bound to 5001 above.
      IBEAM_HEALTH_SERVER_PORT: "5001"
      # Don't kill the gateway during the daily IBKR reset — let
      # ibeam handle the reauth cycle. Without this the container
      # would exit at ~5pm ET and rely on docker's restart policy
      # to bring it back; the inline reauth path is smoother.
      IBEAM_RESTART_FAILED_SESSIONS: "true"
      # Verbose logs so `ibeam_logs` is useful during setup
      # troubleshooting. Drop to INFO once the user is comfortable.
      IBEAM_LOG_LEVEL: "DEBUG"
    volumes:
      # ibeam looks here for any user-supplied config overrides
      # (e.g. custom 2FA handler scripts). Empty by default.
      - ./inputs:/srv/inputs:ro
    healthcheck:
      test: ["CMD", "curl", "-fk", "https://localhost:5001/healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 90s
"#
    )
}

fn readme_template() -> String {
    r#"# Auracle ibeam

This directory holds the docker-compose project for the auto-managed
IBKR Client Portal Gateway. It was generated by Auracle Desktop —
the launcher's "Set up persistent connection" flow under
Settings → Broker Connections.

## What this is

- A Docker container running [ibeam](https://github.com/voyz/ibeam),
  which wraps the IBKR Client Portal Gateway with auto-login + 2FA
  handling so the localhost:5000 REST endpoint stays up indefinitely.

## Manual management

The Auracle Desktop UI is the supported control surface. If you need
to operate this manually:

```
docker compose --project-name auracle-ibeam --project-directory .. up -d
docker compose --project-name auracle-ibeam --project-directory .. logs -f
docker compose --project-name auracle-ibeam --project-directory .. down
```

## Credentials

Credentials are stored in the launcher's encrypted Stronghold vault
(NOT in any file in this directory). They're injected into the
container as env vars only at start time via `--env-file` pointing
at a short-lived 0600 tempfile that's deleted post-start.

To rotate: re-run the setup flow in Settings → Broker Connections.

## Removing

Use Settings → Broker Connections → Disconnect (under the auto-managed
state). That stops the container, deletes the compose file, and
purges the vault credential slots.
"#
    .to_string()
}
