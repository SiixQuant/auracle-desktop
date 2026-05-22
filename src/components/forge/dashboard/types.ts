// Widget renderer types — keep the *runtime* contract out of the
// tauri.ts module so the renderer evolution doesn't bleed into the
// IPC layer.
//
// Each widget's `data` (the result of invoking its data_source) is
// passed in as `unknown` because data sources are typed only by the
// tool that produced them — a kpi_grid pulls account-summary JSON,
// a line_chart pulls {dates, closes}, etc. Each renderer narrows
// what it expects and surfaces a clear error if the data doesn't
// match. This keeps the renderer additive: new widget types can be
// added without changing the dispatcher.

import type { DashboardWidget } from "@/lib/tauri";

/** State a widget passes to its renderer. */
export interface WidgetRenderState {
  spec: DashboardWidget;
  /** Last data payload returned by the widget's data source.
   *  null = no data yet (renderer should show its loading state). */
  data: unknown | null;
  /** Set when the last data fetch failed. */
  error: string | null;
  /** "loading" before the first fetch; "ready" after a success;
   *  "stale" while a refresh is in flight with prior data still shown. */
  status: "loading" | "ready" | "stale" | "error";
  /** Unix ms of the last successful data update. */
  updated_at: number | null;
}

/** Helper: format a number for display. */
export function fmt(
  value: unknown,
  format: string | undefined,
): string {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  switch (format) {
    case "usd":
      return num.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });
    case "usd_signed":
      return (
        (num >= 0 ? "+" : "") +
        num.toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        })
      );
    case "usd_precise":
      return num.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    case "percent":
      return `${(num * 100).toFixed(2)}%`;
    case "percent_signed":
      return `${num >= 0 ? "+" : ""}${(num * 100).toFixed(2)}%`;
    case "number":
      return num.toLocaleString("en-US");
    case "compact":
      return num.toLocaleString("en-US", { notation: "compact" });
    default:
      return String(value);
  }
}

/** Helper: pull a dotted-path value out of an object.
 *  E.g. `pluck(row, "greeks.delta")` returns `row.greeks.delta`. */
export function pluck(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Helper: color a signed number red/green. Returns a CSS color
 *  string suitable for `style={{ color }}`. */
export function signedColor(value: unknown): string {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num === 0) return "var(--fg)";
  return num > 0 ? "var(--ok, #4ade80)" : "var(--err, #f87171)";
}
