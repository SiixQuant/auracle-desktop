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
//!
//! Design authority: launcher-redesign-direction.md §3.8 (slice 9).
//! The icon is the brand mark quoted at menu-bar scale — a hairline
//! ring, one satellite on it, and a status-colored core — drawn by
//! `render_orbital` below. It is the launcher's status surface while
//! the window is hidden (§3.8, "lifecycle contract"), so it is the
//! one part of the redesign that must read at 18pt with no words.

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

    // Three items, unchanged. §3.8 floats an optional fourth ("Open
    // Workspace") but conditions it on the healthy gate being honorable
    // from here, and Risk 9 says omit otherwise: the menu has zero dead
    // controls and stays that way. It isn't honorable. `open_auracle_ide`
    // does enforce health with a fresh poll, but it can also fail for two
    // things this process cannot see in advance — a healthy engine with no
    // owner account yet (the home deliberately offers "Finish setup"
    // there, audit P0-10) and a machine with no IDE installed — and the
    // tray has no surface to report a failure on, exactly as the restart
    // handler below (which can only log). A verb that silently does
    // nothing on some machines is the dead control the law forbids, so the
    // workspace stays behind the home's one verb, where the error is
    // visible.
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

/// Status hue for a health state. The semantic hues are unchanged from
/// the plain-disc icon this replaces — only what carries them changed.
fn status_rgb(state: &str) -> (u8, u8, u8) {
    match state {
        "healthy" => (46, 160, 67),   // green
        "degraded" => (210, 153, 34), // amber
        "down" => (218, 54, 51),      // red
        _ => (139, 148, 158),         // grey — unknown / checking
    }
}

/// The orbital mark in the status hue, as an owned RGBA image.
fn status_icon(state: &str) -> Image<'static> {
    let (r, g, b) = status_rgb(state);
    render_orbital(r, g, b)
}

// ── The icon (§3.8 — the mark, quoted at menu-bar scale) ────────────
//
// Everything below is in raster pixels of the 36×36 buffer. macOS draws
// that buffer into an 18pt status item, so one raster pixel is one
// device pixel on a Retina bar and half of one at 1×: the 1.5px ring is
// a hairline in the design-system sense (§2.3) on the display nearly
// every Mac has, and degrades to an antialiased ~0.75px line on the
// rest. Windows / Linux scale the same buffer to their own tray metric.
//
// The composition is re-picked for this size rather than scaled down
// from `orrery.ts` — the same reasoning its ECHO block records: the
// home instrument's orbit is a foreshortened 49:18 ellipse, and at 36px
// that is a 36×13 sliver that reads as a dash, not an orbit. So the
// tray quotes the mark's *anatomy* (ring, one body riding it, a core at
// the centre) at a circle, which is what §3.8 asks for in words: ring +
// core + "one 2px satellite dot on the ring at 45°".

/// Icon edge, in pixels. §3.8: "still 36px".
const ICON_SIZE: u32 = 36;
/// Centre of the raster, in pixel coordinates.
const CENTER: f32 = (ICON_SIZE as f32 - 1.0) / 2.0;
/// Radius of the orbit. Carried over from the disc this replaces, so
/// the icon keeps its optical size in the bar as its weight drops.
const RING_R: f32 = 13.0;
/// §3.8: "hairline ring (≈1.5px)".
const RING_STROKE: f32 = 1.5;
/// The core — the only part that is ever chromatic (§2.1 accent
/// discipline: bodies are ink, the core carries state). Big enough that
/// the hue survives a 1× bar, small enough to leave the ring its air.
const CORE_R: f32 = 5.0;
/// §3.8: "one 2px satellite dot" — a diameter, as every size in the
/// spec is, and the one number here that is in POINTS rather than raster
/// pixels: 2pt across the surface the user actually looks at, so 4px in
/// a buffer drawn at 2×. Taken as raster pixels instead it would be 2px
/// against a 1.5px stroke, i.e. a quarter-pixel bulge on each side of
/// the ring — the satellite would not exist, and an icon with no body
/// riding it is a bullseye, not the mark (§2.5).
const SATELLITE_R: f32 = 2.0;
/// Where it rides, in degrees above the horizontal, to the right. 45°
/// per §3.8, in the mark's own quadrant: its prominent body sits at
/// −11.5° screen bearing, i.e. up and to the right (MARK in orrery.ts).
const SATELLITE_DEG: f32 = 45.0;
/// Chrome ink — `--fg #e6edf3` (§3.8). The ring and the satellite are
/// both drawn in it: a body riding the orbit is part of the mark's
/// drawing, never a second status light (§2.1).
const CHROME: (u8, u8, u8) = (230, 237, 243);
/// …at α.9 (§3.8).
const CHROME_ALPHA: f32 = 0.9;
/// Width of the dark rim carried under every lit part, in pixels.
const RIM: f32 = 1.0;
/// …and its strength. The old disc used 90/255 ≈ .35 to give a
/// saturated fill an edge on a light bar; the rim now has structural
/// work to do, because chrome ink at #e6edf3 is nearly invisible
/// against a light menu bar and the ring's silhouette is what is left.
/// One notch stronger, and still black-on-black — invisible — on a dark
/// bar.
const RIM_ALPHA: f32 = 0.42;

// The composition's two invariants, held at compile time so the mark
// can never be re-proportioned into something that stops being one:
// the core and its rim never reach the ring (or the orbit silts up into
// the disc this replaces), and the satellite always stands a whole
// pixel proud of the stroke it rides (or it is a thickening, not a
// body).
const _: () = assert!(CORE_R + RIM + 0.5 < RING_R - RING_STROKE / 2.0 - RIM - 0.5);
const _: () = assert!(SATELLITE_R - RING_STROKE / 2.0 >= 1.0);

/// Straight (non-premultiplied) RGBA in float, for compositing the
/// three layers of the mark before they land in the byte buffer.
#[derive(Clone, Copy)]
struct Rgba {
    r: f32,
    g: f32,
    b: f32,
    a: f32,
}

impl Rgba {
    const CLEAR: Rgba = Rgba {
        r: 0.0,
        g: 0.0,
        b: 0.0,
        a: 0.0,
    };

    fn new((r, g, b): (u8, u8, u8), a: f32) -> Self {
        Rgba {
            r: f32::from(r),
            g: f32::from(g),
            b: f32::from(b),
            a,
        }
    }

    /// `self` painted over `under` — Porter-Duff source-over.
    fn over(self, under: Rgba) -> Rgba {
        let a = self.a + under.a * (1.0 - self.a);
        if a <= 0.0 {
            return Rgba::CLEAR;
        }
        let mix = |s: f32, u: f32| (s * self.a + u * under.a * (1.0 - self.a)) / a;
        Rgba {
            r: mix(self.r, under.r),
            g: mix(self.g, under.g),
            b: mix(self.b, under.b),
            a,
        }
    }

    /// Straight RGBA bytes — the same non-premultiplied convention the
    /// disc icon handed Tauri.
    fn to_bytes(self) -> [u8; 4] {
        let q = |c: f32| c.clamp(0.0, 255.0).round() as u8;
        [
            q(self.r),
            q(self.g),
            q(self.b),
            q(self.a.clamp(0.0, 1.0) * 255.0),
        ]
    }
}

/// Coverage of a pixel from its signed distance *inside* a shape: 1.0
/// well inside, 0.0 well outside, a linear ramp across the 1px edge.
/// The same antialiasing convention the disc used, kept so the new mark
/// sits on the bar with the old one's edge quality.
fn coverage(inside: f32) -> f32 {
    (inside + 0.5).clamp(0.0, 1.0)
}

/// Where the satellite sits, in pixel coordinates. Screen y grows
/// downward, so "up and to the right" subtracts the sine.
fn satellite_center() -> (f32, f32) {
    let t = SATELLITE_DEG * std::f32::consts::PI / 180.0;
    (CENTER + RING_R * t.cos(), CENTER - RING_R * t.sin())
}

/// Rasterize the orbital mark: a chrome hairline ring with one
/// satellite riding it, a core in the status hue, and a dark rim under
/// all three so the icon holds its shape on a light menu bar. Pure RGBA
/// math — no image decoding, so it can't fail at runtime.
fn render_orbital(r: u8, g: u8, b: u8) -> Image<'static> {
    Image::new_owned(orbital_rgba(r, g, b), ICON_SIZE, ICON_SIZE)
}

/// The raster itself, as bytes. Split from `render_orbital` so the
/// drawing is testable without a Tauri image (and without a display).
fn orbital_rgba(r: u8, g: u8, b: u8) -> Vec<u8> {
    let (sx, sy) = satellite_center();
    let half = RING_STROKE / 2.0;
    let mut buf = vec![0u8; (ICON_SIZE * ICON_SIZE * 4) as usize];

    for y in 0..ICON_SIZE {
        for x in 0..ICON_SIZE {
            let dx = x as f32 - CENTER;
            let dy = y as f32 - CENTER;
            // Distance from the centre, and from the satellite's seat.
            let d = dx.hypot(dy);
            let ds = (x as f32 - sx).hypot(y as f32 - sy);
            // Distance from the ring's centreline: the annulus is the
            // set of pixels within half a stroke of it.
            let ring = (d - RING_R).abs();

            // Chrome (ring ∪ satellite) and the core. Disjoint by
            // construction — the first of the two invariants above.
            let chrome = coverage(half - ring).max(coverage(SATELLITE_R - ds));
            let core = coverage(CORE_R - d);
            // The rim is those same shapes dilated by RIM, minus
            // whatever the lit ink already covers — so it reads as an
            // outline hugging the mark, never as a wash under it.
            let rim = (coverage(half + RIM - ring)
                .max(coverage(SATELLITE_R + RIM - ds))
                .max(coverage(CORE_R + RIM - d))
                - chrome.max(core))
            .clamp(0.0, 1.0);

            let px = Rgba::new((r, g, b), core)
                .over(Rgba::new(CHROME, chrome * CHROME_ALPHA))
                .over(Rgba::new((0, 0, 0), rim * RIM_ALPHA));

            let i = ((y * ICON_SIZE + x) * 4) as usize;
            buf[i..i + 4].copy_from_slice(&px.to_bytes());
        }
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four states the poller can hand us, healthy first.
    const STATES: [&str; 4] = ["healthy", "degraded", "down", "checking"];

    /// One pixel, straight RGBA.
    type Px = (u8, u8, u8, u8);
    /// …and where it sits.
    type Sample = (u32, u32, Px);

    fn px(buf: &[u8], x: u32, y: u32) -> Px {
        let i = ((y * ICON_SIZE + x) * 4) as usize;
        (buf[i], buf[i + 1], buf[i + 2], buf[i + 3])
    }

    /// Distance of a pixel's centre from the icon's centre.
    fn dist(x: u32, y: u32) -> f32 {
        (x as f32 - CENTER).hypot(y as f32 - CENTER)
    }

    /// Every pixel of a state's raster, as (x, y, rgba).
    fn raster(state: &str) -> Vec<Sample> {
        let (r, g, b) = status_rgb(state);
        let buf = orbital_rgba(r, g, b);
        (0..ICON_SIZE)
            .flat_map(|y| (0..ICON_SIZE).map(move |x| (x, y)))
            .map(|(x, y)| (x, y, px(&buf, x, y)))
            .collect()
    }

    /// §3.8: "still 36px". The Tauri image must carry the raster through
    /// at that size — the menu bar scales it, nothing else does.
    #[test]
    fn image_is_a_36px_rgba_square() {
        let image = render_orbital(1, 2, 3);
        assert_eq!(image.width(), 36);
        assert_eq!(image.height(), 36);
        assert_eq!(image.rgba().len(), 36 * 36 * 4);
    }

    /// The semantic hues are unchanged from the disc icon — green /
    /// amber / red, and grey for anything we don't recognise, which is
    /// the only honest answer to a state we can't read.
    #[test]
    fn status_hues_are_the_semantic_four() {
        assert_eq!(status_rgb("healthy"), (46, 160, 67));
        assert_eq!(status_rgb("degraded"), (210, 153, 34));
        assert_eq!(status_rgb("down"), (218, 54, 51));
        assert_eq!(status_rgb("checking"), (139, 148, 158));
        assert_eq!(status_rgb(""), status_rgb("checking"));
        assert_eq!(status_rgb("something-new"), status_rgb("checking"));
    }

    /// The core is what carries state, at full opacity, in the hue the
    /// poller's word maps to — this is the whole information content of
    /// the icon while the window is hidden.
    #[test]
    fn the_core_carries_the_status_hue() {
        for state in STATES {
            let (r, g, b) = status_rgb(state);
            let buf = orbital_rgba(r, g, b);
            for (x, y) in [(17, 17), (18, 18), (17, 18), (18, 17)] {
                assert_eq!(px(&buf, x, y), (r, g, b, 255), "{state} core at {x},{y}");
            }
        }
    }

    /// …and nothing else does. The ring is chrome (§2.1: "the orrery
    /// ring is chrome, not status"), at `--fg` α.9, whatever the engine
    /// is doing.
    #[test]
    fn the_ring_is_chrome_never_status() {
        let on_ring: Vec<_> = raster("down")
            .into_iter()
            .filter(|&(x, y, _)| (dist(x, y) - RING_R).abs() <= 0.2)
            .collect();
        assert!(on_ring.len() >= 8, "no pixels landed on the ring");
        for (x, y, (r, g, b, a)) in on_ring {
            assert_eq!((r, g, b), CHROME, "ring ink at {x},{y}");
            // 0.9 × 255, rounded.
            assert_eq!(a, 230, "ring alpha at {x},{y}");
        }
    }

    /// The mark is an orbit, not a disc: between the core and the ring
    /// there is nothing at all. (The old icon filled this whole area.)
    /// Measured clear of the satellite, whose own rim reaches a little
    /// inside the ring — as a body riding it should.
    #[test]
    fn the_gap_between_core_and_ring_is_empty() {
        let (sx, sy) = satellite_center();
        let gap: Vec<_> = raster("healthy")
            .into_iter()
            .filter(|&(x, y, _)| {
                let d = dist(x, y);
                d > CORE_R + RIM + 0.5
                    && d < RING_R - RING_STROKE / 2.0 - RIM - 0.5
                    && (x as f32 - sx).hypot(y as f32 - sy) > SATELLITE_R + RIM + 1.0
            })
            .collect();
        assert!(gap.len() >= 40, "the gap has no pixels to check");
        for (x, y, pixel) in gap {
            assert_eq!(pixel, (0, 0, 0, 0), "gap at {x},{y}");
        }
    }

    /// §3.8: "one 2px satellite dot on the ring at 45°" — riding the
    /// ring (not inside or outside it), up and to the right, in the
    /// mark's own quadrant.
    #[test]
    fn the_satellite_rides_the_ring_at_45_degrees() {
        let (sx, sy) = satellite_center();
        assert!(((sx - CENTER).hypot(sy - CENTER) - RING_R).abs() < 1e-4);
        assert!(sx > CENTER, "satellite is right of centre");
        assert!(sy < CENTER, "satellite is above centre");
        // The bearing is 45°: equal reach in x and y.
        assert!(((sx - CENTER) - (CENTER - sy)).abs() < 1e-4);

        // It reads as extra ink: the ring is visibly thicker where the
        // satellite sits than at the same seat mirrored through the
        // centre, where the ring runs bare.
        let pixels = raster("healthy");
        let ink = |cx: f32, cy: f32| {
            pixels
                .iter()
                .filter(|&&(x, y, _)| (x as f32 - cx).hypot(y as f32 - cy) <= 2.0)
                .map(|&(_, _, (_, _, _, a))| u32::from(a))
                .sum::<u32>()
        };
        let here = ink(sx, sy);
        let bare = ink(2.0 * CENTER - sx, 2.0 * CENTER - sy);
        assert!(here > bare, "satellite {here} not heavier than ring {bare}");
    }

    /// The dark rim (kept from the disc, §3.8) is what holds the mark
    /// together on a LIGHT menu bar, where #e6edf3 chrome is nearly
    /// invisible: a translucent black outline hugging the ring, never a
    /// wash, never opaque.
    #[test]
    fn a_dark_rim_outlines_the_mark_for_light_bars() {
        let (sx, sy) = satellite_center();
        let outside: Vec<_> = raster("healthy")
            .into_iter()
            .filter(|&(x, y, _)| {
                let d = dist(x, y);
                // Just beyond the ring's ink, and clear of the satellite.
                d > RING_R + RING_STROKE / 2.0 + 0.6
                    && d < RING_R + RING_STROKE / 2.0 + RIM
                    && (x as f32 - sx).hypot(y as f32 - sy) > SATELLITE_R + RIM + 1.0
            })
            .collect();
        assert!(outside.len() >= 8, "no rim pixels to check");
        for (x, y, (r, g, b, a)) in outside {
            assert_eq!((r, g, b), (0, 0, 0), "rim ink at {x},{y}");
            assert!(a > 0 && a < 255, "rim alpha {a} at {x},{y}");
        }
    }

    /// Nothing is clipped: the whole mark, rim included, sits inside the
    /// raster, so the menu bar gets a complete icon with its own margin
    /// rather than a shape cut off at the edge.
    #[test]
    fn the_mark_never_touches_the_raster_edge() {
        for (x, y, pixel) in raster("degraded") {
            if x == 0 || y == 0 || x == ICON_SIZE - 1 || y == ICON_SIZE - 1 {
                assert_eq!(pixel, (0, 0, 0, 0), "edge ink at {x},{y}");
            }
        }
    }

    /// Tooltip strings are unchanged by this slice (§3.8: "menu/tooltip
    /// semantics unchanged").
    #[test]
    fn tooltips_are_unchanged() {
        assert_eq!(
            status_tooltip("healthy"),
            "Auracle Desktop — Engine healthy"
        );
        assert_eq!(
            status_tooltip("degraded"),
            "Auracle Desktop — Engine degraded"
        );
        assert_eq!(
            status_tooltip("down"),
            "Auracle Desktop — Engine not running"
        );
        assert_eq!(status_tooltip("checking"), "Auracle Desktop — checking…");
        assert_eq!(status_tooltip("whatever"), status_tooltip("checking"));
    }
}
