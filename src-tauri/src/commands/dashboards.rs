//! Forge Dashboards — persistent, agent-authored visual analytics.
//!
//! A Dashboard is a JSON spec stored at:
//!
//!   <strategies_parent>/forge/dashboards/<slug>.json
//!
//! where <strategies_parent> is the parent of the configured
//! strategies directory (defaults to ~/auracle/, so the canonical
//! path is ~/auracle/forge/dashboards/).
//!
//! The spec describes a grid of widgets — KPI cards, tables, charts,
//! 3D surfaces — each pointing at one of the agent's data-source
//! tools. The frontend's WidgetRenderer turns each widget into the
//! right React component; the dashboard_loop module (Phase 4)
//! periodically re-invokes each widget's data source and pushes
//! updates to the renderer via Tauri events.
//!
//! Why JSON-as-canonical-form (vs. e.g. generated TypeScript):
//!
//!   1. The agent authors them. Anthropic models reliably produce
//!      well-formed JSON; producing well-formed React components is
//!      harder + brittle.
//!   2. They round-trip through git cleanly — operators can
//!      version-control their dashboards alongside their strategies.
//!   3. The renderer can evolve (new widget types, new layouts)
//!      without forcing every stored dashboard to be regenerated.
//!
//! Security: every path the agent passes through goes through the
//! same no-parent-dir-escape resolver as strategy files. Slugs are
//! validated as lowercase alphanumeric + hyphen, 1–64 chars, no
//! leading/trailing hyphen. The on-disk filename is always
//! `<validated_slug>.json` — the agent never controls the suffix
//! or directory.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::to_error_string;

const DASHBOARD_DIR_NAME: &str = "forge";
const DASHBOARD_SUBDIR: &str = "dashboards";
const DASHBOARD_ARCHIVE: &str = ".archive";

/// Maximum on-disk size of a single dashboard spec. Generous
/// (a complex dashboard is a few KB of JSON) but prevents the
/// agent from accidentally writing a megabyte of duplicated data
/// in one tool call.
const MAX_DASHBOARD_BYTES: usize = 256 * 1024;

// ── Dashboard schema ─────────────────────────────────────────────

/// The canonical on-disk shape of a dashboard. Widgets are kept as
/// `serde_json::Value` so adding a new widget type in the frontend
/// doesn't require a Rust release — the launcher stores and ships
/// whatever JSON the agent wrote, the renderer validates client-side.
///
/// The wrapper fields (slug, title, timestamps, refresh interval,
/// layout) are strongly typed because they drive backend behavior
/// (file lookup, refresh-loop scheduling, file-tree display).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dashboard {
    pub slug: String,
    pub title: String,
    /// ISO-8601 UTC timestamp.
    pub created_at: String,
    /// ISO-8601 UTC timestamp.
    pub updated_at: String,
    /// How often the live-refresh loop polls each widget's data
    /// source. Clamped to [5, 3600] on save.
    pub refresh_interval_seconds: u32,
    /// "grid" | "rows" | "tabs" — interpreted by the renderer.
    pub layout: String,
    pub widgets: Vec<serde_json::Value>,
}

/// Trimmed view returned by list_dashboards — full widgets array
/// is heavy (each spec can be a few KB), and the file tree only
/// needs label + freshness data.
#[derive(Debug, Clone, Serialize)]
pub struct DashboardSummary {
    pub slug: String,
    pub title: String,
    pub updated_at: String,
    pub widget_count: usize,
    pub refresh_interval_seconds: u32,
}

// ── Path resolution + slug validation ────────────────────────────

/// Resolve the directory dashboards live in. Derived from the
/// configured strategies directory's parent so dashboards travel
/// with the Auracle install (one umbrella `~/auracle/` for code +
/// visualizations + execution).
///
/// Creates the directory on first call so writes don't fail with
/// ENOENT on a fresh install — same UX as strategies_dir.
fn resolve_dashboards_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let strategies = super::forge::resolve_strategies_dir_public(app)?;
    let parent = strategies.parent().ok_or_else(|| {
        "strategies directory has no parent — cannot derive dashboards dir".to_string()
    })?;
    let dir = parent.join(DASHBOARD_DIR_NAME).join(DASHBOARD_SUBDIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(to_error_string)?;
    }
    Ok(dir)
}

/// Validate a slug. The frontend + agent both produce slugs; this
/// enforces the on-disk shape across both. Rules:
///
///   - 1..=64 characters
///   - lowercase ASCII letters, digits, hyphens
///   - no leading or trailing hyphen
///   - no consecutive hyphens (cosmetic; keeps filenames readable)
///
/// Reserved names (`.archive`, `.cache`, anything starting with `.`)
/// are rejected so they can't collide with our internal subdirs.
fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty() || slug.len() > 64 {
        return Err(format!(
            "invalid dashboard slug {slug:?}: must be 1..=64 chars"
        ));
    }
    if slug.starts_with('.') {
        return Err(format!(
            "invalid dashboard slug {slug:?}: cannot start with '.'"
        ));
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err(format!(
            "invalid dashboard slug {slug:?}: cannot start or end with '-'"
        ));
    }
    if slug.contains("--") {
        return Err(format!(
            "invalid dashboard slug {slug:?}: cannot contain consecutive hyphens"
        ));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(format!(
            "invalid dashboard slug {slug:?}: only lowercase a-z, 0-9, and '-' allowed"
        ));
    }
    Ok(())
}

fn slug_to_path(app: &AppHandle, slug: &str) -> Result<PathBuf, String> {
    validate_slug(slug)?;
    let dir = resolve_dashboards_dir(app)?;
    Ok(dir.join(format!("{slug}.json")))
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Tauri commands (frontend + agent surface) ────────────────────

#[tauri::command]
pub async fn forge_dashboards_dir(app: AppHandle) -> Result<String, String> {
    let dir = resolve_dashboards_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Seed the welcome dashboard on first launch IF the dashboards
/// directory is empty. Idempotent — once any dashboard exists (saved
/// by the user, by the agent, or by a previous seed call), this is
/// a no-op. Failure to seed is logged + swallowed; an empty
/// dashboards view is recoverable, a failed seed shouldn't break
/// the rest of the launcher.
fn maybe_seed_welcome(app: &AppHandle) {
    let dir = match resolve_dashboards_dir(app) {
        Ok(d) => d,
        Err(_) => return,
    };
    // Cheap directory-empty check — early-exit before we parse
    // any JSON.
    let has_any = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        })
        .unwrap_or(true); // if read_dir fails, assume populated; safer
    if has_any {
        return;
    }
    let spec = welcome_dashboard_spec();
    let path = dir.join("welcome-tour.json");
    let json = match serde_json::to_string_pretty(&spec) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("dashboards: welcome seed serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&path, json) {
        log::warn!("dashboards: welcome seed write failed: {e}");
    }
}

/// The out-of-box welcome dashboard. Pure data widgets that work
/// without an IBKR connection — the SPY line chart uses Yahoo
/// Finance via get_historical_bars; the markdown panel explains
/// what Forge can do next.
fn welcome_dashboard_spec() -> Dashboard {
    let now = now_iso8601();
    Dashboard {
        slug: "welcome-tour".to_string(),
        title: "Welcome to Auracle Forge".to_string(),
        created_at: now.clone(),
        updated_at: now,
        refresh_interval_seconds: 60,
        layout: "rows".to_string(),
        widgets: vec![
            // 1. Markdown intro panel
            serde_json::json!({
                "id": "intro-notes",
                "type": "notes_md",
                "title": "What Forge can do",
                "data_source": { "tool": "inline", "args": {} },
                "body": "# Welcome — this is what Forge can build for you\n\n\
                        Forge is the agent-powered authoring surface inside Auracle. Ask in plain \
                        English for a strategy, a dashboard, a chart, an account view — Forge \
                        builds it inline and persists it.\n\n\
                        **Try one of these as your first prompt:**\n\n\
                        - *Build me a dashboard with my IBKR account summary and a 90-day chart of SPY*\n\
                        - *Show me a candlestick chart of QQQ over the last 6 months with volume*\n\
                        - *Write an RSI mean-reversion strategy on liquid US ETFs*\n\
                        - *Rank my open positions by unrealized P&L*\n\n\
                        **To pull live broker data**: open Settings → Broker Connections and \
                        connect IBKR. The market-data widgets work without a broker (via \
                        Yahoo Finance) — but account, position, and quote widgets need IBKR \
                        logged in.\n\n\
                        Every dashboard you build is saved as JSON under \
                        `~/auracle/forge/dashboards/` — version-control them, share them \
                        between machines, copy them as templates."
            }),
            // 2. SPY 90-day line chart — uses Yahoo Finance so it
            // works on a fresh install with no broker setup.
            serde_json::json!({
                "id": "spy-90d",
                "type": "line_chart",
                "title": "SPY · last 90 trading days (Yahoo Finance)",
                "data_source": {
                    "tool": "get_historical_bars",
                    "args": { "symbol": "SPY", "days": 90 }
                },
                "x_field": "date",
                "series": [
                    { "key": "close", "label": "Close", "color": "#60a5fa" }
                ]
            }),
            // 3. SPY OHLC candles — same data, different shape.
            serde_json::json!({
                "id": "spy-candles",
                "type": "candlestick_chart",
                "title": "SPY · OHLC + volume",
                "data_source": {
                    "tool": "get_historical_bars",
                    "args": { "symbol": "SPY", "days": 90 }
                },
                "x_field": "date",
                "volume_field": "volume"
            }),
        ],
    }
}

#[tauri::command]
pub async fn forge_list_dashboards(app: AppHandle) -> Result<Vec<DashboardSummary>, String> {
    // Seed the welcome dashboard on first call after install. Safe
    // to do here rather than at app startup: list_dashboards is the
    // first thing the preview pane calls, so seeding here means
    // it's present by the time the user looks at the panel.
    maybe_seed_welcome(&app);
    let dir = resolve_dashboards_dir(&app)?;
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(out), // missing dir = empty list, not an error
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Defensive: validate the slug on read too — if a stale
        // bad-name file ends up in the dir, skip it rather than
        // surface it (and let the user know they have orphans
        // they can clean up if they want).
        if validate_slug(stem).is_err() {
            log::warn!("dashboards: skipping file with invalid slug: {path:?}");
            continue;
        }
        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("dashboards: skipping {path:?}: read failed: {e}");
                continue;
            }
        };
        let dash: Dashboard = match serde_json::from_str(&contents) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("dashboards: skipping {path:?}: parse failed: {e}");
                continue;
            }
        };
        out.push(DashboardSummary {
            slug: dash.slug,
            title: dash.title,
            updated_at: dash.updated_at,
            widget_count: dash.widgets.len(),
            refresh_interval_seconds: dash.refresh_interval_seconds,
        });
    }
    // Newest first — most operators want their latest work surfaced.
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub async fn forge_read_dashboard(app: AppHandle, slug: String) -> Result<Dashboard, String> {
    let path = slug_to_path(&app, &slug)?;
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("dashboard {slug:?} doesn't exist"),
        _ => to_error_string(e),
    })?;
    let dash: Dashboard = serde_json::from_slice(&bytes)
        .map_err(|e| format!("dashboard {slug:?} on disk is corrupt: {e}"))?;
    Ok(dash)
}

/// Create or overwrite a dashboard. The agent's `create_dashboard`
/// tool routes here. Validates the slug, clamps the refresh interval
/// into the [5, 3600] band, normalizes timestamps, then atomically
/// replaces the on-disk file.
#[tauri::command]
pub async fn forge_save_dashboard(
    app: AppHandle,
    mut dashboard: Dashboard,
) -> Result<DashboardSummary, String> {
    validate_slug(&dashboard.slug)?;
    if dashboard.title.trim().is_empty() {
        return Err("dashboard title cannot be empty".to_string());
    }
    if dashboard.title.len() > 200 {
        return Err("dashboard title is too long (>200 chars)".to_string());
    }
    if !matches!(dashboard.layout.as_str(), "grid" | "rows" | "tabs") {
        return Err(format!(
            "invalid dashboard layout {:?}: must be 'grid', 'rows', or 'tabs'",
            dashboard.layout
        ));
    }
    dashboard.refresh_interval_seconds = dashboard.refresh_interval_seconds.clamp(5, 3600);
    // Light sanity-check on widgets: each one must have an `id`,
    // a `type`, and a `data_source`. Anything else is up to the
    // renderer to validate. Cap the widget count so a runaway
    // generation can't produce a 10000-widget JSON blob.
    if dashboard.widgets.len() > 32 {
        return Err(format!(
            "too many widgets ({}); cap is 32 per dashboard",
            dashboard.widgets.len()
        ));
    }
    for (i, w) in dashboard.widgets.iter().enumerate() {
        let obj = w
            .as_object()
            .ok_or_else(|| format!("widget #{i} is not a JSON object"))?;
        for required in ["id", "type", "data_source"] {
            if !obj.contains_key(required) {
                return Err(format!(
                    "widget #{i} is missing required field {required:?}"
                ));
            }
        }
    }

    // Stamp timestamps so the agent doesn't have to produce wall-
    // clock strings (which it often gets wrong).
    let now = now_iso8601();
    if dashboard.created_at.is_empty() {
        dashboard.created_at = now.clone();
    }
    dashboard.updated_at = now;

    let json = serde_json::to_string_pretty(&dashboard).map_err(to_error_string)?;
    if json.len() > MAX_DASHBOARD_BYTES {
        return Err(format!(
            "dashboard too large ({} bytes); cap is {MAX_DASHBOARD_BYTES} bytes",
            json.len()
        ));
    }

    let path = slug_to_path(&app, &dashboard.slug)?;
    // Atomic-rename pattern so a half-written file can't outlive
    // a crash mid-write.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(to_error_string)?;
    std::fs::rename(&tmp, &path).map_err(to_error_string)?;

    Ok(DashboardSummary {
        slug: dashboard.slug,
        title: dashboard.title,
        updated_at: dashboard.updated_at,
        widget_count: dashboard.widgets.len(),
        refresh_interval_seconds: dashboard.refresh_interval_seconds,
    })
}

#[tauri::command]
pub async fn forge_delete_dashboard(app: AppHandle, slug: String) -> Result<(), String> {
    let path = slug_to_path(&app, &slug)?;
    if !path.exists() {
        return Ok(()); // already gone — idempotent
    }
    // Soft delete: move to .archive/<slug>-<timestamp>.json so a
    // user who clicks Delete by accident can recover without a
    // git checkout. The archive directory is created lazily.
    let dir = resolve_dashboards_dir(&app)?;
    let archive = dir.join(DASHBOARD_ARCHIVE);
    if !archive.exists() {
        std::fs::create_dir_all(&archive).map_err(to_error_string)?;
    }
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let archived = archive.join(format!("{slug}-{ts}.json"));
    std::fs::rename(&path, &archived).map_err(to_error_string)?;
    Ok(())
}

/// Frontend signal: "the agent (or the user) wants the preview
/// pane to switch to this dashboard." Emits a Tauri event the
/// PreviewPane listens for; the frontend handles the actual UI
/// switch. Backend stays stateless about "which dashboard is open"
/// — that's UI state.
#[tauri::command]
pub async fn forge_open_dashboard(app: AppHandle, slug: String) -> Result<(), String> {
    // Verify it exists + parses before emitting — better to error
    // here than to have the frontend try to open a missing one.
    let _ = forge_read_dashboard(app.clone(), slug.clone()).await?;
    app.emit("forge-dashboard-open", slug)
        .map_err(to_error_string)?;
    Ok(())
}
