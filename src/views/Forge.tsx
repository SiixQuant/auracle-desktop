// Forge — strategy authoring + AI chat (Phase 1).
//
// Layout: three columns inside the existing top-bar shell.
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │  topbar (Dashboard | Forge | Settings)                       │
//   ├──────────┬───────────────────────────────┬───────────────────┤
//   │ FileTree │           Editor              │     ChatPanel     │
//   │  (left)  │          (center)             │     (right)       │
//   │   220px  │          flex grow            │       380px       │
//   └──────────┴───────────────────────────────┴───────────────────┘
//
// State hub: Forge owns `activePath`, `treeRefreshKey`, and the
// `pendingCode` slot that the ChatPanel writes into when the user
// clicks "Insert into editor." Editor consumes the slot once + we
// reset it to null so subsequent unrelated edits don't get clobbered.

import { useState } from "react";

import ChatPanel from "@/components/forge/ChatPanel";
import Editor from "@/components/forge/Editor";
import FileTree from "@/components/forge/FileTree";

export default function Forge() {
  const [activePath, setActivePath] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  return (
    <div className="forge-shell">
      <div className="forge-col forge-col-left">
        <FileTree
          activePath={activePath}
          onOpen={(p) => setActivePath(p)}
          refreshKey={treeRefreshKey}
        />
      </div>
      <div className="forge-col forge-col-center">
        <Editor
          activePath={activePath}
          externalContent={pendingCode}
          onSaved={() => {
            // Bump the tree so a freshly-created file (or a renamed
            // one) appears immediately + any "modified" sort would
            // reorder. Today we don't surface modified-time in the
            // tree, but the bump costs nothing and future-proofs.
            setTreeRefreshKey((k) => k + 1);
            // Drop the pending-code slot once the editor has applied
            // it; otherwise a second Insert click wouldn't re-trigger
            // the React effect that consumes externalContent.
            if (pendingCode != null) setPendingCode(null);
          }}
        />
      </div>
      <div className="forge-col forge-col-right">
        <ChatPanel
          activePath={activePath}
          onInsertCode={(code) => setPendingCode(code)}
        />
      </div>
    </div>
  );
}
