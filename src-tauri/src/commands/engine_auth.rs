//! Shared loopback auth helpers for talking to the local engine as the
//! owner.
//!
//! Several command modules need the same three steps to make an
//! owner-authenticated call to the local engine over loopback:
//!
//!   1. `read_handoff_secret` — read the per-install IDE-handoff secret
//!      the engine wrote to its bind-mounted keys dir. Only an on-box
//!      process can read it; presenting it to the engine's loopback
//!      handoff endpoint proves the caller runs on this machine (a
//!      remote attacker, even one forging Host / X-Forwarded-*, cannot).
//!   2. `fetch_owner_api_key` — exchange that secret for the owner's
//!      per-user API key via the engine's on-box handoff endpoint.
//!   3. `fetch_csrf` — GET the status surface so the engine issues an
//!      `auracle_csrf` cookie, then echo its value back as both the
//!      cookie and the `X-CSRF-Token` header on a mutation (the engine's
//!      double-submit CSRF gate requires the two to match).
//!
//! These were duplicated across `data_keys.rs` and (partially)
//! `view.rs`. Factoring them here gives one place the audit can point at.
//!
//! SECRECY: no key VALUE is ever logged or placed in an error string by
//! anything here.

use super::to_error_string;

/// Loopback engine origin. Plain http on the local engine port.
pub const ENGINE_BASE: &str = "http://127.0.0.1:1969";
/// GET this to receive the `auracle_csrf` cookie before a `/ui/api`
/// mutation. We use `/ui/api/status` (not an HTML page) so the cookie
/// still flows under the headless web profile, where portal pages 404
/// but the `/ui/api` surface stays served — same choice the IDE makes.
pub const STATUS_PATH: &str = "/ui/api/status";

/// Read the per-install IDE-handoff secret the engine wrote to the
/// bind-mounted keys dir (`<install>/data/keys/.ide-handoff-secret`).
/// Only an on-box process can read it. Returns None when absent or
/// unreadable — the caller then reports that the engine isn't connected
/// yet rather than guessing.
pub fn read_handoff_secret() -> Option<String> {
    let install = super::installer::resolve_install_path().ok()?;
    let path = install
        .join("data")
        .join("keys")
        .join(".ide-handoff-secret");
    std::fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(serde::Deserialize)]
struct ProvisionResponse {
    #[serde(default)]
    api_key: Option<String>,
}

/// Ask the local engine for the owner's per-user API key via the on-box
/// handoff endpoint (`/ui/api/ide/provision-local`).
///
/// Returns the owner key on success. On `Ok(None)` there is nothing to
/// hand off yet — no readable handoff secret, or the engine is up but has
/// no owner account (HTTP 409). Callers turn `None` into a clear
/// "connect/sign in to the engine first" message. Never fabricates a key.
pub async fn fetch_owner_api_key(client: &reqwest::Client) -> Result<Option<String>, String> {
    let secret = match read_handoff_secret() {
        Some(token) => token,
        None => return Ok(None),
    };

    let resp = client
        .post(format!("{ENGINE_BASE}/ui/api/ide/provision-local"))
        .header("X-Auracle-Handoff-Token", secret)
        .send()
        .await
        .map_err(to_error_string)?;

    // 409 = engine healthy but no owner account yet. Not an error — the
    // user just hasn't finished first-run setup; there's no key to hand off.
    if resp.status().as_u16() == 409 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!(
            "couldn't get the owner key from the engine (status {})",
            resp.status()
        ));
    }

    let body: ProvisionResponse = resp.json().await.map_err(to_error_string)?;
    Ok(body.api_key.filter(|key| !key.is_empty()))
}

/// First-run probe (read-only): does the local engine have an owner
/// account yet?
///
/// The launcher home calls this when the engine is healthy so it never
/// offers "Open workspace" — which would land the IDE in a blank Connect
/// modal — before first-run setup is finished (audit P0-10). It reuses the
/// loopback owner-key handoff purely as a signal: it writes nothing on this
/// machine and never returns the key value.
///
///   * `Ok(Some(true))`  — engine reachable, NO owner account yet (HTTP 409)
///   * `Ok(Some(false))` — engine reachable, owner account exists
///   * `Ok(None)`        — indeterminate (no on-box handoff secret, engine
///                         not reachable right now, or an unexpected status).
///                         The caller MUST NOT block the user on a signal it
///                         can't read — it falls back to the normal verb.
#[tauri::command]
pub async fn engine_needs_setup() -> Result<Option<bool>, String> {
    let secret = match read_handoff_secret() {
        Some(token) => token,
        None => return Ok(None),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(to_error_string)?;

    let resp = match client
        .post(format!("{ENGINE_BASE}/ui/api/ide/provision-local"))
        .header("X-Auracle-Handoff-Token", secret)
        .send()
        .await
    {
        Ok(r) => r,
        // Engine not answering loopback right now — can't tell; don't block.
        Err(_) => return Ok(None),
    };

    Ok(match resp.status().as_u16() {
        409 => Some(true),                           // healthy, no owner → needs setup
        s if (200..300).contains(&s) => Some(false), // owner exists → ready
        _ => None,                                   // unexpected → don't block
    })
}

/// Fetch the double-submit CSRF token: GET `/ui/api/status` with the owner
/// session cookie so the engine issues an `auracle_csrf` cookie, then read
/// that cookie's value to echo back on the mutation. The engine's CSRF
/// middleware requires the cookie and the `X-CSRF-Token` header to match.
/// Returns an empty string if no cookie was issued — the mutation then
/// fails the CSRF check and the caller surfaces a clean error.
pub async fn fetch_csrf(client: &reqwest::Client, owner_key: &str) -> Result<String, String> {
    let resp = client
        .get(format!("{ENGINE_BASE}{STATUS_PATH}"))
        .header("X-API-Key", owner_key)
        .header("Cookie", format!("auracle_session={owner_key}"))
        .send()
        .await
        .map_err(to_error_string)?;

    for value in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        let Ok(cookie) = value.to_str() else { continue };
        if let Some(rest) = cookie.strip_prefix("auracle_csrf=") {
            return Ok(rest.split(';').next().unwrap_or("").to_string());
        }
    }
    Ok(String::new())
}
