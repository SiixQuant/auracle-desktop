//! Keyless sign-in — kick off the engine's magic-link device flow.
//!
//! The launcher's sign-in screen calls `sign_in_start(email)`, which asks
//! the local engine to email the user a magic sign-in link
//! (`POST /auth/device/start`). That endpoint is public (pre-auth), so no
//! owner key is needed here.
//!
//! SECRECY: the returned `device_code` is opaque and will be consumed by a
//! future poll step. Treat it as a secret — never log it or put it in an
//! error string.

use super::engine_auth::ENGINE_BASE;
use super::to_error_string;

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
        .post(format!("{ENGINE_BASE}/auth/device/start"))
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
