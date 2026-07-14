# Auracle Desktop

Native launcher for the [Auracle](https://github.com/SiixQuant/Auracle) algorithmic-trading platform. It wraps the engine's Docker Compose stack and keeps the [Auracle IDE](https://github.com/SiixQuant/auracle-ide) up to date, so installing, running, and updating your local Auracle is one click instead of six terminal commands. This is the front door: most people install Auracle by installing the launcher.

> Status: **shipping.** The launcher installs and supervises the engine, delivers IDE updates, surfaces health and diagnostics, and opens the workbench from a single Standby screen.

---

## What it does

| Without the launcher | With the launcher |
|---|---|
| `cd ~/auracle && docker compose pull && docker compose up -d --force-recreate houston` | Click "Pull Update" |
| Open Terminal, find your install dir, `tail -f logs.txt` | Click Logs → pick a container |
| Notice the stack is unhealthy via the dashboard going blank | Tray icon turns red, click → Diagnostics |
| Email support a stack trace and your `.env` | Click "Get Help" — opens a GitHub issue prefilled with diagnostics |

The launcher is a **thin shell** — it manages the same Docker Compose stack that `install.sh` produces. It does NOT replace the web UI; the web UI is where you USE Auracle. The launcher is where you OPERATE Auracle.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Auracle Desktop (Tauri)                    │
│                                             │
│  Frontend (web view)   ←→   Rust core       │
│  - Dashboard               - Docker CLI     │
│  - Diagnostics             - Healthcheck    │
│  - Logs                    - OS keychain    │
│  - Settings                - Auto-updater   │
│                            - Tray icon      │
└─────────────────────────────────────────────┘
              │                  │
              ▼                  ▼
       ┌────────────┐    ┌─────────────┐
       │ User's     │    │ Docker      │
       │ browser    │◄───┤ Desktop     │
       │ (https://  │    │             │
       │  localhost)│    └─────────────┘
       └────────────┘           │
                                ▼
                         ┌─────────────┐
                         │ Auracle     │
                         │ stack       │
                         │ (6 services)│
                         └─────────────┘
```

Frontend: vanilla HTML/CSS/JS for the scaffold (will likely upgrade to Vue or React in Phase 1 polish).
Backend: Rust + Tauri 2.x. Every privileged operation is a typed `#[tauri::command]` — there is no free-form shell or fs API exposed to JavaScript.

---

## First-time install — trust this download

Until the launcher has a steady customer base, builds are **unsigned**
(no Apple Developer ID or Windows EV cert — those purchases come once
the desktop apps justify the ~$500/yr setup). You'll see one warning
per machine on first launch:

### macOS

> "Apple could not verify 'Auracle Desktop.app' is free of malware that
> may harm your Mac or compromise your privacy." — **Not Opened** /
> **Move to Trash**

Click **Done** (never "Move to Trash"), then trust the app — the steps
differ by macOS version:

**macOS 15 Sequoia and later** (Apple removed the old right-click → Open
bypass here):

1. Open **System Settings → Privacy & Security**
2. Scroll to Security — you'll see *""Auracle Desktop.app" was blocked…"*
3. Click **Open Anyway**, then confirm with Touch ID / your password

**macOS 14 Sonoma and earlier:**

1. In Finder, right-click **Auracle Desktop.app** → **Open**
2. Click **Open** on the confirmation

**Any version — the reliable one-liner** (clears the download quarantine
so the app launches normally):

```bash
xattr -dr com.apple.quarantine "/Applications/Auracle Desktop.app"
```

> Builds are ad-hoc signed but not yet Apple-Developer-ID **notarized**,
> so a freshly downloaded copy is quarantined and Gatekeeper blocks the
> first launch. Notarized builds (no warning at all) ship once an Apple
> Developer ID is added to the release pipeline — the workflow is already
> wired for it, gated on the `APPLE_*` secrets.

### Windows

> "Windows protected your PC."

1. Click **More info** on the SmartScreen warning
2. Click **Run anyway**

Chrome may also flag the `.exe` as "not commonly downloaded." Click
the arrow in the downloads bar → **Keep**.

### Linux

Usually no warning. AppImage needs to be marked executable:

```bash
chmod +x Auracle-Desktop-*.AppImage
```

Auto-updates ARE signed (free Ed25519 key, never expires) so subsequent
versions install silently after the first install. Only the initial
download needs the click-through.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Rust | 1.77+ | Tauri 2 minimum |
| Node | not required | scaffolding ships vanilla JS; npm only needed if you upgrade to a framework |
| Docker Desktop | latest | the launcher manages it (auto-prompts to install if missing) |
| macOS Xcode CLI tools | for macOS builds | `xcode-select --install` |
| webkit2gtk on Linux | `libwebkit2gtk-4.1-dev` | Tauri's web view |

---

## Build + run locally

```bash
# 1. Install Tauri CLI
cargo install tauri-cli --version "^2.0" --locked

# 2. From the repo root, run dev mode (hot-reload of the frontend)
cargo tauri dev

# Or build a release artifact for your OS:
cargo tauri build
```

Build outputs land under `src-tauri/target/release/bundle/`:

- macOS: `Auracle Desktop.app`, `Auracle Desktop-{version}.dmg`
- Windows: `Auracle Desktop_{version}_x64-setup.exe`, `.msi`
- Linux: `.deb`, `.rpm`, `.AppImage`

---

## Repo layout

```
auracle-desktop/
├── src-tauri/                Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json       app metadata + plugin config + updater endpoint
│   ├── build.rs              Tauri build script
│   ├── entitlements.plist    macOS code-signing entitlements
│   ├── capabilities/         per-window plugin allow-lists
│   └── src/
│       ├── main.rs
│       ├── lib.rs            command registration + setup hook
│       └── commands/
│           ├── docker.rs     wraps docker compose ps/up/down/pull/logs
│           ├── healthcheck.rs background poll of localhost:1969/healthz
│           ├── installer.rs  first-time install bootstrap
│           ├── keychain.rs   license-key storage in OS keychain
│           ├── tray.rs       system tray icon + menu
│           └── update.rs     auto-updater wrapper
├── src/                      frontend (no build step)
│   ├── index.html
│   ├── app.js                router + topbar + invoke wrapper
│   ├── styles/app.css
│   └── views/
│       ├── dashboard.js
│       ├── diagnostics.js
│       ├── logs.js
│       └── settings.js
├── .github/workflows/
│   ├── pr.yml                clippy + rustfmt + cargo test on PR
│   └── release.yml           cross-platform build + sign + GH Release on tag
├── scripts/                  one-off ops scripts (e.g. icon generation)
├── README.md                 (this file)
└── CONTRIBUTING.md
```

---

## Roadmap

- [x] **Scaffolding**: Tauri shell + Rust commands + frontend + CI workflows
- [x] **MVP**: one-click install, engine supervision, logs, and diagnostics
- [x] **Standby workbench**: single-screen status, health, and a command palette
- [x] **IDE delivery**: checks the release feed and installs IDE updates, with a running-app quit guard
- [ ] **Broader platforms**: Windows and Linux parity, plus code-signing
- [ ] **Post-launch**: multi-install management and cloud-deploy wizards

---

## License

Apache-2.0 (matches `auracle-client`). The Auracle engine itself is commercial — see the [main repo](https://github.com/SiixQuant/Auracle).

---

## Related repos

- [`SiixQuant/Auracle`](https://github.com/SiixQuant/Auracle) — the trading engine + Houston web UI + scheduler + MCP
- [`SiixQuant/auracle-installer`](https://github.com/SiixQuant/auracle-installer) — current `install.sh` flow (the launcher will eventually supersede this for non-developer users)
- [`SiixQuant/auracle-marketing`](https://github.com/SiixQuant/auracle-marketing) — auracle-engine.com landing page

---

## Support

- **Issues**: https://github.com/SiixQuant/auracle-desktop/issues
- **Email**: contact@aurapointcapital.com
