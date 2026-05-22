//! Auracle Desktop Launcher — Rust core.
//!
//! Tiny on purpose. The frontend is the UI; this module is the
//! privileged trust boundary between the web view and the host OS.
//! Every operation that touches the file system, runs a subprocess,
//! reads from the keychain, or hits the network goes through a
//! typed `#[tauri::command]` registered below — there are NO
//! catch-all shell or fs APIs exposed to JavaScript.
//!
//! Module layout:
//!   - `commands::docker`      — `docker compose` CLI invocation
//!   - `commands::healthcheck` — polls Houston's /healthz
//!   - `commands::installer`   — first-time install bootstrap
//!   - `commands::keychain`    — license-key storage in OS keychain
//!   - `commands::preflight`   — port/disk/Docker/network checks
//!     run before `installer::run_first_install`
//!   - `commands::tray`        — system tray icon + menu
//!   - `commands::update`      — GitHub Releases update checker
//!
//! All commands return `Result<T, String>` — Tauri serializes the
//! `Err` arm to the frontend's `.catch()` block. Internal anyhow
//! errors get mapped via `to_error_string` so the frontend sees
//! a clean message rather than a debug-format Rust error.
//!
//! CRASH RESILIENCE (v0.1.6 onward, see CRASH_RESILIENCE.md)
//! --------------------------------------------------------
//! Customer crash reports on v0.1.3 + v0.1.5 showed `abort() called`
//! during `_postDidFinishNotification` with no symbols and no log
//! output anywhere — purely a "app quit unexpectedly" dialog. Three
//! defenses address this:
//!
//! 1. **panic::set_hook → ~/.auracle/desktop-crash.log** (THE ONE
//!    THAT ACTUALLY MATTERS). Writes the panic message + backtrace
//!    to disk before the default abort handler runs. This is what
//!    diagnosed the v0.1.7 crash: a tokio::spawn call in setup()
//!    panicking with "there is no reactor running" — invisible in
//!    the macOS crash report because the offsets pointed at the Rust
//!    panic machinery, not the originating call site. The log file
//!    has the exact line number; CRITICAL infrastructure for any
//!    future startup-path crash debugging.
//!
//! 2. **catch_unwind around plugin chain + setup hook** (COSMETIC
//!    under release builds). Because Cargo.toml sets `panic = "abort"`
//!    to keep the binary small + fast, panics on any thread call
//!    abort() directly without unwinding the stack — meaning
//!    catch_unwind has nothing to catch and is essentially a no-op
//!    in release. We keep the wrappers because (a) they DO work in
//!    debug builds where panic=unwind, useful for developers, and
//!    (b) flipping the Cargo.toml setting later just turns them on.
//!    Don't rely on them in release — rely on the panic hook + on
//!    fixing the actual panic site.
//!
//! 3. **AURACLE_DESKTOP_SAFE_MODE=1** env var skips the store +
//!    updater plugins entirely (launch with `env
//!    AURACLE_DESKTOP_SAFE_MODE=1 open -a "Auracle Desktop"` if a
//!    normal launch crashes and the panic log points at a plugin).

mod commands;

use std::panic;
use std::path::PathBuf;
use std::sync::Once;

use tauri::Builder;

use commands::{
    dashboards as dash_cmd, docker as docker_cmd, forge as forge_cmd,
    healthcheck as health_cmd, ibkr_login as ibkr_login_cmd,
    installer as installer_cmd, keychain as keychain_cmd,
    mcp_sidecar as mcp_cmd, preflight as preflight_cmd,
    scheduled_update as scheduled_update_cmd, tray as tray_cmd, update as update_cmd,
    view as view_cmd,
};

static PANIC_HOOK_INIT: Once = Once::new();

/// Return the path where the launcher writes crash breadcrumbs.
/// ~/.auracle/desktop-crash.log on Unix, %USERPROFILE%\.auracle\...
/// on Windows. Best-effort — falls back to /tmp on resolution failure.
fn crash_log_path() -> PathBuf {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| "/tmp".to_string());
    PathBuf::from(home)
        .join(".auracle")
        .join("desktop-crash.log")
}

/// Install a panic hook that writes the panic to a log file before
/// the default hook runs (which then calls abort() and triggers the
/// macOS crash reporter). The default hook still runs after ours, so
/// stderr output is preserved for users running from terminal.
fn install_panic_hook() {
    PANIC_HOOK_INIT.call_once(|| {
        let default = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            use std::io::Write;
            let path = crash_log_path();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let when = chrono::Utc::now().to_rfc3339();
                let _ = writeln!(
                    f,
                    "\n=== panic at {when} (auracle-desktop v{}) ===",
                    env!("CARGO_PKG_VERSION")
                );
                let _ = writeln!(f, "{info}");
                let bt = std::backtrace::Backtrace::force_capture();
                let _ = writeln!(f, "backtrace:\n{bt}");
                let _ = writeln!(f, "=== end panic ===");
            }
            // Then call the default hook so stderr / system crash
            // reporter still get the panic output too.
            default(info);
        }));
    });
}

/// True iff AURACLE_DESKTOP_SAFE_MODE env is set to a truthy value.
/// When true, the store + updater plugins are skipped — emergency
/// fallback for customers whose disk state crashes those plugins.
fn safe_mode() -> bool {
    matches!(
        std::env::var("AURACLE_DESKTOP_SAFE_MODE")
            .unwrap_or_default()
            .to_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Wrap a plugin constructor in `catch_unwind` so a panic during
/// plugin init doesn't crash the app — logs + returns None, and
/// the calling chain skips registering that plugin.
fn try_plugin<P, F>(name: &str, build: F) -> Option<P>
where
    F: FnOnce() -> P + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(build) {
        Ok(plugin) => {
            log::info!("plugin loaded: {name}");
            Some(plugin)
        }
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic payload".to_string()
            };
            log::error!("plugin {name} panicked during init — continuing without it. error: {msg}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // STEP 1: install the panic hook BEFORE anything else so we
    // capture any panic that happens during builder setup / plugin
    // init / window creation. Without this, customers see only the
    // macOS "Auracle Desktop quit unexpectedly" dialog with no clue
    // about what went wrong.
    install_panic_hook();

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    if safe_mode() {
        log::warn!(
            "AURACLE_DESKTOP_SAFE_MODE=1 — skipping store + updater plugins. \
             Auto-update disabled until you remove the env var."
        );
    }

    // STEP 2: build the plugin chain. Each plugin construction is
    // wrapped in catch_unwind so a panic in one plugin's constructor
    // doesn't kill the launcher. In safe mode, store + updater are
    // skipped entirely (those touch disk + network on init).
    let mut builder: Builder<tauri::Wry> = tauri::Builder::default();

    if let Some(p) = try_plugin("shell", tauri_plugin_shell::init) {
        builder = builder.plugin(p);
    }
    if let Some(p) = try_plugin("dialog", tauri_plugin_dialog::init) {
        builder = builder.plugin(p);
    }
    if let Some(p) = try_plugin("notification", tauri_plugin_notification::init) {
        builder = builder.plugin(p);
    }
    if let Some(p) = try_plugin("opener", tauri_plugin_opener::init) {
        builder = builder.plugin(p);
    }
    if !safe_mode() {
        if let Some(p) = try_plugin("store", || tauri_plugin_store::Builder::default().build()) {
            builder = builder.plugin(p);
        }
        if let Some(p) = try_plugin("updater", || tauri_plugin_updater::Builder::new().build()) {
            builder = builder.plugin(p);
        }
        // Stronghold — encrypted secret store. The hash function
        // turns whatever password we hand the plugin at vault-open
        // time into a 32-byte ChaCha20 key. We use SHA-256 with a
        // versioned constant prefix so we can rotate the derivation
        // later by bumping the prefix (with a one-shot re-encrypt
        // migration). The actual password is machine-derived in
        // commands/secret_store.rs::derive_password().
        if let Some(p) = try_plugin("stronghold", || {
            use sha2::{Digest, Sha256};
            tauri_plugin_stronghold::Builder::new(|password| {
                let mut hasher = Sha256::new();
                hasher.update(b"auracle-desktop-vault-v1:");
                hasher.update(password);
                hasher.finalize().to_vec()
            })
            .build()
        }) {
            builder = builder.plugin(p);
        }
    }

    let builder = builder
        // Setup hook — fires once after the app launches. Tray +
        // healthcheck poll are best-effort; failures are logged but
        // don't crash the app (see CRASH RESILIENCE in module
        // docstring).
        .setup(|app| {
            // catch_unwind handles a panic in setup_tray; Result Err
            // handles a tray-registration error returned via `?`.
            // Either way: log + continue. The main window still loads.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tray_cmd::setup_tray(app)
            }));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    log::error!("tray setup returned error — continuing without menu-bar icon: {e}")
                }
                Err(panic) => {
                    log::error!("tray setup panicked — continuing without menu-bar icon: {panic:?}")
                }
            }
            if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                health_cmd::start_background_poll(app.handle().clone());
            })) {
                log::error!("background healthcheck poll panicked: {panic:?}");
            }
            // Mandatory weekly update on Sundays. See
            // commands/scheduled_update.rs for the policy. Failure
            // to schedule shouldn't block app launch — log + continue.
            if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                scheduled_update_cmd::maybe_run_sunday_update(app.handle().clone());
            })) {
                log::error!("sunday update scheduler panicked: {panic:?}");
            }
            Ok(())
        })
        // Typed IPC commands. The frontend invokes via
        // window.__TAURI__.core.invoke('command_name', { args }).
        .invoke_handler(tauri::generate_handler![
            // Docker / stack management
            docker_cmd::docker_status,
            docker_cmd::docker_install_url,
            docker_cmd::docker_install_landing_url,
            docker_cmd::stack_status,
            docker_cmd::stack_start,
            docker_cmd::stack_stop,
            docker_cmd::stack_pull_update,
            docker_cmd::stack_restart_container,
            docker_cmd::container_logs,
            // Health
            health_cmd::healthcheck_now,
            health_cmd::current_health,
            // Installer
            installer_cmd::is_installed,
            installer_cmd::run_first_install,
            installer_cmd::install_path,
            // Pre-flight (T-02): port / disk / Docker / network
            // gates run before run_first_install. Frontend
            // surfaces results and only enables Install when
            // zero critical checks fail.
            preflight_cmd::preflight_check,
            // Keychain (license keys + secrets)
            keychain_cmd::license_get,
            keychain_cmd::license_set,
            keychain_cmd::license_clear,
            // Updates
            update_cmd::check_for_update,
            update_cmd::install_update,
            update_cmd::current_version,
            // View mode (browser vs embedded)
            view_cmd::get_view_mode,
            view_cmd::set_view_mode,
            view_cmd::open_embedded_auracle,
            // IBKR Client Portal embedded login window
            ibkr_login_cmd::open_ibkr_login,
            ibkr_login_cmd::close_ibkr_login,
            // Forge — strategy authoring + AI chat (Phase 1 + 2 + 3)
            forge_cmd::forge_strategies_dir,
            forge_cmd::forge_set_strategies_dir,
            forge_cmd::forge_list_strategies,
            forge_cmd::forge_read_file,
            forge_cmd::forge_write_file,
            forge_cmd::forge_chat,
            forge_cmd::forge_chat_stream,
            forge_cmd::forge_chat_cancel,
            forge_cmd::forge_agent_run,
            forge_cmd::forge_available_models,
            forge_cmd::forge_get_model,
            forge_cmd::forge_set_model,
            forge_cmd::forge_get_layout_mode,
            forge_cmd::forge_set_layout_mode,
            forge_cmd::forge_strategy_states,
            forge_cmd::forge_set_strategy_state,
            forge_cmd::forge_new_file,
            forge_cmd::forge_rename_file,
            forge_cmd::forge_delete_file,
            forge_cmd::forge_available_templates,
            forge_cmd::anthropic_key_get,
            forge_cmd::anthropic_key_set,
            forge_cmd::anthropic_key_clear,
            // MCP sidecar supervisor (Phase 4c foundation; the
            // actual chat tool-use loop lands in Phase 4d)
            mcp_cmd::mcp_sidecar_status,
            mcp_cmd::mcp_sidecar_start,
            mcp_cmd::mcp_sidecar_stop,
            // Dashboards — persistent, agent-authored visual
            // analytics. See commands/dashboards.rs.
            dash_cmd::forge_dashboards_dir,
            dash_cmd::forge_list_dashboards,
            dash_cmd::forge_read_dashboard,
            dash_cmd::forge_save_dashboard,
            dash_cmd::forge_delete_dashboard,
            dash_cmd::forge_open_dashboard,
            // One-shot agent-tool invocation for the dashboard refresh
            // path. Allow-listed in the command itself; safe for
            // read-only tools only.
            forge_cmd::forge_invoke_tool,
        ]);

    // STEP 3: run the event loop. If this panics, the panic hook
    // installed in step 1 writes the message to disk before macOS
    // shows the crash dialog. We use `.expect()` (not `?`) because
    // there's nothing to recover to if the event loop itself can't
    // start — but the panic hook gives us a paper trail.
    builder
        .run(tauri::generate_context!())
        .expect("error while running Auracle Desktop");
}
