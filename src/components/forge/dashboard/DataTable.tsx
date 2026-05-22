// DataTable widget — sortable, dense table.
//
// Spec shape:
//   {
//     "type": "data_table",
//     "title": "Open Positions",
//     "columns": [
//       { "key": "symbol",         "label": "Symbol" },
//       { "key": "quantity",       "label": "Qty",    "format": "number", "align": "right" },
//       { "key": "unrealized_pnl", "label": "P&L",    "format": "usd_signed", "signed": true, "align": "right" }
//     ],
//     "sort": { "key": "unrealized_pnl", "dir": "desc" },
//     "max_rows": 50
//   }
//
// Data shape: an array of row objects, OR an object with a `rows`
// field. (Both because broker APIs vary on whether they wrap.)

import { useMemo, useState, type ReactElement } from "react";

import { fmt, pluck, signedColor, type WidgetRenderState } from "./types";

interface Column {
  key: string;
  label: string;
  format?: string;
  signed?: boolean;
  align?: "left" | "right" | "center";
  width?: number | string;
}

export default function DataTable({ state }: { state: WidgetRenderState }): ReactElement {
  const columns = (state.spec.columns as Column[] | undefined) ?? [];
  const initialSort = state.spec.sort as
    | { key: string; dir: "asc" | "desc" }
    | undefined;
  const maxRows = (state.spec.max_rows as number | undefined) ?? 100;

  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(
    initialSort?.dir ?? "desc",
  );

  const rows = useMemo<unknown[]>(() => {
    if (!state.data) return [];
    if (Array.isArray(state.data)) return state.data;
    const obj = state.data as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows;
    if (Array.isArray(obj.data)) return obj.data as unknown[];
    return [];
  }, [state.data]);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const factor = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = pluck(a, sortKey);
      const bv = pluck(b, sortKey);
      // numeric-first; fall back to lexical
      const an = typeof av === "number" ? av : Number(av);
      const bn = typeof bv === "number" ? bv : Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) {
        return (an - bn) * factor;
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * factor;
    });
  }, [rows, sortKey, sortDir]);

  const display = sorted.slice(0, maxRows);

  if (columns.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        data_table: no columns declared in the spec
      </div>
    );
  }

  if (state.status === "loading" && rows.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="muted" style={{ padding: 12, fontSize: 13 }}>
        No rows. {state.error ? `(${state.error})` : null}
      </div>
    );
  }

  const onHeaderClick = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <div style={{ padding: 0, overflow: "auto", height: "100%" }}>
      <table
        className="mono"
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border)" }}>
            {columns.map((c) => (
              <th
                key={c.key}
                onClick={() => onHeaderClick(c.key)}
                style={{
                  padding: "8px 10px",
                  textAlign: c.align ?? "left",
                  fontWeight: 500,
                  color: "var(--fg-dim)",
                  cursor: "pointer",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                  width: c.width,
                }}
              >
                {c.label}
                {sortKey === c.key && (
                  <span style={{ marginLeft: 4, opacity: 0.6 }}>
                    {sortDir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {display.map((row, i) => (
            <tr
              key={i}
              style={{
                borderBottom: "1px solid var(--border)",
              }}
            >
              {columns.map((c) => {
                const v = pluck(row, c.key);
                return (
                  <td
                    key={c.key}
                    style={{
                      padding: "6px 10px",
                      textAlign: c.align ?? "left",
                      color: c.signed ? signedColor(v) : "var(--fg)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmt(v, c.format)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows && (
        <div
          className="muted mono"
          style={{ padding: "6px 10px", fontSize: 11 }}
        >
          showing {maxRows} of {rows.length} rows
        </div>
      )}
    </div>
  );
}
