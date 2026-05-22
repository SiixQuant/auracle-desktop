// Diff modal — shown when Insert-into-editor would clobber an
// unsaved buffer. Replaces the plain confirm() dialog with a real
// line-by-line view so the operator can see what's actually being
// added vs removed before committing.
//
// Implementation note: we use jsdiff's diffLines rather than a
// pre-built component. jsdiff returns an array of Change objects
// with `value` (the chunk text) + `added` / `removed` flags; we
// render that as a unified diff with our own classes, which keeps
// the styling consistent with the rest of Forge and saves us a
// 30 KB dependency.
//
// Phase 4 will add hunk-level Accept/Reject (today: whole-diff
// Apply/Cancel) once we have a clear use case for partial application
// — most AI-generated rewrites are coherent enough that the user
// either wants the whole thing or none of it.

import { diffLines, type Change } from "diff";
import { useEffect, useMemo } from "react";

interface DiffModalProps {
  oldText: string;
  newText: string;
  filePath: string;
  onApply: () => void;
  onCancel: () => void;
}

export default function DiffModal({
  oldText,
  newText,
  filePath,
  onApply,
  onCancel,
}: DiffModalProps) {
  // jsdiff is fast enough at this size that running it on every
  // render is fine — but memoize anyway so re-renders from
  // unrelated state don't recompute the line-by-line diff.
  const changes = useMemo(
    () => diffLines(oldText, newText),
    [oldText, newText],
  );

  const { adds, removes } = useMemo(() => {
    let adds = 0;
    let removes = 0;
    for (const c of changes) {
      if (c.added) adds += c.count ?? countLines(c.value);
      else if (c.removed) removes += c.count ?? countLines(c.value);
    }
    return { adds, removes };
  }, [changes]);

  // Esc to cancel, ⌘+Enter to apply. Mirrors the chat panel's
  // submit shortcut for muscle memory.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onApply();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onApply, onCancel]);

  return (
    <div
      className="forge-modal-backdrop"
      onClick={(e) => {
        // Click outside the modal body cancels — matches the
        // standard macOS modal dismissal pattern.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="forge-modal" role="dialog" aria-modal="true">
        <div className="forge-modal-head">
          <div>
            <strong>Apply AI changes to {filePath}?</strong>
            <div className="muted mono" style={{ marginTop: 4, fontSize: 11 }}>
              <span style={{ color: "var(--ok)" }}>+{adds}</span>{" "}
              <span style={{ color: "var(--err)" }}>-{removes}</span>{" "}
              lines
            </div>
          </div>
          <div className="muted mono" style={{ fontSize: 10 }}>
            esc to cancel · ⌘+enter to apply
          </div>
        </div>

        <div className="forge-diff">
          {changes.map((change, i) => (
            <ChangeBlock key={i} change={change} />
          ))}
        </div>

        <div className="forge-modal-foot">
          <button
            type="button"
            className="ghost"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={onApply}
          >
            Apply changes
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangeBlock({ change }: { change: Change }) {
  // Split the chunk into lines so each gets its own row with the
  // right +/- prefix. jsdiff returns the trailing newline inside
  // the value; we filter the artifact-empty last line that creates.
  const lines = change.value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const kind = change.added ? "add" : change.removed ? "remove" : "context";
  const prefix = change.added ? "+" : change.removed ? "-" : " ";

  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={`forge-diff-line ${kind}`}>
          <span className="forge-diff-prefix">{prefix}</span>
          <span className="forge-diff-content">{line || " "}</span>
        </div>
      ))}
    </>
  );
}

function countLines(s: string): number {
  // jsdiff usually sets `count` itself but the type marks it
  // optional. Fall back to a manual count for safety.
  if (!s) return 0;
  const n = s.split("\n").length;
  return s.endsWith("\n") ? n - 1 : n;
}
