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

import { useCallback, useEffect, useState } from "react";

import ChatPanel from "@/components/forge/ChatPanel";
import Editor from "@/components/forge/Editor";
import FileTree from "@/components/forge/FileTree";
import { cmd, type StrategyState } from "@/lib/tauri";

export default function Forge() {
  const [activePath, setActivePath] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  // Strategy lifecycle state map. Lives at the Forge level so the
  // tree pills + the editor dropdown stay in sync without prop-
  // drilling through ChatPanel. Refreshed when the tree refreshes
  // (which covers: app open, file create, file save) and after any
  // explicit state change from the editor dropdown.
  const [states, setStates] = useState<Record<string, StrategyState>>({});
  const [fromHouston, setFromHouston] = useState<boolean>(false);

  const refreshStates = useCallback(async () => {
    try {
      const resp = await cmd.forgeStrategyStates();
      setStates(resp.states);
      setFromHouston(resp.from_houston);
    } catch {
      // Houston offline + cache empty — leave the map untouched
      // so we keep showing whatever we had. Worst case the tree
      // renders no pills, which is the right neutral state.
    }
  }, []);

  useEffect(() => {
    refreshStates();
  }, [refreshStates, treeRefreshKey]);

  const onChangeState = useCallback(
    async (relPath: string, next: StrategyState) => {
      // Optimistic local update first so the UI feels instant; the
      // Rust command writes the cache + pushes to Houston.
      setStates((prev) => ({ ...prev, [relPath]: next }));
      try {
        await cmd.forgeSetStrategyState(relPath, next);
      } catch (err) {
        console.warn("set strategy state failed:", err);
        // Roll back the optimistic write.
        refreshStates();
      }
    },
    [refreshStates],
  );

  return (
    <div className="forge-shell">
      <div className="forge-col forge-col-left">
        <FileTree
          activePath={activePath}
          onOpen={(p) => setActivePath(p)}
          refreshKey={treeRefreshKey}
          states={states}
          statesAreFresh={fromHouston}
        />
      </div>
      <div className="forge-col forge-col-center">
        <Editor
          activePath={activePath}
          externalContent={pendingCode}
          currentState={activePath ? states[activePath] ?? "draft" : "draft"}
          onChangeState={(next) => {
            if (activePath) onChangeState(activePath, next);
          }}
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
