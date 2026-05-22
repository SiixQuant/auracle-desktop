// WidgetRenderer — dispatches a Dashboard widget spec to the right
// renderer component and owns the per-widget data lifecycle (fetch
// + refresh + error state).
//
// Phase 1 implements: kpi_grid, data_table, line_chart, notes_md.
// Phase 3 adds: option_chain_table, iv_surface_3d, payoff_diagram,
// bar_chart, candlestick_chart, scanner_table.
//
// Data fetching: each widget's data_source references an agent tool.
// The renderer invokes that tool through the existing forge_agent_run
// pathway... actually no, those tools live inside the agent loop.
// For dashboard data we need a separate path: a Tauri command
// `forge_invoke_tool` that takes (name, args) and returns the same
// result the agent would see. That command lands in Phase 2 (the
// broker bridge) — for now, widgets pull from inline data baked
// into the spec OR show a "data source not yet available" stub.

import { useEffect, useState, type ReactElement } from "react";

import { cmd, type DashboardWidget } from "@/lib/tauri";

import BarChart from "./BarChart";
import CandlestickChart from "./CandlestickChart";
import DataTable from "./DataTable";
import KpiGrid from "./KpiGrid";
import LineChart from "./LineChart";
import NotesMd from "./NotesMd";
import OptionChainTable from "./OptionChainTable";
import type { WidgetRenderState } from "./types";

interface WidgetRendererProps {
  widget: DashboardWidget;
  /** Forced refresh tick — the parent bumps this when the user
   *  hits "Refresh all" on the dashboard. */
  refreshNonce?: number;
  refreshIntervalSeconds: number;
}

export default function WidgetRenderer({
  widget,
  refreshNonce = 0,
  refreshIntervalSeconds,
}: WidgetRendererProps): ReactElement {
  const [state, setState] = useState<WidgetRenderState>({
    spec: widget,
    data: extractInlineData(widget),
    error: null,
    status: extractInlineData(widget) !== null ? "ready" : "loading",
    updated_at: extractInlineData(widget) !== null ? Date.now() : null,
  });

  // Mirror the latest spec into state so re-renders see prop changes
  // (the agent might have edited the widget config; we want the new
  // columns / fields to take effect immediately).
  useEffect(() => {
    setState((s) => ({ ...s, spec: widget }));
  }, [widget]);

  // Live data fetch + refresh loop.
  useEffect(() => {
    const inline = extractInlineData(widget);
    if (inline !== null) {
      // Inline data: no fetching needed.
      setState((s) => ({
        ...s,
        data: inline,
        status: "ready",
        updated_at: Date.now(),
      }));
      return;
    }
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const fetchOnce = async () => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        status: s.data ? "stale" : "loading",
      }));
      try {
        const result = await cmd.forgeInvokeTool(
          widget.data_source.tool,
          widget.data_source.args,
        );
        if (cancelled) return;
        if (!result.ok) {
          setState((s) => ({
            ...s,
            status: "error",
            error: typeof result.result === "string" ? result.result : "tool error",
          }));
          return;
        }
        setState((s) => ({
          ...s,
          data: parseToolResult(result.result),
          status: "ready",
          error: null,
          updated_at: Date.now(),
        }));
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          status: "error",
          error: String(err),
        }));
      }
    };

    fetchOnce();
    const ms = Math.max(5, refreshIntervalSeconds) * 1000;
    interval = setInterval(() => {
      // Visibility-aware: skip the tick if the window is hidden.
      // Saves bandwidth + IBKR rate limits when the user has the
      // app in a background space. We DON'T cancel the interval —
      // it'll resume cleanly when they switch back.
      if (typeof document !== "undefined" && document.hidden) return;
      fetchOnce();
    }, ms);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
    // We deliberately include refreshNonce so the parent's
    // "refresh all" button forces a re-mount of the fetch cycle.
  }, [widget, refreshIntervalSeconds, refreshNonce]);

  return (
    <section
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
        minHeight: 120,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 11,
          color: "var(--fg-dim)",
        }}
      >
        <span
          style={{
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontWeight: 500,
          }}
        >
          {widget.title || widget.type.replace(/_/g, " ")}
        </span>
        <RefreshIndicator state={state} />
      </header>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <WidgetBody state={state} />
      </div>
    </section>
  );
}

function WidgetBody({ state }: { state: WidgetRenderState }): ReactElement {
  switch (state.spec.type) {
    case "kpi_grid":
      return <KpiGrid state={state} />;
    case "data_table":
      return <DataTable state={state} />;
    case "line_chart":
      return <LineChart state={state} />;
    case "candlestick_chart":
      return <CandlestickChart state={state} />;
    case "bar_chart":
      return <BarChart state={state} />;
    case "option_chain_table":
      return <OptionChainTable state={state} />;
    case "notes_md":
      return <NotesMd state={state} />;
    default:
      return (
        <div
          className="muted mono"
          style={{ padding: 12, fontSize: 12 }}
        >
          widget type {JSON.stringify(state.spec.type)} not implemented
          yet — coming in a later phase. Spec preserved verbatim on disk.
        </div>
      );
  }
}

function RefreshIndicator({ state }: { state: WidgetRenderState }): ReactElement {
  if (state.status === "loading") {
    return <span className="mono">loading…</span>;
  }
  if (state.status === "error") {
    return (
      <span
        className="mono"
        style={{ color: "var(--err)" }}
        title={state.error ?? "error"}
      >
        error
      </span>
    );
  }
  if (state.status === "stale") {
    return <span className="mono">refreshing…</span>;
  }
  if (state.updated_at) {
    const ago = Math.floor((Date.now() - state.updated_at) / 1000);
    return (
      <span
        className="mono"
        style={{ fontSize: 10 }}
        title={new Date(state.updated_at).toLocaleString()}
      >
        ● {ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`}
      </span>
    );
  }
  return <span />;
}

/** Pull literal/inline data out of a widget spec when its
 *  data_source is `{ tool: "inline", args: { data: <payload> } }`.
 *  Used for static widgets (notes, demo dashboards) and as the
 *  initial-data path before the broker bridge ships. */
function extractInlineData(widget: DashboardWidget): unknown {
  if (widget.data_source?.tool !== "inline") return null;
  const args = widget.data_source.args as { data?: unknown } | undefined;
  return args?.data ?? null;
}

/** Tool results come back as a string from the agent surface (because
 *  the agent loop serializes everything for tool_result content). Try
 *  to JSON.parse; fall back to the raw string. */
function parseToolResult(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
