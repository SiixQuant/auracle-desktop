//! "Sign in with GitHub" via the OAuth **device flow** — onboarding
//! connect loop W2.
//!
//! This is the user's OWN GitHub, used purely so `git push`/`pull` is
//! authenticated everywhere (the IDE's terminal, the integrated git,
//! and any plain shell). It is deliberately unrelated to the IDE's own
//! account / collab sign-in — we never touch that.
//!
//! Why the device flow (and not a redirect/PKCE flow): the launcher has
//! no web server to receive a redirect, and a desktop app can't keep a
//! client secret. The device flow is GitHub's blessed path for exactly
//! this shape — the app shows a short user code, the user types it into
//! github.com/login/device in their browser, and we poll for the token.
//!
//! TOKEN HANDLING (the security-critical part):
//!   * The access token is handed straight to the system git credential
//!     helper (`git credential approve`), which on macOS routes to
//!     osxkeychain. We NEVER write the token to a file we create, never
//!     log it, never put it in an error string, and never return it to
//!     the frontend. Only the resolved `login` ever crosses the IPC
//!     boundary.
//!   * The device-flow responses also carry secrets (`device_code`,
//!     `access_token`); we never log those response bodies either.
//!
//! NOT-CONFIGURED PATH: the client_id is compiled in from
//! `AURACLE_GITHUB_CLIENT_ID` at build time (the owner sets it for
//! release builds). When it's empty the commands degrade honestly —
//! `github_auth_status().configured` is false and `github_device_start`
//! returns a plain "not configured" error — rather than fabricating a
//! flow that can't complete.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::to_error_string;

/// Public OAuth device-flow client_id, injected at build time by the
/// owner (`AURACLE_GITHUB_CLIENT_ID`). Device-flow client_ids are not
/// secret (the flow is designed for clients that can't keep a secret),
/// so compiling it in is fine. Empty in dev / unconfigured builds →
/// every command degrades honestly instead of guessing.
const GITHUB_CLIENT_ID: &str = match option_env!("AURACLE_GITHUB_CLIENT_ID") {
    Some(v) => v,
    None => "",
};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_API_URL: &str = "https://api.github.com/user";
/// GitHub's REST API rejects requests without a User-Agent. Use a stable
/// product token so the call is identifiable.
const USER_AGENT: &str = "Auracle";
/// Scopes the launcher requests: repo access for push/pull + read:user
/// so we can resolve and display the signed-in login.
const DEVICE_SCOPE: &str = "repo read:user";
const HTTP_TIMEOUT_SECS: u64 = 15;

// ── Returned shapes ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct GithubAuthStatus {
    /// True iff a non-empty client_id is compiled into this build.
    pub configured: bool,
    /// True iff a github.com https credential already exists (the user
    /// is signed in for git). Conservative: false when we can't prove it.
    pub connected: bool,
    /// The stored git username for github.com, when the credential
    /// helper reports one.
    pub login: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubDeviceStart {
    /// Short code the user types into the verification page (e.g. ABCD-1234).
    pub user_code: String,
    /// The page the user opens to enter the code (github.com/login/device).
    pub verification_uri: String,
    /// Opaque code the caller passes back to `github_device_poll`. Treated
    /// as a secret — never logged.
    pub device_code: String,
    /// Minimum seconds the caller must wait between polls.
    pub interval: u64,
    /// Seconds until the device/user code pair expires.
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubDevicePoll {
    /// "pending" (keep polling), "authorized" (done — `login` is set), or
    /// "error" (the flow failed/expired/was denied — caller offers retry).
    pub status: String,
    /// The signed-in GitHub login, present only on "authorized".
    pub login: Option<String>,
}

// ── Raw GitHub response shapes (never logged) ───────────────────────

#[derive(serde::Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(serde::Deserialize)]
struct AccessTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(serde::Deserialize)]
struct GithubUser {
    #[serde(default)]
    login: Option<String>,
}

// ── Helpers ─────────────────────────────────────────────────────────

fn is_configured() -> bool {
    !GITHUB_CLIENT_ID.is_empty()
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(to_error_string)
}

/// Ask the system git credential helper whether a github.com https
/// credential exists, via `git credential fill`. We feed only the host
/// (no password) on stdin; a configured helper fills in `username` /
/// `password` if it has a stored credential. We read `username` for the
/// `login` and treat "password present" as connected — but we NEVER
/// return, log, or otherwise surface that password.
///
/// Returns `(connected, login)`. Conservative on any error: `(false, None)`.
async fn probe_github_credential() -> (bool, Option<String>) {
    let mut child = match Command::new("git")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        // git not installed / not on PATH → can't prove a credential exists.
        Err(_) => return (false, None),
    };

    // `git credential fill` reads a request blob terminated by a blank
    // line. Asking only for protocol+host means the helper either fills
    // in the stored username/password or returns just what we gave it.
    if let Some(mut stdin) = child.stdin.take() {
        let req = "protocol=https\nhost=github.com\n\n";
        if stdin.write_all(req.as_bytes()).await.is_err() {
            return (false, None);
        }
        // Drop stdin to signal EOF so git proceeds.
        drop(stdin);
    }

    let out = match child.wait_with_output().await {
        Ok(o) => o,
        Err(_) => return (false, None),
    };
    if !out.status.success() {
        // Non-zero typically means "no credential available" (or the
        // user declined an interactive helper) — honestly "not connected".
        return (false, None);
    }

    // Parse the key=value reply. We only keep `username`; a present
    // `password` line means a credential exists, but we never read its
    // value into anything we return or log.
    let reply = String::from_utf8_lossy(&out.stdout);
    let mut login: Option<String> = None;
    let mut has_password = false;
    for line in reply.lines() {
        if let Some(v) = line.strip_prefix("username=") {
            if !v.is_empty() {
                login = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("password=") {
            if !v.is_empty() {
                has_password = true;
            }
        }
    }
    (has_password, login)
}

/// Hand the access token to the system git credential helper via
/// `git credential approve`. On macOS this routes to osxkeychain, so
/// every git client on the box (IDE terminal, integrated git, plain
/// shell) is authenticated for github.com afterward.
///
/// The token is written ONLY to the child's stdin pipe — never to a
/// file, never logged, never placed in an error string. On any failure
/// we return a redacted message.
async fn store_github_credential(login: &str, token: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .args(["credential", "approve"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Couldn't run git to save the credential — is git installed?".to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        // The blob `git credential approve` expects, terminated by a
        // blank line. `password` carries the token — this is the only
        // place it is ever materialized outside memory, and it goes
        // straight into the helper's stdin.
        let blob =
            format!("protocol=https\nhost=github.com\nusername={login}\npassword={token}\n\n");
        stdin
            .write_all(blob.as_bytes())
            .await
            // Deliberately do NOT include the underlying io error — it
            // could, in principle, echo buffer contents. Redact.
            .map_err(|_| "Couldn't save the GitHub credential.".to_string())?;
        drop(stdin);
    }

    let status = child
        .wait()
        .await
        .map_err(|_| "Couldn't save the GitHub credential.".to_string())?;
    if !status.success() {
        return Err("Couldn't save the GitHub credential.".to_string());
    }
    Ok(())
}

/// Fetch the signed-in user's login via the GitHub REST API. Errors are
/// non-fatal to the caller (a connected-but-unknown-login state is fine).
async fn fetch_login(client: &reqwest::Client, token: &str) -> Option<String> {
    let resp = client
        .get(USER_API_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let user: GithubUser = resp.json().await.ok()?;
    user.login.filter(|s| !s.is_empty())
}

// ── Commands ────────────────────────────────────────────────────────

/// Report whether GitHub sign-in is configured for this build and
/// whether the user already has a github.com git credential.
#[tauri::command]
pub async fn github_auth_status() -> Result<GithubAuthStatus, String> {
    let configured = is_configured();
    let (connected, login) = probe_github_credential().await;
    Ok(GithubAuthStatus {
        configured,
        connected,
        login,
    })
}

/// Begin the device flow: ask GitHub for a user code + device code.
/// The caller shows `user_code`, opens `verification_uri`, then polls
/// `github_device_poll(device_code)` every `interval` seconds.
#[tauri::command]
pub async fn github_device_start() -> Result<GithubDeviceStart, String> {
    if !is_configured() {
        return Err("GitHub sign-in isn't configured for this build".to_string());
    }

    let client = http_client()?;
    let body = format!(
        "client_id={}&scope={}",
        urlencoding::encode(GITHUB_CLIENT_ID),
        urlencoding::encode(DEVICE_SCOPE),
    );
    let resp = client
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(to_error_string)?;

    if !resp.status().is_success() {
        // Status code only — the body can carry secrets, so don't echo it.
        return Err(format!(
            "GitHub returned {} when starting sign-in",
            resp.status()
        ));
    }

    // Do NOT log this body — it contains device_code.
    let parsed: DeviceCodeResponse = resp.json().await.map_err(to_error_string)?;
    Ok(GithubDeviceStart {
        user_code: parsed.user_code,
        verification_uri: parsed.verification_uri,
        device_code: parsed.device_code,
        // GitHub's documented default poll interval is 5s when omitted.
        interval: parsed.interval.unwrap_or(5),
        // Documented default expiry is 900s (15 min) when omitted.
        expires_in: parsed.expires_in.unwrap_or(900),
    })
}

/// Poll GitHub once for the access token. Returns:
///   * status="pending"   — `authorization_pending` or `slow_down`
///     (the caller backs off and polls again);
///   * status="authorized" — the token arrived; it's been stored via the
///     git credential helper and `login` is the signed-in user;
///   * status="error"     — `expired_token`, `access_denied`, or any
///     other terminal failure (the caller offers a plain retry).
#[tauri::command]
pub async fn github_device_poll(device_code: String) -> Result<GithubDevicePoll, String> {
    if !is_configured() {
        return Err("GitHub sign-in isn't configured for this build".to_string());
    }

    let client = http_client()?;
    let body = format!(
        "client_id={}&device_code={}&grant_type={}",
        urlencoding::encode(GITHUB_CLIENT_ID),
        urlencoding::encode(&device_code),
        urlencoding::encode("urn:ietf:params:oauth:grant-type:device_code"),
    );
    let resp = client
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(to_error_string)?;

    if !resp.status().is_success() {
        return Err(format!(
            "GitHub returned {} while signing in",
            resp.status()
        ));
    }

    // Do NOT log this body — it can contain access_token.
    let parsed: AccessTokenResponse = resp.json().await.map_err(to_error_string)?;

    // Success: a token is present.
    if let Some(token) = parsed.access_token.filter(|t| !t.is_empty()) {
        // Resolve the login first (best-effort) so we can store the
        // credential under the real username.
        let login = fetch_login(&client, &token)
            .await
            .unwrap_or_else(|| "x-access-token".to_string());
        // Persist via the git credential helper. The token never leaves
        // this scope except into the helper's stdin.
        store_github_credential(&login, &token).await?;
        return Ok(GithubDevicePoll {
            status: "authorized".to_string(),
            // If we fell back to the placeholder username we still report
            // a real login only when GitHub actually gave us one.
            login: if login == "x-access-token" {
                None
            } else {
                Some(login)
            },
        });
    }

    // No token yet — map GitHub's documented error codes.
    match parsed.error.as_deref() {
        // Keep waiting; both mean "not done yet" (slow_down also asks the
        // caller to lengthen its interval, which it does on its own).
        Some("authorization_pending") | Some("slow_down") => Ok(GithubDevicePoll {
            status: "pending".to_string(),
            login: None,
        }),
        // Terminal failures — caller shows a plain retry message. We do
        // not surface the raw error string to the UI here; the status is
        // enough and avoids leaking anything unexpected.
        _ => Ok(GithubDevicePoll {
            status: "error".to_string(),
            login: None,
        }),
    }
}
