# Launcher Shell Report — enterprise uniformity standards

**Date:** 2026-06-12 · **Scope:** the desktop launcher's global shell — layout, nav, headers, spacing, density — audited against the platform design law (Houston `_base.html` tokens / PRD Appendix A) and brought into line.

## 1. Audit findings

**Structure (good bones):** one top bar (brand dot + version + two tabs), a single centered 900px content column, `.card`/`.row` primitives, uppercase `h2` section labels, one segmented-toggle pattern, one badge pattern. The shell's information architecture is deliberately thin (launcher = install/update/door) and that's correct.

**The problems:**
1. **71% of the stylesheet was dead.** 991 of 1,386 lines styled the native Forge that PR #20 removed — file tree, chat panel, diff modal, belt, state pills — including an off-law `#1e1e1e` editor surface and off-palette purple/blue state colors. Dead weight is the opposite of uniform: every future edit had to navigate a stylesheet that was three-quarters fiction.
2. **Token drift from the platform law:** `--warn #f59e0b` (law: `#f5a623`); radii 6/8/12 (law: 4/6/10); system font before Inter and no JetBrains Mono in the mono stack (law: both lead); button hover used an ad-hoc lightened literal (`#34d399`) instead of a defined hover tier; no `--accent-2`.
3. **Density decided inline, 134 times.** Views hand-rolled `fontSize: 11/12/13`, micro-margins (2/6/8/16px), and flex rows in `style={{}}` — including off-scale 12px text that exists nowhere in the type scale. Density was per-author, not per-system.
4. Headers themselves were already uniform (one `h1` per view, uppercase-label `h2` sections) — kept as the standard.

## 2. The shell structure (standard)

```
┌──────────────────────────────────────────────────────┐
│ topbar: [health-dot Auracle vX.Y.Z]      [Home][Settings]  ← only nav
├──────────────────────────────────────────────────────┤
│ main: centered column, max-width 900px, --s-5 padding │
│   h1 (one per view, --t-xl/600/-0.02em)               │
│   h2 (uppercase --t-xs label, --fg-muted) per section │
│   .card → .row (+ .row borders) for all content       │
│   .launch-grid for entry doors (primary = emerald)    │
└──────────────────────────────────────────────────────┘
```
Rules: the top bar never re-lists destinations the platform owns; onboarding owns the whole window pre-install; no second nav level ever — depth belongs to the web product.

## 3. Implemented (this change)

- **Stylesheet 1,386 → 421 lines:** all Forge-era CSS deleted; every remaining rule has a live consumer.
- **Tokens aligned to the law:** `--warn: #f5a623`, radii `4/6/10`, Inter-first sans + JetBrains-first mono stacks, new `--accent-2: #059669` used for primary-button hover, new `--t-md: 16px` completing the scale.
- **Density utility kit** (the only sanctioned micro-typography/spacing): `.fs-xs/.fs-sm`, `.m-0/.mt-0/.mt-1/.mt-2/.mt-4/.mb-2/.ml-2`, `.hstack/.wrap-row`, `.cell/.cell-num`. Off-scale 12px text snaps to the 11px token.
- **View sweep:** 47 recurring inline styles across all five views converted to the kit (Dashboard 14, IbeamSetup 13, BrokerConnections 10, Onboarding 8, Settings 2).
- **Verification:** `tsc --noEmit` clean; `vite build` green; live dev render confirmed the shell serves the law values (`--warn #f5a623`, `--r-lg 10px`, `--accent-2 #059669`, Inter-first, pure-black body) and the kit resolves (`.fs-xs` → 11px).

## 4. The standards (binding for future launcher work)

1. **Token law:** values mirror Houston `_base.html` exactly — `#000` bg, alpha-white surface/line/fg tiers, emerald `#10b981` + hover `#059669`, status `#10b981/#f5a623/#ef4444`, radii 4/6/10, 4-32px spacing steps, 11/13/14/16/18/24 type scale, Inter + JetBrains Mono. A token value changed here must change in Houston and marketing in the same breath, or not at all.
2. **One nav, two tabs.** New launcher features are cards under Home or rows under Settings — never a third tab, never a sidebar. If it needs more nav than that, it belongs in the web product.
3. **Headers:** exactly one `h1` per view; sections are uppercase `h2` labels; cards never contain their own title bars.
4. **Density:** font sizes and margins come from the utility kit or element defaults — `style={{}}` is for genuine one-off *layout* only (grid templates, max-widths, table column widths). No raw font-size or margin literals in views.
5. **No dead CSS:** a class with zero TSX references is deleted in the same PR that orphans it.
6. **Status colors by token only**, in the badge/dot patterns that exist — no new status visual languages.

## 5. Specified follow-ups (not in this change)

- 87 remaining inline styles are layout one-offs under the new policy; a later pass should audit Onboarding (26) and BrokerConnections (22) for layout patterns worth promoting to classes (step lists, key-value tables).
- The IbeamSetup view duplicates table-cell styling the new `.cell/.cell-num` utilities now cover — finish converting its tables when next touched.
- Consider extracting `<Section title>` and `<KeyValueRow>` components if a third view ever repeats those shapes; not justified at two.
