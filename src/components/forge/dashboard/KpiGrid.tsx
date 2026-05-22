// KpiGrid widget — N labeled big-number cards.
//
// Spec shape:
//   {
//     "type": "kpi_grid",
//     "title": "Account",
//     "fields": [
//       { "key": "net_liquidation", "label": "Net Liq", "format": "usd" },
//       { "key": "buying_power",    "label": "Buying",  "format": "usd" }
//     ]
//   }
//
// Data shape (whatever data_source returns): a flat object whose
// keys match each field's `key` (dotted-path allowed).

import type { ReactElement } from "react";

import { fmt, pluck, signedColor, type WidgetRenderState } from "./types";

interface KpiField {
  key: string;
  label: string;
  format?: string;
  /** When true, color the value red/green based on sign. */
  signed?: boolean;
}

export default function KpiGrid({ state }: { state: WidgetRenderState }): ReactElement {
  const fields = (state.spec.fields as KpiField[] | undefined) ?? [];

  if (fields.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        kpi_grid: no fields declared in the spec
      </div>
    );
  }

  const data = state.data as Record<string, unknown> | null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(fields.length, 4)}, 1fr)`,
        gap: 12,
        padding: 12,
      }}
    >
      {fields.map((f) => {
        const raw = data ? pluck(data, f.key) : undefined;
        const isMissing = raw === undefined;
        return (
          <div
            key={f.key}
            style={{
              padding: "12px 14px",
              background: "var(--bg-alt)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          >
            <div
              className="muted"
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 4,
              }}
            >
              {f.label}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 22,
                fontWeight: 500,
                color: f.signed && !isMissing ? signedColor(raw) : "var(--fg)",
              }}
            >
              {state.status === "loading" && !data ? (
                <span className="muted mono" style={{ fontSize: 14 }}>
                  …
                </span>
              ) : isMissing ? (
                "—"
              ) : (
                fmt(raw, f.format)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
