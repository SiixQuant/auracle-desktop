# Changelog

Notable changes per release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.8.26]

The update waits its turn.

### Fixed
- **Update Auracle** never replaces the IDE while the IDE is open anymore. If it's running when an update pass starts, the launcher asks first — then closes it cleanly right before the swap and reopens it on the new version once the update lands. If it can't be closed, the update stops with the installed app untouched. (A running app loads pieces of its bundle as it goes; swapping the bundle underneath it corrupts what it loads next.)

## [0.8.25]

One backdrop, everywhere.

### Changed
- The home screen now runs the exact same animated dot-field as the sign-in screen — the same reveal-and-twinkle motion, from one shared source — so the launcher feels like one continuous surface from sign-in onward. The hub cards and the inspector panels sit over it as translucent glass (the sign-in's own surface treatment), so the dots read softly through them.

## [0.8.24]

A living backdrop and a calmer update.

### Fixed
- The home's dot-matrix backdrop is animated again — it drifts and shimmers instead of sitting still (it went static when it moved off WebGL for the frosted-glass change).
- **Update Auracle** no longer shows an alarming red error when the trading engine simply has no newer images to fetch. If the engine is still running, it now reports "running on the current version" calmly; a red error appears only if the engine actually stopped.

## [0.8.23]

Real frosted-glass surfaces.

### Changed
- The home backdrop is now rendered in CSS instead of WebGL. This lets macOS draw true frosted glass: the Updates / Help / System panels and the home's hub cards are now translucent and blur the dot-field behind them (iOS-style), instead of reading as dark/black rectangles.

## [0.8.22]

An even home backdrop, a clean panel backdrop, and an update that always finishes.

### Fixed
- The home backdrop now darkens evenly behind the hero. The faint horizontal band across the dot field is gone — the hard-edged vignette was replaced with a smooth, full-extent one that matches the sign-in screen.
- Opening a hub panel (Updates, Help, System…) now lets the home recede cleanly behind the frosted glass. The hub cards no longer read through as faint rectangular shadows — the backdrop dims and blurs them into one calm wash.
- **Update Auracle** now updates each piece of the stack independently. If one step can't finish (for example, the trading-engine images), the launcher still updates itself and restarts — a single hiccup no longer blocks the rest of the update. Anything that didn't finish is reported plainly instead of stopping the whole run.

## [0.8.21]

Reliable stack control from a normally-launched app.

### Fixed
- The **Update Auracle** engine step (and Start/Stop/Restart) no longer fail with "No such file or directory" when the app is opened from Finder/Dock — container tooling is now resolved by absolute path in every launch context, not just the status check.

## [0.8.20]

Calmer hub surfaces, presented as glass.

### Changed
- Hub inspectors (Updates, Help, System, Supervision) are now centered floating glass cards with a blurred backdrop, instead of a full-height side panel.
- FAQ and Support are merged into one **Help** surface; the home hub shows three cards (Update Auracle, Changelog, Help) with Update Auracle given top billing.
- The System surface no longer repeats the update controls — updates live only in the Update Auracle card.

### Fixed
- Inspector cards no longer paint a dark full-height banner behind them on macOS.

## [0.8.19]

A calmer home and one update action.

### Changed
- The home top bar now carries only what the home itself doesn't already surface, for a quieter, less repetitive nav.
- The home tiles are solid cards that match the rest of the launcher, instead of faint washes.

### Added
- A single **Update Auracle** action that brings the whole stack — trading engine, IDE, and launcher — current in one pass.

## [0.7.5]

Connect a broker without leaving the app.

### Added
- **Connect a broker** action on the Connections panel — the single door to
  broker setup. Opens the connection page in the in-app window and, on an
  on-box install, **already signed in** (a one-time local login handoff), so
  there's no key to copy and no login wall. Falls back to the plain page when
  there's no on-box handoff.

### Changed
- The connection-setup link now opens the in-app window (which carries the
  session) instead of the external browser, and the footnote no longer implies
  API-key/wallet brokers are unavailable — they're set up via **Connect a broker**.

## [0.7.4]

A more layered, legible Settings & Connections screen.

### Changed
- **Settings & Connections depth + hierarchy.** The Connections panel now
  reads as the page's primary block on its own deeper surface; the page
  title takes the editorial serif; the connected status reads as a single
  clear pill; small labels and counts gain contrast on the layered cards;
  disabled rows and the search field read better. Dark theme and accent
  unchanged — purely a clarity + polish pass.

## [0.7.3]

A refreshed look and a smoother hand-off into the workspace.

### Added
- **Workspace opens already connected.** When you open the workspace from
  the app, it now wires up its connection to the local engine
  automatically — no key to paste. If anything isn't ready yet, it falls
  back to the manual connect screen as before.

### Changed
- **A refreshed visual identity.** A blue accent and elegant serif
  headlines, on a deeper, more layered dark theme — Settings, Connections,
  and Home read with clearer depth and hierarchy while staying dark.
- **Honest, legible status throughout** carries over from the design pass:
  states stay distinct, and text keeps strong contrast on the darker
  surfaces.

## [0.7.2]

One terminal-grade look across the whole launcher.

### Changed
- **A single, calmer design language** end to end. Every screen — Home,
  Settings, Connections, the first-run setup, and the broker connect flow —
  now shares one quiet, sharp, terminal-style look: a true black canvas,
  hairline separators instead of heavy boxes, monospaced figures that line
  up, and the emerald accent reserved for what's actually live. Less chrome,
  more signal; the data leads.
- **Honest, legible status.** Connection and mode states read at a glance —
  paper stays quiet, live trading is unmistakable — with consistent,
  desaturated status colors throughout.
- **Calmer motion + sharper focus.** No glows or flashy effects; clear
  keyboard focus on every control; respects your "reduce motion" setting;
  the home tiles reflow cleanly at any window size.

(No behavior changed — this is a visual pass. Your connections, modes, and
data work exactly as before.)

## [0.7.1]

Your connections tell the truth from the engine, and the launcher only
acts when the engine is really ready.

### Added
- **Live broker & data capabilities.** The connections directory now reads
  each broker's and data source's real capabilities (asset classes,
  data-vs-trade) live from your running engine, falling back to a built-in
  list when the engine is offline — so what you see is what the engine can
  actually do, never a hand-maintained guess.

### Changed
- **Honest launch.** "Launch" only opens the workspace once the engine is
  confirmed healthy; it tells you when the engine is starting, degraded, or
  down instead of opening into a dead backend.
- **Web console placement.** The Settings toggle now actually opens the web
  console where you choose — your own browser or a dedicated app window.
- **Paper vs live, declared up front.** You set paper or live at broker
  setup (paper by default), and that choice is honored on every start — a
  live account is never silently run on paper.
- **Clearer connections directory.** Compact, searchable broker/data list
  with honest per-row connect methods (portal vs API key vs coming soon).

### Fixed
- **macOS first-launch steps.** The README now gives the correct unblock
  steps for recent macOS (the app is not yet notarized — Gatekeeper asks
  once on a fresh download; an in-app update installs normally).

## [0.7.0]

The design system reaches every surface, and updates explain
themselves before they happen.

### Added
- **Release notes in the updater.** Settings now shows what an update
  contains before you install it, a clear in-progress notice names the
  automatic restart, and the outcome is reported in plain words.
- **In-surface confirmations.** Destructive actions (uninstalling the
  gateway connection, clearing a license key) confirm with an inline
  row that states the consequences — reliable inside the desktop
  webview where native dialogs are not.

### Changed
- **Dashboard.** Account numbers live in titled metric tiles, open
  positions in a quieter table, and every section header carries its
  actions on the same line.
- **IBKR gateway card.** Labeled credential fields with a note on
  where the secret is stored, a named log pane, and status notices
  that span the card instead of crowding the buttons.
- **Broker Connections.** The last surface to adopt the shared
  vocabulary — headers, stacks, tone colors, and row separators now
  match the rest of the app.

### Fixed
- Several panels referenced styling values that did not exist, which
  left their frames and separators invisible; all surfaces now draw
  as designed.

## [0.6.0]

Enterprise shell + design system — four passes in one release: the
stylesheet tells the truth, density is a system property, status has
one language, and the install wizard earns trust.

### Changed
- **Shell uniformity.** Tokens aligned to the platform design law
  (status amber, radii, brand-first font stacks, a defined hover
  tier); 991 lines of dead stylesheet from the retired native
  workspace deleted; a small density utility kit replaces the views'
  hand-rolled font sizes and margins.
- **One status language.** New `chip` (machine states) and `banner`
  (notices) components replace three private pill implementations and
  four bespoke banners — views map states to variants, never to
  colors; zero raw color literals remain in any view. Settings and
  Onboarding now describe Docker states identically.
- **First-run install flow.** Named steps (Environment → License →
  Install) with done/current states; install is an explicitly
  consented action; failures render as a first-class state with
  Retry (previously the error UI unmounted itself and the install
  silently re-fired); the value list describes the platform that
  actually ships; success explains the browser handoff.

### Docs
- `LAUNCHER_SHELL_REPORT.md`, `LAUNCHER_DESIGN_SYSTEM.md`,
  `LAUNCHER_WORKFLOW_REPORT.md`, `LAUNCHER_UI_QA.md` — the standards,
  anti-patterns, and remaining-gap ledgers behind this release.

## [0.5.1]

Settings polish — same layout, tighter copy.

### Changed
- Trimmed the Settings copy to plain, straight-to-the-point lines: the
  Workspace toggle descriptions, and the Brokers card's "one connection"
  banner + port-conflict notice are now one crisp line each instead of
  multi-sentence paragraphs. Less bulk, same meaning.

## [0.5.0]

Minimal Settings + the strategy conveyor belt. Same north star as the
v0.4.0 launcher: one cohesive product, no redundancy, every surface
flowing into the next.

### Changed
- **Settings, minimalized.** Five sections collapse to four. *View Mode*
  becomes a compact **Workspace** segmented toggle (Browser | Embedded)
  instead of a two-radio block. *Installation* and *Updates* merge into
  one **System** section (install dir · Docker · launcher version/update).
- **Brokers, de-cluttered.** The three "coming soon" broker blocks
  (Alpaca, Tradier, Hyperliquid) collapse into a single quiet
  "on the roadmap" line, so the card is all signal.

### Added
- **The conveyor belt.** A lifecycle spine renders under the Forge top
  bar in both Agent and Code modes: the active strategy's stage
  (draft → research → backtested → paper → live) as clickable nodes, plus
  the single contextual next action — Run backtest → Deploy to paper →
  Promote to live. Houston-aware: the CTA routes to Houston's working
  deep-link when the stack is up, and disables with a clear hint when it
  isn't (never a dead button). Promoting to live is a gated, explicit
  confirmation that opens Houston — the desktop never places an order.
- **One source of truth** (`src/lib/lifecycle.ts`) for the stage model,
  the Houston deep-links, and the health probe.

### Removed
- **Redundant backtest entry points.** The Editor's "Run Backtest" button
  and inline state dropdown, and the PreviewPane "Backtest" tab's duplicate
  button, are gone — the belt is the single place to see where a strategy
  is and move it forward. The agent's run/deploy tools (a separate
  natural-language modality) are unchanged.

## [0.4.0]

Launcher rework: a minimal, de-duplicated shell.

### Changed
- The top bar collapses from five doors to two — **Home · Settings**.
  The `Forge` tab, `Notebooks ↗`, and `Open Workspace ↗` buttons are
  gone: each duplicated something the web platform already exposes the
  moment you open it. The brand wordmark trims to "Auracle".
- **One door into the platform.** The Home view's "Open Auracle" is now
  the single canonical way into the web product (Home · Build · Research
  · Trade · Seer). The parallel "Open Workspace" implementation was
  removed so the two can't drift apart.
- **Home → Workspaces.** A calm two-up entry grid replaces the old
  "Quick Actions" card: "Open Auracle" (the platform) + "Forge" (native
  authoring). License, broker glance, and container status are unchanged.

### Kept
- The native **Forge** workspace (Agent/Code, local Claude authoring +
  dashboards) — the most-complete authoring surface today. It's now a
  drill-in opened from the Home "Forge" card, with a "‹ Home" exit,
  instead of a competing top-level tab.
- The dedicated JupyterLab window capability (`open_jupyter`) — only its
  top-bar shortcut was retired; notebooks live in the platform's
  Build → Code, and the command remains for re-surfacing inside Forge.

### Removed
- Dead code: `openWorkspace()`, `openResearch()`, and `WORKSPACE_URL`
  in the Tauri bridge — the redundant second "open the workspace" path,
  whose only caller was the removed top-bar button.

## [0.3.1]

Quick polish on top of 0.3.0 — same surface, better defaults.

### Fixed
- Dashboard grid layout no longer leaves dead vertical space
  inside chart widgets. Cells now use a deterministic 90px row
  height so the cell allocation matches what a widget actually
  needs.
- Agent + Code layout split rebalanced from 40/60 to roughly
  28/72 in favor of the preview pane, which is where the
  substantive output (dashboards, charts, option chains) lives.
  Chat panel min-width dropped from 360px to 280px so the
  visualization side has more room at typical window sizes.

## [0.3.0]

A large feature release. The Forge authoring surface goes from
"agent that writes strategy files" to a full visual-analytics
workspace, broker integration moves into the launcher itself,
and a persistent-session path for the broker connection removes
the daily re-login that was the biggest day-to-day friction.

### Added
- **Persistent visual dashboards.** The agent authors named JSON
  specs that render inline as composable grids of components —
  KPI cards, sortable tables, time-series line charts, OHLC
  candles, multi-leg option payoff diagrams, market-maker-style
  option chain tables, live multi-symbol ticker grids, markdown
  notes. Specs round-trip through version control, persist
  across sessions, refresh on a configurable interval.
- **In-app broker connection management.** A new Settings card is
  the single global place to wire up a broker — see live
  connection state, connect, test, disconnect. Coming-soon rows
  for additional brokers under development.
- **Persistent broker session via an auto-managed supervisor
  container.** Optional Docker-based path that re-authenticates
  the local broker gateway automatically when the daily session
  expires, removing the daily manual login cycle.
- **Subscription-aware data quality indicators.** Every quote and
  bar payload now carries a tier flag (real-time / delayed /
  frozen / closed / halted) derived from the broker's own
  availability codes. The launcher's home view shows the active
  tier as a pill so the user always knows what they're looking
  at.
- **Real-time tick streaming surface.** Frontend can subscribe to
  symbol-level tick updates at a configurable cadence; the live
  ticker-grid component consumes this for streaming watchlists.
- **Out-of-box welcome view.** First-launch users see a tour
  dashboard seeded with two market-data components and a
  markdown intro so the workspace isn't empty.
- **Atomic broker connect flow.** Connect detects and resolves
  port conflicts with the legacy bundled gateway in one click.
- **Password-manager autofill** on the credential form.
- **Conflict detection** between the launcher-managed and stack-
  managed broker gateway, with a one-click "free the port" action.

### Changed
- Broker data is now a launcher-global resource, callable from
  every surface (the home view, the agent loop, the visualization
  layer) rather than tunneled through one specific consumer.
- Agent prompt and tool catalog now include the visual-component
  schemas so the agent can author dashboards as a first-class
  output type, not just code.
- Agent system prompt + tool definitions are now marked
  cacheable, cutting per-turn input-token cost roughly tenfold
  after the first call in a session and largely sidestepping
  per-minute rate limits.
- The launcher's home view now shows the active broker account
  summary and top open positions, refreshed on a 30-second
  cadence.

### Fixed
- Encrypted-vault save flow: removed a regression where the key
  appeared to save but the next read returned empty.
- Encrypted-vault save latency: the previous flow could take
  tens of seconds on busier hardware; saves now complete in
  milliseconds.
- Credential tempfile cleanup is now structurally guaranteed
  across every error path via an RAII guard.
- Long-running launcher sessions no longer accumulate unbounded
  symbol-to-contract-id cache entries.
- Many in-component subscription and refresh-loop lifecycle
  fixes — listeners get torn down on unmount, refresh loops
  pause when the window is hidden and refresh immediately when
  it comes back, charts size correctly to their containers.

### Earlier (pre-0.3.0) baseline
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
