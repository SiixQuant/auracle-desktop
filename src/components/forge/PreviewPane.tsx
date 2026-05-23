// PreviewPane — the right column of the agent layout.
//
// Three tabs:
//
//   Dashboard — agent-authored persistent visual analytics. The
//               default tab once the user has any dashboard saved.
//               Switches automatically when the agent calls
//               open_dashboard. Phase 0 shows the JSON spec; Phase 1
//               swaps in the WidgetRenderer for real visualizations.
//
//   Source    — read-only syntax-highlighted view of the currently
//               active strategy file. Always works, even with the
//               Auracle stack offline. Auto-refreshes via refreshKey.
//
//   Backtest  — iframe to Houston's backtest UI for this strategy.
//               Probes Houston's health; renders an offline message
//               or a Run-Backtest CTA depending on state.
//
// Tab selection precedence: explicit user click > agent's open_dashboard
// event > defaultTab heuristic (Dashboard if any exist, else Source).

import { python } from "@codemirror/lang-python";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useState } from "react";

import WidgetRenderer from "@/components/forge/dashboard/WidgetRenderer";
import {
  cmd,
  onEvent,
  openInBrowser,
  type Dashboard,
  type DashboardSummary,
  type ForgeDashboardOpenEvent,
} from "@/lib/tauri";

interface PreviewPaneProps {
  /** Path of the strategy being previewed; null = empty Source state. */
  activePath: string | null;
  /** Bumped by the parent when the file content may have changed. */
  refreshKey: number;
}

type Tab = "dashboard" | "source" | "backtest";

export default function PreviewPane({ activePath, refreshKey }: PreviewPaneProps) {
  const [tab, setTab] = useState<Tab>("source");
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null);
  const [activeDashboard, setActiveDashboard] = useState<string | null>(null);

  // Initial dashboard list fetch. Done once per mount; refreshed
  // implicitly when the agent saves/deletes via the open-event hook.
  useEffect(() => {
    let cancelled = false;
    cmd
      .forgeListDashboards()
      .then((list) => {
        if (cancelled) return;
        setDashboards(list);
        // If the user landed here with no active source file BUT has
        // dashboards saved, default the tab to Dashboard so it's the
        // first thing they see — mirrors CVForge's "your saved work
        // is waiting" philosophy.
        if (!activePath && list.length > 0) {
          setTab("dashboard");
          setActiveDashboard(list[0]!.slug);
        }
      })
      .catch(() => setDashboards([]));
    return () => {
      cancelled = true;
    };
    // intentionally only on mount; tab logic shouldn't fight the user
    // every time activePath flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to the agent's "open this dashboard" event. When the
  // agent calls open_dashboard via the tool surface, the backend
  // emits "forge-dashboard-open" with the slug; we auto-switch tabs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onEvent<ForgeDashboardOpenEvent>("forge-dashboard-open", (slug) => {
      setTab("dashboard");
      setActiveDashboard(slug);
      // Refresh the list too — the slug may be new.
      cmd.forgeListDashboards().then(setDashboards).catch(() => {});
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // If the user opens a strategy file, nudge toward Source — but
  // don't fight them: only auto-switch if we were on the Dashboard
  // empty state, not if they explicitly picked Backtest or Dashboard.
  useEffect(() => {
    if (activePath && tab === "dashboard" && !activeDashboard) {
      setTab("source");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Empty state: no source file AND no dashboards yet. The CTA points
  // the user at the chat — typing a prompt is the only way forward.
  if (!activePath && (!dashboards || dashboards.length === 0)) {
    return (
      <div className="forge-panel">
        <div className="forge-panel-head">
          <span>Preview</span>
        </div>
        <div className="forge-empty" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ margin: 0, color: "var(--fg-dim)", fontSize: 14 }}>
            Ask the agent to build a dashboard or a strategy. Examples:
          </p>
          <ul
            className="muted"
            style={{
              textAlign: "left",
              maxWidth: 380,
              margin: "16px auto 0",
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            <li>“Build me a dashboard with my IBKR positions and account summary”</li>
            <li>“Show me a line chart of SPY closes for the last 90 days”</li>
            <li>“Write an RSI mean-reversion strategy on liquid US ETFs”</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="forge-panel">
      <div className="forge-panel-head forge-preview-head">
        <div className="forge-preview-tabs">
          <button
            type="button"
            className={`forge-preview-tab ${tab === "dashboard" ? "active" : ""}`}
            onClick={() => setTab("dashboard")}
          >
            Dashboard
            {dashboards && dashboards.length > 0 && (
              <span
                className="muted mono"
                style={{ marginLeft: 6, fontSize: 11 }}
              >
                {dashboards.length}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`forge-preview-tab ${tab === "source" ? "active" : ""}`}
            onClick={() => setTab("source")}
            disabled={!activePath}
            style={!activePath ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            Source
          </button>
          <button
            type="button"
            className={`forge-preview-tab ${tab === "backtest" ? "active" : ""}`}
            onClick={() => setTab("backtest")}
            disabled={!activePath}
            style={!activePath ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            Backtest
          </button>
        </div>
        <span className="forge-panel-sub" title={activePath ?? ""}>
          {tab === "dashboard"
            ? activeDashboard
              ? `dashboard · ${activeDashboard}`
              : "dashboards"
            : activePath ?? ""}
        </span>
      </div>

      {tab === "dashboard" && (
        <DashboardTab
          dashboards={dashboards ?? []}
          activeSlug={activeDashboard}
          onSelect={(slug) => setActiveDashboard(slug)}
          onRefresh={() => {
            cmd.forgeListDashboards().then(setDashboards).catch(() => {});
          }}
        />
      )}
      {tab === "source" && activePath && (
        <SourceView path={activePath} refreshKey={refreshKey} />
      )}
      {tab === "backtest" && activePath && <BacktestView path={activePath} />}
    </div>
  );
}

// ── Dashboard tab ────────────────────────────────────────────────
//
// Phase 0: shows a sidebar list + a JSON pretty-print of the active
// dashboard's spec. Phase 1 swaps the JSON view for the
// WidgetRenderer (KPI cards, tables, charts).

function DashboardTab({
  dashboards,
  activeSlug,
  onSelect,
  onRefresh,
}: {
  dashboards: DashboardSummary[];
  activeSlug: string | null;
  onSelect: (slug: string) => void;
  onRefresh: () => void;
}) {
  const [spec, setSpec] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeSlug) {
      setSpec(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    cmd
      .forgeReadDashboard(activeSlug)
      .then((d) => {
        if (!cancelled) {
          setSpec(d);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSlug]);

  if (dashboards.length === 0) {
    return (
      <div className="forge-empty" style={{ padding: 32, textAlign: "center" }}>
        <p style={{ margin: 0, color: "var(--fg-dim)", fontSize: 14 }}>
          No dashboards yet. Ask the agent to build one — e.g.
          <br />
          <em>“give me a dashboard with my open positions and SPY P&amp;L over 90 days”</em>
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <aside
        style={{
          width: 200,
          borderRight: "1px solid var(--border)",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "8px 12px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 11,
            textTransform: "uppercase",
            color: "var(--fg-dim)",
            letterSpacing: 0.5,
          }}
        >
          <span>Saved</span>
          <button
            type="button"
            className="ghost"
            onClick={onRefresh}
            style={{ padding: "2px 6px", fontSize: 11 }}
            title="Refresh list"
          >
            ↻
          </button>
        </div>
        {dashboards.map((d) => (
          <button
            key={d.slug}
            type="button"
            onClick={() => onSelect(d.slug)}
            className={activeSlug === d.slug ? "active" : ""}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              background:
                activeSlug === d.slug ? "var(--accent-bg)" : "transparent",
              border: "none",
              borderBottom: "1px solid var(--border)",
              color: "var(--fg)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            <div style={{ fontWeight: 500 }}>{d.title}</div>
            <div
              className="muted mono"
              style={{ fontSize: 10, marginTop: 2 }}
            >
              {d.widget_count}w · {d.refresh_interval_seconds}s
            </div>
          </button>
        ))}
      </aside>
      <main style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        {!activeSlug && (
          <div
            className="forge-empty muted mono"
            style={{ padding: 20 }}
          >
            Pick a dashboard from the list.
          </div>
        )}
        {activeSlug && loading && (
          <div className="forge-empty muted mono" style={{ padding: 20 }}>
            loading…
          </div>
        )}
        {activeSlug && error && (
          <div
            className="forge-empty muted mono"
            style={{ padding: 20, color: "var(--err)" }}
          >
            {error}
          </div>
        )}
        {activeSlug && spec && !loading && !error && (
          <DashboardView spec={spec} />
        )}
      </main>
    </div>
  );
}

// Renders a dashboard's widgets via WidgetRenderer. Layout modes:
//
//   "grid" — CSS Grid using each widget's spec.grid.{x,y,w,h}.
//            Auto-flow falls back if a widget omits its grid coords.
//   "rows" — Vertically stacked, each widget full-width.
//   "tabs" — One tab per widget (each widget is a separate page).
//
// "refresh nonce" wires a single "Refresh all" button into every
// child widget's effect deps so the user can force a fresh fetch
// without waiting for the next interval tick.
function DashboardView({ spec }: { spec: Dashboard }) {
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [activeTab, setActiveTab] = useState(0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>{spec.title}</h2>
          <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>
            {spec.widgets.length} widget{spec.widgets.length === 1 ? "" : "s"} ·
            refresh {spec.refresh_interval_seconds}s · layout {spec.layout}
          </div>
        </div>
        <button
          type="button"
          className="ghost"
          onClick={() => setRefreshNonce((n) => n + 1)}
          style={{ fontSize: 12 }}
        >
          Refresh all
        </button>
      </div>

      {spec.layout === "tabs" && spec.widgets.length > 0 ? (
        <>
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--border)",
              overflowX: "auto",
            }}
          >
            {spec.widgets.map((w, i) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setActiveTab(i)}
                style={{
                  padding: "8px 14px",
                  background:
                    activeTab === i ? "var(--bg-alt)" : "transparent",
                  border: "none",
                  borderBottom:
                    activeTab === i
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                  color: activeTab === i ? "var(--fg)" : "var(--fg-dim)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {w.title || w.type}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
            {spec.widgets[activeTab] && (
              <WidgetRenderer
                widget={spec.widgets[activeTab]!}
                refreshNonce={refreshNonce}
                refreshIntervalSeconds={spec.refresh_interval_seconds}
              />
            )}
          </div>
        </>
      ) : (
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: 12,
            display: spec.layout === "grid" ? "grid" : "flex",
            flexDirection: spec.layout === "rows" ? "column" : undefined,
            gap: 12,
            gridTemplateColumns:
              spec.layout === "grid" ? "repeat(12, 1fr)" : undefined,
            gridAutoRows: spec.layout === "grid" ? "minmax(80px, auto)" : undefined,
            alignContent: spec.layout === "grid" ? "start" : undefined,
          }}
        >
          {spec.widgets.map((w) => {
            const gridStyle =
              spec.layout === "grid" && w.grid
                ? {
                    gridColumn: `${w.grid.x + 1} / span ${w.grid.w}`,
                    gridRow: `${w.grid.y + 1} / span ${w.grid.h}`,
                  }
                : undefined;
            return (
              <div key={w.id} style={gridStyle}>
                <WidgetRenderer
                  widget={w}
                  refreshNonce={refreshNonce}
                  refreshIntervalSeconds={spec.refresh_interval_seconds}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Source tab ───────────────────────────────────────────────────

function SourceView({ path, refreshKey }: { path: string; refreshKey: number }) {
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    cmd
      .forgeReadFile(path)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, refreshKey]);

  if (loading) {
    return (
      <div className="forge-empty muted mono" style={{ padding: 20 }}>
        loading…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="forge-empty muted mono"
        style={{ padding: 20, color: "var(--err)" }}
      >
        {error}
      </div>
    );
  }
  return (
    <div className="forge-editor forge-preview-source">
      <CodeMirror
        value={content}
        theme={vscodeDark}
        extensions={[python()]}
        height="100%"
        editable={false}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: false,
          foldGutter: true,
          bracketMatching: true,
        }}
      />
    </div>
  );
}

// ── Backtest tab ─────────────────────────────────────────────────

function BacktestView({ path }: { path: string }) {
  const [houstonStatus, setHoustonStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");

  useEffect(() => {
    let cancelled = false;
    setHoustonStatus("checking");
    const controller = new AbortController();
    fetch("http://localhost:1969/healthz", {
      signal: controller.signal,
      mode: "no-cors",
    })
      .then(() => {
        if (!cancelled) setHoustonStatus("online");
      })
      .catch(() => {
        if (!cancelled) setHoustonStatus("offline");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [path]);

  const params = new URLSearchParams({ strategy: path });
  const newRunUrl = `http://localhost:1969/ui/backtests/new?${params}`;

  return (
    <div className="forge-empty" style={{ padding: 32, textAlign: "center" }}>
      {houstonStatus === "checking" && (
        <p className="muted mono" style={{ margin: 0, fontSize: 12 }}>
          probing houston…
        </p>
      )}

      {houstonStatus === "offline" && (
        <>
          <p style={{ margin: 0, color: "var(--fg-dim)", fontSize: 14 }}>
            Houston isn&apos;t running. Start the Auracle stack to
            run backtests + see results here.
          </p>
          <p
            className="muted mono"
            style={{ fontSize: 11, marginTop: 12 }}
          >
            cd ~/auracle && docker compose up -d
          </p>
        </>
      )}

      {houstonStatus === "online" && (
        <>
          <p style={{ margin: 0, color: "var(--fg-dim)", fontSize: 14 }}>
            Run a backtest in Houston to see results.
          </p>
          <button
            type="button"
            className="primary"
            style={{ marginTop: 16 }}
            onClick={() => openInBrowser(newRunUrl)}
          >
            Run Backtest in Houston
          </button>
          <p
            className="muted"
            style={{ fontSize: 11, marginTop: 16, lineHeight: 1.6 }}
          >
            Inline backtest results land here once Houston ships
            the <code>/api/forge/strategies/{"{rel_path}"}/runs</code> endpoint
            (see <code>docs/HOUSTON-FORGE-API.md</code>). Until
            then, results live in Houston&apos;s UI.
          </p>
        </>
      )}
    </div>
  );
}
