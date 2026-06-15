# PRODUCT.md — Auracle Desktop

## Register
**product** — this is app UI (a control surface for the self-hosted Auracle
algorithmic-trading engine), not marketing. Design SERVES the product: the data
and the operator's tasks lead; the chrome recedes.

## Target users
Hedge-fund operators, quants, and trading-infra leads running or evaluating a
self-hosted algorithmic-trading platform on their own machine. Sophisticated,
impatient, allergic to retail-app gloss. They judge craft instantly.

## Product purpose
The desktop launcher is the operator's control surface: connect brokers + market
data, supervise the engine/Docker stack, and move strategies research → backtest →
paper → live. It opens into the IDE + the web console. Engine is authoritative;
this app is a calm, honest client.

## Brand personality
**Covert, sharp, minimal, terminal-grade.** Stealth-wealth quant terminal:
confident, calm, precise, data-forward. Understated — nothing announces itself.
Premium through restraint and exactness, never through ornament.

## Anti-references (do NOT look like these)
- The generic AI/SaaS-template tell: Inter-for-everything, purple→blue gradients,
  cards nested in cards, gray text on colored fills, the rounded-square icon tile
  above every heading.
- Retail trading apps: bright candy greens/reds, glows, neon, busy gradients.
- Anything that "shouts": oversized heroes, heavy drop-shadows, decorative motion.

## Strategic design principles
1. **The data does the talking** — minimal chrome; content + numbers lead.
2. **Implied chrome, not announced** — hairline low-alpha borders; surfaces via
   tone steps, never heavy cards.
3. **Mono + tabular for all data** — `tabular-nums` on every number-bearing row.
4. **Surgical emerald** — `#10b981` only for live/active/long + primary buttons;
   everything else is the grayscale ramp.
5. **High-contrast, not glowing** — no glow/neon/gradients; restraint = the look.
6. **One exact unified theme** — the same tokens, spacing, states everywhere; zero
   drift across surfaces.
7. **Honesty** — never a fake/placeholder state; show real engine/broker truth.

See DESIGN.md for the visual system. The locked direction is "Percept terminal"
(soft 6–10px corners), derived from the owner's AuraTerminal `perceptTheme.ts`.
