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

import { useEffect, useState } from "react";

import { cmd, type StrategyFile } from "@/lib/tauri";

interface FileTreeProps {
  activePath: string | null;
  onOpen: (path: string) => void;
  refreshKey: number;
}

export default function FileTree({
  activePath,
  onOpen,
  refreshKey,
}: FileTreeProps) {
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
    <div className="forge-panel">
      <div className="forge-panel-head">
        Strategies
        <span className="forge-panel-sub" title={dir}>
          {shortPath(dir)}
        </span>
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
              {groups.get(groupName)!.map((f) => (
                <button
                  key={f.rel_path}
                  type="button"
                  className={`forge-tree-row ${
                    activePath === f.rel_path ? "active" : ""
                  }`}
                  onClick={() => onOpen(f.rel_path)}
                  title={f.rel_path}
                >
                  <span className="forge-tree-kind">
                    {f.kind === "notebook" ? "ⓝ" : "py"}
                  </span>
                  <span className="forge-tree-name">{leafName(f.rel_path)}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
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
