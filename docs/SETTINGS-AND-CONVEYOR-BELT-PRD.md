# PRD — Minimal Settings + the Strategy Conveyor Belt

_Status: approved for build · Branch: `feat/settings-conveyor-belt` · App: `auracle-desktop`_
_Follows the launcher rework (v0.4.0). Same north star: one cohesive, minimal product where every surface flows into the next without redundancy._

---

## 1. Problem

Two surfaces still feel heavier and more disjointed than the new launcher:

### 1a. Settings is a long, partly-dead scroll
Five stacked sections (View Mode · Forge · Broker Connections · Installation · Updates). Concrete clutter:
- **Three dead "COMING SOON" broker rows** (Alpaca, Tradier, Hyperliquid) — each a full label/description/pill/"roadmap" block that does nothing but occupy a third of the broker card.
- **A heavy two-radio card** for what is a binary toggle (browser vs embedded).
- **Installation and Updates are two sections** for what is really one concern: *system & maintenance* (install dir, Docker, launcher version/update).

### 1b. The strategy "conveyor belt" looks like a belt but isn't connected
The lifecycle (`draft → research → backtested → paper → live → archived`) is shown as pills and a dropdown, but:
- **State changes are purely cosmetic** — setting "paper" updates a label; nothing advances.
- **Three redundant backtest entry points** with **duplicated Houston deep-link strings**: the Editor's "Run Backtest" button, the PreviewPane "Backtest" tab's button, and the agent's `run_backtest` tool.
- **No single, visible spine** that tells you *where a strategy is* and *what the next step is*.
- The real backtest/deploy engines live in **Houston** (the web platform); several REST endpoints aren't shipped, so the only reliably-working path today is Houston's UI deep-link.

Owner direction (verbatim intent): minimalize Settings, remove redundancy, make it easier to navigate; and "build out … strategy development … connect to services in a minimalistic and compact way without obstruction or redundancy … every aspect of the platform should work in unison like a conveyor belt."

## 2. Goals

1. **Settings: fewer, clearer sections; zero dead weight.** Collapse the coming-soon rows, merge Installation+Updates into one "System" section, compact the view-mode toggle.
2. **One visible lifecycle spine.** A compact **conveyor belt** in Forge that shows the active strategy's stage and the *single* next action — present in both Agent and Code modes.
3. **One path per action, no redundancy.** A single shared `lifecycle` module owns the stage model + the Houston deep-links + the health probe. The belt is the one human-facing action surface; the duplicate Editor/PreviewPane controls are removed.
4. **Connected, honest, minimal.** The belt routes each stage to its real next step through the working path (Houston deep-link), is aware of Houston's health, and degrades clearly when the stack is down — never a dead button, never faked results.
5. **Safe by construction.** Promoting to **live** is a gated, explicit, human action that deep-links into Houston (where its own kill-switch + tier gate + confirmation live). The desktop never places an order itself.
6. **Reversible, frontend-only.** No new side-effecting desktop commands; no backend command removed. Ships entirely in the frontend bundle.

## 3. Non-goals

- **No** implementing Houston's missing REST endpoints (`/api/forge/strategies/{rel}/backtest`, `/api/forge/deployments`, `/runs`) — that's cross-repo and tracked separately. The belt is built so swapping deep-link → API + auto-advance is a localized change later.
- **No** autonomous or automatic live-order execution from the desktop. (Out of bounds, by policy.)
- **No** change to the Anthropic key flow, installer, Docker, or updater logic.
- **No** removal of the agent's `run_backtest`/`deploy_strategy` tools — natural-language remains a distinct modality, not a redundant button.

## 4. Design — Part A: Settings

Five sections → **four**, lighter and de-duplicated:

```
BEFORE                          AFTER
View Mode      (2-radio card)   Workspace     (compact segmented toggle)
Forge          (key/dir/model)  Forge         (unchanged — distinct dev settings)
Broker Conn.   (IBKR + 3 dead)  Brokers       (IBKR full + 1 collapsed "roadmap" line)
Installation   (dir + docker)   System        (dir + docker + launcher version/update)
Updates        (version/update)   └─ Installation + Updates merged into one concern
```

- **Collapse coming-soon brokers**: `BrokerConnections` partitions statuses — real brokers (IBKR) render full rows; `not_implemented` brokers collapse into **one** muted line: *"More brokers on the roadmap — Alpaca · Tradier · Hyperliquid."* (−3 bulky blocks → +1 line.)
- **Workspace toggle**: replace the two stacked radios with a compact segmented control (same pattern as Forge's Agent|Code toggle) + a one-line caption.
- **System section**: one `<h2>System</h2>` + one card with rows: install directory, Docker status, then launcher version + Check/Install-update — the two maintenance concerns under one roof.
- Keep **Forge** (Anthropic key · strategies dir · model) as-is — genuinely distinct settings, not redundant.

## 5. Design — Part B: The Conveyor Belt

### 5.1 Single source of truth — `src/lib/lifecycle.ts`
One module owns everything the belt and the (slimmed) surfaces share, killing the duplicated strings:
- `LIFECYCLE_STAGES` — ordered `draft → research → backtested → paper → live` (+ `archived` as a terminal side-state), each with label, blurb, and accent class.
- `HOUSTON_BASE`, `backtestUrl(relPath)`, `deployUrl(relPath, mode)` — the **only** place these URLs are built.
- `nextStep(state)` — the contextual primary action for the belt (kind, label, target stage).
- `probeHouston()` — the health check (lifted from PreviewPane so there's one implementation).

### 5.2 The belt — `src/components/forge/LifecycleBelt.tsx`
A compact strip rendered once in `Forge.tsx` (right under `ForgeTopBar`), so the lifecycle is the visible spine in **both** Agent and Code modes.

```
 ◆ draft ── ◆ research ── ● backtested ── ○ paper ── ○ live          [ Deploy to paper → ]
                              ▲ current                               (Houston · online)
```

- **Stages** render as connected nodes; past = filled-muted, current = emerald, future = hollow. Clicking a node sets the strategy's state (`forgeSetStrategyState`, already wired + Houston-synced).
- **One contextual CTA** per stage (the "advance" action):
  | Current stage      | Primary action        | What it does                                                        |
  |--------------------|-----------------------|---------------------------------------------------------------------|
  | draft / research   | **Run backtest**      | deep-link → Houston `/ui/backtests/new?strategy=…`                   |
  | backtested         | **Deploy to paper**   | deep-link → Houston Forge board (paper)                              |
  | paper              | **Promote to live**   | **gated** confirm (real-capital warning) → Houston Forge board      |
  | live               | **Manage / Archive**  | open Houston · set `archived` via node click                        |
- **Houston-aware**: probes health on mount/active-file change. Online → CTA active. Offline → CTA disabled with *"Start Auracle to backtest/deploy"* (no dead links).
- **Live gate**: "Promote to live" requires an explicit `confirm()` spelling out real-capital risk; only then opens Houston (where the platform's `AURACLE_FORGE_ALLOW_LIVE` + tier + in-UI confirm apply). The desktop never executes the order.
- **No active file** → muted *"Select or create a strategy to see its lifecycle."*

### 5.3 De-duplication (the "no redundancy" mandate)
- **Editor** (`Editor.tsx`): remove the standalone **"Run Backtest"** button *and* the inline **state dropdown** — both are now owned by the belt directly above. Editor returns to a focused code surface (name · dirty · Save). Drops the `currentState`/`onChangeState` props.
- **PreviewPane** (`PreviewPane.tsx`): the **Backtest** tab becomes view-only — Houston health + a pointer to the belt + the honest "inline results land here once Houston ships `/runs`" note. Its duplicate "Run Backtest in Houston" button is removed (the belt owns the action).
- **FileTree** pills stay — they're a read-only per-file *overview*, not a control, so not redundant with the belt's active-file spine.
- **Agent tools** stay — natural-language run/deploy is a separate modality.
- Net: **one** lifecycle control (belt), **one** action path per stage, **one** place that builds the Houston URLs.

## 6. Files

**New:** `docs/SETTINGS-AND-CONVEYOR-BELT-PRD.md`, `src/lib/lifecycle.ts`, `src/components/forge/LifecycleBelt.tsx`.
**Modified:** `src/views/Settings.tsx` (merge System, compact Workspace), `src/views/BrokerConnections.tsx` (collapse coming-soon), `src/views/Forge.tsx` (mount belt, drop Editor state props), `src/components/forge/Editor.tsx` (remove dropdown + backtest btn), `src/components/forge/PreviewPane.tsx` (slim Backtest tab), `src/styles/app.css` (belt + settings tweaks), `CHANGELOG.md`, version files → `0.5.0`.

## 7. Verification

- `npm run typecheck` + `npm run build` green.
- Visual (dev server): Settings shows four tidy sections, one roadmap line, a segmented Workspace toggle, a merged System section. Forge shows the belt in both modes; clicking stages advances the spine; CTA deep-links when Houston is up and disables with a clear hint when down; Editor no longer shows the dropdown/backtest button; the Backtest tab is view-only.
- Ship via release `v0.5.0` so the installed app auto-updates (same pipeline as v0.4.0).

## 8. SWOT

**Strengths**
- Settings loses its dead weight; four scannable sections instead of five + clutter.
- The belt makes the lifecycle the product's visible spine — "where am I, what's next" answered at a glance, in one place, both modes.
- One shared `lifecycle` module ends the triple-duplicated deep-links and the three-button backtest confusion.
- Honest + safe: routes to the working Houston path, degrades clearly offline, and keeps live execution gated in Houston — the desktop never trades.
- Pure frontend → low blast radius, instant on update, trivially reversible.

**Weaknesses**
- The belt's "advance" is partly manual (you click to the next stage; we can't auto-detect a Houston backtest finishing without the `/runs` endpoint). Mitigated: stages are one click, and the structure is ready for auto-advance when the endpoint ships.
- Deploy deep-links to the Forge board rather than a strategy-prefilled form (route certainty); the user finishes there. Acceptable, and a one-line change when the deploy API/route is confirmed.
- Removing the Editor dropdown is a behavior change for power users who used it — mitigated by the more prominent belt directly above.

**Opportunities**
- When Houston ships `/backtest` + `/runs` + `/deployments`, the belt swaps deep-link → API call + inline status + true auto-advance, with no UI restructure.
- The belt is the natural home for a future "last run: Sharpe 1.4 · 3d ago" chip and a one-glance health/positions readout.
- The shared `lifecycle` module can back a future Home "strategies in flight" summary.

**Threats**
- If a deep-linked Houston route differs from assumption, the user lands on a Houston page instead of a prefilled form — non-fatal, and isolated to one constant in `lifecycle.ts`.
- Scope creep toward "make backtest/deploy fully run in-desktop" pulls in cross-repo + live-capital work — explicitly deferred here and flagged for sign-off.

## 9. Rollout

One branch, logical commits (Settings → Belt → version/CHANGELOG), one PR → CI green → merge → tag `v0.5.0` → release pipeline publishes the signed bundle + `latest.json` → installed app self-updates.
