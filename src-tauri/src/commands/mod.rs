//! Tauri commands — the typed IPC surface exposed to the frontend.
//!
//! Each submodule owns one functional area. Keep modules small;
//! anything that grows beyond ~200 LoC should split into a deeper
//! tree (e.g. `docker::compose`, `docker::detect`).
//!
//! Error mapping convention: every command returns
//! `Result<T, String>` where the Err arm is a human-readable
//! message safe to display in a UI toast. Internal errors that
//! aren't UI-safe go to the log file via `log::warn!` /
//! `log::error!` first.

pub mod broker_bridge;
pub mod broker_connections;
pub mod broker_stream;
pub mod data_keys;
pub mod docker;
pub mod github_auth;
pub mod healthcheck;
pub mod ibeam;
pub mod ibkr_login;
pub mod installer;
pub mod keychain;
pub mod mcp_sidecar;
pub mod preflight;
pub mod scheduled_update;
pub mod secret_store;
pub mod tray;
pub mod update;
pub mod view;

/// Map any error type to a string suitable for returning across
/// the Tauri IPC boundary. Logs the full debug representation so
/// operators can see the underlying error in the launcher log
/// file even though the user only sees the short message.
pub(crate) fn to_error_string<E: std::fmt::Debug>(err: E) -> String {
    let msg = format!("{:?}", err);
    log::warn!("command error: {}", msg);
    msg
}

/// Shared ticker-symbol shape validator used across every place
/// that takes a user/agent-supplied symbol and either embeds it
/// in a broker REST URL or hands it to a downstream tool. Lives
/// here (vs. duplicated in forge.rs + broker_bridge.rs as it was
/// pre-consolidation) so there's a single rule the audit can
/// point at.
///
/// Accepts: 1..=32 ASCII alphanumeric characters plus the few
/// punctuation characters real tickers carry — `.` (BRK.B style
/// share classes), `-` (some option symbols), `/` (some
/// FX / futures roots), `:` (crypto perp suffixes). Rejects
/// everything else so the symbol can't carry a shell metachar,
/// URL fragment separator, or path separator into downstream
/// commands.
pub(crate) fn is_valid_ticker(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '/' | ':'))
}
