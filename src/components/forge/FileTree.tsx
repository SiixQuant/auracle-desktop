// File tree — left panel of the Forge view.
//
// Lists Python + notebook files under the configured strategies/
// directory (resolved server-side by forge_list_strategies, defaults
// to ~/auracle/strategies/). Click a row to open it in the editor.
//
// Phase 1 is flat-after-folding: we group by top-level directory so
// templates/, drafts/, archived/ get their own headings, but we
// don't render a full recursive tree widget yet. If your workspace
// has 6+ nested levels of strategies, the listing still works —
// they just collapse into the nearest top-level group. Real tree
// UX lands in Phase 2.

import { useEffect, useRef, useState } from "react";

import {
  cmd,
  type StrategyFile,
  type StrategyState,
} from "@/lib/tauri";

interface FileTreeProps {
  activePath: string | null;
  onOpen: (path: string) => void;
  refreshKey: number;
  /** rel_path -> state. Missing entries render as "draft". */
  states: Record<string, StrategyState>;
  /** True when states came from Houston (fresh); false on cache fallback. */
  statesAreFresh: boolean;
  /** Open the "New strategy" modal. */
  onNewStrategy: () => void;
  /** Called after a successful rename — parent re-fetches the tree. */
  onRenamed: (oldPath: string, newPath: string) => void;
  /** Called after a successful delete — parent re-fetches the tree. */
  onDeleted: (path: string) => void;
}

export default function FileTree({
  activePath,
  onOpen,
  refreshKey,
  states,
  statesAreFresh,
  onNewStrategy,
  onRenamed,
  onDeleted,
}: FileTreeProps) {
  // Per-row inline rename state: which row is being edited + the
  // value-in-progress. null = nothing being renamed.
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Which row's ⋯ menu is open. Click outside to close.
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const [files, setFiles] = useState<StrategyFile[] | null>(null);
  const [dir, setDir] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, list] = await Promise.all([
          cmd.forgeStrategiesDir(),
          cmd.forgeListStrategies(),
        ]);
        if (cancelled) return;
        setDir(d);
        setFiles(list);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) {
    return (
      <div className="forge-panel">
        <div className="forge-panel-head">Strategies</div>
        <div className="muted mono forge-empty">{error}</div>
      </div>
    );
  }

  if (files === null) {
    return (
      <div className="forge-panel">
        <div className="forge-panel-head">Strategies</div>
        <div className="muted mono forge-empty">loading…</div>
      </div>
    );
  }

  // Group by top-level directory. Files at the root of strategies/
  // go under "(root)" so they're not orphaned.
  const groups = new Map<string, StrategyFile[]>();
  for (const f of files) {
    const segs = f.rel_path.split("/");
    const group = segs.length > 1 ? segs[0] : "(root)";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(f);
  }
  // Stable ordering: root first, then alphabetical, archived last.
  const sortedGroupNames = Array.from(groups.keys()).sort((a, b) => {
    if (a === "(root)") return -1;
    if (b === "(root)") return 1;
    if (a === "archived") return 1;
    if (b === "archived") return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="forge-panel" onClick={() => setMenuOpenFor(null)}>
      <div className="forge-panel-head">
        <span>
          Strategies
          <span className="forge-panel-sub" title={dir}>
            {shortPath(dir)}
            {!statesAreFresh && files.length > 0 ? (
              <span
                title="Showing cached lifecycle states — Houston is offline or hasn't implemented /api/forge/strategies yet."
                style={{ marginLeft: 6, opacity: 0.6 }}
              >
                · cached
              </span>
            ) : null}
          </span>
        </span>
        <button
          type="button"
          className="forge-tree-new"
          onClick={(e) => {
            e.stopPropagation();
            onNewStrategy();
          }}
          title="New strategy"
        >
          + New
        </button>
      </div>
      <div className="forge-tree">
        {files.length === 0 ? (
          <div className="muted forge-empty">
            <p style={{ margin: "0 0 8px" }}>No strategies yet.</p>
            <p
              className="mono"
              style={{ fontSize: 11, margin: 0, wordBreak: "break-all" }}
            >
              {dir}
            </p>
            <p style={{ marginTop: 12 }}>
              Use the chat panel to generate one, or drop a .py file
              into this folder.
            </p>
          </div>
        ) : (
          sortedGroupNames.map((groupName) => (
            <div key={groupName} className="forge-tree-group">
              <div className="forge-tree-group-head">{groupName}</div>
              {groups.get(groupName)!.map((f) => {
                const state = states[f.rel_path] ?? "draft";
                const isRenaming = renamingPath === f.rel_path;
                const isMenuOpen = menuOpenFor === f.rel_path;
                return (
                  <TreeRow
                    key={f.rel_path}
                    file={f}
                    state={state}
                    active={activePath === f.rel_path}
                    isRenaming={isRenaming}
                    isMenuOpen={isMenuOpen}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    onOpen={onOpen}
                    onMenuToggle={() => {
                      setMenuOpenFor(isMenuOpen ? null : f.rel_path);
                    }}
                    onBeginRename={() => {
                      setMenuOpenFor(null);
                      setRenamingPath(f.rel_path);
                      setRenameValue(leafName(f.rel_path));
                    }}
                    onCommitRename={async () => {
                      const trimmed = renameValue.trim();
                      if (!trimmed || trimmed === leafName(f.rel_path)) {
                        setRenamingPath(null);
                        return;
                      }
                      // Preserve the parent directory of the original path.
                      const slash = f.rel_path.lastIndexOf("/");
                      const newRel =
                        slash === -1
                          ? trimmed
                          : `${f.rel_path.slice(0, slash + 1)}${trimmed}`;
                      try {
                        await cmd.forgeRenameFile(f.rel_path, newRel);
                        onRenamed(f.rel_path, newRel);
                      } catch (err) {
                        alert(`Rename failed: ${err}`);
                      } finally {
                        setRenamingPath(null);
                      }
                    }}
                    onCancelRename={() => setRenamingPath(null)}
                    onDelete={async () => {
                      setMenuOpenFor(null);
                      if (
                        !confirm(
                          `Move ${f.rel_path} to .archive/?\n\nThe file is archived (not permanently deleted) and recoverable from Finder.`,
                        )
                      )
                        return;
                      try {
                        await cmd.forgeDeleteFile(f.rel_path);
                        onDeleted(f.rel_path);
                      } catch (err) {
                        alert(`Delete failed: ${err}`);
                      }
                    }}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface TreeRowProps {
  file: StrategyFile;
  state: StrategyState;
  active: boolean;
  isRenaming: boolean;
  isMenuOpen: boolean;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onOpen: (path: string) => void;
  onMenuToggle: () => void;
  onBeginRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

function TreeRow({
  file,
  state,
  active,
  isRenaming,
  isMenuOpen,
  renameValue,
  setRenameValue,
  onOpen,
  onMenuToggle,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: TreeRowProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Autofocus + select the stem (no extension) when rename begins
  // so the user can type a new name without having to delete the
  // .py suffix every time.
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const dot = el.value.lastIndexOf(".");
      el.setSelectionRange(0, dot === -1 ? el.value.length : dot);
    }
  }, [isRenaming]);

  if (isRenaming) {
    return (
      <div className={`forge-tree-row ${active ? "active" : ""}`}>
        <span className="forge-tree-kind">
          {file.kind === "notebook" ? "ⓝ" : "py"}
        </span>
        <input
          ref={inputRef}
          type="text"
          className="forge-tree-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={onCommitRename}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  }

  return (
    <div
      className={`forge-tree-row ${active ? "active" : ""}`}
      onClick={() => onOpen(file.rel_path)}
      title={`${file.rel_path} · ${state}`}
    >
      <span className="forge-tree-kind">
        {file.kind === "notebook" ? "ⓝ" : "py"}
      </span>
      <span className="forge-tree-name">{leafName(file.rel_path)}</span>
      <StatePill state={state} />
      <button
        type="button"
        className="forge-tree-menu-trigger"
        onClick={(e) => {
          e.stopPropagation();
          onMenuToggle();
        }}
        title="File actions"
        aria-label="File actions"
      >
        ⋯
      </button>
      {isMenuOpen && (
        <div
          className="forge-tree-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onBeginRename();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onDelete();
            }}
          >
            Archive…
          </button>
        </div>
      )}
    </div>
  );
}

// Tiny state pill rendered at the end of each file row. The
// Editor toolbar's dropdown is the place to CHANGE state; this is
// just visual at-a-glance. Color mapping mirrors the Editor
// dropdown so the same state always looks the same.
function StatePill({ state }: { state: StrategyState }) {
  if (state === "draft") return null; // draft is the default — no pill, less visual noise
  return (
    <span className={`forge-state-pill state-${state}`} title={`State: ${state}`}>
      {state.slice(0, 4)}
    </span>
  );
}

function leafName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function shortPath(p: string): string {
  if (!p) return "";
  const home = "/Users/";
  if (p.startsWith(home)) {
    const after = p.slice(home.length);
    const slash = after.indexOf("/");
    if (slash !== -1) return "~/" + after.slice(slash + 1);
  }
  return p;
}
