# Launcher UI QA — formatting & consistency pass

**Date:** 2026-06-12 · Third pass in the series (shell → design system → workflow → **QA**). Screens inspected: Dashboard, Settings, Broker Connections, IBKR auto-login (IbeamSetup), Onboarding, app shell.

## 1. What the inspection found

**Component inconsistency (top issue):** Settings and Onboarding rendered the *identical* Docker machine-states in two different visual languages — Settings used sentence-case `badge`s, an `<a href="#">` action, and bare "checking…" text, while Onboarding (post-workflow-pass) speaks chips + real buttons. Same state, one tab apart, two systems.

**Typography drift:** 20 `style={{ fontSize: … }}` props survived the earlier passes, including a four-times-repeated compact-button literal (`fontSize: 12, padding: "4px 10px"`) — an *uncodified size variant* that views kept re-inventing, plus 10/11px fine-print one-offs.

**Spacing drift:** ad-hoc `marginBottom: 12`, `marginTop: 6`, `padding: 8` literals off the 4px grid utilities; one hand-rolled flex-wrap row duplicating `.wrap-row`.

**Weak states:**
- Broker Connections' loading state was plain padded text ("probing brokers…") — no status vocabulary.
- Field-level error hints hand-rolled `color: var(--err), fontSize: 11` three separate times (another un-codified pattern).
- Dashboard's empty/loading states were textually fine ("No open positions.", "refreshing…") but styled off-grid.

**Alignment:** `.wrap-row` lacked `align-items: center`, so chip+text rows could baseline-wobble.

## 2. Fixed in this pass

- **One Docker-state language:** Settings' `DockerStatusBadge` rewritten onto chips (`checking` / `not installed` / `installed · not running` / `running` + mono version) with a real `ghost btn-sm` download action — now a mirror of Onboarding's Step 1. The anchor-as-action pattern is gone from the codebase.
- **Codified the compact control:** `.btn-sm` (the 12px tier seg-tabs already used) is now defined once in CSS; all five repeated literals across Dashboard/BrokerConnections converted. `.fs-2xs` (10px fine-print tier) and `.err-text` join the kit; `.mb-3` fills the spacing-utility gap; `.wrap-row` aligns centers.
- **Swept the drift:** error hints, fine print, empty-state and "showing top N" lines, banner inner spacing, and the activation-card paragraph all moved onto utilities. Typography-in-style-props: **20 → 3**; total inline styles: 87 → 61 (the remainder is layout per policy).
- Verified: `tsc --noEmit` clean, `vite build` green after every step.

## 3. Remaining gaps (honest ledger)

| Gap | Where | Why deferred |
|---|---|---|
| 3 typography props (`alignSelf` + size combos) | IbeamSetup mid-layout | needs the view's layout pass, not a literal swap |
| IbeamSetup deep pass (13 inline styles, hand-rolled credential form rows) | IbeamSetup | biggest remaining non-system view; the wizard components from Onboarding (`.stepper`, `.step-head`) are its natural vocabulary |
| Onboarding card frame (`maxWidth: 640, margin: 48px auto, padding: 32`) | Onboarding root | legit layout one-off; could become `.wizard-frame` if a second wizard appears |
| `pre.logs` sizing repeated (`maxHeight: 200`, `fs-2xs`) in two views | Onboarding/Settings | promote a `.logs--compact` variant when touched next |
| No skeleton/shimmer for Dashboard first load (text "refreshing…" only) | Dashboard | acceptable for a 5s-poll launcher; revisit only if load feel worsens |

## 4. Next priorities (ranked)

1. **IbeamSetup layout pass** — last non-system view; adopt wizard + row + chip vocabulary end-to-end (clears the final 3 typography props).
2. **`.logs--compact` variant** — one definition for collapsible log panes.
3. **Empty-state copy audit** — Dashboard "No open positions." is good; give Broker Connections' no-brokers state an equally directive line (where to connect, what appears after).
4. Keep the checklist green: `grep -E 'fontSize|fontWeight|letterSpacing' src/views -r --include='*.tsx' | grep 'style={{'` should trend to zero and never grow.
