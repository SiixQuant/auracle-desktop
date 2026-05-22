// ForgeTopBar — always-visible bar above the Forge layout.
//
// Three regions:
//
//   Left:   Mode toggle (Agent | Code). Persisted in Tauri store
//           via forge_set_layout_mode. Agent is the new default;
//           Code preserves the 3-pane classic for power users.
//
//   Center: Active project / file name. Mirrors CVForge's project
//           label (e.g. "noko"). Empty when no file is open.
//
//   Right:  "+ New session" button. Clears the chat transcript +
//           closes any open file. Matches CVForge's "fresh session"
//           tab affordance.
//
// The bar lives inside the Forge view (not the top-level App
// topbar) because Dashboard + Settings don't share its concerns.

import type { ForgeLayoutMode } from "@/lib/tauri";

interface ForgeTopBarProps {
  mode: ForgeLayoutMode;
  onModeChange: (mode: ForgeLayoutMode) => void;
  activePath: string | null;
  onNewSession: () => void;
}

export default function ForgeTopBar({
  mode,
  onModeChange,
  activePath,
  onNewSession,
}: ForgeTopBarProps) {
  return (
    <div className="forge-topbar">
      <div className="forge-topbar-left">
        <div
          className="forge-mode-toggle"
          role="tablist"
          aria-label="Forge layout"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "agent"}
            className={`forge-mode-tab ${mode === "agent" ? "active" : ""}`}
            onClick={() => onModeChange("agent")}
            title="2-pane agent + preview layout"
          >
            Agent
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "code"}
            className={`forge-mode-tab ${mode === "code" ? "active" : ""}`}
            onClick={() => onModeChange("code")}
            title="Classic 3-pane (file tree + editor + chat)"
          >
            Code
          </button>
        </div>
      </div>

      <div className="forge-topbar-center" title={activePath ?? undefined}>
        {activePath ? (
          <span className="forge-project-name">{leafName(activePath)}</span>
        ) : (
          <span className="muted">No active file</span>
        )}
      </div>

      <div className="forge-topbar-right">
        <button
          type="button"
          className="forge-tree-new"
          onClick={onNewSession}
          title="Clear the chat transcript and close any open file."
        >
          + New session
        </button>
      </div>
    </div>
  );
}

function leafName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
