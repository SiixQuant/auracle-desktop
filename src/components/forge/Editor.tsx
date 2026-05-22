// Editor — center panel of the Forge view.
//
// CodeMirror 6 (via @uiw/react-codemirror) with Python syntax
// highlighting. We picked CodeMirror over Monaco for the MVP
// because it:
//
//   * Ships ~70 KB gzipped vs Monaco's ~500 KB.
//   * Works out of the box with Vite — no worker / web worker
//     plumbing, no CSP carve-outs for ?worker imports.
//   * Has a clean React wrapper that handles controlled-value
//     reconciliation, which is awkward in Monaco for our
//     "save on Cmd+S" + "AI inserts new content" flow.
//
// Monaco may come back later if we ever need its IntelliSense /
// language-server-protocol hooks — but Forge's actual use is
// editing short Python files with type hints, which CM6 covers
// perfectly.

import { python } from "@codemirror/lang-python";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useRef, useState } from "react";

import DiffModal from "@/components/forge/DiffModal";
import { cmd, openInBrowser } from "@/lib/tauri";

interface EditorProps {
  /** Path relative to the strategies dir; null when no file is open. */
  activePath: string | null;
  /** Set by the parent so the chat panel can inject AI-generated code. */
  externalContent: string | null;
  onSaved: () => void;
}

export default function Editor({
  activePath,
  externalContent,
  onSaved,
}: EditorProps) {
  const [content, setContent] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pending diff: when externalContent arrives + buffer is dirty,
  // we stash the proposed content here and render the DiffModal.
  // null means "no modal open." See the externalContent effect.
  const [pendingDiff, setPendingDiff] = useState<string | null>(null);
  // Track the path we last loaded so an in-flight read doesn't clobber
  // a newer open. Sequence-of-asyncs guard for the case where the user
  // clicks two files in quick succession.
  const loadedFor = useRef<string | null>(null);

  // Load file contents whenever the active path changes.
  useEffect(() => {
    if (!activePath) {
      setContent("");
      setDirty(false);
      loadedFor.current = null;
      return;
    }
    let cancelled = false;
    loadedFor.current = activePath;
    setError(null);
    cmd.forgeReadFile(activePath)
      .then((text) => {
        if (cancelled || loadedFor.current !== activePath) return;
        setContent(text);
        setDirty(false);
      })
      .catch((err) => {
        if (cancelled || loadedFor.current !== activePath) return;
        setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  // AI-suggested content from the chat panel.
  //
  // Three branches:
  //
  //   1. No file open → silently no-op. Parent's button is gated
  //      too; this is defence-in-depth.
  //
  //   2. Buffer is clean (or empty) → apply directly. No need
  //      to interrupt the flow with a modal when there's nothing
  //      to lose.
  //
  //   3. Buffer is dirty + non-empty → open the DiffModal so the
  //      operator can see the proposed change line-by-line before
  //      committing. Apply / Cancel buttons + esc / ⌘+enter.
  //
  // Parent is responsible for resetting `externalContent` to null
  // after we consume it (so repeated Insert clicks re-trigger the
  // effect even when the same code text comes through twice).
  useEffect(() => {
    if (externalContent == null) return;
    if (!activePath) return;

    if (dirty && content.trim().length > 0) {
      setPendingDiff(externalContent);
      return;
    }

    setContent(externalContent);
    setDirty(true);
    onSaved();           // clear the parent's pendingCode slot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalContent]);

  // Cmd+S / Ctrl+S to save.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmdKey = e.metaKey || e.ctrlKey;
      if (cmdKey && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, content]);

  const save = async () => {
    if (!activePath || saving) return;
    setSaving(true);
    setError(null);
    try {
      await cmd.forgeWriteFile(activePath, content);
      setDirty(false);
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  // Run Backtest — saves the file first (if dirty), then deep-links
  // into Houston's backtest view at /ui/backtests/new with the
  // strategy path as a query param. Houston owns the actual run +
  // results UI; Forge just gets you there with a single click
  // instead of "save, switch to browser, click Strategies, find
  // the file, click Backtest." If Houston isn't running, the user
  // hits the standard "stack offline" page from there.
  const [backtesting, setBacktesting] = useState(false);
  const runBacktest = async () => {
    if (!activePath || backtesting) return;
    setBacktesting(true);
    setError(null);
    try {
      if (dirty) {
        await cmd.forgeWriteFile(activePath, content);
        setDirty(false);
        onSaved();
      }
      // Strip the .py / .ipynb extension — Houston's URL expects
      // the dotted module path (strategies.foo) or the file stem,
      // not the on-disk filename. We pass the raw rel_path and
      // let Houston resolve; the worst case is the form pre-fill
      // doesn't land and the user picks the strategy manually.
      const params = new URLSearchParams({ strategy: activePath });
      const url = `http://localhost:1969/ui/backtests/new?${params}`;
      await openInBrowser(url);
    } catch (err) {
      setError(`Could not start backtest: ${String(err)}`);
    } finally {
      setBacktesting(false);
    }
  };

  if (!activePath) {
    return (
      <div className="forge-panel">
        <div className="forge-panel-head">Editor</div>
        <div className="forge-empty">
          <p style={{ margin: 0, color: "var(--fg-dim)" }}>
            Pick a file from the left to edit, or generate one in the
            chat panel on the right.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="forge-panel">
      <div className="forge-panel-head">
        <span title={activePath}>
          {activePath}
          {dirty ? <span className="forge-dirty"> · unsaved</span> : null}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {error && <span className="muted mono forge-error">{error}</span>}
          <button
            type="button"
            className="ghost"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save (⌘S)"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={backtesting}
            onClick={runBacktest}
            title="Save the file + open Houston's backtest form pre-filled with this strategy."
          >
            {backtesting ? "Opening…" : "Run Backtest"}
          </button>
        </div>
      </div>
      <div className="forge-editor">
        <CodeMirror
          value={content}
          theme={vscodeDark}
          extensions={[python()]}
          height="100%"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            foldGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
            highlightSelectionMatches: true,
          }}
          onChange={(v) => {
            setContent(v);
            setDirty(true);
          }}
        />
      </div>

      {pendingDiff !== null && activePath && (
        <DiffModal
          filePath={activePath}
          oldText={content}
          newText={pendingDiff}
          onApply={() => {
            setContent(pendingDiff);
            setDirty(true);
            setPendingDiff(null);
            onSaved();   // clear parent slot
          }}
          onCancel={() => {
            setPendingDiff(null);
            onSaved();   // clear parent slot even on reject
          }}
        />
      )}
    </div>
  );
}
