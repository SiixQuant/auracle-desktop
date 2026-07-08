// Shell — the single-surface launcher chrome for "The Standby".
//
// Replaces the old Home/Settings/Help rail. One surface (the Standby home)
// plus a thin top bar, the right-docked inspector layer, and the ⌘K
// command palette. The Shell owns: the shared engine read (so the home
// keeps polling behind an open inspector), the one actuator verb (shared
// by the button and the palette), the inspector state, the palette, the
// single-key hotkeys, and the transient command echo (echo-to-teach).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuracleGlyph } from "@/components/AuracleGlyph";
import Coachmark, { coachSeen } from "@/components/Coachmark";
import CommandPalette from "@/components/CommandPalette";
import InspectorHost, { type InspectorKey } from "@/components/InspectorHost";
import ShellBackground from "@/components/ShellBackground";
import StandbyHome from "@/components/StandbyHome";
import { deriveBoard } from "@/lib/aggregator";
import { buildCommands, type Command } from "@/lib/commands";
import { cmd, openEngineSetup, openIdePanel, type ContainerStatus } from "@/lib/tauri";
import { useEngineState } from "@/lib/useEngineState";

export default function Shell({
  onOpenTutorial,
  onRerunSetup,
}: {
  onOpenTutorial: () => void;
  onRerunSetup: () => void;
}) {
  const eng = useEngineState();
  const board = deriveBoard(eng.state);

  const [inspector, setInspector] = useState<InspectorKey | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [containers, setContainers] = useState<ContainerStatus[]>([]);
  const [echo, setEcho] = useState<string | null>(null);
  const [showCoach, setShowCoach] = useState(() => !coachSeen());
  const echoTimer = useRef<number | null>(null);
  const showTips = useCallback(() => setShowCoach(true), []);

  // Live container names for the palette's restart commands.
  const loadContainers = useCallback(() => {
    cmd.stackStatus().then((s) => setContainers(s.containers)).catch(() => {});
  }, []);
  useEffect(() => loadContainers(), [loadContainers]);

  const emit = useCallback((verb: string) => {
    setEcho(verb);
    if (echoTimer.current) window.clearTimeout(echoTimer.current);
    echoTimer.current = window.setTimeout(() => setEcho(null), 2400);
  }, []);
  useEffect(() => () => {
    if (echoTimer.current) window.clearTimeout(echoTimer.current);
  }, []);

  // The one verb — shared by the home button, the hotkey, and the palette.
  const runActuator = useCallback(() => {
    switch (board.actuator.action) {
      case "launch":
        void eng.launch();
        break;
      case "start":
        void eng.startEngine();
        break;
      case "setup":
        // Engine's up but has no owner yet — open the first-run wizard
        // (/ui/setup) in the browser; the next health poll flips the home
        // to "Open workspace" once the account exists.
        void openEngineSetup();
        break;
      case "degraded":
        setInspector("supervision");
        break;
      default:
        break;
    }
  }, [board.actuator.action, eng]);

  const commands = useMemo(
    () =>
      buildCommands({
        board,
        containers,
        openInspector: (k) => setInspector(k),
        runActuator,
        restartContainer: (name) => {
          void cmd.stackRestartContainer(name).catch(() => {});
        },
        refresh: eng.refresh,
        openIdePanel: (p) => void openIdePanel(p),
        openTutorial: onOpenTutorial,
        showTips,
      }),
    [board, containers, runActuator, eng.refresh, onOpenTutorial, showTips],
  );

  const runCommand = useCallback(
    (c: Command) => {
      c.run();
      emit(c.verb);
    },
    [emit],
  );

  // Single-key hotkeys (gated on no input focused); ⌘K is always safe.
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => {
          if (!open) loadContainers();
          return !open;
        });
        return;
      }
      if (paletteOpen) return; // palette owns its own keys
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping()) return;
      switch (e.key) {
        case "l":
        case "L":
          e.preventDefault();
          runActuator();
          emit(
            board.actuator.action === "start"
              ? "engine start"
              : board.actuator.action === "setup"
                ? "finish setup"
                : "launch",
          );
          break;
        case "u":
          e.preventDefault();
          setInspector("updates");
          emit("updates");
          break;
        case "s":
          e.preventDefault();
          setInspector("supervision");
          emit("supervision");
          break;
        case "a":
          e.preventDefault();
          setInspector("intelligence");
          emit("intelligence");
          break;
        case ",":
          e.preventDefault();
          setInspector("system");
          emit("system");
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, runActuator, emit, board.actuator.action, loadContainers]);

  return (
    <div className="shell-standby">
      <ShellBackground />
      <header className="topbar">
        <div className="topbar__brand">
          <AuracleGlyph className="topbar__mark" />
          <strong>Auracle</strong>
        </div>
        <div className="topbar__actions">
          <button
            type="button"
            className="topbar__btn"
            onClick={() => {
              loadContainers();
              setPaletteOpen(true);
            }}
          >
            <SearchIcon />
            <span className="kbd-hint">⌘K</span>
          </button>
          <button type="button" className="topbar__btn" onClick={() => setInspector("system")}>
            <GearIcon />
            System
          </button>
        </div>
      </header>

      <main className="standby-stage">
        <StandbyHome
          eng={eng}
          onActuator={runActuator}
          onDoor={(d) => setInspector(d)}
          onCard={(k) => setInspector(k)}
          onRerunSetup={onRerunSetup}
          onAgent={() => setInspector("intelligence")}
        />
        <InspectorHost open={inspector} onClose={() => setInspector(null)} />
        {echo && (
          <div className="echo-line" role="status" aria-live="polite">
            ran <span className="mono">{echo}</span>
          </div>
        )}
      </main>

      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
          onRun={runCommand}
        />
      )}

      {showCoach && <Coachmark onClose={() => setShowCoach(false)} />}
    </div>
  );
}

// ── Top-bar icons (inline, no icon-font dependency) ─────────────────

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function SearchIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="9" cy="9" r="6" />
      <path d="M13.5 13.5 L17 17" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 2.5 v2 M10 15.5 v2 M2.5 10 h2 M15.5 10 h2 M4.7 4.7 l1.4 1.4 M13.9 13.9 l1.4 1.4 M15.3 4.7 l-1.4 1.4 M6.1 13.9 l-1.4 1.4" />
    </svg>
  );
}

