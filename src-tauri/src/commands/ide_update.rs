//! Launcher-managed updates for the **Auracle IDE**.
//!
//! The launcher is the single update conduit on a customer's machine:
//! it already auto-updates *itself* via the Tauri updater (see
//! `update.rs` / `scheduled_update.rs`), and this module extends that
//! role to the native IDE. The IDE no longer self-updates — the
//! launcher detects, downloads, and installs new IDE versions.
//!
//! The IDE ships as GitHub Releases on the public `SiixQuant/auracle-ide`
//! repo. Each release tag is `auracle-v<semver>` and carries a macOS
//! aarch64 disk image asset (`*.dmg`). The check is unauthenticated —
//! these are public releases, so no token is involved and none is ever
//! logged. (We reuse the reqwest patterns from `github_auth.rs`.)
//!
//! INSTALL FLOW (macOS aarch64 only for now):
//!   1. Stream the `.dmg` to a temp file, verifying the byte count
//!      against the release asset's declared size.
//!   2. `hdiutil attach -nobrowse` to mount it read-only.
//!   3. Copy the `.app` into `/Applications`, replacing the old one —
//!      and only AFTER the copy succeeds is the old bundle gone (we
//!      copy to a staging name, swap, then remove). We never delete
//!      the running app before the replacement is in place.
//!   4. `hdiutil detach` to unmount, regardless of copy result.
//!
//! NO SUDO: copying into `/Applications` works for the common
//! user-writable install. If the OS denies the write (a locked-down
//! `/Applications`), we return a plain message telling the user to
//! drag-install — we never silently fail and never fabricate success.
//!
//! WE NEVER AUTO-LAUNCH THE IDE from here. Installing is the whole job;
//! opening the IDE stays an explicit user action (see `view.rs`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::to_error_string;

/// Public GitHub REST endpoint listing releases for the IDE repo. We
/// list (not `/releases/latest`) because `latest` can point at a
/// release whose tag doesn't match our `auracle-v` convention (e.g. a
/// future tooling release in the same repo); we pick the newest tag
/// that does match.
const RELEASES_API_URL: &str = "https://api.github.com/repos/SiixQuant/auracle-ide/releases";

/// GitHub's REST API rejects requests without a User-Agent. Use a
/// stable product token so the call is identifiable (mirrors
/// `github_auth.rs`).
const USER_AGENT: &str = "Auracle-Desktop-Launcher";

/// Tag prefix that marks an IDE release. The version is the remainder
/// (`auracle-v0.1.0` → `0.1.0`).
const TAG_PREFIX: &str = "auracle-v";

/// Where the installed IDE lives on macOS. Matches `view.rs`'s
/// resolution of the installed bundle.
const INSTALLED_APP: &str = "/Applications/Auracle IDE.app";

const HTTP_TIMEOUT_SECS: u64 = 20;
/// Generous ceiling for the streamed download — the asset is ~90 MB;
/// allow slow connections without hanging forever.
const DOWNLOAD_TIMEOUT_SECS: u64 = 600;

// ── Returned shapes ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct IdeUpdateInfo {
    /// Installed IDE version (`CFBundleShortVersionString` from the
    /// app's Info.plist), or `None` when the IDE isn't installed here.
    pub installed_version: Option<String>,
    /// Newest published IDE version (the version part of the newest
    /// `auracle-v*` release tag), or `None` if the repo has no matching
    /// release yet.
    pub latest_version: Option<String>,
    /// True iff a `latest_version` exists AND it is strictly newer than
    /// `installed_version` (or the IDE isn't installed at all). Never
    /// true on a tie or when we can't determine `latest_version`.
    pub update_available: bool,
    /// True iff the IDE is installed on this machine. When false,
    /// `update_available` reflects "install available", and the UI says
    /// "not installed" rather than "update".
    pub installed: bool,
    /// Browser-download URL of the `.dmg` asset for the latest release,
    /// when one is present. Required for `ide_download_and_install`.
    pub asset_url: Option<String>,
    /// Declared byte size of the `.dmg` asset (for a pre-install size
    /// display + a post-download integrity check).
    pub asset_size: Option<u64>,
    /// Release notes (the release body), shown before installing.
    /// Render as PLAIN TEXT only — never as HTML.
    pub notes: Option<String>,
    /// True on platforms we can't install on yet (anything but macOS
    /// aarch64). The UI shows an honest "not yet supported here" state
    /// and hides the install button.
    pub unsupported_platform: bool,
}

/// Progress event emitted to the frontend during the download/install.
/// The Settings IDE card subscribes via `onEvent('ide-update-progress')`.
#[derive(Debug, Clone, Serialize)]
pub struct IdeUpdateProgress {
    /// "downloading" | "installing" | "done" | "error"
    pub phase: String,
    /// Human-readable status line, safe to show as-is.
    pub message: String,
    /// 0-100 best-effort. During download this is real (bytes/total);
    /// the install steps are coarse (mount/copy/detach).
    pub percent: u8,
}

// ── Raw GitHub response shapes ──────────────────────────────────────

#[derive(serde::Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(serde::Deserialize)]
struct GhAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

// ── Version comparison ──────────────────────────────────────────────

/// Parse a dotted version (`0.1.10`, optionally with a leading `v` or a
/// `-suffix` we ignore) into numeric components. Non-numeric or empty
/// input yields `None`. Trailing pre-release/build metadata after the
/// first `-` or `+` is dropped — we only compare the numeric core.
fn parse_version(s: &str) -> Option<Vec<u64>> {
    let core = s.trim().trim_start_matches('v');
    // Drop pre-release (`-rc.1`) / build (`+abc`) metadata.
    let core = core.split(['-', '+']).next().unwrap_or("");
    if core.is_empty() {
        return None;
    }
    let parts: Vec<u64> = core
        .split('.')
        .map(|p| p.parse::<u64>())
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.is_empty() {
        return None;
    }
    Some(parts)
}

/// Compare two dotted versions numerically, component by component,
/// treating a missing trailing component as 0 (so `0.1` == `0.1.0`).
/// Returns `Ordering` over the parsed numeric cores, or `None` when
/// either side can't be parsed (caller decides what "unknown" means).
fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering;
    let va = parse_version(a)?;
    let vb = parse_version(b)?;
    let n = va.len().max(vb.len());
    for i in 0..n {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            other => return Some(other),
        }
    }
    Some(Ordering::Equal)
}

/// True iff `latest` is strictly newer than `installed`. Conservative:
/// when `installed` is `None` (IDE not installed) we treat any parseable
/// `latest` as "available". When versions can't be compared, returns
/// false — we never claim an update we can't prove.
fn is_newer(latest: &str, installed: Option<&str>) -> bool {
    match installed {
        None => parse_version(latest).is_some(),
        Some(cur) => matches!(
            compare_versions(latest, cur),
            Some(std::cmp::Ordering::Greater)
        ),
    }
}

// ── Platform guard ──────────────────────────────────────────────────

/// We can only drive the macOS `hdiutil` + `/Applications` install path
/// today. Everything else reports honestly rather than half-working.
fn is_supported_platform() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

// ── Installed-version probe ─────────────────────────────────────────

/// Read `CFBundleShortVersionString` from the installed IDE's
/// `Info.plist` via `/usr/bin/defaults`, which handles both the binary
/// and XML plist formats. Returns `None` when the IDE isn't installed
/// or the key is absent. Best-effort — never an error to the caller.
#[cfg(target_os = "macos")]
fn installed_version() -> Option<String> {
    use std::process::Command;
    let plist = Path::new(INSTALLED_APP).join("Contents/Info.plist");
    if !plist.exists() {
        return None;
    }
    // `defaults read <path-without-.plist> <key>` — defaults wants the
    // path WITHOUT the trailing `.plist` extension.
    let plist_stem = plist.with_extension("");
    let out = Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(&plist_stem)
        .arg("CFBundleShortVersionString")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

#[cfg(not(target_os = "macos"))]
fn installed_version() -> Option<String> {
    None
}

// ── HTTP ────────────────────────────────────────────────────────────

fn http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(to_error_string)
}

/// Pick the newest release whose tag matches `auracle-v*`, skipping
/// drafts and prereleases. "Newest" is by parsed version, not list
/// order, so an out-of-order release list still resolves correctly.
fn pick_latest(releases: Vec<GhRelease>) -> Option<(String, GhRelease)> {
    let mut best: Option<(String, GhRelease)> = None;
    for rel in releases {
        if rel.draft || rel.prerelease {
            continue;
        }
        let Some(tag) = rel.tag_name.as_deref() else {
            continue;
        };
        let Some(version) = tag.strip_prefix(TAG_PREFIX) else {
            continue;
        };
        let version = version.to_string();
        if parse_version(&version).is_none() {
            continue;
        }
        match &best {
            Some((best_ver, _))
                if compare_versions(&version, best_ver) != Some(std::cmp::Ordering::Greater) => {}
            _ => best = Some((version, rel)),
        }
    }
    best
}

/// Find the macOS `.dmg` asset in a release. Returns its download URL +
/// declared size. There's normally exactly one; if several, the first
/// `.dmg` wins.
fn pick_dmg_asset(rel: &GhRelease) -> Option<(String, u64)> {
    rel.assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".dmg"))
        .map(|a| (a.browser_download_url.clone(), a.size))
}

// ── Commands ────────────────────────────────────────────────────────

/// Check whether a newer Auracle IDE is published, and how it compares
/// to the installed one. Unauthenticated GitHub API call (public
/// releases). Network / rate-limit errors come back as plain messages.
#[tauri::command]
pub async fn ide_check_update() -> Result<IdeUpdateInfo, String> {
    let installed = installed_version();
    let installed_present = installed.is_some();
    let unsupported = !is_supported_platform();

    let client = http_client(HTTP_TIMEOUT_SECS)?;
    let resp = client
        .get(RELEASES_API_URL)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            // Network failure — give an actionable message, not a raw
            // reqwest debug string in the user's face.
            log::warn!("ide update check network error: {e:?}");
            "Couldn't reach GitHub to check for an IDE update. Check your \
             network connection and try again."
                .to_string()
        })?;

    // Rate limiting / forbidden — surface honestly. GitHub returns 403
    // with a `X-RateLimit-Remaining: 0` header when the unauthenticated
    // hourly budget is exhausted.
    if resp.status().as_u16() == 403 || resp.status().as_u16() == 429 {
        let rate_limited = resp
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == "0")
            .unwrap_or(false);
        return Err(if rate_limited {
            "GitHub's rate limit was hit while checking for an IDE update. \
             Try again in a little while."
                .to_string()
        } else {
            "GitHub declined the IDE update check (HTTP 403). Try again later.".to_string()
        });
    }
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub returned {} when checking for an IDE update.",
            resp.status()
        ));
    }

    let releases: Vec<GhRelease> = resp.json().await.map_err(to_error_string)?;

    let Some((latest_version, latest_rel)) = pick_latest(releases) else {
        // Repo reachable but no matching release yet — honest "nothing
        // published", not an error.
        return Ok(IdeUpdateInfo {
            installed_version: installed,
            latest_version: None,
            update_available: false,
            installed: installed_present,
            asset_url: None,
            asset_size: None,
            notes: None,
            unsupported_platform: unsupported,
        });
    };

    let dmg = pick_dmg_asset(&latest_rel);
    let (asset_url, asset_size) = match dmg {
        Some((url, size)) => (Some(url), Some(size)),
        None => (None, None),
    };

    // An update is only actionable when: the platform is supported, a
    // .dmg asset exists, and the latest is strictly newer than installed
    // (or the IDE isn't installed at all).
    let newer = is_newer(&latest_version, installed.as_deref());
    let update_available = newer && !unsupported && asset_url.is_some();

    Ok(IdeUpdateInfo {
        installed_version: installed,
        latest_version: Some(latest_version),
        update_available,
        installed: installed_present,
        asset_url,
        asset_size,
        notes: latest_rel.body.filter(|b| !b.trim().is_empty()),
        unsupported_platform: unsupported,
    })
}

/// Download the IDE `.dmg` from `asset_url` and install it on macOS.
///
/// `expected_size` (when > 0) is the release asset's declared byte
/// count; the download is rejected if the bytes on disk don't match, so
/// a truncated transfer can never be mounted. Emits `ide-update-progress`
/// events throughout.
///
/// Returns the installed version string on success. On any failure
/// returns a plain message — and on a permission-denied copy into
/// `/Applications` the message tells the user to drag-install instead.
#[tauri::command]
pub async fn ide_download_and_install(
    app: AppHandle,
    asset_url: String,
    expected_size: Option<u64>,
) -> Result<String, String> {
    if !is_supported_platform() {
        return Err(
            "Automatic IDE install isn't supported on this platform yet. \
             Download the IDE from the Auracle releases page and install it \
             manually."
                .to_string(),
        );
    }
    // Defensive: only ever fetch from GitHub's release CDN. The URL
    // comes from our own `ide_check_update` today, but pinning the host
    // keeps a future caller from being tricked into fetching elsewhere.
    if !is_trusted_asset_url(&asset_url) {
        return Err("Refusing to download the IDE from an unexpected location.".to_string());
    }

    emit(&app, "downloading", "Starting download…", 0);

    // 1. Stream the .dmg to a temp file.
    let tmp_dir = std::env::temp_dir().join("auracle-ide-update");
    std::fs::create_dir_all(&tmp_dir).map_err(to_error_string)?;
    let dmg_path = tmp_dir.join("AuracleIDE.dmg");
    let downloaded = download_dmg(&app, &asset_url, &dmg_path, expected_size).await;
    // Wrap so we always clean the temp file even on the error path.
    let result = match downloaded {
        Ok(()) => install_dmg(&app, &dmg_path).await,
        Err(e) => Err(e),
    };

    // Best-effort cleanup of the downloaded image — keep the install
    // result regardless of whether cleanup succeeds.
    let _ = std::fs::remove_file(&dmg_path);

    match &result {
        Ok(version) => emit(
            &app,
            "done",
            &format!("Auracle IDE {version} installed."),
            100,
        ),
        Err(e) => emit(&app, "error", e, 0),
    }
    result
}

/// Only allow downloading from GitHub's release-asset hosts. GitHub
/// serves `browser_download_url` from `github.com` (which 302s) and the
/// final bytes from `objects.githubusercontent.com` / `*.githubusercontent.com`.
/// reqwest follows redirects, so checking the initial host is sufficient.
fn is_trusted_asset_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => {
            u.scheme() == "https"
                && matches!(
                    u.host_str(),
                    Some("github.com") | Some("objects.githubusercontent.com")
                )
        }
        Err(_) => false,
    }
}

/// Stream the asset to `dest`, emitting download progress. Verifies the
/// final byte count against `expected_size` when provided (> 0).
async fn download_dmg(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let client = http_client(DOWNLOAD_TIMEOUT_SECS)?;
    let resp = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .map_err(|e| {
            log::warn!("ide dmg download error: {e:?}");
            "Couldn't download the IDE update. Check your network and try again.".to_string()
        })?;
    if !resp.status().is_success() {
        return Err(format!(
            "Download failed — GitHub returned {} for the IDE asset.",
            resp.status()
        ));
    }

    // Prefer the asset's declared size for the percent denominator;
    // fall back to Content-Length.
    let total = expected_size
        .filter(|s| *s > 0)
        .or_else(|| resp.content_length());

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(to_error_string)?;
    let mut written: u64 = 0;
    let mut last_pct: u8 = 0;
    // `Response::chunk()` pulls the body incrementally without needing
    // reqwest's `stream` feature (or a futures combinator) — it streams
    // straight to disk, so a ~90 MB image never has to sit in memory.
    let mut resp = resp;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break, // end of body
            Err(e) => {
                log::warn!("ide dmg stream error: {e:?}");
                return Err("The IDE download was interrupted. Try again.".to_string());
            }
        };
        file.write_all(&chunk).await.map_err(to_error_string)?;
        written += chunk.len() as u64;
        if let Some(total) = total {
            if total > 0 {
                // Cap download progress at 90% — the remaining 10% is
                // the mount + copy + detach, so the bar doesn't jump to
                // 100% and then sit there during the install steps.
                let pct = ((written.min(total) as f64 / total as f64) * 90.0) as u8;
                if pct != last_pct {
                    last_pct = pct;
                    emit(app, "downloading", "Downloading the IDE update…", pct);
                }
            }
        }
    }
    file.flush().await.map_err(to_error_string)?;
    drop(file);

    // Integrity: bytes on disk must match the declared asset size.
    if let Some(expected) = expected_size.filter(|s| *s > 0) {
        if written != expected {
            // Remove the partial file so a retry starts clean.
            let _ = std::fs::remove_file(dest);
            return Err(format!(
                "The IDE download looks incomplete ({written} of {expected} bytes). Try again."
            ));
        }
    }
    if written == 0 {
        let _ = std::fs::remove_file(dest);
        return Err("The IDE download was empty. Try again.".to_string());
    }

    Ok(())
}

/// Mount the `.dmg`, copy the `.app` into `/Applications` (swapping the
/// old one in place — never deleting it before the new one is staged),
/// then unmount. macOS-only — the caller guards the platform.
#[cfg(target_os = "macos")]
async fn install_dmg(app: &AppHandle, dmg_path: &Path) -> Result<String, String> {
    use std::process::Command;

    emit(app, "installing", "Mounting the disk image…", 92);

    // 1. Mount read-only, no Finder window, auto-yes any license
    //    agreement EULA prompt. `-mountpoint` pins the mount location so
    //    we don't have to parse hdiutil's plist output to find it.
    let mount_point = std::env::temp_dir().join("auracle-ide-mount");
    // A stale mount from a previous failed run would block a fresh
    // attach — detach it first (best-effort).
    let _ = Command::new("/usr/bin/hdiutil")
        .arg("detach")
        .arg(&mount_point)
        .arg("-force")
        .output();
    let _ = std::fs::remove_dir_all(&mount_point);

    let attach = Command::new("/usr/bin/hdiutil")
        .arg("attach")
        .arg(dmg_path)
        .arg("-nobrowse")
        .arg("-readonly")
        .arg("-mountpoint")
        .arg(&mount_point)
        .output()
        .map_err(|e| format!("Couldn't run hdiutil to mount the IDE image: {e}"))?;
    if !attach.status.success() {
        let stderr = String::from_utf8_lossy(&attach.stderr);
        log::warn!("hdiutil attach failed: {stderr}");
        return Err("Couldn't mount the downloaded IDE image. Try again.".to_string());
    }

    // Everything after a successful attach must detach on the way out.
    let install_result = copy_app_from_mount(app, &mount_point);

    // 2. Always detach, even if the copy failed.
    emit(app, "installing", "Cleaning up…", 98);
    let _ = Command::new("/usr/bin/hdiutil")
        .arg("detach")
        .arg(&mount_point)
        .arg("-force")
        .output();
    let _ = std::fs::remove_dir_all(&mount_point);

    install_result
}

/// Find the `.app` inside the mounted image and place it in
/// `/Applications`. Copies to a staging path first, then atomically
/// swaps so the running app is never deleted before its replacement is
/// fully in place.
#[cfg(target_os = "macos")]
fn copy_app_from_mount(app: &AppHandle, mount_point: &Path) -> Result<String, String> {
    use std::process::Command;

    emit(app, "installing", "Locating the IDE in the image…", 94);

    // The image's top level should contain exactly one `.app` bundle.
    let app_bundle = find_app_bundle(mount_point)
        .ok_or_else(|| "The downloaded image didn't contain an IDE app.".to_string())?;

    // Read the new app's version up front so we can report it and so a
    // copy that lands a wrong bundle is caught.
    let new_version = bundle_version(&app_bundle)
        .ok_or_else(|| "Couldn't read the new IDE's version from the image.".to_string())?;

    let dest = PathBuf::from(INSTALLED_APP);
    let applications = dest
        .parent()
        .ok_or_else(|| "Internal error resolving /Applications.".to_string())?;
    // Staging path next to the final location so the final swap is a
    // same-filesystem rename (atomic), not a cross-device copy.
    let staging = applications.join(".AuracleIDE.app.incoming");

    emit(app, "installing", "Installing into Applications…", 96);

    // Clean any leftover staging dir from a prior failed run.
    let _ = std::fs::remove_dir_all(&staging);

    // Copy bundle → staging using `cp -R` (preserves the bundle's
    // symlinks + resource forks correctly; std::fs::copy can't recurse).
    let cp = Command::new("/bin/cp")
        .arg("-R")
        .arg(&app_bundle)
        .arg(&staging)
        .output()
        .map_err(|e| format!("Couldn't copy the IDE into place: {e}"))?;
    if !cp.status.success() {
        let stderr = String::from_utf8_lossy(&cp.stderr);
        let _ = std::fs::remove_dir_all(&staging);
        // Permission-denied is the one failure with a clear user remedy.
        if is_permission_error(&stderr) {
            return Err(format!(
                "Couldn't write to {}: permission denied. Quit the IDE if \
                 it's running, or install it manually by dragging Auracle \
                 IDE into your Applications folder.",
                applications.display()
            ));
        }
        log::warn!("cp -R into staging failed: {stderr}");
        return Err("Couldn't copy the IDE into Applications. Try again.".to_string());
    }

    // Swap: move the old app aside, move staging into place, then remove
    // the old one. The destination is only ever empty for the instant
    // between the two renames — and if the second rename fails we
    // restore the old app so the user is never left with no IDE.
    let backup = applications.join(".AuracleIDE.app.old");
    let _ = std::fs::remove_dir_all(&backup);
    let had_existing = dest.exists();
    if had_existing {
        if let Err(e) = std::fs::rename(&dest, &backup) {
            let _ = std::fs::remove_dir_all(&staging);
            log::warn!("couldn't move existing IDE aside: {e}");
            if is_permission_error(&e.to_string()) {
                return Err(format!(
                    "Couldn't replace the existing IDE in {}: permission \
                     denied. Quit the IDE if it's running and try again, or \
                     install it manually.",
                    applications.display()
                ));
            }
            return Err("Couldn't replace the existing IDE. Try again.".to_string());
        }
    }
    if let Err(e) = std::fs::rename(&staging, &dest) {
        // Roll back: put the old app back so we never leave a hole.
        if had_existing {
            let _ = std::fs::rename(&backup, &dest);
        }
        let _ = std::fs::remove_dir_all(&staging);
        log::warn!("couldn't move new IDE into place: {e}");
        return Err("Couldn't finish installing the IDE. Try again.".to_string());
    }
    // New app is in place — remove the old one (best-effort).
    let _ = std::fs::remove_dir_all(&backup);

    Ok(new_version)
}

/// Find the single `.app` bundle at the top level of a mounted image.
#[cfg(target_os = "macos")]
fn find_app_bundle(mount_point: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(mount_point).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("app") {
            return Some(path);
        }
    }
    None
}

/// Read `CFBundleShortVersionString` from an app bundle at an arbitrary
/// path (used for the freshly-copied bundle inside the mount).
#[cfg(target_os = "macos")]
fn bundle_version(app_bundle: &Path) -> Option<String> {
    use std::process::Command;
    let plist = app_bundle.join("Contents/Info.plist");
    if !plist.exists() {
        return None;
    }
    let plist_stem = plist.with_extension("");
    let out = Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(&plist_stem)
        .arg("CFBundleShortVersionString")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Heuristic: does this OS error / stderr indicate a permission denial?
/// Used to give the drag-install remedy instead of a generic "try again".
#[cfg(target_os = "macos")]
fn is_permission_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("permission denied") || m.contains("operation not permitted") || m.contains("eacces")
}

/// Non-macOS install stub. The platform guard in
/// `ide_download_and_install` prevents this from being reached, but the
/// function must exist for the code to compile on other targets.
#[cfg(not(target_os = "macos"))]
async fn install_dmg(_app: &AppHandle, _dmg_path: &Path) -> Result<String, String> {
    Err("Automatic IDE install is only available on macOS.".to_string())
}

/// Emit one progress event to the frontend. Best-effort — a dropped
/// event never fails the install.
fn emit(app: &AppHandle, phase: &str, message: &str, percent: u8) {
    let _ = app.emit(
        "ide-update-progress",
        IdeUpdateProgress {
            phase: phase.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn parses_simple_versions() {
        assert_eq!(parse_version("0.1.0"), Some(vec![0, 1, 0]));
        assert_eq!(parse_version("1.2.3"), Some(vec![1, 2, 3]));
        assert_eq!(parse_version("10.0"), Some(vec![10, 0]));
        assert_eq!(parse_version("v2.5.1"), Some(vec![2, 5, 1]));
    }

    #[test]
    fn parses_versions_with_metadata() {
        assert_eq!(parse_version("0.1.0-rc.1"), Some(vec![0, 1, 0]));
        assert_eq!(parse_version("1.2.3+build7"), Some(vec![1, 2, 3]));
    }

    #[test]
    fn rejects_garbage_versions() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("1.x.0"), None);
        assert_eq!(parse_version("v"), None);
    }

    #[test]
    fn compares_versions_numerically() {
        assert_eq!(compare_versions("0.1.0", "0.1.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.2.0", "0.1.0"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.1.0", "0.2.0"), Some(Ordering::Less));
        // Numeric, not lexical: 0.1.10 > 0.1.9.
        assert_eq!(compare_versions("0.1.10", "0.1.9"), Some(Ordering::Greater));
        // Missing trailing component treated as 0: 0.1 == 0.1.0.
        assert_eq!(compare_versions("0.1", "0.1.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("1.0", "0.9.9"), Some(Ordering::Greater));
    }

    #[test]
    fn compare_unparseable_is_none() {
        assert_eq!(compare_versions("nope", "0.1.0"), None);
        assert_eq!(compare_versions("0.1.0", "nope"), None);
    }

    #[test]
    fn is_newer_handles_not_installed() {
        // Not installed → any parseable latest is "available".
        assert!(is_newer("0.1.0", None));
        // Unparseable latest with nothing installed → not available.
        assert!(!is_newer("garbage", None));
    }

    #[test]
    fn is_newer_strictly_greater_only() {
        assert!(is_newer("0.2.0", Some("0.1.0")));
        assert!(is_newer("0.1.10", Some("0.1.9")));
        // Equal is NOT newer.
        assert!(!is_newer("0.1.0", Some("0.1.0")));
        // Older is not newer.
        assert!(!is_newer("0.1.0", Some("0.2.0")));
        // Unparseable installed → can't prove newer → false.
        assert!(!is_newer("0.2.0", Some("weird-build")));
    }

    #[test]
    fn pick_latest_chooses_newest_matching_tag() {
        let releases = vec![
            GhRelease {
                tag_name: Some("auracle-v0.1.0".into()),
                body: Some("first".into()),
                draft: false,
                prerelease: false,
                assets: vec![],
            },
            GhRelease {
                tag_name: Some("auracle-v0.2.0".into()),
                body: Some("second".into()),
                draft: false,
                prerelease: false,
                assets: vec![],
            },
            // Non-matching tag is ignored.
            GhRelease {
                tag_name: Some("tooling-v9.9.9".into()),
                body: None,
                draft: false,
                prerelease: false,
                assets: vec![],
            },
        ];
        let (version, rel) = pick_latest(releases).expect("a match");
        assert_eq!(version, "0.2.0");
        assert_eq!(rel.body.as_deref(), Some("second"));
    }

    #[test]
    fn pick_latest_skips_drafts_and_prereleases() {
        let releases = vec![
            GhRelease {
                tag_name: Some("auracle-v0.3.0".into()),
                body: None,
                draft: true,
                prerelease: false,
                assets: vec![],
            },
            GhRelease {
                tag_name: Some("auracle-v0.2.5".into()),
                body: None,
                draft: false,
                prerelease: true,
                assets: vec![],
            },
            GhRelease {
                tag_name: Some("auracle-v0.2.0".into()),
                body: None,
                draft: false,
                prerelease: false,
                assets: vec![],
            },
        ];
        let (version, _) = pick_latest(releases).expect("a stable match");
        assert_eq!(version, "0.2.0");
    }

    #[test]
    fn pick_latest_none_when_no_match() {
        let releases = vec![GhRelease {
            tag_name: Some("v1.0.0".into()),
            body: None,
            draft: false,
            prerelease: false,
            assets: vec![],
        }];
        assert!(pick_latest(releases).is_none());
    }

    #[test]
    fn pick_dmg_finds_the_asset() {
        let rel = GhRelease {
            tag_name: Some("auracle-v0.1.0".into()),
            body: None,
            draft: false,
            prerelease: false,
            assets: vec![
                GhAsset {
                    name: "checksums.txt".into(),
                    browser_download_url: "https://github.com/x/checksums.txt".into(),
                    size: 12,
                },
                GhAsset {
                    name: "Auracle-aarch64.dmg".into(),
                    browser_download_url: "https://github.com/x/Auracle-aarch64.dmg".into(),
                    size: 94_000_000,
                },
            ],
        };
        let (url, size) = pick_dmg_asset(&rel).expect("a dmg");
        assert!(url.ends_with("Auracle-aarch64.dmg"));
        assert_eq!(size, 94_000_000);
    }

    #[test]
    fn pick_dmg_none_without_dmg() {
        let rel = GhRelease {
            tag_name: Some("auracle-v0.1.0".into()),
            body: None,
            draft: false,
            prerelease: false,
            assets: vec![GhAsset {
                name: "notes.txt".into(),
                browser_download_url: "https://github.com/x/notes.txt".into(),
                size: 1,
            }],
        };
        assert!(pick_dmg_asset(&rel).is_none());
    }

    #[test]
    fn trusted_asset_url_only_github() {
        assert!(is_trusted_asset_url(
            "https://github.com/SiixQuant/auracle-ide/releases/download/auracle-v0.1.0/Auracle-aarch64.dmg"
        ));
        assert!(is_trusted_asset_url(
            "https://objects.githubusercontent.com/some/path/Auracle-aarch64.dmg"
        ));
        // Wrong host, wrong scheme, garbage → rejected.
        assert!(!is_trusted_asset_url("https://evil.example.com/x.dmg"));
        assert!(!is_trusted_asset_url("http://github.com/x.dmg"));
        assert!(!is_trusted_asset_url("not a url"));
    }
}
