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

mod commands;

use commands::{
    docker as docker_cmd, healthcheck as health_cmd, installer as installer_cmd,
    keychain as keychain_cmd, preflight as preflight_cmd, tray as tray_cmd, update as update_cmd,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        // Plugin registration — must happen BEFORE invoke_handler.
        // Plugins extend the IPC surface; capabilities/default.json
        // gates which permissions actually fire.
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Setup hook — fires once after the app launches. Used to
        // build the system-tray icon + start the background
        // healthcheck poll.
        //
        // CRASH-RESILIENCE (added 2026-05-17 after a customer crash
        // report on v0.1.3): tray setup is treated as best-effort.
        // Previously `tray_cmd::setup_tray(app)?` would propagate
        // any tray-registration error up through the setup hook,
        // causing Tauri to abort() inside
        // _postDidFinishNotification — the whole app failed to
        // launch because the menu-bar icon couldn't be created.
        // The launcher's primary window is fully functional without
        // a tray icon, so we now log + continue if tray setup
        // fails. Same defensive treatment for the background
        // healthcheck poll.
        .setup(|app| {
            if let Err(e) = tray_cmd::setup_tray(app) {
                log::error!(
                    "tray setup failed — continuing without menu-bar \
                     icon. Restart the app to retry. error: {e}"
                );
            }
            // Background poll is fire-and-forget; failures inside
            // are logged at the call site. Catch panics defensively
            // anyway so a poll thread panic can't bring down the UI.
            if let Err(panic) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                health_cmd::start_background_poll(app.handle().clone());
            })) {
                log::error!("background healthcheck poll failed to start: {:?}", panic);
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
            update_cmd::current_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Auracle Desktop");
}
