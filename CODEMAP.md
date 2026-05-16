# CODEMAP — `auracle-desktop` (Tauri launcher)

Repo orientation for AI sessions. Read before editing.

---

## Purpose

Native macOS / Windows / Linux launcher that installs and manages
the self-hosted Auracle Docker Compose stack. Tiny Rust core
(privileged trust boundary), web-tech frontend (the UI), zero
framework dependencies (intentional — keeps the binary <3 MB).

Apache-2.0 licensed. Public repo. Customer-facing.

The launcher's only secrets are the license key (OS keychain) and
the install path (preference). Everything else (Stripe MCP token,
broker creds, SMTP password) lives in `~/auracle/.env` and is
owned by the Auracle stack.

---

## Directory layout

```
auracle-desktop/
├── src/                          Web frontend (plain HTML/JS, no framework)
│   ├── index.html                Single-page shell
│   ├── app.js                    Router + view registry
│   ├── components/               Shared UI components
│   ├── styles/                   CSS (vanilla, no preprocessor)
│   └── views/
│       ├── dashboard.js          Stack status + tray-link buttons
│       ├── diagnostics.js        Docker check + healthcheck + logs links
│       ├── logs.js               Live container log streaming
│       ├── onboarding.js         3-step install wizard
│       └── settings.js           License + install path + auto-start
├── src-tauri/                    Rust core
│   ├── Cargo.toml
│   ├── build.rs                  Tauri build hook
│   ├── entitlements.plist        macOS sandbox/entitlements
│   ├── tauri.conf.json           Bundle config (productName, version, icons, signing)
│   ├── capabilities/
│   │   └── default.json          Plugin permission ACL
│   ├── icons/                    Bundle icons (16/32/64/128/256/512/1024 + .icns + .ico)
│   └── src/
│       ├── main.rs               Thin binary entrypoint → lib::run()
│       ├── lib.rs                Plugin registration + invoke_handler!
│       └── commands/
│           ├── docker.rs         docker_status + stack_start/stop/restart + container_logs
│           ├── healthcheck.rs    Background poll of localhost:1969/healthz
│           ├── installer.rs      Download install.sh + run with progress events
│           ├── keychain.rs       OS keychain license-key storage (accepts all key formats)
│           ├── tray.rs           System tray icon + menu
│           └── update.rs         GitHub Releases version check (auto-updater plumbing)
├── scripts/
│   ├── gen-icons.sh              Regenerate icon set from 1024px source
│   └── setup-updater-keys.sh     Generate Ed25519 keypair for Tauri updater
├── docs/
│   └── ci-templates/             Stashed CI workflows (pending OAuth workflow scope)
│       ├── pr.yml
│       └── release.yml
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE                       Apache-2.0
├── README.md
└── CODEMAP.md                    This file
```

---

## Key entrypoints

| File | Purpose |
|---|---|
| `src-tauri/src/main.rs` | Binary entrypoint — calls `auracle_desktop_lib::run()` |
| `src-tauri/src/lib.rs` | All plugin registration + IPC handler list |
| `src-tauri/tauri.conf.json` | Bundle config — version + icons + signing identity |
| `src/index.html` + `src/app.js` | Frontend entry |
| `scripts/setup-updater-keys.sh` | One-time updater keypair generation |
| `.github/workflows/release.yml` | (stashed in `docs/ci-templates/` pending T-17 / T-18) |

---

## How a Tauri command flows

1. Frontend JS calls `await invoke('docker_status')` from any view
2. Tauri IPC routes to the registered handler in `src-tauri/src/lib.rs`
3. Handler is a `#[tauri::command] pub fn docker_status() -> Result<DockerStatus, String>`
4. Handler returns `Result<T, String>` — Tauri serializes `Err` to JS `.catch()`
5. Plugin permission ACL in `capabilities/default.json` gates which
   capabilities the frontend can request

When adding a new command:
- Define in `src-tauri/src/commands/<module>.rs`
- Register in `src-tauri/src/lib.rs`'s `tauri::generate_handler![...]`
- Add capability to `capabilities/default.json` if it needs a plugin
- Call from frontend via `invoke('command_name', { args })`

---

## License handling — start here for license work

| File | Owns |
|---|---|
| `src-tauri/src/commands/keychain.rs` | OS keychain CRUD; accepts `akey_` / `polar_` / JWT (`eyJ…`) formats |
| `src/views/onboarding.js` step 2 | License entry form |
| `src/views/settings.js` | License view/rotate |

Validation is NOT done in the launcher. License key is forwarded to
Houston's `/license/validate` endpoint, which is the authority.
This is why the launcher accepts all key formats — server decides.

License-server URL is currently hardcoded into the Houston container's
default config. Launcher doesn't speak to license server directly;
the running Houston instance does. Launcher only stores the key for
injection into Houston's `.env` during install.

---

## Build + sign

```bash
# Local build (requires Rust + tauri-cli)
cargo install tauri-cli --version "^2.0" --locked
cargo tauri build --bundles dmg              # macOS .dmg
cargo tauri build --bundles msi              # Windows .msi
cargo tauri build --bundles deb,rpm,appimage # Linux

# Output
src-tauri/target/release/bundle/dmg/Auracle\ Desktop_<version>_aarch64.dmg
src-tauri/target/release/auracle-desktop                    # raw binary
```

Code-signing setup:
- **macOS ad-hoc** (current, free): `"signingIdentity": "-"` in
  `tauri.conf.json` → Tauri runs `codesign --force --sign -`.
  Bundle gets `Sealed Resources version=2` + hardened runtime.
  Gatekeeper shows "unidentified developer" (workable) instead of
  "damaged" (blocking).
- **macOS Developer ID** (T-46 in PLAN.md): Add `APPLE_*` env vars,
  Tauri picks them up automatically. Notarization adds 5-10 min to
  CI run.
- **Windows EV cert** (T-82, deferred): Add `WINDOWS_CERTIFICATE`
  + password env vars when wired.

---

## Release process (manual, current state)

```bash
# 1. Bump version in src-tauri/tauri.conf.json + src-tauri/Cargo.toml
# 2. Build for each platform
cargo tauri build --bundles dmg

# 3. Rename for stable URL
cd src-tauri/target/release/bundle/dmg
cp "Auracle Desktop_<v>_aarch64.dmg" Auracle-Desktop-mac-aarch64.dmg

# 4. Tag + push
git tag -a v0.1.x -m "release notes"
git push origin main v0.1.x

# 5. Create GitHub release with both versioned + stable-name dmg
gh release create v0.1.x \
  --title "..." --notes-file notes.md \
  Auracle-Desktop-mac-aarch64.dmg Auracle-Desktop_<v>_aarch64.dmg
```

The marketing site's stable URL
`/releases/latest/download/Auracle-Desktop-mac-aarch64.dmg` auto-
resolves to the newest release. No marketing-site edit per release.

---

## Configuration

| Setting | Location | Notes |
|---|---|---|
| Product name | `tauri.conf.json` → `productName` | Used for bundle filename |
| Version | `tauri.conf.json` → `version` AND `Cargo.toml` → `version` | Keep in sync |
| Icons | `src-tauri/icons/` | Regenerate via `scripts/gen-icons.sh` |
| Bundle identifier | `tauri.conf.json` → `identifier` = `com.auracle.desktop` |
| macOS signing | `tauri.conf.json` → `bundle.macOS.signingIdentity` | `"-"` = ad-hoc |
| Updater pubkey | `tauri.conf.json` → `plugins.updater.pubkey` | Set by `setup-updater-keys.sh` |
| Updater active | `tauri.conf.json` → `plugins.updater.active` | `false` until T-25 wires real keys |
| CSP | `tauri.conf.json` → `app.security.csp` | Restrictive; reviewed via T-56 |
| Min macOS | `tauri.conf.json` → `bundle.macOS.minimumSystemVersion` | `11.0` |

---

## Conventions

- **Rust style**: standard rustfmt. `Result<T, String>` for all
  IPC-facing commands; use `to_error_string()` for the error map.
- **Frontend**: plain JS modules, no bundler. Each view file owns
  its render + event handlers.
- **No external CSS frameworks**. Keep `src/styles/app.css` small
  and readable.
- **Logging**: `log::info!` / `log::warn!` from Rust. Browser
  console from JS.
- **Permissions**: every new plugin call goes through
  `capabilities/default.json`. Minimum necessary.

---

## Common gotchas

- **Icons change requires full rebuild** — Tauri caches the bundle.
  Run `rm -rf src-tauri/target/release/bundle && cargo tauri build`
  to force.
- **Cargo.lock is gitignored** — `git add` won't take it. Fine for
  application crates; binary's lockfile is per-build.
- **macOS Volume name collision** — if you mount the same-named dmg
  twice without unmounting, second mount lands at `/Volumes/Auracle
  Desktop 1/`. Always `hdiutil detach` before re-mounting.
- **`Sealed Resources=none` warning** — was a real bug in v0.1.0
  before ad-hoc signing was added. Now fixed in v0.1.1+.

---

## Where to read more

- Parent: [auracle/PLAN.md](../auracle/PLAN.md) for the launcher's
  outstanding tasks (D-1 through D-14)
- [auracle/INITIATION_PLAN.md](../auracle/INITIATION_PLAN.md) for
  why these tasks are sequenced as they are
- README.md for customer-facing docs
- CONTRIBUTING.md for PR conventions
- CHANGELOG.md for shipped versions
