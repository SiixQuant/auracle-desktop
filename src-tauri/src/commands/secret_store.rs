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
use std::sync::Mutex;

use once_cell::sync::Lazy;
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

/// Process-wide cache for the open Stronghold instance. Avoids the
/// 200-500ms reopen cost on every put/get/delete:
///
///   * machine_uid::get() shells out to ioreg/registry/file-read
///   * Stronghold::new() loads + decrypts the snapshot
///
/// Both happen ONCE for the process lifetime. Subsequent calls just
/// lock the mutex (uncontended in our usage) and operate on the
/// in-memory client. save() is the only thing that touches disk per
/// write call, and that's necessary by definition.
///
/// Thread safety: iota_stronghold uses its own internal locking, so
/// holding our mutex across the inner ops is correct. Tauri
/// commands are short-lived so contention is a non-issue.
static VAULT: Lazy<Mutex<Option<Stronghold>>> = Lazy::new(|| Mutex::new(None));

/// Cache the machine-derived password too — `machine_uid::get()` is
/// the most expensive call in the whole open path (ioreg subprocess
/// on macOS). Once per process is enough.
static CACHED_PASSWORD: Lazy<Mutex<Option<String>>> =
    Lazy::new(|| Mutex::new(None));

// ── Password derivation ─────────────────────────────────────────

fn derive_password(app: &AppHandle) -> Result<String, String> {
    let mut guard = CACHED_PASSWORD.lock().unwrap();
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
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
    let password = format!("auracle:{machine}:{install}");
    *guard = Some(password.clone());
    Ok(password)
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

/// Lock the global vault, lazily opening + caching on the first
/// call. The closure receives the cached Stronghold instance —
/// subsequent invocations skip the entire open path (machine_uid
/// lookup, snapshot decryption, KeyProvider construction).
///
/// Cost profile:
///   First call:        ~200-500ms (open + cache)
///   Subsequent calls:  ~1ms lock + closure body
fn with_vault<F, R>(app: &AppHandle, f: F) -> Result<R, String>
where
    F: FnOnce(&Stronghold) -> Result<R, String>,
{
    let mut guard = VAULT.lock().unwrap();

    if guard.is_none() {
        let path = vault_path(app)?;
        let password = derive_password(app)?;
        // SHA-256 with a versioned domain-separator. Bumping the
        // prefix would re-key the vault — would need a one-shot
        // re-encrypt migration in that release.
        let mut hasher = Sha256::new();
        hasher.update(VAULT_KEY_DOMAIN);
        hasher.update(password.as_bytes());
        let key = hasher.finalize().to_vec();
        let stronghold = Stronghold::new(path, key).map_err(to_error_string)?;
        *guard = Some(stronghold);
    }

    // unwrap-safe: we just ensured it's Some above.
    f(guard.as_ref().unwrap())
}

/// Variant of `with_vault` that swallows vault-open errors and
/// returns the supplied default. Used by get() / delete() where
/// "vault doesn't exist" is a legitimate no-op state.
fn with_vault_or_default<F, R>(app: &AppHandle, default: R, f: F) -> Result<R, String>
where
    F: FnOnce(&Stronghold) -> Result<R, String>,
{
    let mut guard = VAULT.lock().unwrap();

    if guard.is_none() {
        let path = vault_path(app)?;
        let password = match derive_password(app) {
            Ok(p) => p,
            Err(_) => return Ok(default),
        };
        let mut hasher = Sha256::new();
        hasher.update(VAULT_KEY_DOMAIN);
        hasher.update(password.as_bytes());
        let key = hasher.finalize().to_vec();
        match Stronghold::new(path, key) {
            Ok(s) => *guard = Some(s),
            Err(_) => return Ok(default),
        }
    }

    f(guard.as_ref().unwrap())
}

// ── Public API ──────────────────────────────────────────────────
//
// All three ops go through with_vault so they share the cached
// Stronghold instance. The client lookup inside each closure is
// in-memory + cheap (~microseconds).

pub fn put(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    with_vault(app, |stronghold| {
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
        // save() encrypts + writes the snapshot. The actual disk
        // cost — unavoidable for a write op, but our vault is
        // small (a few keys = few KB) so this is ~10-50ms.
        stronghold.save().map_err(to_error_string)?;
        Ok(())
    })
}

pub fn get(app: &AppHandle, key: &str) -> Result<Option<String>, String> {
    with_vault_or_default(app, None, |stronghold| {
        let client = match stronghold.load_client(CLIENT_BYTES) {
            Ok(c) => c,
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
    })
}

pub fn delete(app: &AppHandle, key: &str) -> Result<(), String> {
    with_vault_or_default(app, (), |stronghold| {
        let client = match stronghold.load_client(CLIENT_BYTES) {
            Ok(c) => c,
            Err(_) => return Ok(()),
        };
        let store = client.store();
        let _ = store.delete(key.as_bytes()).map_err(to_error_string);
        stronghold.save().map_err(to_error_string)?;
        Ok(())
    })
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
