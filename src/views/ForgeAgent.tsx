// ForgeAgent — CVForge-style 2-pane layout.
//
//   ┌─────────────────────────────────────────────────────────┐
//   │  topbar (Agent | Code) · project name · + New session   │
//   ├──────────────────────────────┬──────────────────────────┤
//   │                              │                          │
//   │  AGENT (40% width)           │  PREVIEW (60% width)     │
//   │                              │                          │
//   │  - Chat input at bottom      │  Tabs: Source | Backtest │
//   │  - Activity stream above     │  Source: read-only file  │
//   │  - Insert buttons in cards   │  Backtest: Houston iframe│
//   │                              │                          │
//   └──────────────────────────────┴──────────────────────────┘
//
// Wrapped by Forge.tsx, which owns shared state (active file,
// chat history reset, etc.) and renders either this or the
// classic 3-pane based on the layout mode toggle.

import ChatPanel from "@/components/forge/ChatPanel";
import PreviewPane from "@/components/forge/PreviewPane";

interface ForgeAgentProps {
  activePath: string | null;
  setActivePath: (p: string | null) => void;
  previewRefreshKey: number;
  pendingCode: string | null;
  setPendingCode: (code: string | null) => void;
}

export default function ForgeAgent({
  activePath,
  previewRefreshKey,
  setPendingCode,
}: ForgeAgentProps) {
  return (
    <div className="forge-agent-shell">
      <div className="forge-col forge-col-agent-chat">
        <ChatPanel
          activePath={activePath}
          onInsertCode={(code) => setPendingCode(code)}
        />
      </div>
      <div className="forge-col forge-col-agent-preview">
        <PreviewPane activePath={activePath} refreshKey={previewRefreshKey} />
      </div>
    </div>
  );
}
