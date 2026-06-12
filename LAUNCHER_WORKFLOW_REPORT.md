# Launcher Workflow Report — first-run install

**Date:** 2026-06-12 · **Workflow:** the launcher's highest-value journey — first launch → environment check → license → install → handoff into the platform. It is the product's entire reason to exist (install / update / door) and every customer's first five minutes.

## 1. The flow, mapped (before)

1. App gate: `isInstalled()` false → wizard owns the window, tabs hidden.
2. **Step 1** — welcome + Docker probe (5s auto-poll after a download click), "what you'll get" list, Next appears only when Docker runs.
3. **Step 2** — license key (keychain-stored) or skip to Community.
4. **Step 3** — pre-flight checks; on pass, the install **auto-started after 1.2s**; live phase/percent/log via Tauri events; on success, browser opens `/ui/setup` and the wizard exits to Dashboard.

## 2. Friction and inconsistency found

- **A broken failure state (real bug):** the error text and Retry button rendered *inside* the `{installing && …}` block, but the failure handler set `installing` to false — unmounting the error the instant it existed. Worse, the auto-start effect (`can_install && !installing`) then re-fired the install: **a failed install showed nothing and silently retried forever.**
- **Unconsented multi-gigabyte action:** the screen said "verifying before we pull anything," then pulled 3–8 minutes of images with no click.
- **Anonymous stepper:** "Step 1 · Step 2 · Step 3," with completed and current steps styled identically — no names, no sense of place.
- **Hierarchy inversion:** step titles used `h2`, which the shell styles as an 11px uppercase *field label* — so "Let's get you set up" rendered smaller than its own body text.
- **Stale value proposition:** the step-1 list led with JupyterLab notebooks — a surface the 2.5.0 platform sunset — and never mentioned the five-surface platform or the Seer IDE.
- **Dead-end affordance:** when Docker wasn't ready, Next simply didn't exist; nothing said what would unlock it. Copy also told users to "re-launch to continue" while the code auto-detects without relaunching.
- **Pre-system visuals:** hand-rolled stepper/progress bar, `badge` used for machine states, link-as-`<a href="#">` actions, ad-hoc margins.

## 3. The flow, improved (after)

- **Named, stateful stepper:** `Environment → License → Install`, with `done` (walked, dim emerald), `current` (bright emerald, bold), and upcoming (quiet) — now a system component (`.stepper`/`.step`).
- **Explicit install gate:** pre-flight pass now ends at a clear summary + **"Install Auracle"** primary action ("Nothing is downloaded until you start the install"). Consent restored — and because nothing auto-fires, the retry loop is structurally impossible.
- **Failure is a first-class state:** install errors render as a `.banner err` with **Retry install** and Back, outside the installing gate, visible regardless of flags.
- **Honest waiting and success states:** progress bar is the system `.progress` component; the waiting copy says it's safe to background the window; success is a `.banner info` that explains the handoff — *"The stack is up. Finishing first-run setup in your browser — the launcher stays here for status, brokers, and updates"* — so the wizard's exit teaches the launcher's ongoing role.
- **Environment step:** Docker states are `chip`s (`not installed`/`installed · not running`/`running` + version), download/verify are real buttons (both arm the auto-poll), the "re-launch" copy is gone, and a **disabled Next with a reason** ("Waiting for Docker Desktop… auto-detects every few seconds") replaces the vanishing button.
- **Truthful value list:** the platform at `localhost:1969` (Home/Build/Research/Trade), the Seer IDE, MCP, TimescaleDB.
- **Hierarchy fixed:** step titles use the new `.step-head` (18px/600); `h2` remains for true sub-sections; pre-flight results are system rows with `pass/warn/fail` chips and indented remediation.

## 4. Verification

- `tsc --noEmit` clean; `vite build` green.
- Live render: `.step.current` computes emerald/600, `.chip.ok` the law tint with JetBrains Mono, `.progress` 6px, `.step-head` 18px.
- Inline styles in the view: 26 → 17, all remaining are layout one-offs per the density policy (card width, action-row layout, log sizing).
- New system pieces (`.stepper`, `.step`, `.step-head`, `.progress`) documented here and available to future wizards (broker connect is the obvious next consumer).

## 5. Transition map (after)

```
 launch ──not installed──► WIZARD
   Environment ──chip:running──► Next
   License ──key|skip──► Install step
   Pre-flight ──fail──► fix list + Re-check / Back   (no downloads yet)
             ──pass──► "Install Auracle" (explicit)
   Installing ──error──► banner err + Retry / Back   (always visible)
              ──done───► banner info + browser /ui/setup + Dashboard
```
