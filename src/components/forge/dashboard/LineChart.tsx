// LineChart widget — TradingView Lightweight Charts wrapper.
//
// Spec shape:
//   {
//     "type": "line_chart",
//     "title": "SPY 90d",
//     "x_field": "date",         // ISO-8601 date or unix-seconds
//     "series": [
//       { "key": "close", "label": "Close", "color": "#4ade80" }
//     ]
//   }
//
// Data shape: an array of row objects (each row has the x_field
// and every series.key as a numeric value), OR `{ rows: [...] }`.
//
// Why Lightweight Charts vs Recharts / Chart.js / uPlot:
//   * Designed for financial charts (proper time-series x-axis,
//     crosshair, log scale, fit-content). Recharts is general-
//     purpose and stutters on >5k points.
//   * ~200KB gzipped (vs Plotly's ~3MB). Acceptable bundle cost
//     for the value.
//   * MIT licensed, maintained by TradingView. Stable API.

import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesPartialOptions,
  type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, type ReactElement } from "react";

import { pluck, type WidgetRenderState } from "./types";

interface SeriesSpec {
  key: string;
  label?: string;
  color?: string;
}

interface Row {
  [field: string]: unknown;
}

export default function LineChart({ state }: { state: WidgetRenderState }): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const seriesRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());

  const xField = (state.spec.x_field as string | undefined) ?? "date";
  const seriesSpecs = (state.spec.series as SeriesSpec[] | undefined) ?? [];

  // Extract rows in the same shape as DataTable accepts (array
  // OR {rows} OR {data}). Memoized so reference equality holds
  // when state.data doesn't change.
  const rows = useMemo<Row[]>(() => {
    if (!state.data) return [];
    if (Array.isArray(state.data)) return state.data as Row[];
    const obj = state.data as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows as Row[];
    if (Array.isArray(obj.data)) return obj.data as Row[];
    return [];
  }, [state.data]);

  // Create the chart on mount; destroy on unmount. Chart instance
  // is reused across data updates — only series data is replaced.
  //
  // `autoSize: true` (v5+) lets the chart track its container size
  // via the library's internal ResizeObserver. We previously
  // pulled clientWidth/clientHeight at mount time + ran our own
  // RO, but the initial pull lands BEFORE the parent layout
  // settles — clientHeight=0 means the chart is born invisible
  // and never recovers because our own RO doesn't fire until
  // something else explicitly resizes it. autoSize avoids that
  // race entirely.
  useEffect(() => {
    if (!container.current) return;
    const c = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "rgba(255,255,255,0.8)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.06)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.12)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.12)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
    });
    chart.current = c;

    return () => {
      c.remove();
      chart.current = null;
      seriesRefs.current.clear();
    };
  }, []);

  // Sync the series list with the current spec, then push the data.
  useEffect(() => {
    if (!chart.current) return;
    const c = chart.current;

    // Remove series whose keys are no longer in the spec.
    const wanted = new Set(seriesSpecs.map((s) => s.key));
    for (const [key, series] of seriesRefs.current) {
      if (!wanted.has(key)) {
        c.removeSeries(series);
        seriesRefs.current.delete(key);
      }
    }
    // Add missing series. v5 of lightweight-charts replaced the
    // per-type `addLineSeries` helper with a single generic
    // `addSeries(SeriesDefinition, options)` call — pass the
    // `LineSeries` definition import.
    for (const spec of seriesSpecs) {
      if (seriesRefs.current.has(spec.key)) continue;
      const opts: LineSeriesPartialOptions = {
        color: spec.color ?? "#60a5fa",
        lineWidth: 2,
        title: spec.label ?? spec.key,
        priceLineVisible: false,
        lastValueVisible: true,
      };
      const series = c.addSeries(LineSeries, opts);
      seriesRefs.current.set(spec.key, series);
    }

    // Push the data. Lightweight Charts wants {time, value} pairs
    // sorted by time ascending; we coerce both the x and y to the
    // right primitives and drop unparseable rows rather than
    // throwing — broker feeds are messy.
    for (const spec of seriesSpecs) {
      const series = seriesRefs.current.get(spec.key);
      if (!series) continue;
      const pts: { time: Time; value: number }[] = [];
      for (const row of rows) {
        const t = coerceTime(pluck(row, xField));
        if (t === null) continue;
        const v = pluck(row, spec.key);
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n)) continue;
        pts.push({ time: t, value: n });
      }
      pts.sort((a, b) => (a.time as number) - (b.time as number));
      series.setData(pts);
    }

    // Fit chart on first data load only — subsequent refreshes
    // shouldn't snap the user's pan/zoom away.
    if (rows.length > 0) {
      c.timeScale().fitContent();
    }
  }, [rows, seriesSpecs, xField]);

  if (seriesSpecs.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        line_chart: no series declared in the spec
      </div>
    );
  }

  // `position: absolute; inset: 0` on the chart-host div sidesteps
  // `height: 100%` percentage-resolution flakiness inside flex /
  // grid parents — the chart host always fills the relative
  // outer, which carries the minHeight floor.
  return (
    <div style={{ position: "relative", height: "100%", minHeight: 240 }}>
      <div ref={container} style={{ position: "absolute", inset: 0 }} />
      {state.status === "loading" && rows.length === 0 && (
        <div
          className="muted mono"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
          }}
        >
          loading…
        </div>
      )}
    </div>
  );
}

/** Coerce a date/timestamp value into Lightweight Charts' Time type.
 *  Accepts unix seconds, unix millis, ISO-8601 strings, YYYY-MM-DD.
 *  Returns null for anything unparseable. */
function coerceTime(v: unknown): Time | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    // > year-2200-in-millis? assume already millis; convert to sec.
    if (v > 1e12) return Math.floor(v / 1000) as Time;
    return Math.floor(v) as Time;
  }
  if (typeof v === "string") {
    // YYYY-MM-DD is a special-cased "BusinessDay" — pass as string,
    // lightweight-charts handles it.
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v as unknown as Time;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return Math.floor(d / 1000) as Time;
  }
  return null;
}
