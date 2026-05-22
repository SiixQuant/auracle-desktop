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
// Two states:
//
//   1. "Run a backtest" CTA — until the user clicks Run, we don't
//      know which run_id to render. Forge's deep-link opens Houston
//      in a new window/browser tab; the customer flips back to
//      Forge afterward and the iframe path renders.
//
//   2. Iframe to http://localhost:1969/ui/backtests/recent — once
//      Houston knows a recent run exists for this strategy, we
//      embed the results inline. The "recent" route is a stable
//      Houston URL that always picks the most recent run for a
//      given strategy (per the planned Houston endpoints in
//      docs/HOUSTON-FORGE-API.md).

function BacktestView({ path }: { path: string }) {
  const [showIframe, setShowIframe] = useState(false);
  const [iframeError, setIframeError] = useState(false);

  // Auto-attempt iframe load on tab open. If Houston isn't running,
  // we'll catch the error event and fall back to the CTA.
  useEffect(() => {
    setIframeError(false);
    setShowIframe(true);
  }, [path]);

  const params = new URLSearchParams({ strategy: path });
  const iframeUrl = `http://localhost:1969/ui/backtests/recent?${params}`;
  const newRunUrl = `http://localhost:1969/ui/backtests/new?${params}`;

  if (!showIframe || iframeError) {
    return (
      <div
        className="forge-empty"
        style={{ padding: 32, textAlign: "center" }}
      >
        <p style={{ margin: 0, color: "var(--fg-dim)", fontSize: 14 }}>
          {iframeError
            ? "Houston is offline — start the Auracle stack to see backtest results here."
            : "No backtest run yet for this strategy."}
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
          style={{ fontSize: 12, marginTop: 12 }}
        >
          After a run completes, switch tabs to come back — the
          embed will pick up the most recent run automatically.
        </p>
      </div>
    );
  }

  return (
    <iframe
      title={`Backtest results for ${path}`}
      src={iframeUrl}
      className="forge-preview-iframe"
      // CSP in tauri.conf.json permits http://localhost:1969 in
      // connect-src; for iframe embeds frame-src would need to be
      // widened too. We deliberately leave frame-src 'none' as the
      // default for security; the load handler below detects the
      // CSP block and falls back to the CTA.
      onError={() => setIframeError(true)}
      onLoad={(e) => {
        // Sniff the loaded URL — when CSP blocks the embed, the
        // iframe gets stuck on about:blank and contentWindow access
        // throws. We use the error path in that case.
        try {
          const win = (e.target as HTMLIFrameElement).contentWindow;
          if (!win || !win.location) setIframeError(true);
        } catch {
          // Cross-origin access errors are EXPECTED for a working
          // iframe; that's actually a sign of success. Ignore.
        }
      }}
    />
  );
}
