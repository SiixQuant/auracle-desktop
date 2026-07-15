//! First-time install bootstrap.
//!
//! Mirrors the existing `install.sh` flow but in Rust so it can
//! be invoked from the Tauri frontend with structured progress
//! reporting instead of raw stdout. Steps:
//!
//!   1. Pick install path (~/auracle by default; user can override
//!      in Settings before running install).
//!   2. Download install.sh from auracle-installer GitHub repo (the
//!      same script power users curl | bash today). Verify its
//!      SHA-256 against a digest when one is available — an
//!      operator-supplied `AURACLE_INSTALLER_SHA256` env value, or a
//!      digest published alongside the script (the
//!      `install.sh.sha256` sidecar / `checksums.txt` in the same
//!      repo path) — before writing it to disk and handing it to
//!      bash, mirroring the .dmg integrity gate in ide_update.rs. A
//!      mismatch fails closed. The shebang sanity check stays as a
//!      cheap first filter so a cached HTML 404 page can't slip
//!      through. Progressive hardening: when NO digest is published
//!      yet (env unset and no sidecar), we log a loud warning and
//!      proceed unverified — preserving today's behavior so
//!      publishing a digest is a pure upgrade, not a flag day; the
//!      check engages automatically once a digest exists.
//!   3. Run the installer with the user's chosen license key in
//!      env (set AURACLE_LICENSE_KEY before invoking) so the
//!      install.sh's prompt-for-key step skips.
//!   4. Poll /healthz to know when the stack came up.
//!
//! Long-running steps (docker compose pull is multi-minute) emit
//! structured progress via Tauri events the frontend can subscribe
//! to (`installer-progress` event with {phase, message, percent}).

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::to_error_string;
use crate::commands::keychain;

/// URL of the install.sh script that materializes a fresh Auracle
/// stack. Matches the public auracle-installer repo's main branch.
const INSTALLER_SCRIPT_URL: &str =
    "https://raw.githubusercontent.com/SiixQuant/auracle-installer/main/install.sh";

/// Env var an operator can set to the expected lowercase 64-char hex
/// SHA-256 of install.sh. Used as an interim integrity source until the
/// release pipeline publishes the `install.sh.sha256` sidecar; takes
/// precedence over the fetched sidecar when both are present.
const INSTALLER_SHA_ENV: &str = "AURACLE_INSTALLER_SHA256";

/// Hard ceiling on a fetched checksum body so a host that streams an
/// unbounded chunked response can't make us buffer without limit. A real
/// `.sha256` sidecar is well under 1 KiB; 64 KiB is generous headroom.
const MAX_CHECKSUM_BYTES: usize = 64 * 1024;

/// Resolve the install path — either AURACLE_INSTALL_DIR env (for
/// dev / power users) or the default ~/auracle.
pub fn resolve_install_path() -> anyhow::Result<PathBuf> {
    if let Ok(p) = std::env::var("AURACLE_INSTALL_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home = dirs_home()?;
    Ok(home.join("auracle"))
}

fn dirs_home() -> anyhow::Result<PathBuf> {
    // std::env::home_dir() was deprecated then un-deprecated in 1.85.
    // For safety + cross-platform, prefer the env vars directly.
    if cfg!(windows) {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .map_err(|_| anyhow::anyhow!("USERPROFILE env var not set"))
    } else {
        std::env::var("HOME")
            .map(PathBuf::from)
            .map_err(|_| anyhow::anyhow!("HOME env var not set"))
    }
}

#[tauri::command]
pub async fn is_installed() -> Result<bool, String> {
    let path = resolve_install_path().map_err(to_error_string)?;
    Ok(path.join("docker-compose.yml").exists())
}

/// Per-phase progress event emitted to the frontend during install.
/// The frontend's onboarding view subscribes via window.__TAURI__.
/// event.listen('installer-progress', ...) and renders a stepper.
#[derive(Debug, Clone, Serialize)]
pub struct InstallerProgress {
    pub phase: String,        // "download_script" | "run_installer" | "wait_healthy"
    pub message: String,      // human-readable status line
    pub percent: u8,          // 0-100 (best-effort)
    pub line: Option<String>, // raw subprocess output line, when relevant
}

#[tauri::command]
pub async fn run_first_install(app: AppHandle) -> Result<(), String> {
    let path = resolve_install_path().map_err(to_error_string)?;
    // install.sh runs `docker compose up` from `path`, under the project name
    // Compose derives from its basename (`auracle`). If a different working_dir
    // already owns that name — a dev checkout at ~/Downloads/auracle — that
    // `up` would recreate the dev stack's containers with our compose file +
    // `.env` and down a running engine. Refuse before touching disk; adopt the
    // running stack instead. No-op on a clean machine (nothing owns the name).
    crate::commands::docker::ensure_engine_home_unclaimed(&path).await?;
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(to_error_string)?;
    }
    log::info!("first install bootstrap into {}", path.display());

    emit_progress(
        &app,
        "download_script",
        "Downloading installer script…",
        5,
        None,
    );

    // 1. Download install.sh into the install dir
    let script_path = path.join("install.sh");
    download_installer(&script_path)
        .await
        .map_err(to_error_string)?;
    emit_progress(
        &app,
        "download_script",
        "Installer script downloaded.",
        15,
        None,
    );

    // Make executable (chmod +x equivalent on Unix; no-op on Windows
    // where bash isn't available anyway — see WINDOWS note below).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)
            .map_err(to_error_string)?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).map_err(to_error_string)?;
    }

    // WINDOWS: the launcher itself runs natively (.msi installs to
    // Program Files); the Auracle Docker stack underneath the
    // launcher requires Docker Desktop, which on Windows uses WSL2
    // as its backend. install.sh runs in bash, which is provided by
    // Git Bash (typically already installed via Git for Windows) OR
    // WSL2's bash.exe.
    //
    // Check for bash availability before invoking. If neither Git
    // Bash nor WSL2 bash is present, surface a clear instruction.
    #[cfg(windows)]
    {
        use std::process::Command as StdCommand;
        let bash_available = StdCommand::new("where")
            .arg("bash")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !bash_available {
            return Err(
                "Bash not found on PATH. Auracle's install.sh requires bash, \
                 typically provided by Git for Windows (https://git-scm.com/) \
                 OR WSL2 (https://learn.microsoft.com/en-us/windows/wsl/install). \
                 Install either + restart Auracle Desktop to continue."
                    .into(),
            );
        }
    }

    // 2. Pull license key from the secret store, set in env so the
    //    installer script's prompt-for-key step skips. Operator who
    //    wants to install without a key (Community tier) can clear
    //    the key in Settings before running install.
    // Distinguish a genuine "no key" (→ Community, fine) from a vault READ
    // FAILURE (audit P0-12). The old `.ok().flatten().unwrap_or_default()`
    // mapped any keychain error to an empty key, silently downgrading a paid
    // customer to Community at install time. Abort on a real error instead.
    let license = match keychain::license_get(app.clone()) {
        Ok(Some(key)) => key,
        Ok(None) => String::new(), // genuinely no key on file → Community tier
        Err(e) => {
            return Err(format!(
                "Couldn't read your license key from the system keychain ({e}). \
                 Aborting install rather than silently downgrading to Community — \
                 retry, or clear the key in Settings to install Community on purpose."
            ));
        }
    };

    emit_progress(
        &app,
        "run_installer",
        "Running install.sh — pulling Docker images and starting services. \
         This usually takes 3–8 minutes on a fresh machine.",
        20,
        None,
    );

    // 3. Spawn install.sh with stdout/stderr piped so we can
    //    forward each line to the frontend as a progress event.
    let mut cmd = Command::new("bash");
    cmd.arg(&script_path);
    // If a prior install left a .env, install.sh's idempotency gate would
    // exit 0 without doing anything (audit P0-11) — run_first_install then
    // falsely "succeeds" or dead-ends at the health timeout, with no way to
    // recover. Pass --reset so install.sh backs up the .env and actually
    // re-pulls + re-ups; it carries forward the DB password + install UUID
    // from the backup, so preserved volumes keep authenticating.
    if path.join(".env").exists() {
        cmd.arg("--reset");
    }
    cmd.current_dir(&path)
        .env("AURACLE_LICENSE_KEY", &license)
        .env("AURACLE_NONINTERACTIVE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("install.sh spawn failed: {e}"))?;

    // Drain stdout in a background task so the pipe doesn't fill.
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                emit_progress(&app_clone, "run_installer", "", 50, Some(line));
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                log::warn!("installer stderr: {line}");
                emit_progress(&app_clone, "run_installer", "", 50, Some(line));
            }
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("install.sh wait: {e}"))?;
    if !status.success() {
        return Err(format!(
            "install.sh exited with code {:?} — check the logs panel for details",
            status.code(),
        ));
    }
    emit_progress(&app, "run_installer", "Installer completed.", 80, None);

    // 4. Wait for /healthz to come up (max 120 s). The healthcheck
    //    poll runs continuously in the background; here we just
    //    block until it reports healthy.
    emit_progress(
        &app,
        "wait_healthy",
        "Waiting for the Auracle stack to become healthy…",
        85,
        None,
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(to_error_string)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if let Ok(resp) = client.get("http://localhost:1969/healthz").send().await {
            if resp.status().is_success() {
                emit_progress(&app, "wait_healthy", "Auracle is up.", 100, None);
                return Ok(());
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Err(
        "Stack didn't reach healthy state within 2 minutes. Check Diagnostics → \
         container logs to see what's stuck."
            .into(),
    )
}

/// Helper: emit one InstallerProgress event to the main window.
fn emit_progress(app: &AppHandle, phase: &str, message: &str, percent: u8, line: Option<String>) {
    let _ = app.emit(
        "installer-progress",
        InstallerProgress {
            phase: phase.to_string(),
            message: message.to_string(),
            percent,
            line,
        },
    );
}

/// Download the installer script and verify its integrity before it
/// touches disk. Two gates, cheapest first:
///   1. The first line must be a `#!` shebang — a cheap filter so a
///      cached HTML "404 Not Found" page from a misconfigured CDN can't
///      land in install.sh and make bash fail with a confusing syntax
///      error.
///   2. If a SHA-256 digest is available — an operator-supplied
///      `AURACLE_INSTALLER_SHA256`, or one published alongside the script
///      (the `install.sh.sha256` sidecar / `checksums.txt` in the same repo
///      path) — the bytes must match it; a mismatch fails closed. This
///      mirrors the .dmg integrity check in ide_update.rs.
///
/// Progressive hardening: when NO digest is available yet (env unset and no
/// sidecar published), we log a loud warning and proceed unverified rather
/// than aborting — this matches today's behavior so publishing a digest is a
/// pure upgrade, not a flag day. The check engages automatically (and the
/// mismatch gate becomes binding) the moment a digest exists. Note this is
/// weaker than ide_update.rs's hard fail-closed, which is justified because
/// the IDE release pipeline already publishes per-asset checksums; once the
/// installer pipeline does too, this can be tightened to fail-closed.
async fn download_installer(target: &PathBuf) -> anyhow::Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client
        .get(INSTALLER_SCRIPT_URL)
        .header("User-Agent", "Auracle-Desktop-Launcher/0.1")
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!(
            "installer download HTTP {} from {}",
            resp.status(),
            INSTALLER_SCRIPT_URL,
        );
    }
    let body = resp.bytes().await?.to_vec();

    // Gate 1 — sanity: the first line should be a shebang. If we got HTML
    // back from a misconfigured CDN, refuse before we even hash it.
    let first_line = String::from_utf8_lossy(&body)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    if !first_line.starts_with("#!") {
        anyhow::bail!(
            "installer download didn't look like a shell script (first line: {:?}). \
             Refusing to write — re-check INSTALLER_SCRIPT_URL.",
            &first_line[..first_line.len().min(80)],
        );
    }

    // Gate 2 — integrity: resolve the expected digest, then decide. A
    // mismatch always aborts; a genuinely-absent digest (env unset + no
    // published sidecar) warns and proceeds so we never regress today's
    // behavior. The decision itself is a pure function (unit-tested below).
    let expected = resolve_expected_installer_sha(&client).await?;
    match integrity_decision(expected.as_deref(), &body) {
        IntegrityOutcome::Verified => {}
        IntegrityOutcome::Unverified => {
            log::warn!(
                "installer integrity check skipped: no published digest for install.sh \
                 (no AURACLE_INSTALLER_SHA256 env, no install.sh.sha256 / checksums.txt \
                 sidecar) — proceeding unverified. The release pipeline should publish \
                 install.sh.sha256 so this download is cryptographically verified."
            );
        }
        IntegrityOutcome::Mismatch { expected, actual } => {
            anyhow::bail!(
                "installer download failed SHA-256 verification \
                 (expected {expected}, got {actual}). Refusing to write — the file \
                 may be corrupted or tampered with. Try again.",
            );
        }
    }

    std::fs::write(target, &body)?;
    Ok(())
}

/// Outcome of the integrity decision for a downloaded script.
#[derive(Debug, PartialEq, Eq)]
enum IntegrityOutcome {
    /// A digest was available and the bytes matched it.
    Verified,
    /// No digest was available — proceed, but the caller should warn.
    Unverified,
    /// A digest was available and the bytes did NOT match — abort.
    Mismatch { expected: String, actual: String },
}

/// Pure integrity decision: given the resolved expected digest (`None` when
/// none is published) and the downloaded bytes, decide whether to proceed.
/// Verify-if-available, warn-if-absent, fail-on-mismatch. Kept side-effect
/// free so it's deterministically unit-testable without the network.
fn integrity_decision(expected: Option<&str>, body: &[u8]) -> IntegrityOutcome {
    match expected {
        None => IntegrityOutcome::Unverified,
        Some(expected) => {
            let actual = sha256_hex(body);
            if checksums_match(expected, &actual) {
                IntegrityOutcome::Verified
            } else {
                IntegrityOutcome::Mismatch {
                    expected: expected.to_string(),
                    actual,
                }
            }
        }
    }
}

/// Resolve the expected SHA-256 for install.sh, in preference order:
///   1. `AURACLE_INSTALLER_SHA256` env (interim / operator override), then
///   2. the published `install.sh.sha256` sidecar, then
///   3. a combined `checksums.txt` in the same repo path.
///
/// Returns:
///   - `Ok(Some(digest))` when a valid digest is found (the caller then
///     fails closed on mismatch),
///   - `Ok(None)` when none is available at all (env unset AND sidecars 404)
///     — the caller warns and proceeds, preserving today's behavior, and
///   - `Err` only for operator misconfiguration: the env var is set but
///     malformed, which is worth surfacing rather than silently ignoring.
async fn resolve_expected_installer_sha(
    client: &reqwest::Client,
) -> anyhow::Result<Option<String>> {
    let script_filename = INSTALLER_SCRIPT_URL.rsplit('/').next().unwrap_or_default();

    // 1. Operator-supplied digest wins — lets a deployment pin the hash
    //    before the repo publishes a sidecar. A set-but-malformed value is a
    //    misconfiguration we surface (the operator clearly intended to pin).
    if let Ok(raw) = std::env::var(INSTALLER_SHA_ENV) {
        if let Some(d) = parse_sha256(&raw, script_filename) {
            return Ok(Some(d));
        }
        anyhow::bail!(
            "{INSTALLER_SHA_ENV} is set but isn't a valid SHA-256 \
             (expected 64 hex chars). Fix or unset it.",
        );
    }

    // 2 + 3. Fetch candidate checksum URLs derived from the script URL —
    //    same host, so they inherit the HTTPS chain the script download uses.
    let candidates = [
        format!("{INSTALLER_SCRIPT_URL}.sha256"),
        INSTALLER_SCRIPT_URL
            .rsplit_once('/')
            .map(|(base, _)| format!("{base}/checksums.txt"))
            .unwrap_or_default(),
    ];
    for url in candidates.iter().filter(|u| !u.is_empty()) {
        if let Some(body) = fetch_checksum_body(client, url).await {
            if let Some(d) = parse_sha256(&body, script_filename) {
                return Ok(Some(d));
            }
        }
    }

    // No digest published anywhere yet — caller warns and proceeds.
    Ok(None)
}

/// GET a (small) checksum file as text. Returns `None` on any network or
/// HTTP error, an over-size body, or non-UTF-8 content so the caller can
/// fall through to the next candidate / fail closed.
async fn fetch_checksum_body(client: &reqwest::Client, url: &str) -> Option<String> {
    let mut resp = client
        .get(url)
        .header("User-Agent", "Auracle-Desktop-Launcher/0.1")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    // Read with a hard ceiling so a host that omits Content-Length and
    // streams chunked can't make us buffer unbounded data.
    let mut buf: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        if buf.len() + chunk.len() > MAX_CHECKSUM_BYTES {
            log::warn!("installer checksum body exceeded {MAX_CHECKSUM_BYTES} bytes; refusing");
            return None;
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).ok()
}

/// Pull a lowercase 64-char hex SHA-256 digest out of checksum-file text.
/// Accepts a bare digest, `shasum`/`sha256sum` output (`<digest>  <file>`),
/// and a multi-entry `checksums.txt` (prefers the line naming
/// `script_filename`). Returns `None` if no valid digest is present.
fn parse_sha256(contents: &str, script_filename: &str) -> Option<String> {
    let is_hex64 = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());

    // Prefer a line naming our script (handles a combined checksums.txt
    // listing several files). Match the filename as a WHOLE whitespace-
    // delimited token, never a substring, so a sibling that merely starts
    // with our name can't shadow the real line. The leading `*` is the GNU
    // coreutils binary-mode marker (`*<file>`).
    if !script_filename.is_empty() {
        let mut saw_named_line = false;
        for line in contents.lines() {
            if line
                .split_whitespace()
                .any(|t| t.trim_start_matches('*') == script_filename)
            {
                saw_named_line = true;
                if let Some(tok) = line.split_whitespace().find(|t| is_hex64(t)) {
                    return Some(tok.to_ascii_lowercase());
                }
            }
        }
        // A line named our script but carried no valid digest: fail closed
        // rather than borrowing some other file's digest below.
        if saw_named_line {
            return None;
        }
    }
    // Fallback: the first 64-hex token anywhere (a bare digest, or a
    // single-entry sidecar where no line names us).
    contents
        .split_whitespace()
        .find(|t| is_hex64(t))
        .map(|t| t.to_ascii_lowercase())
}

/// Compare a published digest against a computed one, case-insensitively
/// and tolerant of stray surrounding whitespace.
fn checksums_match(expected: &str, actual: &str) -> bool {
    expected.trim().eq_ignore_ascii_case(actual.trim())
}

/// SHA-256 of a byte slice as a lowercase hex string.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // SHA-256("abc") — known NIST vector.
    const SHA256_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(sha256_hex(b"abc"), SHA256_ABC);
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn checksums_match_case_and_whitespace_insensitive() {
        assert!(checksums_match(
            SHA256_ABC,
            &SHA256_ABC.to_ascii_uppercase()
        ));
        assert!(checksums_match(&format!("  {SHA256_ABC}  "), SHA256_ABC));
        let wrong = format!("0{}", &SHA256_ABC[1..]);
        assert!(!checksums_match(SHA256_ABC, &wrong));
    }

    #[test]
    fn parse_sha256_accepts_bare_sidecar_and_named_line() {
        // Bare digest.
        assert_eq!(
            parse_sha256(SHA256_ABC, "install.sh").as_deref(),
            Some(SHA256_ABC)
        );
        // `sha256sum` style: `<digest>  <file>`.
        let line = format!("{SHA256_ABC}  install.sh\n");
        assert_eq!(
            parse_sha256(&line, "install.sh").as_deref(),
            Some(SHA256_ABC)
        );
        // Combined checksums.txt: prefer the line naming our file.
        let other = "0".repeat(64);
        let combined = format!("{other}  uninstall.sh\n{SHA256_ABC}  install.sh\n");
        assert_eq!(
            parse_sha256(&combined, "install.sh").as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_rejects_missing_or_malformed() {
        assert!(parse_sha256("not a checksum", "install.sh").is_none());
        assert!(parse_sha256("", "install.sh").is_none());
        // A line names our file but carries no valid digest → fail closed,
        // don't borrow a sibling's digest.
        let combined = format!(
            "{}  install.sh\n{SHA256_ABC}  uninstall.sh\n",
            "zz".repeat(32)
        );
        assert!(parse_sha256(&combined, "install.sh").is_none());
    }

    #[test]
    fn substring_filename_does_not_shadow_real_line() {
        // A sibling whose name merely starts with ours (`install.sh.bak`)
        // must not shadow the genuine `install.sh` line — filename match is
        // whole-token, not substring.
        let combined = format!(
            "{}  install.sh.bak\n{SHA256_ABC}  install.sh\n",
            "0".repeat(64)
        );
        assert_eq!(
            parse_sha256(&combined, "install.sh").as_deref(),
            Some(SHA256_ABC)
        );
    }

    // ── Integrity decision: verify-if-available / warn-if-absent / fail-on-mismatch ──

    #[test]
    fn integrity_no_digest_proceeds_unverified() {
        // No published digest (env unset + sidecars 404) must NOT abort —
        // it preserves today's behavior. The caller logs a warning on this.
        assert_eq!(
            integrity_decision(None, b"abc"),
            IntegrityOutcome::Unverified
        );
    }

    #[test]
    fn integrity_matching_digest_verifies() {
        // A digest that matches the bytes → Verified (proceed).
        assert_eq!(
            integrity_decision(Some(SHA256_ABC), b"abc"),
            IntegrityOutcome::Verified
        );
        // Case/whitespace tolerance carries through.
        assert_eq!(
            integrity_decision(
                Some(&format!("  {}  ", SHA256_ABC.to_ascii_uppercase())),
                b"abc"
            ),
            IntegrityOutcome::Verified
        );
    }

    #[test]
    fn integrity_mismatched_digest_aborts() {
        // A digest present but NOT matching the bytes → Mismatch (abort).
        match integrity_decision(Some(SHA256_ABC), b"abcd") {
            IntegrityOutcome::Mismatch { expected, actual } => {
                assert_eq!(expected, SHA256_ABC);
                assert_eq!(actual, sha256_hex(b"abcd"));
                assert_ne!(actual, SHA256_ABC);
            }
            other => panic!("expected Mismatch, got {other:?}"),
        }
    }
}
