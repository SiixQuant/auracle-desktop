//! Keyless sign-in — kick off HQ's magic-link device flow.
//!
//! The launcher's sign-in screen calls `sign_in_start(email)`, which asks
//! the Auracle HQ licensing server (NOT the local engine) to email the user
//! a 6-digit code + magic sign-in link (`POST /auth/device/start`). This
//! MUST target HQ: a first-time customer has no local engine running yet,
//! and the signed entitlement JWT + Stripe state live only at HQ. The
//! endpoint is public (pre-auth), so no owner key is needed here.
//!
//! SECRECY: the returned `device_code` is opaque and will be consumed by a
//! future poll step. Treat it as a secret — never log it or put it in an
//! error string.

use tauri::AppHandle;

use super::secret_store;
use super::to_error_string;

/// Base URL of the Auracle HQ licensing server — the sign-in / device-code
/// and entitlement authority. Overridable via `AURACLE_LICENSE_SERVER_URL`
/// (the same env the engine uses) for staging or self-host; defaults to the
/// hosted HQ. Any trailing slash is trimmed so `{base}/auth/...` joins clean.
fn hq_auth_base() -> String {
    std::env::var("AURACLE_LICENSE_SERVER_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            "https://amused-commitment-production-fb48.up.railway.app".to_string()
        })
}

#[derive(serde::Serialize)]
pub struct SignInStart {
    pub ok: bool,
    /// Opaque device code for a future poll step. Secret — do not log.
    pub device_code: String,
}

#[derive(serde::Serialize)]
struct StartBody<'a> {
    email: &'a str,
}

#[derive(serde::Deserialize)]
struct StartResponse {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    device_code: String,
}

/// Ask the local engine to email a magic sign-in link to `email`.
///
/// Returns the opaque `device_code` for a later poll. Errors when the
/// engine isn't reachable or rejects the address — the caller surfaces
/// that inline rather than blocking the screen.
#[tauri::command]
pub async fn sign_in_start(email: String) -> Result<SignInStart, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(to_error_string)?;

    let response = client
        .post(format!("{}/auth/device/start", hq_auth_base()))
        .json(&StartBody { email: &email })
        .send()
        .await
        .map_err(to_error_string)?;

    if !response.status().is_success() {
        return Err(format!("engine returned {}", response.status()));
    }

    // Do NOT log this body — it carries the device_code.
    let parsed: StartResponse = response.json().await.map_err(to_error_string)?;
    Ok(SignInStart {
        ok: parsed.ok,
        device_code: parsed.device_code,
    })
}

/// Keychain keys for the established session. The signed JWT is the engine's
/// proof of who's signed in; the refresh token renews it without another code.
const SESSION_JWT_KEY: &str = "auracle_session_jwt";
const REFRESH_TOKEN_KEY: &str = "auracle_refresh_token";

#[derive(serde::Serialize)]
pub struct SignInResult {
    /// "ready" (signed in) | "invalid" | "expired" | "locked".
    pub status: String,
    pub tier: Option<String>,
}

#[derive(serde::Serialize)]
struct VerifyBody<'a> {
    email: &'a str,
    code: &'a str,
}

#[derive(serde::Deserialize)]
struct VerifyResponse {
    #[serde(default)]
    status: String,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    signed_jwt: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Verify the 6-digit sign-in code with the engine. On success ("ready"),
/// persist the signed session JWT + refresh token to the OS keychain (the
/// refresh token lets us renew silently). Non-ready outcomes are returned for
/// the UI to surface inline; only a transport/5xx error rejects.
#[tauri::command]
pub async fn sign_in_verify(
    app: AppHandle,
    email: String,
    code: String,
) -> Result<SignInResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(to_error_string)?;

    let response = client
        .post(format!("{}/auth/device/verify", hq_auth_base()))
        .json(&VerifyBody {
            email: &email,
            code: &code,
        })
        .send()
        .await
        .map_err(to_error_string)?;

    // A 400 means a malformed request (missing field); treat as a bad code
    // for the UI rather than a hard error.
    if response.status() == reqwest::StatusCode::BAD_REQUEST {
        return Ok(SignInResult {
            status: "invalid".into(),
            tier: None,
        });
    }
    if !response.status().is_success() {
        return Err(format!("engine returned {}", response.status()));
    }

    let parsed: VerifyResponse = response.json().await.map_err(to_error_string)?;
    if parsed.status == "ready" {
        // Best-effort cache: a failure here doesn't undo the server-side
        // sign-in, so don't fail the call over it.
        if let Some(jwt) = parsed.signed_jwt.as_deref() {
            secret_store::put(&app, SESSION_JWT_KEY, jwt).ok();
        }
        if let Some(refresh) = parsed.refresh_token.as_deref() {
            secret_store::put(&app, REFRESH_TOKEN_KEY, refresh).ok();
        }
    }
    Ok(SignInResult {
        status: parsed.status,
        tier: parsed.tier,
    })
}

/// Whether a sign-in session is cached on this machine (a refresh token is
/// present in the keychain). The launcher gates its sign-in screen on this so
/// the stored credential — not a bare local flag — decides whether the user is
/// signed in. (Full JWT-expiry validation + silent refresh is a later slice.)
#[tauri::command]
pub fn sign_in_status(app: AppHandle) -> Result<bool, String> {
    Ok(secret_store::get(&app, REFRESH_TOKEN_KEY)?.is_some())
}
