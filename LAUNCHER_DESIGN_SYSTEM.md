# Auracle Launcher Design System

**Date:** 2026-06-12 · Companion to `LAUNCHER_SHELL_REPORT.md` (shell anatomy + density standards). This document is the component-level law: the inventory, the rules for using it, and the anti-patterns that re-fragment it.

## 1. Inconsistency audit (what made this necessary)

- **One pill concept, three private implementations.** BrokerConnections, Dashboard, and IbeamSetup each hand-rolled the same 10px mono uppercase status pill with their own `{bg, fg}` color maps — 47 raw color literals in views, none on the platform palette: Tailwind-era greens (`#86efac`), ambers (`#fcd34d`), reds (`#fca5a5`), slates (`#cbd5e1`), and an off-palette blue banner (`rgba(96,165,250,…)`) on a platform that has no blue.
- **Two hand-rolled banner shapes** (info/warn/err notices) with per-view padding, radius, and tint decisions.
- **Wrong-value token fallbacks** (`var(--ok, #4ade80)`) that would silently ship the wrong green if the token ever failed to resolve.
- Everything else (cards, rows, buttons, badges, toggle, inputs, logs) was already one system — the fragmentation was concentrated in *status visualization*, the place trust matters most.

**After this change: zero raw color literals in any view.** Status meaning is expressed only through system variants.

## 2. Tokens (shared with the whole platform)

Values are the platform law (Houston `_base.html` / PRD Appendix A) — see `LAUNCHER_SHELL_REPORT.md §4.1` for the full table. The short version every component builds from:

| Group | Tokens |
|---|---|
| Surfaces | `--bg #000` · `--surface/-2/-3` (white α .02/.04/.06) |
| Text | `--fg` · `--fg-dim .60` · `--fg-muted .40` · `--fg-faint .20` |
| Lines | `--line .10` · `--line-strong .20` |
| Brand/status | `--accent #10b981` · `--accent-2 #059669` (hover) · `--accent-soft/-dim` · `--ok #10b981` · `--warn #f5a623` · `--err #ef4444` |
| Geometry | radii `4/6/10/pill` · spacing `4→32` · type `11/13/14/16/18/24` |
| Fonts | Inter-first sans · JetBrains-first mono |

**Tint rule:** soft fills are the token at fixed alphas — `.12` for chips/badges, `.08` for banners — never a different hue.

## 3. Component inventory & rules

| Component | Use for | Never for |
|---|---|---|
| `.card` + `.row` | All content blocks; rows auto-divide | nesting cards in cards |
| `.launch-grid` / `.launch-card` (+`--primary`) | Entry doors on Home; primary = the one platform door | more than one primary per grid |
| `button.primary` | The single advancing action in a context | two primaries side by side |
| `button.ghost` (+`.danger`) | Secondary/destructive actions | primary-styled destructive acts |
| `.badge` `ok/warn/err` | Sentence-case status words in prose contexts (Docker state, update state) | machine-state words |
| **`.chip`** `ok/warn/err/neutral` | Mono/uppercase machine states (broker `connected`, data tier, ibeam state) | free-form colors; new hues |
| **`.banner`** `info/warn/err` | Inline notices inside views (guidance, 2FA wait, errors) | page-level chrome; success confetti (`ok` rows use badges) |
| `.seg-toggle` | Binary mode choices | 3+ options (use rows) |
| `.logo-dot` states | Topbar stack health only | per-card health (use chips) |
| `pre.logs` | Log/terminal output | styled prose |
| Density utilities (`.fs-*`, `.mt-*`, `.hstack`, `.wrap-row`, `.cell/.cell-num`) | All micro-typography/spacing | replacing semantic components |

**State→variant mapping (binding):** healthy/connected/real-time → `ok` · attention/pending/delayed/2FA → `warn` · failed/offline/halted → `err` · inert/not-installed/closed/unknown → `neutral`. A new state must pick one of these four; if none fits, the state model is wrong, not the palette.

## 4. Anti-patterns (each one observed and removed in this repo)

1. **Private color maps in components** — a `{bg, fg}` record per view is a second design system. Map states to variants instead.
2. **Off-palette hues for emphasis** (the blue banner): if the platform palette can't say it, don't say it with color.
3. **Wrong-value fallbacks** (`var(--ok, #4ade80)`): a fallback that disagrees with the token is a dormant bug; tokens are always defined — write `var(--ok)`.
4. **Inline typography/spacing** (`fontSize: 12`, `marginTop: 6`): off-scale values and per-author density. Utilities only; `style={{}}` is layout-only.
5. **Re-rolling an existing shape** with slightly different padding/radius (the three pills, the two banners). Grep for the shape before building it.
6. **Dead CSS kept "just in case"** — 71% of the stylesheet was fiction before the shell pass; orphaned classes are deleted in the PR that orphans them.
7. **A third nav level or second primary door** — the launcher's IA is intentionally two tabs + one emerald door.

## 5. Contribution checklist (for any launcher UI change)

- [ ] Colors: only tokens/variants; `grep -E '#[0-9a-f]{3,8}|rgba?\(' src/views` stays at zero.
- [ ] Status: states map to `ok/warn/err/neutral` chips or badges — no new color logic.
- [ ] Density: no `fontSize`/`margin*` in `style={{}}`; utilities or defaults.
- [ ] One `h1`; sections are uppercase `h2` labels; notices are `.banner` variants.
- [ ] `tsc --noEmit` and `vite build` green; no class shipped without a TSX consumer.

## 6. Implemented in this change

- New system components: `.chip` (ok/warn/err/neutral) and `.banner` (info/warn/err) in `src/styles/app.css`, sharing the badge tint vocabulary.
- `StatePill` (BrokerConnections), `DataQualityBadge` (Dashboard), and `StatePill` (IbeamSetup) rewritten from private color maps to variant maps — labels and tooltips preserved.
- All four hand-rolled banners converted to `.banner` variants.
- All wrong-value token fallbacks corrected.
- Views now contain **0** raw color literals (was 47). Verified: `tsc --noEmit` clean, `vite build` green.
