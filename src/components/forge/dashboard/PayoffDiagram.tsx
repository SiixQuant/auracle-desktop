// PayoffDiagram widget — multi-leg option strategy P&L at expiry.
//
// Spec shape (all inline; no upstream data fetch needed):
//   {
//     "type": "payoff_diagram",
//     "title": "QBTS Jul long strangle",
//     "data_source": { "tool": "inline", "args": {} },
//     "spot": 18.50,
//     "legs": [
//       { "type": "call", "strike": 20, "premium": 1.20, "qty": 1, "action": "buy" },
//       { "type": "put",  "strike": 17, "premium": 0.95, "qty": 1, "action": "buy" }
//     ],
//     "price_range": { "min": 12, "max": 25, "steps": 100 },   // optional
//     "contract_multiplier": 100                               // optional, default 100
//   }
//
// Standalone — no IBKR / Yahoo dependency. The agent computes the
// legs from a get_options_chain call, then bakes the parameters
// into the spec. The widget re-renders the P&L curve inline and
// the user can iterate by asking the agent to tweak the legs.

import { useMemo, type ReactElement } from "react";

import { fmt, type WidgetRenderState } from "./types";

interface Leg {
  type: "call" | "put";
  strike: number;
  premium: number;
  qty: number;
  action: "buy" | "sell";
}

interface PayoffSpec {
  spot?: number;
  legs?: Leg[];
  price_range?: { min: number; max: number; steps?: number };
  contract_multiplier?: number;
}

export default function PayoffDiagram({
  state,
}: {
  state: WidgetRenderState;
}): ReactElement {
  const spec = state.spec as unknown as PayoffSpec;
  const legs = spec.legs ?? [];
  const mult = spec.contract_multiplier ?? 100;
  const spot = spec.spot ?? deriveSpotFromLegs(legs);

  const { min, max, steps } = useMemo(() => {
    if (spec.price_range) {
      return {
        min: spec.price_range.min,
        max: spec.price_range.max,
        steps: spec.price_range.steps ?? 100,
      };
    }
    // Default: ±30% around spot.
    return {
      min: spot * 0.7,
      max: spot * 1.3,
      steps: 100,
    };
  }, [spec.price_range, spot]);

  // Compute the payoff curve.
  const curve = useMemo(() => {
    if (legs.length === 0) return [];
    const pts: { price: number; pnl: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const price = min + ((max - min) * i) / steps;
      let pnl = 0;
      for (const leg of legs) {
        const intrinsic =
          leg.type === "call"
            ? Math.max(0, price - leg.strike)
            : Math.max(0, leg.strike - price);
        const sign = leg.action === "buy" ? 1 : -1;
        const premiumCost = leg.premium * sign;
        pnl += (intrinsic - premiumCost) * leg.qty * mult * sign;
        // Wait — premium accounting: when you BUY a leg you PAY the
        // premium (negative cash); intrinsic at expiry is positive
        // for the buyer. PnL = (intrinsic - premium) * qty * mult.
        // When you SELL, PnL = (premium - intrinsic) * qty * mult.
        // Rewriting cleanly:
      }
      // Recompute cleanly (the inline version above had double-sign).
      pnl = 0;
      for (const leg of legs) {
        const intrinsic =
          leg.type === "call"
            ? Math.max(0, price - leg.strike)
            : Math.max(0, leg.strike - price);
        const perContract =
          leg.action === "buy"
            ? intrinsic - leg.premium
            : leg.premium - intrinsic;
        pnl += perContract * leg.qty * mult;
      }
      pts.push({ price, pnl });
    }
    return pts;
  }, [legs, min, max, steps, mult]);

  if (legs.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        payoff_diagram: no legs declared in the spec
      </div>
    );
  }

  // Find max/min P&L for SVG scaling.
  const maxPnl = Math.max(...curve.map((p) => p.pnl), 0);
  const minPnl = Math.min(...curve.map((p) => p.pnl), 0);
  const rangePnl = Math.max(Math.abs(maxPnl), Math.abs(minPnl)) || 1;

  // SVG viewport. We render in a 100×100 normalized coordinate
  // system and let CSS scale — cleaner than computing px on the fly.
  const W = 600;
  const H = 240;
  const PADX = 40;
  const PADY = 20;
  const plotW = W - 2 * PADX;
  const plotH = H - 2 * PADY;

  const xScale = (price: number) =>
    PADX + ((price - min) / (max - min)) * plotW;
  const yScale = (pnl: number) =>
    PADY + plotH / 2 - (pnl / rangePnl) * (plotH / 2 - 4);

  // Build the path string for the payoff line.
  const pathD = curve
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"} ${xScale(p.price).toFixed(2)} ${yScale(p.pnl).toFixed(2)}`,
    )
    .join(" ");

  // Find break-even points (where pnl crosses zero) — useful
  // annotations for the trader.
  const breakEvens: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if ((a.pnl <= 0 && b.pnl >= 0) || (a.pnl >= 0 && b.pnl <= 0)) {
      const t = a.pnl / (a.pnl - b.pnl);
      const be = a.price + t * (b.price - a.price);
      breakEvens.push(be);
    }
  }

  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }}>
        {/* Background grid */}
        <line
          x1={PADX}
          y1={PADY + plotH / 2}
          x2={W - PADX}
          y2={PADY + plotH / 2}
          stroke="rgba(255,255,255,0.15)"
          strokeDasharray="2 2"
        />
        {/* Spot indicator */}
        <line
          x1={xScale(spot)}
          y1={PADY}
          x2={xScale(spot)}
          y2={H - PADY}
          stroke="rgba(96,165,250,0.4)"
          strokeDasharray="3 3"
        />
        <text
          x={xScale(spot) + 4}
          y={PADY + 12}
          fontSize="10"
          fill="rgba(96,165,250,0.9)"
          fontFamily="monospace"
        >
          spot {fmt(spot, "usd_precise")}
        </text>
        {/* Break-even markers */}
        {breakEvens.map((be, i) => (
          <g key={i}>
            <line
              x1={xScale(be)}
              y1={PADY + plotH / 2 - 4}
              x2={xScale(be)}
              y2={PADY + plotH / 2 + 4}
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1.5}
            />
            <text
              x={xScale(be)}
              y={PADY + plotH / 2 + 16}
              fontSize="9"
              fill="rgba(255,255,255,0.6)"
              fontFamily="monospace"
              textAnchor="middle"
            >
              {fmt(be, "usd_precise")}
            </text>
          </g>
        ))}
        {/* Strike lines per leg */}
        {legs.map((leg, i) => (
          <line
            key={i}
            x1={xScale(leg.strike)}
            y1={PADY}
            x2={xScale(leg.strike)}
            y2={H - PADY}
            stroke={leg.type === "call" ? "rgba(74,222,128,0.2)" : "rgba(248,113,113,0.2)"}
            strokeDasharray="1 3"
          />
        ))}
        {/* The payoff curve */}
        <path d={pathD} fill="none" stroke="#60a5fa" strokeWidth={2} />
        {/* X-axis labels (min, spot, max) */}
        <text
          x={PADX}
          y={H - 4}
          fontSize="10"
          fill="rgba(255,255,255,0.5)"
          fontFamily="monospace"
        >
          {fmt(min, "usd_precise")}
        </text>
        <text
          x={W - PADX}
          y={H - 4}
          fontSize="10"
          fill="rgba(255,255,255,0.5)"
          fontFamily="monospace"
          textAnchor="end"
        >
          {fmt(max, "usd_precise")}
        </text>
        {/* Y-axis labels (max P&L, 0, min P&L) */}
        <text
          x={PADX - 6}
          y={PADY + 4}
          fontSize="10"
          fill="rgba(255,255,255,0.5)"
          fontFamily="monospace"
          textAnchor="end"
        >
          +{fmt(rangePnl, "usd")}
        </text>
        <text
          x={PADX - 6}
          y={PADY + plotH / 2 + 4}
          fontSize="10"
          fill="rgba(255,255,255,0.5)"
          fontFamily="monospace"
          textAnchor="end"
        >
          0
        </text>
        <text
          x={PADX - 6}
          y={H - PADY}
          fontSize="10"
          fill="rgba(255,255,255,0.5)"
          fontFamily="monospace"
          textAnchor="end"
        >
          -{fmt(rangePnl, "usd")}
        </text>
      </svg>
      <div
        className="mono"
        style={{
          fontSize: 11,
          marginTop: 8,
          color: "var(--fg-dim)",
          lineHeight: 1.7,
        }}
      >
        <div>
          {legs.map((l, i) => (
            <span key={i}>
              {i > 0 ? " + " : ""}
              <span
                style={{
                  color: l.action === "buy" ? "var(--ok, #86efac)" : "var(--err, #fca5a5)",
                }}
              >
                {l.action === "buy" ? "long" : "short"}
              </span>{" "}
              {l.qty}x {l.type === "call" ? "C" : "P"} {fmt(l.strike, "usd_precise")} @{" "}
              {fmt(l.premium, "usd_precise")}
            </span>
          ))}
        </div>
        <div>
          max profit{" "}
          <strong style={{ color: maxPnl > 0 ? "var(--ok, #86efac)" : "var(--fg)" }}>
            {fmt(maxPnl, "usd_signed")}
          </strong>{" "}
          · max loss{" "}
          <strong style={{ color: minPnl < 0 ? "var(--err, #fca5a5)" : "var(--fg)" }}>
            {fmt(minPnl, "usd_signed")}
          </strong>
          {breakEvens.length > 0 && (
            <>
              {" "}
              · break-even{breakEvens.length > 1 ? "s" : ""}{" "}
              {breakEvens.map((be) => fmt(be, "usd_precise")).join(" · ")}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveSpotFromLegs(legs: Leg[]): number {
  if (legs.length === 0) return 100;
  const strikes = legs.map((l) => l.strike);
  return strikes.reduce((a, b) => a + b, 0) / strikes.length;
}
