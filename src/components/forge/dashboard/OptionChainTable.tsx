// OptionChainTable widget — calls-and-puts grid arranged around the
// strike column. Standard market-maker layout: calls on the left,
// strikes in the middle (highlighted to show ATM), puts on the right.
//
// Spec shape:
//   {
//     "type": "option_chain_table",
//     "title": "SPY Jun 2026",
//     "fields": ["bid", "ask", "iv", "delta", "volume"],  // optional, default shown
//   }
//
// Data shape (what get_options_chain returns):
//   {
//     symbol: "SPY",
//     month: "202606",
//     spot: 503.21,
//     rows: [
//       { strike: 500, call_bid: 5.2, call_ask: 5.3, ..., put_bid: 1.1, ... },
//       ...
//     ]
//   }

import { useMemo, type ReactElement } from "react";

import { fmt, type WidgetRenderState } from "./types";

const DEFAULT_FIELDS = ["bid", "ask", "iv", "delta", "volume"] as const;

const FIELD_LABELS: Record<string, string> = {
  bid: "Bid",
  ask: "Ask",
  last: "Last",
  iv: "IV",
  delta: "Δ",
  gamma: "Γ",
  theta: "Θ",
  vega: "ν",
  volume: "Vol",
};

const FIELD_FORMATS: Record<string, string> = {
  bid: "usd_precise",
  ask: "usd_precise",
  last: "usd_precise",
  iv: "percent",
  delta: "number",
  gamma: "number",
  theta: "number",
  vega: "number",
  volume: "compact",
};

interface ChainRow {
  strike: number;
  [k: string]: number | null | undefined;
}

interface ChainData {
  symbol: string;
  month: string;
  spot: number;
  rows: ChainRow[];
}

export default function OptionChainTable({
  state,
}: {
  state: WidgetRenderState;
}): ReactElement {
  const fields = (state.spec.fields as string[] | undefined) ?? DEFAULT_FIELDS;
  const data = state.data as ChainData | null;

  // Closest strike to spot — highlighted as ATM.
  const atmStrike = useMemo(() => {
    if (!data?.rows?.length) return null;
    const spot = data.spot ?? 0;
    let best = data.rows[0]!.strike;
    let bestDist = Math.abs(best - spot);
    for (const r of data.rows) {
      const d = Math.abs(r.strike - spot);
      if (d < bestDist) {
        best = r.strike;
        bestDist = d;
      }
    }
    return best;
  }, [data]);

  if (state.status === "loading" && !data) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        loading chain (may take 5–10s on first load)…
      </div>
    );
  }

  if (!data || !data.rows?.length) {
    return (
      <div className="muted" style={{ padding: 12, fontSize: 13 }}>
        No chain data. {state.error ?? null}
      </div>
    );
  }

  return (
    <div style={{ padding: 0, overflow: "auto", height: "100%" }}>
      <div
        className="muted mono"
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          fontSize: 11,
        }}
      >
        {data.symbol} · {formatExpiry(data.month)} · spot {fmt(data.spot, "usd_precise")}
      </div>
      <table
        className="mono"
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 11,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            <th
              colSpan={fields.length}
              style={{
                padding: "6px 8px",
                color: "var(--ok, #86efac)",
                textAlign: "center",
                fontWeight: 500,
                borderRight: "2px solid var(--border)",
              }}
            >
              Calls
            </th>
            <th
              style={{
                padding: "6px 8px",
                color: "var(--fg-dim)",
                textAlign: "center",
                fontWeight: 500,
              }}
            >
              Strike
            </th>
            <th
              colSpan={fields.length}
              style={{
                padding: "6px 8px",
                color: "var(--err, #fca5a5)",
                textAlign: "center",
                fontWeight: 500,
                borderLeft: "2px solid var(--border)",
              }}
            >
              Puts
            </th>
          </tr>
          <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--fg-dim)" }}>
            {fields.map((f) => (
              <th
                key={`c-${f}`}
                style={{ padding: "4px 8px", textAlign: "right", fontWeight: 400 }}
              >
                {FIELD_LABELS[f] ?? f}
              </th>
            ))}
            <th style={{ padding: "4px 8px", textAlign: "center", fontWeight: 500 }}>
              ·
            </th>
            {fields.map((f) => (
              <th
                key={`p-${f}`}
                style={{ padding: "4px 8px", textAlign: "right", fontWeight: 400 }}
              >
                {FIELD_LABELS[f] ?? f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const isAtm = atmStrike !== null && row.strike === atmStrike;
            return (
              <tr
                key={row.strike}
                style={{
                  borderBottom: "1px solid var(--border)",
                  background: isAtm ? "rgba(96,165,250,0.08)" : undefined,
                }}
              >
                {fields.map((f) => {
                  const v = row[`call_${f}`];
                  return (
                    <td
                      key={`c-${f}`}
                      style={{ padding: "3px 8px", textAlign: "right" }}
                    >
                      {v === null || v === undefined
                        ? "—"
                        : fmt(v, FIELD_FORMATS[f])}
                    </td>
                  );
                })}
                <td
                  style={{
                    padding: "3px 8px",
                    textAlign: "center",
                    fontWeight: isAtm ? 600 : 500,
                    background: isAtm ? "rgba(96,165,250,0.15)" : "var(--bg-alt)",
                    borderLeft: "2px solid var(--border)",
                    borderRight: "2px solid var(--border)",
                  }}
                >
                  {fmt(row.strike, "usd_precise")}
                </td>
                {fields.map((f) => {
                  const v = row[`put_${f}`];
                  return (
                    <td
                      key={`p-${f}`}
                      style={{ padding: "3px 8px", textAlign: "right" }}
                    >
                      {v === null || v === undefined
                        ? "—"
                        : fmt(v, FIELD_FORMATS[f])}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "202606" → "Jun 2026" — purely cosmetic for the header. */
function formatExpiry(month: string): string {
  if (!/^\d{6}$/.test(month)) return month;
  const year = month.slice(0, 4);
  const m = parseInt(month.slice(4, 6), 10) - 1;
  const names = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${names[m] ?? "?"} ${year}`;
}
