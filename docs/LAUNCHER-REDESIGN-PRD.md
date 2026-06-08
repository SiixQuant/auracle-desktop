# PRD — Desktop Launcher: Minimal, De-duplicated Shell

_Status: approved for build · Target branch: `feat/launcher-minimal` · App: `auracle-desktop` (Tauri + React)_
_Author: product/eng · Supersedes the v0.3.x five-door top bar._

---

## 1. Problem

The desktop launcher's top bar grew into a **second, competing product surface**. It currently
exposes five top-level doors:

```
[● Auracle Desktop  v0.3.3]   Dashboard · Forge · Settings           Notebooks ↗   Open Workspace ↗
```

Three of those doors **duplicate things the web platform already provides the moment you launch it**:

| Top-bar door        | What it does                                  | Already in the platform?                                   |
| ------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| **Forge** (tab)     | Native local strategy authoring (Agent/Code)  | Platform exposes **Build → Compose** (web Forge)            |
| **Notebooks ↗**     | Opens a dedicated JupyterLab window           | Platform exposes **Build → Code** (Notebooks)              |
| **Open Workspace ↗**| Opens `https://localhost/ui` (the web shell)  | This **is** the platform — and the Home view already has an "Open Auracle" action that opens the same thing |

The result is the exact "several separate products" feeling the unified-shell effort exists to kill:
the desktop chrome re-lists destinations that live one click inside the product, and there are **two
independent implementations of "open the web product"** (`Open Workspace ↗` via `openWorkspace()` and
Home's `Open Auracle` via `openEmbeddedAuracle()`).

Owner direction (verbatim intent): _"we don't need a separate Forge there or a notebook/open workspace
since this is already in the launch of the Auracle platform — make this launcher page aesthetically
appealing and minimal … keep only the best-performing functions people will use, and don't be
repetitive."_

## 2. Goals

1. **One door into the platform.** Exactly one obvious way to enter the web product, not three.
2. **A launcher that does launcher things.** The desktop's unique, non-duplicated value: install &
   stack lifecycle, health, license activation, broker glance, settings — plus the one product door.
3. **Minimal, beautiful chrome.** A two-destination top bar (`Home · Settings`) with generous space,
   the shared emerald token system, and no horizontal door-soup.
4. **Keep the best-performing function people actually use.** The native **Forge** authoring workspace
   (working Claude agent loop + local dashboards) is more complete today than the partly-stubbed web
   Forge — so it stays in the app, reachable from Home, just not as a competing top-level tab.
5. **Reversible & low-risk.** Pure frontend re-route + presentation change; no backend command removed;
   no functionality deleted — only re-homed and de-duplicated.

## 3. Non-goals

- **No** removal of native Forge functionality (engine, agent loop, dashboards, Rust commands).
- **No** change to the embedded/browser "Open Auracle" behavior, cert-trust flow, or the dedicated
  JupyterLab window capability (`open_jupyter` Rust command stays; only its chrome shortcut is retired).
- **No** change to Settings, Onboarding, Broker Connections, or any installer logic.
- **No** new web-platform work — this PRD is the desktop shell only.

## 4. Current-state inventory (what exists, what it's worth)

| Surface / function          | Where                              | Unique to desktop? | Verdict          |
| --------------------------- | ---------------------------------- | ------------------ | ---------------- |
| Install / preflight / stack | `Onboarding`, `Dashboard` containers | **Yes**          | Keep (core)      |
| Health dot (5s poll)        | `App` top bar                      | **Yes**            | Keep             |
| License activation          | `Dashboard` LicenseSection         | **Yes**            | Keep (first-run) |
| Broker glance (acct + pos)  | `Dashboard` BrokerSection          | **Yes**            | Keep (high-value)|
| Settings (cert/view/model/broker) | `Settings`                   | **Yes**            | Keep             |
| Native **Forge** authoring  | `Forge` view (+ Rust forge cmds)   | Mostly             | **Keep, re-home**|
| **Open Workspace ↗**        | `App` top bar → `openWorkspace()`  | No (dup of Open Auracle) | **Remove door, consolidate** |
| **Notebooks ↗**             | `App` top bar → `open_jupyter`     | No (in platform Build→Code) | **Remove door, keep cmd** |
| `openWorkspace`/`openResearch`/`WORKSPACE_URL` | `lib/tauri.ts`    | dead after change  | **Delete (dead code)** |

## 5. The redesign

### 5.1 Top bar (chrome) — from five doors to two

```
BEFORE:  [● Auracle Desktop v0.3.3]   Dashboard · Forge · Settings        Notebooks ↗   Open Workspace ↗
AFTER:   [● Auracle  v0.4.0]                                              Home · Settings
```

- Tabs reduce to **Home · Settings**. `Forge` tab removed; `Notebooks ↗` and `Open Workspace ↗` removed.
- Brand wordmark trimmed to **"Auracle"** (it's already the desktop app — "Desktop" is redundant chrome).
- The health dot + version stay (unique launcher value; ambient status).
- Tabs right-aligned with breathing room; `Home` reads active for both the Home view **and** while
  drilled into Forge (Forge is a child of Home, so the way back stays lit).

### 5.2 Home view — one door + the launcher essentials

`Home` (the view formerly labeled Dashboard) becomes the single, calm entry point:

```
Auracle
┌───────────────────────── (only when no license stored) ─────────────────────────┐
│  Activate Auracle — paste your license key                                        │
└───────────────────────────────────────────────────────────────────────────────────┘

WORKSPACES
┌───────────────────────────────┐   ┌───────────────────────────────┐
│  Open Auracle            ⟶     │   │  Forge                   ⟶     │
│  The full platform — Home,     │   │  Build & iterate on strategies │
│  Build, Research, Trade, Seer  │   │  with Claude, locally          │
│  [ Open Auracle ]  (primary)   │   │  [ Open Forge ]    (ghost)     │
└───────────────────────────────┘   └───────────────────────────────┘

BROKER        … account summary + top positions (unchanged) …
CONTAINERS    … stack status (unchanged, secondary) …
```

- **Open Auracle** is the single canonical door to the web product (keeps the existing embedded/browser
  two-mode logic + healthy/`/ui/setup` fallback). It is the **only** place that opens the platform.
- **Forge** card opens the native authoring workspace in-app (`view → "forge"`). This preserves the
  function people use without giving it a competing chrome tab.
- License / Broker / Containers sections are unchanged in behavior; only their order is normalized so
  the two entry cards sit near the top (the launcher's primary job is "get me in").

### 5.3 Forge view — add an explicit way back

Because Forge is no longer a top-level tab, its own `ForgeTopBar` gains a left-most **"‹ Home"** control
(`onExit → view "dashboard"`). The persistent app top bar's lit `Home` tab is the secondary path back.
Nothing else in Forge changes.

### 5.4 Code-level de-duplication (the "don't be repetitive" mandate)

- Delete `openResearch()` (already zero callers), `openWorkspace()`, and `WORKSPACE_URL` from
  `lib/tauri.ts` — the only caller was the removed `Open Workspace ↗` button, and the canonical door
  (`Open Auracle`) uses the Rust `open_embedded_auracle` (which loads `https://localhost/ui` via Caddy)
  or the browser fallback. One implementation, not two.
- Keep `cmd.openJupyter` (1:1 binding to the live `open_jupyter` Rust handler — capability preserved,
  chrome shortcut retired). No Rust command is removed in this PR.

## 6. Visual / UX spec

- **Tokens:** reuse `app.css` `:root` (emerald `--accent #10b981`, surfaces, radii). No new palette.
- **Entry cards:** a responsive 2-up grid (`.launch-grid`), each a `.launch-card` — title, one-line
  description, a trailing arrow glyph that nudges on hover, accented left edge / border on hover. The
  primary card ("Open Auracle") uses `button.primary`; "Open Forge" uses `button.ghost`.
- **Top bar:** unchanged structure, fewer children; tabs keep `var(--s-1)` gap; brand wordmark shortened.
- **Motion:** existing 0.15s transitions; arrow translateX(2px) on card hover. No new animation libs.
- **Empty/again states:** license card only when unactivated; containers only when a stack is detected
  (unchanged silent-omit logic).

## 7. Reversibility

- Branch `feat/launcher-minimal` off `main`; `main` tip is the rollback point.
- Change is additive/subtractive **frontend only** + version/CHANGELOG. No DB, no Rust command removed.
- Hard revert = checkout `main`. Soft revert = restore the two removed buttons (kept in PR history).

## 8. Implementation plan

1. `lib/tauri.ts` — remove `openResearch`, `openWorkspace`, `WORKSPACE_URL`; tidy the comment that
   referenced them; keep `openJupyter`/`openEmbeddedAuracle`/`openInBrowser`.
2. `App.tsx` — drop `Forge` tab + `Notebooks ↗` + `Open Workspace ↗`; tabs → `Home · Settings`; pass
   `onOpenForge` to `Dashboard`; `Home` active for `dashboard|forge`; trim brand to "Auracle"; remove
   the now-unused `openWorkspace` import.
3. `views/Dashboard.tsx` — accept `onOpenForge`; add the `WORKSPACES` entry grid (Open Auracle + Forge);
   keep License/Broker/Containers; normalize order.
4. `components/forge/ForgeTopBar.tsx` — add optional `onExit`; render `‹ Home` in the left slot.
5. `views/Forge.tsx` — thread `onExit` through to `ForgeTopBar`.
6. `styles/app.css` — add `.launch-grid` / `.launch-card` / `.launch-card__arrow`; minor top-bar polish;
   `‹ Home` button style.
7. Version bump `0.3.3 → 0.4.0` (package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml) +
   `CHANGELOG.md` entry.

## 9. Verification

- `npm run typecheck` (tsc --noEmit) and `npm run build` (tsc + vite) green.
- Manual: top bar shows only `Home · Settings`; Home shows the two entry cards; `Open Auracle` opens the
  platform (embedded/browser per setting); `Open Forge` enters Forge; `‹ Home` and the lit `Home` tab
  both return; license/broker/containers render as before; no references to removed symbols.

## 10. SWOT

**Strengths**
- Kills the "second product" feel: chrome no longer competes with the platform's own IA.
- One door into the platform — removes the dual-implementation drift (`openWorkspace` vs `Open Auracle`).
- Preserves the highest-value, most-complete authoring surface (native Forge) without cluttering chrome.
- Pure presentation/routing change → low blast radius, trivially reversible, no backend risk.
- Reinforces "one Auracle": desktop = thin, beautiful launcher onto the unified web product.

**Weaknesses**
- Forge loses top-bar prominence; a card on Home is one extra glance to discover (mitigated by placing
  the entry cards at the top and lighting `Home` while in Forge).
- Retiring the `Notebooks ↗` shortcut removes the fastest path to the dedicated JupyterLab **window**;
  embedded-mode users who hit the known WKWebView inline-Jupyter limitation now route via the platform
  (acceptable: default mode is browser, where inline notebooks work; Rust command retained for re-surfacing).

**Opportunities**
- A calm, minimal launcher is the right canvas to later fold install/health into an even quieter
  "it just works" status strip.
- The single-door pattern sets up a future "auto-open platform on healthy stack" preference.
- Re-surface notebooks **inside** Forge (Code mode) later, using the retained `open_jupyter`, so there's
  still zero chrome duplication.

**Threats**
- If the web Forge matures past the native one, we'll want to retire native Forge too — this PRD
  deliberately keeps that an easy, separate follow-up (the card is the only entry to remove).
- Version drift if the three version files aren't bumped together (mitigated: all three in step 7).

## 11. Rollout

Single PR on `feat/launcher-minimal` → review → merge. Native rebuild (`tauri build`) picks up the
`0.4.0` Cargo version for the visible label; the frontend changes are live on the next webview load.
