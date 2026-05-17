//! Secure license-key storage in the OS keychain.
//!
//! - macOS:   Keychain Services (Keychain.app)
//! - Windows: Credential Manager
//! - Linux:   Secret Service (libsecret) — works under GNOME, KDE,
//!   and headless via `secret-tool` if available
//!
//! The license key is the only secret the launcher itself manages —
//! everything else (Stripe MCP token, broker credentials, SMTP
//! password) is owned by the auracle stack and lives in
//! ~/auracle/.env. The launcher writes the license key to BOTH:
//!
//!   1. The OS keychain (canonical)
//!   2. ~/auracle/.env as AURACLE_LICENSE_KEY (because the running
//!      Houston container reads .env, not the host keychain)
//!
//! Step 2 happens in the install flow; this module owns step 1.

use keyring::Entry;

use super::to_error_string;

const SERVICE: &str = "com.auracle.desktop";
const ACCOUNT: &str = "license-key";

#[tauri::command]
pub fn license_get() -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(to_error_string)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(to_error_string(e)),
    }
}

#[tauri::command]
pub fn license_set(value: String) -> Result<(), String> {
    let value = value.trim().to_string();
    // Reject empty and obvious non-key shapes (whitespace, < 16 chars)
    // but accept any of the three formats Auracle understands — the
    // license server decides validity, not the launcher:
    //
    //   akey_…  — Stripe-issued opaque (current primary path)
    //   polar_… — legacy Polar key (deprecated but some early-access
    //             customers still hold one)
    //   eyJ…    — Ed25519 JWT (self-hosted-licenser path, used by
    //             customers who run their own licenser instance or
    //             by Enterprise customers with offline-capable keys)
    //
    // Forwarding any non-empty string to the server is fine; the
    // /license/validate endpoint returns a clean "not_found" if the
    // shape doesn't parse. The launcher's job is just to capture +
    // store the string, not gate it.
    if value.len() < 16 {
        return Err(
            "license key looks too short — paste the full key from your purchase email".to_string(),
        );
    }
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(to_error_string)?;
    entry.set_password(&value).map_err(to_error_string)?;
    let prefix = &value[..value.len().min(8)];
    log::info!(
        "license_set: stored license starting with '{}…' in OS keychain",
        prefix
    );
    Ok(())
}

#[tauri::command]
pub fn license_clear() -> Result<(), String> {
    let entry = Entry::new(SERVICE, ACCOUNT).map_err(to_error_string)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(to_error_string(e)),
    }
}
