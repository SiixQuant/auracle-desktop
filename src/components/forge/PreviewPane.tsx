// PreviewPane — right side of the agent layout.
//
// Two tabs:
//
//   Source — read-only syntax-highlighted view of the currently
//            active strategy. Always works, even with Houston offline.
//            Auto-refreshes when the agent edits the file (via the
//            refreshKey prop bumped from Forge.tsx).
//
//   Backtest — iframe to Houston's backtest UI for this strategy.
//              Requires Houston to be running at http://localhost:1969.
//              Empty state with a Run-Backtest CTA when no run yet.
//
// Mirrors CVForge's preview pane (which shows the rendered HTML
// dashboard as the agent builds it). For trading strategies, the
// equivalent "rendered output" is the backtest equity curve +
// metrics + trade list, served by Houston.

import { python } from "@codemirror/lang-python";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useState } from "react";

import { cmd, openInBrowser } from "@/lib/tauri";

interface PreviewPaneProps {
  /** Path of the strategy being previewed; null = empty state. */
  activePath: string | null;
  /** Bumped by the parent when the file content may have changed,
   *  e.g. after the agent applies an edit or the user saves. */
  refreshKey: number;
}

type Tab = "source" | "backtest";

export default function PreviewPane({ activePath, refreshKey }: PreviewPaneProps) {
  const [tab, setTab] = useState<Tab>("source");

  if (!activePath) {
    return (
      <div className="forge-panel">
        <div className="forge-panel-head">
          <span>Preview</span>
        </div>
        <div className="forge-empty" style={{ padding: 32, textAlign: "center" }}>
          <p style={{ margin: 0, color: "var(--fg-dim)", fontSize: 14 }}>
            Open a strategy or ask the agent to create one. The preview
            will render here as the file changes.
          </p>
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
            className={`forge-preview-tab ${tab === "source" ? "active" : ""}`}
            onClick={() => setTab("source")}
          >
            Source
          </button>
          <button
            type="button"
            className={`forge-preview-tab ${tab === "backtest" ? "active" : ""}`}
            onClick={() => setTab("backtest")}
          >
            Backtest
          </button>
        </div>
        <span className="forge-panel-sub" title={activePath}>
          {activePath}
        </span>
      </div>

      {tab === "source" && (
        <SourceView path={activePath} refreshKey={refreshKey} />
      )}
      {tab === "backtest" && <BacktestView path={activePath} />}
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
    cmd.forgeReadFile(path)
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
//
// Probes Houston's status to decide what to render:
//
//   * Houston offline       → "Start the Auracle stack" message
//   * Houston online        → "Run Backtest" CTA (opens Houston's
//                              new-backtest form pre-filled with
//                              this strategy)
//
// The earlier iteration tried to iframe Houston's per-strategy
// recent-run URL inline, but that route doesn't exist yet — Houston
// served its own 404 page inside the iframe, which my onError
// handler couldn't detect (a load is a load). Cleaner: a small
// probe via the connect-src-allowed REST origin, and we route to
// Houston for actual results until the planned
// /api/forge/strategies/{rel_path}/runs endpoint lands (then we
// render results inline). Spec lives in docs/HOUSTON-FORGE-API.md.

function BacktestView({ path }: { path: string }) {
  const [houstonStatus, setHoustonStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");

  // One small healthcheck probe per path change — much cheaper than
  // iframing a heavyweight page and the failure mode is unambiguous.
  // /healthz is a Houston route we know exists across all versions.
  useEffect(() => {
    let cancelled = false;
    setHoustonStatus("checking");
    const controller = new AbortController();
    fetch("http://localhost:1969/healthz", {
      signal: controller.signal,
      mode: "no-cors", // we just need to know it responded, not the body
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
