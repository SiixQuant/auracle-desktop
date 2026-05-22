// BarChart widget — vertical bars rendered as inline SVG.
//
// We use SVG (not Lightweight Charts, not Recharts) because:
//   * Lightweight Charts' histogram series is time-series-locked
//     (x-axis is always time); we want categorical x too.
//   * Recharts pulls in ~150KB of React deps. For a simple bar
//     chart, hand-rolled SVG is ~40 lines and looks the same.
//
// Spec shape:
//   {
//     "type": "bar_chart",
//     "title": "P&L by Symbol",
//     "x_field": "symbol",
//     "y_field": "unrealized_pnl",
//     "color": "#60a5fa",        // optional
//     "signed_color": true,      // optional: red/green based on y sign
//     "max_bars": 25             // optional cap
//   }
//
// Data shape: array of rows OR {rows: [...]}.

import { useMemo, type ReactElement } from "react";

import { fmt, pluck, type WidgetRenderState } from "./types";

interface Row {
  [field: string]: unknown;
}

export default function BarChart({ state }: { state: WidgetRenderState }): ReactElement {
  const xField = (state.spec.x_field as string | undefined) ?? "label";
  const yField = (state.spec.y_field as string | undefined) ?? "value";
  const baseColor = (state.spec.color as string | undefined) ?? "#60a5fa";
  const signedColorMode = state.spec.signed_color === true;
  const maxBars = (state.spec.max_bars as number | undefined) ?? 30;
  const yFormat = state.spec.y_format as string | undefined;

  const bars = useMemo(() => {
    if (!state.data) return [];
    const arr = Array.isArray(state.data)
      ? (state.data as Row[])
      : Array.isArray((state.data as Record<string, unknown>).rows)
        ? ((state.data as Record<string, unknown>).rows as Row[])
        : [];
    return arr
      .map((r) => {
        const x = String(pluck(r, xField) ?? "");
        const yRaw = pluck(r, yField);
        const y = typeof yRaw === "number" ? yRaw : Number(yRaw);
        return { x, y: Number.isFinite(y) ? y : 0 };
      })
      .filter((b) => b.x !== "")
      .slice(0, maxBars);
  }, [state.data, xField, yField, maxBars]);

  if (state.status === "loading" && bars.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        loading…
      </div>
    );
  }

  if (bars.length === 0) {
    return (
      <div className="muted" style={{ padding: 12, fontSize: 13 }}>
        No data.
      </div>
    );
  }

  const max = Math.max(...bars.map((b) => Math.abs(b.y)), 1);
  const positiveColor = "#4ade80";
  const negativeColor = "#f87171";

  return (
    <div style={{ padding: 12, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {bars.map((b) => {
          const widthPct = (Math.abs(b.y) / max) * 100;
          const color = signedColorMode
            ? b.y >= 0
              ? positiveColor
              : negativeColor
            : baseColor;
          return (
            <div
              key={b.x}
              style={{
                display: "grid",
                gridTemplateColumns: "100px 1fr 80px",
                alignItems: "center",
                fontSize: 12,
                gap: 8,
              }}
            >
              <div
                className="mono"
                style={{
                  textAlign: "right",
                  color: "var(--fg-dim)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={b.x}
              >
                {b.x}
              </div>
              <div
                style={{
                  height: 18,
                  background: "var(--bg-alt)",
                  borderRadius: 2,
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    width: `${widthPct}%`,
                    height: "100%",
                    background: color,
                    opacity: 0.7,
                    transition: "width 200ms",
                  }}
                />
              </div>
              <div
                className="mono"
                style={{
                  textAlign: "right",
                  color: signedColorMode
                    ? b.y >= 0
                      ? positiveColor
                      : negativeColor
                    : "var(--fg)",
                  fontSize: 11,
                }}
              >
                {fmt(b.y, yFormat)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
