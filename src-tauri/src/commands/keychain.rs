//! License-key storage.
//!
//! Backed by the Stronghold-encrypted vault in
//! commands/secret_store.rs (and not, despite the legacy name of
//! this file, the OS keychain). Switched away from the OS
//! keychain in the 0.3.0 release after seeing silent
//! set-then-NoEntry-on-read bugs on macOS in the field — see
//! secret_store.rs's module docstring for the full rationale.
//!
//! The license key lives in TWO places:
//!
//!   1. Stronghold vault (canonical) — this module owns the
//!      read/write path.
//!   2. ~/auracle/.env as AURACLE_LICENSE_KEY — the running
//!      Houston container reads .env, not the desktop vault.
//!      The installer command handles writing step 2.
//!
//! On first run of 0.3.0+ for a customer with an existing OS-
//! keychain entry, secret_store::get_with_migration transparently
//! pulls the old entry over to Stronghold and deletes the
//! keychain slot. Migration runs lazily, on the first license_get
//! call. No customer action needed.

use tauri::AppHandle;

use super::secret_store;

/// Legacy OS-keychain slot. Stays in code so the migration knows
/// where to look; can be removed in a future release once all
/// customers have upgraded past 0.3.0.
const LEGACY_KEYCHAIN_SERVICE: &str = "com.auracle.desktop";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "license-key";

/// Stronghold vault key.
const VAULT_KEY_LICENSE: &str = "license_key";

#[tauri::command]
pub fn license_get(app: AppHandle) -> Result<Option<String>, String> {
    secret_store::get_with_migration(
        &app,
        VAULT_KEY_LICENSE,
        LEGACY_KEYCHAIN_SERVICE,
        LEGACY_KEYCHAIN_ACCOUNT,
    )
}

#[tauri::command]
pub fn license_set(app: AppHandle, value: String) -> Result<(), String> {
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
            "license key looks too short — paste the full key from your purchase email"
                .to_string(),
        );
    }

    secret_store::put(&app, VAULT_KEY_LICENSE, &value)?;

    let prefix = &value[..value.len().min(8)];
    log::info!(
        "license_set: stored license starting with '{}…' in Stronghold vault",
        prefix
    );
    Ok(())
}

#[tauri::command]
pub fn license_clear(app: AppHandle) -> Result<(), String> {
    // Vault first; then best-effort scrub of the legacy keychain
    // entry so a clear leaves no copies behind.
    secret_store::delete(&app, VAULT_KEY_LICENSE)?;
    if let Ok(entry) = keyring::Entry::new(LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    Ok(())
}
