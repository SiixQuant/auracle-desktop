//! Keyless sign-in — kick off the magic-link device flow, HQ first.
//!
//! The launcher's sign-in screen calls `sign_in_start(email)`. Entitlements
//! are derived from Stripe state that lives at HQ, so the flow tries HQ
//! first (`AURACLE_HQ_URL` env override, canonical default otherwise) and
//! falls back to the local engine when HQ is unreachable or doesn't serve
//! the route — a self-hosted box keeps working offline, a customer install
//! gets billing-real tiers. The verify step is pinned to whichever host
//! opened the session, since the pending sign-in row lives in its database.
//! `/auth/device/start` is public (pre-auth), so no owner key is needed.
//!
//! SECRECY: the returned `device_code` is opaque and will be consumed by a
//! future poll step. Treat it as a secret — never log it or put it in an
//! error string.

use std::sync::Mutex;

use tauri::AppHandle;

use super::engine_auth::ENGINE_BASE;
use super::secret_store;
use super::to_error_string;

/// Canonical HQ (license server) — mirrors the engine's
/// `license_server_url` resolution, env-overridable for staging.
const HQ_CANONICAL: &str = "https://amused-commitment-production-fb48.up.railway.app";

fn hq_base() -> String {
    std::env::var("AURACLE_HQ_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| HQ_CANONICAL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// The host that opened the current pending sign-in. Verify must hit the
/// same host — the session row lives in its database.
static ACTIVE_AUTH_BASE: Mutex<Option<String>> = Mutex::new(None);

fn remember_auth_base(base: &str) {
    if let Ok(mut guard) = ACTIVE_AUTH_BASE.lock() {
        *guard = Some(base.to_string());
    }
}

fn active_auth_base() -> String {
    ACTIVE_AUTH_BASE
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_else(|| ENGINE_BASE.to_string())
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

/// Ask HQ (or, failing that, the local engine) to email a magic sign-in
/// link to `email`.
///
/// Returns the opaque `device_code` for the verify step. Errors when
/// neither host is reachable or the address is rejected — the caller
/// surfaces that inline rather than blocking the screen.
#[tauri::command]
pub async fn sign_in_start(email: String) -> Result<SignInStart, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(to_error_string)?;

    let hq = hq_base();
    let mut base = hq.clone();
    let mut attempt = client
        .post(format!("{hq}/auth/device/start"))
        .json(&StartBody { email: &email })
        .send()
        .await;
    let hq_failed = match &attempt {
        Ok(response) => !response.status().is_success(),
        Err(_) => true,
    };
    if hq_failed {
        // Stale/absent HQ must never strand sign-in on a self-hosted box —
        // the local engine serves the same routes (honestly refusing when
        // it has no way to send email).
        base = ENGINE_BASE.to_string();
        attempt = client
            .post(format!("{ENGINE_BASE}/auth/device/start"))
            .json(&StartBody { email: &email })
            .send()
            .await;
    }
    let response = attempt.map_err(to_error_string)?;

    if !response.status().is_success() {
        return Err(format!("sign-in service returned {}", response.status()));
    }
    remember_auth_base(&base);

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

    let base = active_auth_base();
    let response = client
        .post(format!("{base}/auth/device/verify"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hq_base_env_override_and_default() {
        std::env::set_var("AURACLE_HQ_URL", "https://staging.example.com/");
        assert_eq!(hq_base(), "https://staging.example.com");
        std::env::remove_var("AURACLE_HQ_URL");
        assert_eq!(hq_base(), HQ_CANONICAL);
    }

    #[test]
    fn verify_base_defaults_to_engine_until_a_start_succeeds() {
        assert_eq!(active_auth_base(), ENGINE_BASE.to_string());
        remember_auth_base("https://hq.example.com");
        assert_eq!(active_auth_base(), "https://hq.example.com");
        remember_auth_base(ENGINE_BASE);
    }
}
