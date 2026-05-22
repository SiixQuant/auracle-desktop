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

pub mod dashboards;
pub mod docker;
pub mod forge;
pub mod healthcheck;
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
