# DESIGN.md — Auracle Desktop

The visual and behavioural system of the launcher, **as built**. Concept: **The
Orrery**. Design authority: `launcher-redesign-direction.md` (external); this
file is the record of what actually landed, including where the build
deliberately departed from that document and why.

Single source of truth for values is `src/styles/app.css :root` — every token
there carries its own rationale in a comment. This file is the map and the law;
the stylesheet is the values.

> **Retired vocabulary.** Three things appear in older commits, comments and
> screenshots and are *gone*: **emerald as a brand colour** (green now means
> health and only health — `--ok`), **the white accent** (a white "accent" is
> not an accent, it is ink), and **the Lamp** (the 108px status orb the
> instrument replaced). If you find any of them in a doc or a class name, it is
> drift — delete it.

---

## 1. The concept

Auracle's mark is already an orbital system: a swirl and two bodies. The
launcher makes that mark *functional*. The engine core sits at the centre of the
window; every real container the machine is running is a body on a hairline
ring. Healthy, the mechanism turns — 60 seconds to the revolution, sub-
perceptual — and says *your desk is live* before a single word is read.
Degraded, the affected body goes amber and falls visibly off the beat. Down, the
mechanism spins down to a stop and the ring goes dashed: a stopped watch,
unmistakable and calm.

The resting state of the instrument — core plus two chrome dots — reproduces the
logo. Opening the launcher on a stopped machine shows the mark, at rest. Opening
Supervision is opening the back of the instrument.

The window is three fixed bands on one charcoal chamber:

```
┌──────────────────────────────────────────────┐
│ topbar: glyph·Auracle            ⌘K · System │  hairline below, 44px
│                                              │
│                THE INSTRUMENT                │  orbit stage, minmax(0,55%)
│           (orrery: core + bodies)            │  ambient dot-field behind
│                                              │
│            Everything's ready.               │  THE VERDICT (display serif)
│              [ Open workspace ]              │  one Nous-blue verb
│                                              │
│ engine Healthy · v0.8.37 · What's new · Help │  THE LEDGER (mono meta row)
└──────────────────────────────────────────────┘
```

Depth surfaces — the inspector tray, the ⌘K palette, the tutorial and coachmark
— are machined parts of the same instrument: opaque charcoal planes, hairline
edges. No glass, no glow, no `backdrop-filter` anywhere.

---

## 2. The system as it landed

### 2.1 Colour

The launcher adds no hue. It subtracts. Full values and rationale live in
`app.css :root`.

| Group | Tokens |
|---|---|
| Canvas ladder | `--bg #0b0c0e` · `--bg-rail #08090b` · `--bg-elev #181b20` |
| Surfaces | `--surface #131519` · `--surface-2 #1b1e23` (hover) · `--surface-3 #23272d` (pressed) |
| Text ramp | `--fg #e6edf3` · `--fg-dim #9da7b3` · `--fg-muted #7c8694` · `--fg-faint #3a4049` |
| Lines | `--line` white α.08 · `--line-strong` white α.14 |
| Accent | `--accent #0053fd` · `--accent-2 #0042cc` · `--accent-soft` α.16 · `--accent-dim` · `--accent-text #7aa2ff` · `--accent-ink #fff` |
| Status | `--ok #34d399` · `--warn #fbbf24` · `--err #f87171` (+ `-soft` α.12 / `-dim` α.30) |
| Elevation | `--elev-card 0 1px 2px rgba(0,0,0,.45)` + `--hairline-top` — nothing more |
| Ambient | `--stage-dot` α.05 · `--stage-dot-near` α.09 |
| Instrument | `--orbit-ring: var(--line-strong)` · `--orbit-body: var(--fg-dim)` |

**Three laws, all enforced by the token names themselves:**

1. **Blue is brand, never status.** Never point `--ok`/`--warn`/`--err` at
   `--accent`. A blue health dot conveys nothing.
2. **Contrast is a token choice, not a judgement call.** `#0053fd` on `--bg` is
   ≈3.4:1 — fills, borders and graphics only. Blue *text* always takes
   `--accent-text` (≈7:1). White on filled accent is ≈5.7:1.
3. **Blue lands at most three times per screen** (the one verb, one live
   signal, the focus ring) and never fills a region.

The instrument is deliberately achromatic: the ring is **chrome** (it is the
mechanism, not a reading), a body is neutral **ink** until its own container
reports otherwise, and only the **core** is ever chromatic. That is what keeps
one status colour on screen instead of a constellation.

### 2.2 Type

Three OFL faces are **bundled** (`@fontsource*`, served from `'self'`), so the
launcher renders identically on macOS, Windows and Linux, offline, on first
paint. The system stacks are fallbacks only.

| Role | Face | Used for |
|---|---|---|
| Display | **Fraunces Variable** (`--font-display`, `--fvs-display: "opsz" 72, "SOFT" 0`, weight 400) | The verdict line, station titles, sign-in welcome. Nowhere else. **Never bold.** |
| UI sans | **Inter Variable** (`--font-sans`) | Body, buttons, prose. |
| Data mono | **JetBrains Mono** (`--font-mono`) | Ledger, chips, labels, logs, container names, versions, codes, palette input. `tabular-nums` on every number. |

Scale: `--t-xs 11 / --t-sm 13 / --t-base 14 / --t-md 16 / --t-lg 18 / --t-xl 24`,
plus two display steps — `--t-verdict: clamp(22px, 3.4vw, 30px)` and
`--t-station: 20px`. The **mono-label register** (10–11px, 0.08em tracking,
UPPERCASE, `--fg-muted`) is the app's section-head voice.

### 2.3 Space, radius, elevation

Spacing `--s-1…--s-6` (4/8/12/16/24/32). Radius 6/8/10/pill. Exactly two
elevation levels above the canvas: cards (`--elev-card` + top hairline) and
floaters (tray/palette). Scrims are plain `rgba(0,0,0,.55)`.

**No `filter` and no `backdrop-filter`, anywhere.** WKWebView renders
`backdrop-filter` as flat black over canvas layers — a documented project scar.
The stylesheet currently contains zero of both; keep it that way.

### 2.4 Motion

**One engine: GSAP**, and one vocabulary, in `src/fx/motion.ts`. Components
import `EASE` / `DUR` / `STAGGER` and never hand-roll a curve or a magic
millisecond. CSS transitions survive only for hover/focus micro-states
(≤ `DUR.micro`, eased out).

House curves: `aur-enter` (power4.out, entrances) · `aur-exit` (power2.in,
exits) · `aur-mech` (power2.inOut, mechanical moves). Never bounce, elastic or
overshoot. Nothing animates longer than **800ms** (`MAX_DURATION`), and the only
thing allowed to reach it is the once-per-machine commissioning ceremony.

> **Deviation — stock eases, not `CustomEase`.** The direction document
> specified registering the house curves via `CustomEase`. They are registered
> with `gsap.registerEase(name, gsap.parseEase("power4.out"))` instead, because
> all three curves *are* stock GSAP curves — naming them is the point, not
> re-deriving them. `CustomEase` is therefore never imported and never ships.
> Add it only if a curve appears that GSAP cannot already parse.

**The one live CSS keyframe** in the whole app is `act-progress`, the in-button
hairline sweep while the engine is coming up. Everything else that moves goes
through GSAP. If you are about to write `@keyframes`, you are probably about to
create a second animation system.

### 2.5 The mark

`AuracleGlyph` is the one source of the logotype and renders in `--fg` at rest —
never blue (blue is spent on the verb). The home instrument is *not* the glyph
scaled up: it is purpose-built SVG whose resting geometry quotes the mark
exactly. `MARK` in `src/fx/orrery.ts` records how it was measured off the traced
vectors, and why the size difference between the two dots is perspective rather
than encoding. The menu-bar icon is the same quotation, rasterised at 36px
(§6).

---

## 3. The power law

The launcher lives in the menu bar and is hidden most of its life. Battery
behaviour is a design property, not an optimisation.

| Window state | Ambient dot-field | GSAP ticker |
|---|---|---|
| `document.hidden` (minimised, tray-only) | **suspended** — no rAF, canvas never painted | **asleep** |
| visible, blurred | 30fps (frame-skip gate) | 30fps |
| visible, focused | 60fps | 60fps |
| `prefers-reduced-motion` | **one static frame**, no drift, loop never started | *unchanged — deliberately* |

Both halves come from one module, `src/fx/ambient.ts`, so the field and the
ticker can never disagree about what "hidden" means. `ambientCadence()` is the
field's half; `tickerPower()` is the ticker's.

`tickerPower()` ignores `reducedMotion` **on purpose**. Reduced motion collapses
every tween to zero duration, and a zero-duration tween still needs one tick to
land on its end state. Sleeping the ticker there would strand every entrance
mid-flight — the exact bug the kill switch exists to prevent.

**Resume re-measures before it paints.** A hidden WKWebView delivers neither rAF
nor ResizeObserver, so geometry cached before a hide may describe a window that
no longer exists. `DotField`'s `sync()` measures, then paints, then decides
whether to loop — in that order. Never trust a cached size across a hide.

**Measured against the budget** (900×700, this machine): 3,200 dots; ambient
paint **1.34 ms/frame**; GSAP ticker **~0.001 ms/tick** with five bodies riding;
combined **~1.34 ms** against a 3 ms budget. Six `fill()` calls per frame, DPR
capped at 2, **zero WebGL contexts**.

---

## 4. The honesty laws

These are the ones that make this a status instrument rather than a decoration.
Every one of them is enforced somewhere you can point at.

1. **The instrument never fabricates a machine.** Bodies come only from real
   containers reported by `stackStatus()`. An unknown or empty list does not
   become "a couple of dots so it looks alive" — it falls back to the mark's own
   two **chrome dots**, which are part of the ring drawing and carry no data.
   *Enforced:* `fx/orrery.ts` (`orreryFrame`, `chrome`), tested in
   `orrery.test.ts`.

2. **Motion is ambience; data is ink.** A body's *angle* means nothing — seeds
   are deterministic and the revolution is a 60s drift. What a body *means* lives
   in its ink (neutral / amber / red, straight off the container's own state) and
   in its mono flag, which quotes the container's own words. Nothing upgrades a
   container to healthy; an unknown state stays neutral, because the instrument
   has no green. *Enforced:* `containerTone` / `containerFlag`.

3. **Numbers never tween.** No count, countdown, percentage or progress value is
   ever animated. `fx/motion.ts` deliberately ships **no** number-tween helper
   and must never grow one. The install arc is *set* from the last percent the
   installer itself reported — no floor, no minimum speed, no trickle: a step
   that stalls renders stalled, at the number it stalled on. *Enforced:*
   `fx/commissioning.ts` (`arcProgress`), and the absence of `countTo` in
   `fx/motion.ts`.

4. **Status hues never crossfade.** A half-amber dot is a state the machine was
   never in. Hues snap at the trough of a 120ms opacity dip. *Enforced:*
   `snapStatus()`.

5. **A verdict may animate as ceremony; its content is truth.** `revealWords()`
   can only reveal the words the element already holds — no scramble, decrypt,
   typewriter or split-flap, because every one of those spells words the machine
   never said. *Enforced:* `revealWords()`, plus a grep guard in `motion.test.ts`
   keeping those plugins out of the tree.

   > **Deviation — the outgoing line does not fade.** The direction document
   > specified a 120ms opacity-out on the old sentence before the new one
   > arrives. That requires committing the new line from a tween's
   > `onComplete` — and this app sleeps its ticker whenever the window is
   > hidden. A slept ticker would strand the verdict on the previous sentence
   > while the verb and the ledger beside it already read the new state: the
   > home contradicting itself, which this surface may never do. **The line
   > commits immediately; only its arrival is animated.** React owns the text
   > and a `key` retires the element, so the DOM holds exactly one line and it
   > is always the one the engine reports.

6. **Nothing turns until something is running.** The commissioning mechanism is
   `running` in exactly one stage — `live` — reached only after a real health
   answer from the engine. Neither the installer exiting nor the arc reaching
   100% is enough: both are claims about a process, and the instrument reports
   the machine. *Enforced:* `fx/commissioning.ts`, tested.

7. **No dead controls.** Every control either acts or explains why it cannot
   (disabled + a reason line). The tray menu has zero dead items and stays that
   way.

---

## 5. Reduced motion

`prefers-reduced-motion` is a **kill switch, not a skip**. Every duration, delay
and stagger passes through `motionTime()`, which returns 0. Zero-duration tweens
still *run*: they land on their end state in one tick and still fire
`onComplete`, so an entrance can never strand content invisible and no
mount/unmount gated on a completion callback can hang.

The preference is read **live**, never cached into a module constant — users
flip it mid-session. `prefersReducedMotion()` reads at call time;
`useReducedMotion()` is the React binding.

What each surface does when the preference is on:

| Surface | Behaviour |
|---|---|
| Orrery revolution | Seated at its deterministic seed, then **paused**. Resumes live if the preference is turned off. |
| Core breath | Never started; the core is simply lit. |
| Bodies arriving/leaving | Instant; `onComplete` still fires, so cleanup runs. |
| Spin-down | Snaps. The stopped state is *also* carried statically by the dashed ring, the core hue and the absence of bodies. |
| Ambient field | One static frame, dots on their anchors, rAF never started. |
| Verdict | Words split and land complete on the first tick; `aria-label` carries the sentence regardless. |
| Ledger update sweep | The underline is simply there. |
| Tray / palette / echo | Instant open and close, both directions. |
| Tutorial / coachmark | No animation at all in any mode. |
| Install arc | Never animated in any mode. |
| CSS `act-progress` sweep | Neutralised to nothing. |

The global CSS neutraliser (`@media (prefers-reduced-motion: reduce)`) zeroes
animation and transition **durations *and* delays**. A ~0 duration after a 2s
delay is still a 2s stall — "instant" has to mean instant at both ends.

**The truth test.** Motion may never be the *only* carrier of a fact. Every
state above is redundantly encoded in static ink or words: off-tempo ⟺ amber/red
body ink; stopped mechanism ⟺ dashed ring + core hue + absent bodies; breath
tempo ⟺ core hue + the verdict sentence; the in-button sweep ⟺ the button label,
the disabled state, the verdict and the ledger vital. **If you add a surface
where turning motion off loses information, the surface is wrong.**

---

## 6. The menu-bar icon

Native, and the only part of the system outside `src/`
(`src-tauri/src/commands/tray.rs`). It is **not an asset** — there is no
`tray.png` to edit. It is rasterised at runtime, pure RGBA, by `render_orbital`:

- 36px buffer, `set_icon_as_template(false)` (the core must keep its hue).
- Ring radius 13, stroke ≈1.5px, drawn in chrome `#e6edf3` at α.9.
- Core radius 5 — **the only chromatic part**, carrying the status hue
  (healthy/degraded/down/checking).
- One satellite, 2**pt** diameter, riding the ring at 45° — in the mark's own
  quadrant, since its prominent body sits at −11.5° screen bearing. Taken as
  raster pixels instead of points it would vanish into the 1.5px stroke, and an
  icon with no body riding it is a bullseye, not the mark.
- A dark rim keeps it legible on light menu bars.

Two `const` assertions in that file keep the core from colliding with the ring
and the satellite from being swallowed by the stroke. `scripts/gen-icons.sh`
emits exactly `tauri.conf.json`'s `bundle.icon` list and deliberately nothing
else.

---

## 7. File map

The system is split the same way three times: a **pure module** that decides
*what is shown*, and an **imperative component** that owns nodes and tweens. The
split is why the honesty laws are tests instead of promises — the pure half runs
under plain `node --test` with no renderer.

| File | Owns |
|---|---|
| `src/fx/motion.ts` | The one motion engine. `EASE`/`DUR`/`STAGGER`, the house curves, `enter`/`exit`/`mech`/`snapStatus`/`revealWords`, the reduced-motion kill switch, and `governTicker()`. |
| `src/fx/ambient.ts` | The power law (`ambientCadence`, `tickerPower`), the field's geometry and dot budget, the ink ramp. **Pure.** |
| `src/fx/DotField.tsx` | The ambient canvas. Vendored + adapted from react-bits (attribution in the file header). Canvas plumbing only. |
| `src/fx/orrery.ts` | The instrument's state map, body rules, ring/seam geometry, the `MARK` measurements, and `seatPoint` (the still echo's arc-length walk). **Pure.** |
| `src/components/Orrery.tsx` | The instrument's SVG and tweens. Nothing decided here. |
| `src/fx/commissioning.ts` | First-run staging: stage ladder, stations, arc progress, ring/core per stage. **Pure.** |
| `src/components/CommissioningInstrument.tsx` | The first-run instrument's SVG, the arc, the ceremony. |
| `src/components/OrreryEcho.tsx` | The still miniature at the top of Supervision. Plain SVG, zero tweens. |
| `src/lib/aggregator.ts` | `deriveBoard()` — the single source of what the home says. Pure, and the highest-value test seam in the app. |
| `src/lib/ledger.ts` | Band 3's cells and the update-truth ladder. |
| `src/lib/signin.ts` | The pre-auth gate: whether the browser sign-in can start at all, and what the card says when it can't. **Pure.** |
| `src/components/Shell.tsx` | The live surface: bands, hotkeys, echo line, polling. |
| `src/components/StandbyHome.tsx` | The three bands' markup: instrument, verdict + verb, ledger. |
| `src/components/InspectorHost.tsx` | The tray: one at a time, Esc/scrim close, the mechanical slide. |
| `src/components/CommandPalette.tsx` | ⌘K. |
| `src/views/Onboarding.tsx` | The first-run state machine (Docker probe, licence, pre-flight, `installer-progress`, health poll). |
| `src/styles/app.css` | Every value, every token, one stylesheet. |

**The seam that must not move:** this is a re-skin of truth, not a re-derivation
of it. `aggregator.ts`, `lib/tauri.ts` and the Rust commands decide what is
true; everything above only draws it.

---

## 8. Adding a surface without breaking the system

1. **Decide in a pure module, draw in a component.** If your surface has any
   state logic, it belongs next to `orrery.ts`/`commissioning.ts` with a
   `node --test` file — not inside a `useEffect`.
2. **Take values from tokens.** `grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' src/views
   src/components` stays at zero. A new hue means the state model is wrong, not
   the palette.
3. **Take motion from `fx/motion.ts`.** Import `EASE`/`DUR`; never write a raw
   millisecond. If you must call `gsap` directly (a continuous loop is the only
   legitimate reason), you now own the reduced-motion contract yourself: hold
   the tween in a ref and pause/resume it from an effect that has `reduced` in
   its dependency array. `Orrery.tsx` is the reference implementation.
4. **Ask what the surface says with motion off.** If the answer is "less", add
   the static carrier before you add the animation.
5. **Never animate a number, and never add a helper that could.**
6. **No `filter`, no `backdrop-filter`, no WebGL, no second animation library.**
   `motion.test.ts` greps for the ones already removed.
7. **Delete the CSS in the PR that orphans it.** Every class in `app.css` must
   have a consumer; dynamic construction counts, so check for the built prefix
   (`coach__callout--${band}`) before declaring a class dead.
8. **Status maps to `ok` / `warn` / `err` / `neutral`.** See
   `LAUNCHER_DESIGN_SYSTEM.md` for the component-level law.

## 9. Anti-patterns (auto-fail)

Emerald or white as a brand accent · blue used for status · blue as small text
(use `--accent-text`) · a second animation library · `@keyframes` for anything
that is not already `act-progress` · `filter` / `backdrop-filter` / glow /
gradient / neon · nested cards · a tweened number, count or percentage · a
progress bar that moves without real progress · a body on the ring without a
container behind it · non-tabular numbers in data · animating width/height/
padding (animate transform) · a control that neither acts nor explains itself ·
raw hex in a view.
