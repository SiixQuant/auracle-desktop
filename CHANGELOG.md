# Changelog

Notable changes per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Phase 0 scaffolding: Tauri 2.x shell, Rust command modules
  (docker / healthcheck / installer / keychain / tray / update),
  vanilla HTML/CSS/JS frontend (dashboard / diagnostics / logs /
  settings views), CI workflows (PR lint + tagged release).
- OS keychain license-key storage via the `keyring` crate.
- System tray menu with quick-open dashboard / Jupyter / restart
  stack / quit.
- `cargo tauri dev` runs end-to-end against a local Auracle stack
  installed at `~/auracle/`.

## [0.1.0] — TBD (first tagged release)

Targets Phase 1 MVP completion per the launcher plan: macOS only,
manual update, basic onboarding flow.
