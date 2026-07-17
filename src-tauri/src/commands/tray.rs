//! System-tray icon + menu.
//!
//! macOS shows in the menu bar (NSStatusItem); Windows in the
//! notification area; Linux via StatusNotifierItem (KDE / GNOME
//! / Cinnamon all support it). Tauri's tray-icon plugin
//! abstracts the per-OS difference.
//!
//! Icon color reflects engine health: green (healthy) / amber
//! (degraded) / red (down) / grey (checking). The healthcheck
//! poller pushes each new state onto this tray by id through
//! `apply_health` — see healthcheck.rs.

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, AppHandle, Manager,
};

/// Stable id for the launcher's single tray icon. The healthcheck
/// poller looks the tray up by this id to update its color + tooltip.
pub const TRAY_ID: &str = "auracle-status";

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

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(status_icon("unknown"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip(status_tooltip("unknown"))
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
                    // Resolve the Docker CLI the same way every other stack
                    // command does. A Finder-launched macOS app inherits a
                    // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that omits
                    // Docker's bin dir, so a bare `docker` fails to spawn here
                    // even when Docker is installed — resolve_docker_bin()
                    // probes the known install locations.
                    let Some(bin) = crate::commands::docker::resolve_docker_bin().await else {
                        log::warn!("tray restart: Docker CLI not found on PATH");
                        return;
                    };
                    // `up -d` rather than `restart`: restart only touches
                    // containers that still exist, so it can't recover a
                    // stack that was brought down or had its containers
                    // removed — exactly the "engine not running" case. `up
                    // -d` recreates whatever is missing and is a no-op for
                    // what's already healthy.
                    let _ = tokio::process::Command::new(&bin)
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

    // The status icon carries its own color, so opt out of macOS
    // template tinting (which would force it monochrome).
    let _ = tray.set_icon_as_template(false);

    Ok(())
}

/// Push the latest engine-health state onto the tray icon + tooltip.
///
/// Safe to call from any thread: the tray setters marshal to the main
/// thread internally. A no-op if the tray failed to register.
pub fn apply_health(app: &AppHandle, state: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(status_icon(state)));
        let _ = tray.set_icon_as_template(false);
        let _ = tray.set_tooltip(Some(status_tooltip(state)));
    }
}

/// Tooltip text for a health state.
fn status_tooltip(state: &str) -> String {
    let label = match state {
        "healthy" => "Engine healthy",
        "degraded" => "Engine degraded",
        "down" => "Engine not running",
        _ => "checking…",
    };
    format!("Auracle Desktop — {label}")
}

/// Colored status dot for a health state, as an owned RGBA image.
fn status_icon(state: &str) -> Image<'static> {
    let (r, g, b) = match state {
        "healthy" => (46, 160, 67),   // green
        "degraded" => (210, 153, 34), // amber
        "down" => (218, 54, 51),      // red
        _ => (139, 148, 158),         // grey — unknown / checking
    };
    render_dot(r, g, b)
}

/// Rasterize a filled, anti-aliased disc with a faint dark rim so it
/// stays legible on both light and dark menu bars. Pure RGBA math —
/// no image decoding, so it can't fail at runtime.
fn render_dot(r: u8, g: u8, b: u8) -> Image<'static> {
    const N: u32 = 36;
    const RADIUS: f32 = 13.0;
    let center = (N as f32 - 1.0) / 2.0;
    let mut buf = vec![0u8; (N * N * 4) as usize];
    for y in 0..N {
        for x in 0..N {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            // 1.0 inside the disc, fading to 0 across a 1px edge.
            let fill = (RADIUS - dist + 0.5).clamp(0.0, 1.0);
            // A thin darker rim one pixel beyond the fill.
            let rim = ((RADIUS + 1.0) - dist + 0.5).clamp(0.0, 1.0);
            let i = ((y * N + x) * 4) as usize;
            if fill > 0.0 {
                buf[i] = r;
                buf[i + 1] = g;
                buf[i + 2] = b;
                buf[i + 3] = (fill * 255.0) as u8;
            } else if rim > 0.0 {
                // rgb stays 0 -> a translucent dark edge.
                buf[i + 3] = (rim * 90.0) as u8;
            }
        }
    }
    Image::new_owned(buf, N, N)
}
