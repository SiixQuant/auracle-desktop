// CandlestickChart widget — OHLC candles via Lightweight Charts.
//
// Spec shape:
//   {
//     "type": "candlestick_chart",
//     "title": "SPY 90d",
//     "x_field": "date",
//     "ohlc_field_names": {
//       "open": "open", "high": "high", "low": "low", "close": "close"
//     },
//     "volume_field": "volume"   // optional histogram below
//   }
//
// Data shape: array of OHLC rows (the broker bridge's
// get_historical_bars already returns exactly this).

import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, type ReactElement } from "react";

import { pluck, type WidgetRenderState } from "./types";

interface OhlcFieldNames {
  open: string;
  high: string;
  low: string;
  close: string;
}

interface Row {
  [field: string]: unknown;
}

export default function CandlestickChart({
  state,
}: {
  state: WidgetRenderState;
}): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);

  const xField = (state.spec.x_field as string | undefined) ?? "date";
  const ohlc =
    (state.spec.ohlc_field_names as OhlcFieldNames | undefined) ?? {
      open: "open",
      high: "high",
      low: "low",
      close: "close",
    };
  const volumeField = state.spec.volume_field as string | undefined;

  const rows = useMemo<Row[]>(() => {
    if (!state.data) return [];
    if (Array.isArray(state.data)) return state.data as Row[];
    const obj = state.data as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows as Row[];
    if (Array.isArray(obj.data)) return obj.data as Row[];
    return [];
  }, [state.data]);

  useEffect(() => {
    if (!container.current) return;
    const c = createChart(container.current, {
      width: container.current.clientWidth,
      height: container.current.clientHeight,
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

    // Cast to avoid type-import flake on addCandlestickSeries / addHistogramSeries.
    const cAny = c as unknown as {
      addCandlestickSeries: (opts: Record<string, unknown>) => ISeriesApi<"Candlestick">;
      addHistogramSeries: (opts: Record<string, unknown>) => ISeriesApi<"Histogram">;
    };
    candleSeries.current = cAny.addCandlestickSeries({
      upColor: "#4ade80",
      downColor: "#f87171",
      borderUpColor: "#4ade80",
      borderDownColor: "#f87171",
      wickUpColor: "#4ade80",
      wickDownColor: "#f87171",
    });
    if (volumeField) {
      volumeSeries.current = cAny.addHistogramSeries({
        color: "rgba(96,165,250,0.4)",
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volumeSeries.current.priceScale().applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
    }

    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      c.applyOptions({
        width: e.contentRect.width,
        height: e.contentRect.height,
      });
    });
    ro.observe(container.current);

    return () => {
      ro.disconnect();
      c.remove();
      chart.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
    };
    // Only volumeField presence affects which series we create.
  }, [volumeField]);

  useEffect(() => {
    if (!candleSeries.current) return;
    const candles: { time: Time; open: number; high: number; low: number; close: number }[] = [];
    const volumes: { time: Time; value: number; color?: string }[] = [];
    for (const row of rows) {
      const t = coerceTime(pluck(row, xField));
      if (t === null) continue;
      const o = numeric(pluck(row, ohlc.open));
      const h = numeric(pluck(row, ohlc.high));
      const l = numeric(pluck(row, ohlc.low));
      const cl = numeric(pluck(row, ohlc.close));
      if (
        o === null ||
        h === null ||
        l === null ||
        cl === null
      )
        continue;
      candles.push({ time: t, open: o, high: h, low: l, close: cl });
      if (volumeField) {
        const v = numeric(pluck(row, volumeField));
        if (v !== null) {
          volumes.push({
            time: t,
            value: v,
            color: cl >= o ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)",
          });
        }
      }
    }
    candles.sort((a, b) => (a.time as number) - (b.time as number));
    candleSeries.current.setData(candles);
    if (volumeSeries.current) {
      volumes.sort((a, b) => (a.time as number) - (b.time as number));
      volumeSeries.current.setData(volumes);
    }
    if (candles.length > 0) {
      chart.current?.timeScale().fitContent();
    }
  }, [rows, xField, ohlc.open, ohlc.high, ohlc.low, ohlc.close, volumeField]);

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 240 }}>
      <div ref={container} style={{ width: "100%", height: "100%" }} />
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

function numeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerceTime(v: unknown): Time | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (v > 1e12) return Math.floor(v / 1000) as Time;
    return Math.floor(v) as Time;
  }
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v as unknown as Time;
    const d = Date.parse(v);
    if (Number.isFinite(d)) return Math.floor(d / 1000) as Time;
  }
  return null;
}
