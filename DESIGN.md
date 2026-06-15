# DESIGN.md — Auracle Desktop

Visual system for the desktop launcher. Direction: **Percept terminal** (covert,
sharp, minimal), soft 6–10px corners. Single source of truth for tokens is
`src/styles/app.css :root`; this file is the spec those tokens encode. Derived
from the owner's `AuraTerminal/src/styles/perceptTheme.ts` + the Auracle palette +
the marketing site (`auracle-marketing`).

## Theme
Pure-black terminal. Elevated surfaces are tone steps above black (not white
washes). Chrome is implied by hairline low-alpha lines, never announced by heavy
borders or cards. No gradients, glows, neon, or heavy shadows. High-contrast, not
glowing. The grid is barely there; the data does the talking.

## Color palette
- **Background ladder:** `#000000` base · `#050505` sunk · `#0a0a0a` panel/hero · `#111111` elevated.
- **Surfaces (translucent washes):** white 0.02 / 0.04 / 0.07.
- **Text ramp:** `#e6edf3` primary · `#9da7b3` secondary · `#5a636e` tertiary · `#3a4049` muted/disabled.
- **Lines (implied chrome):** white 0.06 default · white 0.10 strong · `rgba(16,185,129,0.30)` accent ring.
- **Accent (surgical):** emerald `#10b981` (live/active/long + primary buttons, black text). Hover `#059669`. Soft `rgba(16,185,129,0.12)`.
- **States (desaturated):** ok `#34d399` · warn `#fbbf24` (amber) · err `#f87171`. Never harsh pure RGB.
- **Grid:** horizontal white 0.04, vertical white 0.025 (~30px cell).
- Contrast: body ≥4.5:1, large ≥3:1 — verify on the near-black base (the ramp is built for it).

## Typography
- **Sans:** Inter / system. **Mono:** SF Mono → ui-monospace (leads for all data + labels).
- **tabular-nums** on every number-bearing cell/row.
- **mono-label:** SF Mono, 10–11px, 0.06–0.12em tracking, UPPERCASE, color tertiary — for section labels + column heads.
- Headings: medium weight (500), tracking-tight (≈ -0.02em); no oversized heroes (this is product, not brand).
- Pair on a contrast axis only (sans + mono); never two similar sans.

## Components
- **Surfaces:** hairline-bordered tone panels (white 0.02 fill + white 0.06 line), 6–10px radius. NOT solid cards; NEVER nested cards.
- **Data rows / tables:** the primary pattern — mono + tabular, hairline row separators, name in primary ink, details in tertiary, emerald only for live capability.
- **Status:** restrained pills (pill radius) — desaturated amber/red/emerald; or inverted high-contrast (black text on solid fill) for emphasis.
- **Primary button:** emerald-filled, black text, 6–10px radius. Secondary: transparent + hairline border.
- **Signature data elements (from the site):** big emerald mono-feature-numerals for headline metrics; thin metric-bars (avoid animating width — animate transform); terminal-block for system/log strips.
- **Focus:** visible emerald focus ring on every interactive element.

## Layout
- Compact terminal density (≈13–14px rows); vary spacing for rhythm.
- Editorial hairline dividers over boxes; exact pixel alignment; flex for 1D, grid for 2D.
- Barely-there grid texture on canvas surfaces only; flat black elsewhere.
- Responsive: density holds at all window sizes; no column collisions at narrow widths.

## Anti-patterns (auto-fail — also caught by `npx impeccable detect`)
Solid gray rounded cards on gray; cool-gray hex text instead of the ramp; announced
heavy borders; any glow/gradient/neon; non-tabular numbers in data; decorative
(non-surgical) emerald; sharp-2px or pill corners on panels (use 6–10px);
animating width/height/padding (use transform).
