//! Encrypted secret store backed by Tauri's Stronghold plugin.
//!
//! Replaces direct `keyring::Entry` access in forge.rs + keychain.rs
//! with a single ChaCha20-Poly1305-encrypted file at:
//!
//!   ~/Library/Application Support/com.auracle.desktop/vault.snap        (macOS)
//!   %APPDATA%/com.auracle.desktop/vault.snap                            (Windows)
//!   ~/.local/share/com.auracle.desktop/vault.snap                       (Linux)
//!
//! Why this exists (vs `keyring`):
//!
//!   The OS keychain APIs we used previously (Security.framework on
//!   macOS, Credential Manager on Windows, Secret Service on Linux)
//!   have failure modes that are opaque to the user — a dismissed
//!   permission prompt, a missing keyring daemon, a code-signature
//!   mismatch between dev and installed builds, all manifest as
//!   silent set-then-NoEntry-on-read bugs. We hit this in production.
//!   For a thousands-of-users product, the encrypted-file approach
//!   used by VS Code / Cursor / JetBrains is the right answer: one
//!   file, predictable failure modes, identical behavior across
//!   platforms.
//!
//! Threat model:
//!
//!   * Attacker with the vault file BUT NOT the customer's machine
//!     → cannot decrypt (password is machine-derived).
//!   * Attacker with the machine BUT NOT the file → no vault to
//!     decrypt; their attack surface is the keychain / shell env
//!     instead, which they already have access to.
//!   * Attacker with BOTH → can decrypt. This is the "evil maid"
//!     scenario; not solvable for a local-only secret without TPM
//!     bindings. Out of scope here.
//!   * Vault tampering → ChaCha20-Poly1305 is AEAD; any byte flip
//!     in the file fails decryption.
//!
//! Password derivation:
//!
//!     vault_password = "auracle:" + machine_uid + ":" + install_uuid
//!
//!   - machine_uid: stable per-machine. macOS = IOPlatformUUID,
//!     Linux = /etc/machine-id, Windows = MachineGuid registry key.
//!     Sourced via the `machine-uid` crate.
//!   - install_uuid: random v4 UUID generated on first run, stored
//!     in plaintext in tauri-plugin-store. NOT a secret — its job
//!     is to make reinstalls (which wipe app data) produce a fresh
//!     vault instead of one keyed identically to the old install.
//!     Lets a customer "reset" by deleting one file.
//!
//!   The plugin's password_hash_function (in lib.rs) then SHA-256s
//!   this into the 32-byte ChaCha20 key.
//!
//! Migration:
//!
//!   First call to `get()` for a known slot transparently migrates
//!   any existing keyring entry into Stronghold, then deletes the
//!   keyring entry. Customers upgrading from a keyring-using build
//!   never need to re-enter their keys. See `migrate_from_keyring`.

use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use tauri_plugin_stronghold::stronghold::Stronghold;

use super::to_error_string;

const VAULT_FILE: &str = "vault.snap";
const META_STORE_FILE: &str = "secret_store_meta.json";
const KEY_INSTALL_UUID: &str = "install_uuid";

/// One client identifier inside the snapshot — Stronghold supports
/// multiple "clients" per snapshot for namespacing. We use one
/// client for all Auracle secrets; namespacing happens via key
/// prefix instead (cleaner mapping to our domain).
const CLIENT_BYTES: &[u8] = b"auracle-desktop";

/// Domain-separation prefix for the SHA-256 password hash. Bumping
/// the suffix (v1 -> v2) is how we'd rotate the snapshot key
/// derivation — we'd ship a one-shot re-encrypt migration in that
/// release.
const VAULT_KEY_DOMAIN: &[u8] = b"auracle-desktop-vault-v1:";

// ── Password derivation ─────────────────────────────────────────

fn derive_password(app: &AppHandle) -> Result<String, String> {
    let machine = machine_uid::get().unwrap_or_else(|_| {
        // machine-uid can fail on stripped-down Linux containers,
        // headless CI, etc. Fall back to a stable placeholder; the
        // install_uuid alone still provides per-install separation.
        // Customers in this fallback regime have a less-resilient
        // vault but it still works.
        log::warn!(
            "secret_store: machine_uid lookup failed, falling back to constant. \
             Vault is per-install but not per-machine."
        );
        "no-machine-id".to_string()
    });
    let install = ensure_install_uuid(app)?;
    Ok(format!("auracle:{machine}:{install}"))
}

fn ensure_install_uuid(app: &AppHandle) -> Result<String, String> {
    let store = app.store(META_STORE_FILE).map_err(to_error_string)?;
    if let Some(v) = store
        .get(KEY_INSTALL_UUID)
        .and_then(|v| v.as_str().map(String::from))
    {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    let uuid = uuid::Uuid::new_v4().to_string();
    store.set(KEY_INSTALL_UUID, uuid.clone());
    store.save().map_err(to_error_string)?;
    Ok(uuid)
}

// ── Vault open helpers ──────────────────────────────────────────

fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(to_error_string)?;
    std::fs::create_dir_all(&dir).map_err(to_error_string)?;
    Ok(dir.join(VAULT_FILE))
}

/// Open the snapshot. Each call builds a fresh `Stronghold` wrapper
/// — they're cheap (one disk read of the snapshot if it exists, no
/// work if it doesn't). The plugin's own Stronghold collection is
/// for frontend-facing Tauri commands; we use the wrapper type
/// directly here so we don't have to plumb requests through the
/// command dispatcher.
fn open(app: &AppHandle) -> Result<Stronghold, String> {
    let path = vault_path(app)?;
    let password = derive_password(app)?;
    // Hash the machine-derived password into a fixed-size key for
    // the snapshot. SHA-256 with a versioned domain-separator
    // prefix so we can rotate via the prefix later.
    let mut hasher = Sha256::new();
    hasher.update(VAULT_KEY_DOMAIN);
    hasher.update(password.as_bytes());
    let key = hasher.finalize().to_vec();
    Stronghold::new(path, key).map_err(to_error_string)
}

// ── Public API ──────────────────────────────────────────────────
//
// Each fn opens the vault fresh and looks up the client by name.
// Cheap — the snapshot file is small and the plugin handles
// loading/decryption efficiently. We don't extract a `client_for`
// helper because doing so would require naming
// `iota_stronghold::Client` in the return type (which isn't a
// direct dep). Inlining the lookup lets type inference handle it.

pub fn put(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let stronghold = open(app)?;
    let client = match stronghold.load_client(CLIENT_BYTES) {
        Ok(c) => c,
        Err(_) => stronghold
            .create_client(CLIENT_BYTES)
            .map_err(to_error_string)?,
    };
    let store = client.store();
    store
        .insert(key.as_bytes().to_vec(), value.as_bytes().to_vec(), None)
        .map_err(to_error_string)?;
    stronghold.save().map_err(to_error_string)?;
    Ok(())
}

pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    let stronghold = match open(app) {
        Ok(s) => s,
        // Vault open failure (most often: doesn't exist yet) → no
        // secrets, return None. Not an error from the caller's
        // perspective.
        Err(_) => return Ok(None),
    };
    let client = match stronghold.load_client(CLIENT_BYTES) {
        Ok(c) => c,
        // Vault exists but no client → no data yet.
        Err(_) => return Ok(None),
    };
    let store = client.store();
    let bytes = match store.get(key.as_bytes()) {
        Ok(Some(b)) => b,
        Ok(None) => return Ok(None),
        Err(e) => return Err(to_error_string(e)),
    };
    let s = String::from_utf8(bytes).map_err(to_error_string)?;
    Ok(Some(s))
}

pub fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    let stronghold = match open(app) {
        Ok(s) => s,
        Err(_) => return Ok(()), // vault gone = key gone
    };
    let client = match stronghold.load_client(CLIENT_BYTES) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let store = client.store();
    let _ = store.delete(key.as_bytes()).map_err(to_error_string);
    stronghold.save().map_err(to_error_string)?;
    Ok(())
}

// ── Migration from the OS keychain ──────────────────────────────
//
// Called from `get_with_migration` below. Best-effort: any failure
// at any step is logged + swallowed. The next call retries.

fn migrate_from_keyring(
    app: &AppHandle,
    keyring_service: &str,
    keyring_account: &str,
    stronghold_key: &str,
) -> Option<String> {
    let entry = match keyring::Entry::new(keyring_service, keyring_account) {
        Ok(e) => e,
        Err(_) => return None,
    };
    let value = match entry.get_password() {
        Ok(v) => v,
        Err(_) => return None, // no entry to migrate
    };

    // Write to Stronghold. If that fails, leave the keyring entry
    // alone — better to have the secret only in the keyring than to
    // delete it before we've persisted it elsewhere.
    if let Err(err) = put(app, stronghold_key, &value) {
        log::warn!(
            "secret_store: migration from keyring failed for {stronghold_key}: {err}"
        );
        return Some(value);
    }

    // Successful migration. Best-effort cleanup of the keyring slot
    // so we don't have two copies drifting. Failures here are fine —
    // the keyring entry just sticks around as a stale duplicate.
    if let Err(err) = entry.delete_credential() {
        log::warn!(
            "secret_store: migrated {stronghold_key} to vault but \
             failed to clear the keyring entry: {err}"
        );
    } else {
        log::info!("secret_store: migrated {stronghold_key} from keyring to vault");
    }

    Some(value)
}

/// Get a secret. If Stronghold has nothing AND there's an old
/// keyring entry under the given (service, account), migrate the
/// keyring entry into Stronghold transparently and return its
/// value. Use this from every command that previously called
/// keyring::Entry directly.
pub fn get_with_migration(
    app: &AppHandle,
    stronghold_key: &str,
    keyring_service: &str,
    keyring_account: &str,
) -> Result<Option<String>, String> {
    if let Some(v) = get(app, stronghold_key)? {
        return Ok(Some(v));
    }
    Ok(migrate_from_keyring(
        app,
        keyring_service,
        keyring_account,
        stronghold_key,
    ))
}
