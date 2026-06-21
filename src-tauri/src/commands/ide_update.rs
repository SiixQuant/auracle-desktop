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
//! aarch64 disk image asset (`*.dmg`) plus a published SHA-256 checksum:
//! the `<dmg>.sha256` sidecar the build emits, and the launcher
//! additionally tolerates a combined `checksums.txt` should one ever be
//! published. The check is unauthenticated — these are public releases,
//! so no token is involved and none is ever logged. (We reuse the reqwest
//! patterns from `github_auth.rs`.)
//!
//! INSTALL FLOW (macOS aarch64 only for now):
//!   1. Stream the `.dmg` to a temp file, verifying the byte count
//!      against the release asset's declared size.
//!   2. Verify the streamed image against the release's PUBLISHED
//!      SHA-256: fetch the `<dmg>.sha256` sidecar (host-pinned to
//!      github.com), compute the file's SHA-256, and ABORT the install if
//!      they don't match — so a corrupted or tampered image is never
//!      mounted. A missing/unfetchable checksum is treated as a failure,
//!      not a skip: we never install something we can't verify.
//!   3. `hdiutil attach -nobrowse` to mount it read-only.
//!   4. Copy the `.app` into `/Applications`, replacing the old one —
//!      and only AFTER the copy succeeds is the old bundle gone (we
//!      copy to a staging name, swap, then remove). We never delete
//!      the running app before the replacement is in place.
//!   5. `hdiutil detach` to unmount, regardless of copy result.
//!
//! NO SUDO: copying into `/Applications` works for the common
//! user-writable install. If the OS denies the write (a locked-down
//! `/Applications`), we return a plain message telling the user to
//! drag-install — we never silently fail and never fabricate success.
//!
//! WE NEVER AUTO-LAUNCH THE IDE from here. Installing is the whole job;
//! opening the IDE stays an explicit user action (see `view.rs`).

// `Path` is used on every platform (the download dest + the non-macOS
// install stub); `PathBuf` is only needed in the macOS install path, so
// it's imported inside those functions to keep non-macOS clippy clean
// (`-D unused-imports`).
use std::path::Path;

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
/// resolution of the installed bundle. macOS-only — referenced solely
/// by the macOS probe + install path, so it's gated to avoid a
/// dead-code warning on other targets.
#[cfg(target_os = "macos")]
const INSTALLED_APP: &str = "/Applications/Auracle IDE.app";

const HTTP_TIMEOUT_SECS: u64 = 20;
/// Generous ceiling for the streamed download — the asset is ~90 MB;
/// allow slow connections without hanging forever.
const DOWNLOAD_TIMEOUT_SECS: u64 = 600;
/// Hard ceiling on a fetched checksum body. A `<dmg>.sha256` sidecar is
/// ~85 bytes; even a large combined `checksums.txt` is a few KB. The cap
/// stops a misbehaving or hostile host (one that omits Content-Length and
/// streams chunked) from making us buffer megabytes for a tiny file.
const MAX_CHECKSUM_BYTES: usize = 1 << 20; // 1 MiB

// ── Returned shapes ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct IdeUpdateInfo {
    /// Installed IDE version, read from the marker the launcher writes when
    /// it installs a release (`~/.auracle/ide_version`). `None` when the
    /// IDE isn't installed here, OR it was installed out-of-band so we
    /// can't trust its version (the app bundle's own version string is the
    /// upstream editor's, not the Auracle release — comparing it would lie).
    pub installed_version: Option<String>,
    /// True iff `installed_version` came from our marker (trustworthy).
    /// False when the bundle exists but we never recorded its version —
    /// the UI then shows "version unknown" + offers a reinstall rather
    /// than a bogus up-to-date/upgrade claim.
    pub version_tracked: bool,
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

/// Path to the version marker the launcher writes after it installs an
/// IDE release: `~/.auracle/ide_version`. This — not the app bundle's own
/// version string (which is the upstream editor's) — is the source of
/// truth for "which Auracle IDE release is installed".
fn version_marker_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(Path::new(&home).join(".auracle").join("ide_version"))
}

/// Read the recorded installed version, or `None` if we never wrote one.
fn tracked_version() -> Option<String> {
    let p = version_marker_path()?;
    let v = std::fs::read_to_string(p).ok()?.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// Record the version we just installed so future checks compare against
/// the real Auracle release, not the bundle's upstream version. Best-effort.
fn write_version_marker(version: &str) {
    if let Some(p) = version_marker_path() {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&p, version);
    }
}

/// True iff the IDE app bundle is present on disk.
#[cfg(target_os = "macos")]
fn bundle_present() -> bool {
    Path::new(INSTALLED_APP).exists()
}

#[cfg(not(target_os = "macos"))]
fn bundle_present() -> bool {
    false
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
    let installed_present = bundle_present();
    // Only a marker-recorded version is trustworthy; the bundle's own
    // version string is the upstream editor's, not the Auracle release.
    let installed = if installed_present {
        tracked_version()
    } else {
        None
    };
    let version_tracked = installed.is_some();
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
            version_tracked,
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

    // An update is actionable when the platform is supported, a .dmg asset
    // exists, and either the IDE isn't installed, or the latest is strictly
    // newer than the TRACKED installed version. An installed-but-untracked
    // IDE never claims an upgrade (we can't trust its version) — the UI
    // offers a reinstall instead, keyed off version_tracked.
    let newer = if installed_present && !version_tracked {
        false
    } else {
        is_newer(&latest_version, installed.as_deref())
    };
    let update_available = newer && !unsupported && asset_url.is_some();

    Ok(IdeUpdateInfo {
        installed_version: installed,
        version_tracked,
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
    version: String,
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
    // Wrap so we always clean the temp file even on the error path. The
    // published SHA-256 is verified BEFORE mounting — a corrupt or
    // tampered image must never reach hdiutil or `/Applications`.
    let result = match downloaded {
        Ok(()) => match verify_checksum(&app, &asset_url, &dmg_path).await {
            Ok(()) => install_dmg(&app, &dmg_path).await,
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    };

    // Best-effort cleanup of the downloaded image — keep the install
    // result regardless of whether cleanup succeeds.
    let _ = std::fs::remove_file(&dmg_path);

    match result {
        Ok(_bundle_ver) => {
            // Record the Auracle release we installed — the source of truth
            // for future checks (the bundle's own version is upstream's).
            write_version_marker(&version);
            emit(
                &app,
                "done",
                &format!("Auracle IDE {version} installed."),
                100,
            );
            Ok(version)
        }
        Err(e) => {
            emit(&app, "error", &e, 0);
            Err(e)
        }
    }
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

// ── Checksum verification ───────────────────────────────────────────

/// Verify the freshly-downloaded `.dmg` against the release's PUBLISHED
/// SHA-256 before anything mounts it. We fetch the checksum that ships
/// alongside the asset — the `<dmg>.sha256` sidecar the build emits, and
/// (if ever published) a combined `checksums.txt` in the same release
/// directory — parse the expected digest, hash the file on disk, and
/// compare. Any failure (missing checksum, malformed file, or mismatch)
/// aborts the install: we never mount an image we can't prove. This runs
/// AFTER the byte-count check in `download_dmg`, so it's the binding
/// integrity gate.
async fn verify_checksum(app: &AppHandle, asset_url: &str, dmg_path: &Path) -> Result<(), String> {
    emit(app, "downloading", "Verifying the download…", 91);

    let dmg_filename = asset_url.rsplit('/').next().unwrap_or_default();

    // Candidate checksum URLs in preference order: the per-asset sidecar
    // (`<dmg>.sha256`), then a combined `checksums.txt` in the same release
    // directory. Both share the asset's host, so they inherit the
    // github.com pin checked by the caller.
    let mut candidates = vec![format!("{asset_url}.sha256")];
    candidates.extend(
        asset_url
            .rsplit_once('/')
            .map(|(base, _)| format!("{base}/checksums.txt")),
    );

    // Fetch each candidate's body (`None` = untrusted host or fetch
    // failure), then pick the first that yields a digest for our dmg.
    let mut bodies: Vec<Option<String>> = Vec::with_capacity(candidates.len());
    for url in candidates {
        // Never fetch a checksum from an unexpected host. The derived URLs
        // share the asset's host, so this only ever rejects a malformed URL.
        if is_trusted_asset_url(&url) {
            bodies.push(fetch_checksum_body(&url).await);
        } else {
            bodies.push(None);
        }
    }
    // A `None` here means NO candidate published a usable checksum — fail
    // closed: we never install something we can't verify.
    let expected = select_expected_digest(&bodies, dmg_filename).ok_or_else(|| {
        "Couldn't verify the IDE download: the release didn't publish a \
         usable SHA-256 checksum. Refusing to install an unverified build."
            .to_string()
    })?;

    let actual = compute_file_sha256(dmg_path)?;
    if !checksums_match(&expected, &actual) {
        // Drop the suspect file so a retry starts clean and nothing else
        // can pick it up.
        let _ = std::fs::remove_file(dmg_path);
        log::warn!("ide dmg checksum mismatch: expected {expected}, got {actual}");
        return Err(
            "The IDE download failed SHA-256 verification — the file may be \
             corrupted or tampered with. Refusing to install. Try again."
                .to_string(),
        );
    }
    Ok(())
}

/// GET a (small) checksum file as text. Returns `None` on any network or
/// HTTP error so the caller can fall through to the next candidate URL.
async fn fetch_checksum_body(url: &str) -> Option<String> {
    let client = http_client(HTTP_TIMEOUT_SECS).ok()?;
    let resp = match client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::warn!("ide checksum fetch error: {e:?}");
            return None;
        }
    };
    if !resp.status().is_success() {
        return None;
    }
    // Read with a hard ceiling so a host that omits Content-Length and
    // streams chunked can't make us buffer unbounded data. Mirrors the
    // chunked streaming used for the .dmg download.
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > MAX_CHECKSUM_BYTES {
                    log::warn!("ide checksum body exceeded {MAX_CHECKSUM_BYTES} bytes; refusing");
                    return None;
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                log::warn!("ide checksum body read error: {e:?}");
                return None;
            }
        }
    }
    // A checksum file is ASCII; non-UTF-8 → treat as no checksum (fail closed).
    String::from_utf8(buf).ok()
}

/// Pull a lowercase 64-char hex SHA-256 digest out of a published checksum
/// file. Accepts a bare digest, `shasum`/`sha256sum` output
/// (`<digest>  <filename>`), and a multi-entry `checksums.txt` (we prefer
/// the line that names `dmg_filename`). Returns `None` if no valid digest
/// is present.
fn parse_sha256(contents: &str, dmg_filename: &str) -> Option<String> {
    let is_hex64 = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());

    // Prefer a line naming our dmg (handles a combined checksums.txt that
    // lists several assets). Match the filename as a WHOLE whitespace-
    // delimited token, never a substring, so a sibling whose name merely
    // starts with ours — `Auracle-aarch64.dmg.blockmap`, `…dmg.sig`, or even
    // the `…dmg.sha256` sidecar itself — can't shadow the real `.dmg` line.
    // The leading `*` is the GNU coreutils binary-mode marker (`*<file>`).
    if !dmg_filename.is_empty() {
        let mut saw_named_line = false;
        for line in contents.lines() {
            if line
                .split_whitespace()
                .any(|t| t.trim_start_matches('*') == dmg_filename)
            {
                saw_named_line = true;
                if let Some(tok) = line.split_whitespace().find(|t| is_hex64(t)) {
                    return Some(tok.to_ascii_lowercase());
                }
            }
        }
        // A line named our dmg but carried no valid digest (a malformed or
        // truncated entry): fail closed rather than borrowing some other
        // asset's digest from the bare-token scan below.
        if saw_named_line {
            return None;
        }
    }
    // Fallback: the first 64-hex token anywhere (a bare digest, or a
    // single-entry sidecar like `<digest>  <file>` where no line names us).
    contents
        .split_whitespace()
        .find(|t| is_hex64(t))
        .map(|t| t.to_ascii_lowercase())
}

/// Pick the expected digest from candidate checksum bodies in preference
/// order. Each entry is `None` when that candidate failed to fetch (or came
/// from an untrusted host). Returns the first body that yields a digest for
/// `dmg_filename`, or `None` when NO candidate does — callers MUST treat
/// `None` as fail-closed (abort the install; never verify against nothing).
fn select_expected_digest(bodies: &[Option<String>], dmg_filename: &str) -> Option<String> {
    bodies
        .iter()
        .filter_map(|b| b.as_deref())
        .find_map(|b| parse_sha256(b, dmg_filename))
}

/// Compare a published digest against a computed one, case-insensitively.
/// Both are 64-char hex in practice; we trim and lower to be defensive
/// about stray whitespace or upstream casing.
fn checksums_match(expected: &str, actual: &str) -> bool {
    expected.trim().eq_ignore_ascii_case(actual.trim())
}

/// Compute the SHA-256 of a file on disk as a lowercase hex string.
/// Streams in fixed-size chunks so a ~90 MB image never sits fully in
/// memory.
fn compute_file_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(to_error_string)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(to_error_string)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(to_hex(&hasher.finalize()))
}

/// Lowercase hex-encode bytes. Tiny local helper so we don't pull in the
/// `hex` crate just for one digest.
fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
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
    use std::path::PathBuf;
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
fn find_app_bundle(mount_point: &Path) -> Option<std::path::PathBuf> {
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

    // ── Checksum verification ───────────────────────────────────────

    // SHA-256("abc") — the canonical NIST test vector, reused below.
    const SHA256_ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn parse_sha256_bare_digest() {
        assert_eq!(
            parse_sha256(SHA256_ABC, "Auracle-aarch64.dmg").as_deref(),
            Some(SHA256_ABC)
        );
        // Trailing whitespace / newline is tolerated.
        assert_eq!(
            parse_sha256(&format!("{SHA256_ABC}\n"), "").as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_shasum_output() {
        // `shasum -a 256` / `sha256sum` form: `<digest>  <filename>`.
        let body = format!("{SHA256_ABC}  Auracle-aarch64.dmg\n");
        assert_eq!(
            parse_sha256(&body, "Auracle-aarch64.dmg").as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_picks_matching_line_in_checksums_txt() {
        let other = "1111111111111111111111111111111111111111111111111111111111111111";
        let body = format!("{other}  some-other-asset.zip\n{SHA256_ABC}  Auracle-aarch64.dmg\n");
        // Must pick the line naming OUR dmg, not merely the first digest.
        assert_eq!(
            parse_sha256(&body, "Auracle-aarch64.dmg").as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_ignores_dmg_prefixed_siblings() {
        // Siblings whose names START WITH the dmg name (the `.sha256` sidecar
        // itself, a `.blockmap`, a detached `.sig`) must NOT shadow the real
        // `.dmg` line — even when listed first. A substring match would have
        // latched onto the sibling's digest.
        let sib = "1111111111111111111111111111111111111111111111111111111111111111";
        let body = format!(
            "{sib}  Auracle-aarch64.dmg.sha256\n\
             {sib}  Auracle-aarch64.dmg.blockmap\n\
             {SHA256_ABC}  Auracle-aarch64.dmg\n"
        );
        assert_eq!(
            parse_sha256(&body, "Auracle-aarch64.dmg").as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_tolerates_binary_mode_marker() {
        // GNU coreutils binary mode prints `<digest> *<file>`.
        let body = format!("{SHA256_ABC} *Auracle-aarch64.dmg\n");
        assert_eq!(
            parse_sha256(&body, "Auracle-aarch64.dmg").as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_fails_closed_on_malformed_named_line() {
        // Our dmg's line exists but carries no valid digest; another asset's
        // line does. We must NOT borrow that unrelated digest — return None
        // so verification fails closed rather than against the wrong file.
        let other = "1111111111111111111111111111111111111111111111111111111111111111";
        let body = format!("notahexdigest  Auracle-aarch64.dmg\n{other}  other.zip\n");
        assert_eq!(parse_sha256(&body, "Auracle-aarch64.dmg"), None);
    }

    #[test]
    fn select_expected_digest_fails_closed_without_a_usable_body() {
        let dmg = "Auracle-aarch64.dmg";
        // No candidate fetched (all None) → None → caller aborts.
        assert_eq!(select_expected_digest(&[None, None], dmg), None);
        // Candidates fetched but empty / garbage → None → caller aborts.
        assert_eq!(
            select_expected_digest(&[Some(String::new()), Some("not a checksum".into())], dmg),
            None
        );
        // First usable body wins, skipping earlier failed fetches.
        let good = format!("{SHA256_ABC}  {dmg}\n");
        assert_eq!(
            select_expected_digest(&[None, Some(good)], dmg).as_deref(),
            Some(SHA256_ABC)
        );
    }

    #[test]
    fn parse_sha256_normalizes_uppercase() {
        let upper = SHA256_ABC.to_ascii_uppercase();
        assert_eq!(parse_sha256(&upper, "").as_deref(), Some(SHA256_ABC));
    }

    #[test]
    fn parse_sha256_rejects_garbage() {
        assert_eq!(parse_sha256("", "x.dmg"), None);
        assert_eq!(parse_sha256("not a checksum at all", "x.dmg"), None);
        // 63 hex chars — wrong length.
        assert_eq!(parse_sha256(&"a".repeat(63), "x.dmg"), None);
        // 64 chars but not all hex.
        assert_eq!(parse_sha256(&format!("{}z", "a".repeat(63)), "x.dmg"), None);
    }

    #[test]
    fn checksums_match_case_and_whitespace_insensitive() {
        let upper = SHA256_ABC.to_ascii_uppercase();
        assert!(checksums_match(SHA256_ABC, &upper));
        assert!(checksums_match(&format!("  {SHA256_ABC}  "), SHA256_ABC));
        // A single different nibble must NOT match.
        let wrong = format!("0{}", &SHA256_ABC[1..]);
        assert!(!checksums_match(SHA256_ABC, &wrong));
    }

    // Per-process-unique temp path so concurrent `cargo test` runs (or a
    // leftover file from a crashed run) can't collide.
    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "auracle-ide-checksum-{}-{tag}.bin",
            std::process::id()
        ))
    }

    #[test]
    fn compute_file_sha256_matches_known_vectors() {
        // SHA-256("abc") and SHA-256("") — known NIST vectors.
        let abc = temp_path("abc");
        std::fs::write(&abc, b"abc").expect("write temp");
        let got = compute_file_sha256(&abc).expect("hash");
        let _ = std::fs::remove_file(&abc);
        assert_eq!(got, SHA256_ABC);

        let empty = temp_path("empty");
        std::fs::write(&empty, b"").expect("write temp");
        let got_empty = compute_file_sha256(&empty).expect("hash");
        let _ = std::fs::remove_file(&empty);
        assert_eq!(
            got_empty,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn checksum_primitives_accept_match_reject_tamper() {
        // Composition smoke check of the checksum building blocks
        // (parse_sha256 + compute_file_sha256 + checksums_match). This does
        // NOT drive verify_checksum itself (which is async/network-bound);
        // it pins that a matching image passes the compare and tampered
        // bytes against the same published digest are rejected.
        let good = temp_path("good");
        std::fs::write(&good, b"abc").expect("write temp");
        let actual = compute_file_sha256(&good).expect("hash");
        let _ = std::fs::remove_file(&good);

        let published = format!("{SHA256_ABC}  Auracle-aarch64.dmg\n");
        let expected = parse_sha256(&published, "Auracle-aarch64.dmg").expect("a digest");
        assert!(checksums_match(&expected, &actual));

        // Tampered: same published digest, different bytes on disk.
        let bad = temp_path("bad");
        std::fs::write(&bad, b"abcd").expect("write temp");
        let actual_bad = compute_file_sha256(&bad).expect("hash");
        let _ = std::fs::remove_file(&bad);
        assert!(!checksums_match(&expected, &actual_bad));
    }
}
