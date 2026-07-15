//! System-tray icon + menu.
//!
//! macOS shows in the menu bar (NSStatusItem); Windows in the
//! notification area; Linux via StatusNotifierItem (KDE / GNOME
//! / Cinnamon all support it). Tauri's tray-icon plugin
//! abstracts the per-OS difference.
//!
//! Color: green (healthy) / yellow (degraded/starting) / red
//! (down). Updated by the healthcheck poller via a
//! tokio::watch channel — see healthcheck.rs.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

pub fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let open_launcher = MenuItemBuilder::new("Show Auracle Desktop")
        .id("open-launcher")
        .build(app)?;
    let restart = MenuItemBuilder::new("Restart Auracle Stack")
        .id("restart")
        .build(app)?;
    let quit = MenuItemBuilder::new("Quit Auracle Desktop")
        .id("quit")
        .build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&open_launcher, &restart, &separator, &quit])
        .build()?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Auracle Desktop — checking…")
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open-launcher" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "restart" => {
                tauri::async_runtime::spawn(async move {
                    let dir = match crate::commands::installer::resolve_install_path() {
                        Ok(d) => d,
                        Err(e) => {
                            log::warn!("tray restart: install path: {e}");
                            return;
                        }
                    };
                    // Don't recreate a stack a different working_dir owns under
                    // our project name (a dev checkout at ~/Downloads/auracle).
                    // No UI to surface an error here, so log + skip.
                    if let Err(e) =
                        crate::commands::docker::ensure_engine_home_unclaimed(&dir).await
                    {
                        log::warn!("tray restart skipped: {e}");
                        return;
                    }
                    // `up -d` rather than `restart`: restart only touches
                    // containers that still exist, so it can't recover a
                    // stack that was brought down or had its containers
                    // removed — exactly the "engine not running" case. `up
                    // -d` recreates whatever is missing and is a no-op for
                    // what's already healthy.
                    let _ = tokio::process::Command::new("docker")
                        .args(["compose", "up", "-d"])
                        .current_dir(&dir)
                        .status()
                        .await;
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
