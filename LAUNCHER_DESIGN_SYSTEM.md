# Auracle Launcher Design System

Component-level law for the desktop launcher: the inventory, the rules for using
it, and the anti-patterns that re-fragment it. Companion to `DESIGN.md`, which
owns the concept, the tokens, the motion laws and the file map — **read that
first**. This file answers "which shape do I reach for?".

Concept: **The Orrery**. Everything below is what shipped.

> **v0.10.0 re-materialed this inventory; it did not change it.** Every
> component, rule and anti-pattern below is the one that shipped in v0.9.0.
> What moved is the palette and the type they are drawn in — see `DESIGN.md
> §2.1/§2.2`, and `auracle-marketing/DESIGN.md` for the brand authority behind
> those values.

> **Retired.** `.launch-card` and the launch grid · the left `.rail` and
> `.nav-item` tabs · `.hero` · `.kpi` tiles · `.tiles`/`.tile` ·
> `.section-head` / `.pane-head` · Nous-blue as the accent · emerald as an
> accent · the white accent · the Lamp. These were deleted, not deprecated. If
> you find one referenced, it is drift.

---

## 1. Tokens

Values and rationale live in `src/styles/app.css :root`; the table is in
`DESIGN.md §2.1`. The short version every component builds from:

| Group | Tokens |
|---|---|
| Canvas / surfaces | `--bg` cream · `--bg-rail` · `--bg-elev` · `--surface` / `-2` / `-3` · `--paper` |
| Text | `--fg` ink · `--fg-dim` · `--fg-muted` warm grey · `--fg-faint` |
| Lines | `--line #dedede` · `--line-strong #c9c6bf` |
| Accent (brand only) | `--accent #ff9100` · `--accent-2` · `--accent-soft` · `--accent-dim` · `--accent-text #a04e00` · `--accent-ink` ink |
| Status | `--ok` · `--warn` · `--err` (+ `-soft` α.12 / `-dim` α.30) |
| Depth | `--elev-card` · `--hairline-top` · `--elev-floater` · `--scrim` |
| Geometry | radii 6/8/10/pill · spacing 4→32 · type 11/13/14/16/18/24 + `--t-verdict` / `--t-station` |
| Fonts | `--font-sans` Geist Sans · `--font-mono` Geist Mono · `--font-display` → `--font-sans` at `--fw-display` 500 |

**Tint rule:** soft fills are the token at a fixed alpha — `.12` for
chips/badges, `.08` for banners — never a different hue.

**Accent rule:** `--accent` is brand, never status. Orange text always takes
`--accent-text`. At most three accent elements per screen. The focus ring is
2px solid `--accent`, everywhere.

**Two grounds, one set of names.** The tray (`.insp`) re-points these tokens
to the black counter-material for its own subtree. Components never learn
which ground they are on: they name the token, the ground supplies the value.
If you find yourself writing a `{light, dark}` record in a component, the
answer is a scoped token re-point, not a second palette (§4.1).

---

## 2. Component inventory & rules

| Component | Use for | Never for |
|---|---|---|
| `.card` + `.row` | Content blocks inside a tray; rows auto-divide | nesting cards in cards |
| `.card-head` (+`--action-only`) | A block's own title/badge line | repeating the tray's own title (the tray **is** the container) |
| `.standby__actuator` | **The one verb.** Exactly one per screen, `--accent` fill, `--accent-ink` label | two primaries; any secondary action |
| `button.ghost` (+`.danger`) | Every secondary/destructive action | primary-styled destructive acts |
| `.chip` `ok/warn/err/neutral` | Mono/uppercase machine states (container health, tier, docker state) | free-form colours; new hues |
| `.badge` `ok/warn/err` | Sentence-case status words in prose | machine-state words (use a chip) |
| `.banner` `info/warn/err` | Inline notices inside a tray body | page-level chrome |
| **`IncidentCard`** | **Every "something is wrong"**: severity chip + plain cause + ≤1 action + optional detail | a bespoke error shape; more than one action |
| `ConfirmRow` | In-surface destructive confirm (arms, then acts) | a modal |
| `SetupHint` | "No owner account yet — Finish setup →", wherever owner-gating fires | generic empty states |
| `.seg-toggle` | Binary mode choices | 3+ options (use rows) |
| `.ledger__cell` | Band 3 meta cells — each a discrete button with provenance | decorative meta text |
| `.insp-*` (tray) | Any depth surface docked right | a second simultaneous tray |
| `.cmdk__*` | ⌘K only | a general menu system |
| `pre.logs` | Log/terminal output | styled prose |
| Density utilities (`.fs-*`, `.mt-*`, `.mb-*`, `.hstack`, `.wrap-row`) | Micro-typography/spacing | replacing semantic components |

**State→variant mapping (binding).** healthy / connected / real-time → `ok` ·
attention / pending / delayed / starting → `warn` · failed / offline / halted →
`err` · inert / not-installed / closed / unknown → `neutral`. A new state must
pick one of these four; if none fits, the state model is wrong, not the palette.

**Two shapes for every fault.** Every error, edge and degraded state in the app
renders as either an **`IncidentCard`** or an **inline err/muted line** — Docker
trio, engine unreachable vs unhealthy vs no-probe-yet, 409 settings conflicts,
install failure, installed-but-not-answering, no-Tauri-backend, LAN-off pairing,
expired pair code, GitHub not-configured, clipboard failure, launch errors. If
you are inventing a third shape, use `IncidentCard`.

---

## 3. The surfaces

| Surface | Shape |
|---|---|
| **Home** | Three bands: instrument (`minmax(0,55%)`), verdict + one verb, ledger. Ambient dot-field behind. |
| **Tray** (8 inspectors) | Full-height right dock, 420px (or a 92%-width sheet under 720px), the **black** counter-material, 1px `--line-strong` left edge. Header = mono-uppercase title + `esc` keycap. One at a time; home keeps polling behind it. Motion: x +16→0, 240ms `aur-mech`; scrim to `--scrim`. Home dims, never blurs. |
| **⌘K palette** | Centred, top third, 560px, `--bg-elev` (paper on cream — it annotates the board, so it does not take the tray's black). Mono input, `live-sourced` tag, mono-uppercase group labels. Selected row = `--surface-2` + inset 1px `--accent`. Destructive rows carry a `live` tag; double-Enter arms. Footer states the honesty rule. |
| **Tutorial** | Orientation card, bottom-centre: mono step label, display-serif title, station ticks on a hairline. |
| **Coachmark** | Three sequential hairline callouts pointing at the real bands — instrument → verb → ledger. Anchors are deterministic because the bands are fixed. |
| **Commissioning** | Left hairline spine with three stations (Environment · Sign in · Install), right station content, the instrument above. |
| **Sign-in** | Ambient field, 64px glyph, display welcome, one white Google pill on a hairline (the mark is reproduced as its owner draws it — the Google affordance is a trust signal). |

The eight inspector keys are `supervision · updates · system · intelligence ·
changelog · help · lifecycle · pair`. Adding a ninth means adding a key to
`InspectorKey` and a case to the switch — and asking whether the tray is still
one idea.

---

## 4. Anti-patterns

1. **Private colour maps in components** — a `{bg, fg}` record per view is a
   second design system. Map states to variants.
2. **Off-palette hues for emphasis.** If the palette can't say it, don't say it
   with colour.
3. **Wrong-value token fallbacks** (`var(--ok, #4ade80)`): a fallback that
   disagrees with the token is a dormant bug. Tokens are always defined — write
   `var(--ok)`. Likewise never chain a fallback onto a token that does not
   exist.
4. **Inline typography/spacing** (`fontSize: 12`, `marginTop: 6`). Utilities
   only; `style={{}}` is layout-only.
5. **Re-rolling an existing shape** with slightly different padding/radius. Grep
   for the shape before building it.
6. **Dead CSS kept "just in case."** Orphaned classes are deleted in the PR that
   orphans them. When checking whether a class is dead, remember classes built
   at runtime (`coach__callout--${band}`) never appear literally in source —
   grep the *prefix*.
7. **A body on the ring with no container behind it**, a count that was never
   reported, a progress bar that moves without progress. See `DESIGN.md §4`.
8. **A second primary.** One verb per screen.
9. **Repeating the tray title inside the tray body.** The tray is the container.

---

## 5. Contribution checklist

- [ ] Colours: tokens/variants only. `grep -rnE '#[0-9a-fA-F]{3,8}' src/views src/components --include='*.tsx'` returns **only** the four `fill=` values of the Google "G" mark (a third-party logo reproduced exactly, in `Onboarding.tsx` and `ui/sign-in-flow-1.tsx`). Any other hit is drift. The sign-in's Tailwind utilities count: they name tokens (`text-[var(--fg)]`), never colours.
- [ ] Status maps to `ok`/`warn`/`err`/`neutral`; faults render as `IncidentCard` or an inline line.
- [ ] Motion imports `EASE`/`DUR` from `src/fx/motion.ts`; no raw milliseconds, no second library, no new `@keyframes`.
- [ ] Any raw `gsap` loop holds its tween in a ref and pauses/resumes it from an effect with `reduced` in the deps.
- [ ] With `prefers-reduced-motion` on, the surface still says everything it said before.
- [ ] No `filter` / `backdrop-filter` / WebGL.
- [ ] Density: no `fontSize`/`margin*` in `style={{}}`.
- [ ] Every new class has a TSX consumer; every orphaned class is deleted in the same change.
- [ ] `npm run typecheck`, `npm run build`, `npm test` green.
