//! Mandatory weekly auto-update on Sundays.
//!
//! Policy: once a week — Sundays in the customer's local timezone —
//! the launcher checks for an update on its first launch of the day.
//! If one exists, it downloads + installs + restarts without asking
//! the customer to confirm. The trade-off (interruption vs always
//! patched) is intentional: a launcher running a customer's live
//! trading stack must not lag behind security or correctness fixes.
//!
//! What "first launch on Sunday" means in practice:
//!
//!   - On every launch, compare today's local date to the last
//!     stored `last_forced_update_check` date.
//!   - If today is a Sunday AND it's been ≥ 7 days since the last
//!     forced check (or no last check stored): run the check.
//!   - The "≥ 7 days" gate means we never run twice in a row; if
//!     a customer launches the app at 9 am Sunday and again at 4 pm
//!     Sunday, only the first launch triggers the check.
//!   - If a customer skips a Sunday entirely (launcher closed all
//!     day Sunday), the NEXT launch — Monday or later — picks up
//!     the missed check. Never enforce more than once per week, but
//!     never silently skip a missed week either.
//!
//! "Force" semantics: when an update is found, we call the same
//! `update.download_and_install()` path the manual `install_update`
//! command uses, then `app.restart()`. No UI prompt; no countdown.
//! From the customer's perspective the launcher closes, reopens
//! ~30 s later on the new version. They lose any unsaved state in
//! the embedded WebView (most surfaces are stateless reads).
//!
//! Quiet hours: not implemented in this version. A future iteration
//! can refuse to enforce between, say, 09:30 and 16:00 US/Eastern
//! to avoid interrupting market-hours sessions. For now we treat
//! Sunday as a known-quiet day for US equities — equity markets
//! are closed.

use chrono::Datelike;
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::UpdaterExt;

const STORE_FILE: &str = "auto-update-state.json";
const KEY_LAST_CHECK: &str = "last_forced_check_date";

/// Top-level entry point — spawned from `lib.rs::run()`'s setup
/// hook on a background thread. Returns immediately; the work runs
/// asynchronously inside the Tauri runtime.
pub fn maybe_run_sunday_update(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&app).await {
            // Log + continue — a failed update check shouldn't
            // prevent the launcher from working. Customer can still
            // use Settings → Check for Update to install manually.
            log::warn!("sunday update check skipped: {e}");
        }
    });
}

async fn run(app: &tauri::AppHandle) -> Result<(), String> {
    if !is_due(app) {
        log::debug!("sunday update: not due today");
        return Ok(());
    }

    log::info!("sunday update: checking for new version");
    record_check_today(app);

    let updater = app
        .updater()
        .map_err(|e| format!("updater unavailable: {e:?}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e:?}"))?
    else {
        log::info!("sunday update: already on latest version");
        return Ok(());
    };

    log::warn!(
        "sunday update: installing v{} (current v{}). Launcher will restart.",
        update.version,
        env!("CARGO_PKG_VERSION")
    );
    update
        .download_and_install(
            |_, _| {}, // chunk progress — silent
            || log::info!("sunday update: download complete; installing"),
        )
        .await
        .map_err(|e| format!("download/install failed: {e:?}"))?;

    // Replaces the running process with the new binary — never returns.
    app.restart();
}

/// True iff today is Sunday in the customer's local timezone AND
/// it's been at least 7 days since the last forced check (or no
/// previous check is recorded).
fn is_due(app: &tauri::AppHandle) -> bool {
    let today = chrono::Local::now().date_naive();
    if today.weekday() != chrono::Weekday::Sun {
        return false;
    }
    let last = read_last_check(app);
    match last {
        Some(d) => (today - d).num_days() >= 7,
        None => true, // never checked before — first Sunday counts
    }
}

fn read_last_check(app: &tauri::AppHandle) -> Option<chrono::NaiveDate> {
    let store = app.store(STORE_FILE).ok()?;
    let raw = store.get(KEY_LAST_CHECK)?;
    let s = raw.as_str()?;
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

fn record_check_today(app: &tauri::AppHandle) {
    let today = chrono::Local::now().date_naive();
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(
            KEY_LAST_CHECK,
            serde_json::Value::String(today.format("%Y-%m-%d").to_string()),
        );
        if let Err(e) = store.save() {
            log::warn!("could not persist last_forced_check date: {e:?}");
        }
    }
}
