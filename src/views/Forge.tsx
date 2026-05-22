// Forge — top-level shell with mode toggle (Agent | Code).
//
// Two layouts coexist behind the toggle:
//
//   Agent (default, CVForge-style): 2-pane chat + live preview.
//     File management is hidden — the agent creates/edits files
//     via the chat panel's Insert flow. Power users who want to
//     pick files manually flip to Code mode.
//
//   Code (legacy 3-pane): file tree + monaco-style editor + chat
//     panel. The full polished file-management UX we shipped in
//     Phase 4c (new/rename/delete, state pills, etc.) lives here.
//
// Mode is persisted in Tauri store (forge.json:layout_mode). First
// launch defaults to Agent. Mid-session toggle preserves the active
// file + chat transcript (chat state lives inside ChatPanel — it
// re-mounts when the mode changes, so chat history is per-mode for
// now; Phase 5b will lift it up so both modes share one transcript).

import { useCallback, useEffect, useState } from "react";

import ChatPanel from "@/components/forge/ChatPanel";
import Editor from "@/components/forge/Editor";
import FileTree from "@/components/forge/FileTree";
import ForgeTopBar from "@/components/forge/ForgeTopBar";
import NewStrategyModal from "@/components/forge/NewStrategyModal";
import ForgeAgent from "@/views/ForgeAgent";
import {
  cmd,
  type ForgeLayoutMode,
  type StrategyState,
} from "@/lib/tauri";

export default function Forge() {
  const [mode, setMode] = useState<ForgeLayoutMode>("agent");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);

  // Strategy lifecycle state map (lives at Forge level so both
  // tree pills + editor dropdown stay in sync).
  const [states, setStates] = useState<Record<string, StrategyState>>({});
  const [fromHouston, setFromHouston] = useState<boolean>(false);

  // Session-bust counter: bumping this re-mounts the children
  // (ChatPanel, etc.) so a "New session" click reliably clears
  // their internal transcript state without each child needing a
  // dedicated reset method.
  const [sessionKey, setSessionKey] = useState(0);

  // Load persisted mode on first render.
  useEffect(() => {
    cmd.forgeGetLayoutMode()
      .then((m) => setMode(m))
      .catch(() => setMode("agent"));
  }, []);

  // Persist mode changes. Fire-and-forget — a Tauri store write
  // failure is logged but doesn't roll back the UI flip.
  const onModeChange = useCallback((next: ForgeLayoutMode) => {
    setMode(next);
    cmd.forgeSetLayoutMode(next).catch((err) =>
      console.warn("forge_set_layout_mode failed:", err),
    );
  }, []);

  const refreshStates = useCallback(async () => {
    try {
      const resp = await cmd.forgeStrategyStates();
      setStates(resp.states);
      setFromHouston(resp.from_houston);
    } catch {
      // Houston offline + cache empty — leave the map untouched
      // so we keep showing whatever we had.
    }
  }, []);

  useEffect(() => {
    refreshStates();
  }, [refreshStates, treeRefreshKey]);

  const onChangeState = useCallback(
    async (relPath: string, next: StrategyState) => {
      setStates((prev) => ({ ...prev, [relPath]: next }));
      try {
        await cmd.forgeSetStrategyState(relPath, next);
      } catch (err) {
        console.warn("set strategy state failed:", err);
        refreshStates();
      }
    },
    [refreshStates],
  );

  const onNewSession = useCallback(() => {
    if (
      !confirm(
        "Start a new session?\n\nThis clears the chat transcript and closes the open file. Saved strategies stay where they are.",
      )
    )
      return;
    setActivePath(null);
    setPendingCode(null);
    setSessionKey((k) => k + 1);
  }, []);

  return (
    <div className="forge-shell-outer" key={sessionKey}>
      <ForgeTopBar
        mode={mode}
        onModeChange={onModeChange}
        activePath={activePath}
        onNewSession={onNewSession}
      />

      {mode === "agent" ? (
        <ForgeAgent
          activePath={activePath}
          setActivePath={setActivePath}
          previewRefreshKey={previewRefreshKey}
          pendingCode={pendingCode}
          setPendingCode={setPendingCode}
        />
      ) : (
        <div className="forge-shell">
          <div className="forge-col forge-col-left">
            <FileTree
              activePath={activePath}
              onOpen={(p) => setActivePath(p)}
              refreshKey={treeRefreshKey}
              states={states}
              statesAreFresh={fromHouston}
              onNewStrategy={() => setShowNewModal(true)}
              onRenamed={(oldPath, newPath) => {
                setTreeRefreshKey((k) => k + 1);
                if (activePath === oldPath) setActivePath(newPath);
              }}
              onDeleted={(deleted) => {
                setTreeRefreshKey((k) => k + 1);
                if (activePath === deleted) setActivePath(null);
              }}
            />
          </div>
          <div className="forge-col forge-col-center">
            <Editor
              activePath={activePath}
              externalContent={pendingCode}
              currentState={
                activePath ? states[activePath] ?? "draft" : "draft"
              }
              onChangeState={(next) => {
                if (activePath) onChangeState(activePath, next);
              }}
              onSaved={() => {
                setTreeRefreshKey((k) => k + 1);
                setPreviewRefreshKey((k) => k + 1);
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
      )}

      {showNewModal && (
        <NewStrategyModal
          onCreated={(relPath) => {
            setShowNewModal(false);
            setTreeRefreshKey((k) => k + 1);
            setActivePath(relPath);
          }}
          onCancel={() => setShowNewModal(false)}
        />
      )}
    </div>
  );
}
