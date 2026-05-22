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

import { cmd } from "@/lib/tauri";

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

  // AI-suggested content from the chat panel. The parent passes it
  // in via `externalContent`; we drop it straight into the editor
  // and mark the buffer dirty. The parent is responsible for resetting
  // `externalContent` to null after we consume it (otherwise repeated
  // Insert clicks won't re-trigger this effect).
  useEffect(() => {
    if (externalContent != null) {
      setContent(externalContent);
      setDirty(true);
    }
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
    </div>
  );
}
