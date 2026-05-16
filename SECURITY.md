# Security Policy

For Auracle security disclosures, see the canonical policy:

- [`SECURITY.md`](https://github.com/SiixQuant/Auracle/blob/main/SECURITY.md) in the main `auracle` repo
- [`/.well-known/security.txt`](https://auracle-engine.com/.well-known/security.txt) on auracle-engine.com (RFC 9116)

## Report a vulnerability

Email **security@aurapointcapital.com**, or file a [private GitHub Security Advisory](https://github.com/SiixQuant/Auracle/security/advisories/new) on the main repo.

Please do NOT open a public issue. We aim to triage within 48 hours.

## In-scope for this repo

This repository (`auracle-desktop` — the Tauri launcher) is in-scope.
See the main SECURITY.md for the full scope statement and safe-harbor
language.

## Repo-specific notes

- Tauri 2 + Rust + plain HTML/JS — no Electron, no third-party UI framework
- License key is stored in the OS keychain (macOS Keychain, Windows
  Credential Manager, Linux libsecret) — never on disk
- Ad-hoc code-signed (`signingIdentity: "-"`) as of v0.1.1; not Apple
  Developer ID-signed yet (deferred until paying-customer revenue
  justifies the $99/yr cost)
- IPC commands are typed via `#[tauri::command]`; capability ACL in
  `src-tauri/capabilities/default.json` gates which surfaces the
  frontend can invoke
- `src-tauri/tauri.conf.json` `app.security.csp` is restrictive
  (no `unsafe-eval`, no wildcard `connect-src`) — review pending
  in T-56 (PLAN.md)
