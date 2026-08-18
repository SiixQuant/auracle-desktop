// Shell — the single-surface launcher chrome for "The Standby".
//
// Replaces the old Home/Settings/Help rail. One surface (the Standby home)
// plus a thin top bar, the right-docked inspector layer, and the ⌘K
// command palette. The Shell owns: the shared engine read (so the home
// keeps polling behind an open inspector), the one actuator verb (shared
// by the button and the palette), the inspector state, the palette, the
// single-key hotkeys, and the transient command echo (echo-to-teach).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Coachmark, { coachSeen } from "@/components/Coachmark";
import CommandPalette from "@/components/CommandPalette";
import InspectorHost, { type InspectorKey } from "@/components/InspectorHost";
import NavPill from "@/components/NavPill";
import StandbyHome from "@/components/StandbyHome";
import AsciiField from "@/fx/AsciiField";
import { DUR, enter, useGSAP } from "@/fx/motion";
import { frameFor } from "@/fx/orrery";
import { deriveBoard } from "@/lib/aggregator";
import { buildCommands, type Command } from "@/lib/commands";
import {
  cmd,
  openEngineSetup,
  openIdePanel,
  type AccountSession,
  type ContainerStatus,
} from "@/lib/tauri";
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

  // Who is signed in, for the pill's account chip. Read once: the session is
  // the engine's and it does not change under a running launcher — and a chip
  // that polled would be one more clock for one word. A failed probe leaves it
  // null, which the chip renders as the name of its own door, never as a guess.
  const [account, setAccount] = useState<AccountSession | null>(null);
  useEffect(() => {
    let cancelled = false;
    cmd
      .clerkSession()
      .then((s) => !cancelled && setAccount(s))
      .catch(() => !cancelled && setAccount(null));
    return () => {
      cancelled = true;
    };
  }, []);

  // The live stack: the palette's restart commands AND the instrument's
  // bodies. Re-read on every health poll rather than on a timer of its own —
  // the engine read is the only clock in the app, it already stands down when
  // the window is hidden, and during a start sequence it ticks every 2s, which
  // is what lets the orrery's bodies appear one-by-one as their containers
  // actually report.
  const loadContainers = useCallback(() => {
    cmd.stackStatus().then((s) => setContainers(s.containers)).catch(() => {});
  }, []);
  useEffect(() => loadContainers(), [loadContainers, eng.state.health]);

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
        setInspector("status");
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
        rerunSetup: onRerunSetup,
      }),
    [
      board,
      containers,
      runActuator,
      eng.refresh,
      onOpenTutorial,
      showTips,
      onRerunSetup,
    ],
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
        case "s":
          e.preventDefault();
          setInspector("status");
          emit("status");
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
      {/* The ambient stage: the mark itself, rasterised into a field of
          characters, composed large and running off the right edge. Texture
          first, image second — it seats the instrument by standing behind it,
          not by pointing at it. */}
      <AsciiField />
      {/* The launcher's whole navigation, and the window's drag strip. The
          window has no title bar of its own (tauri.conf.json: titleBarStyle
          "Overlay" — decorations stay, so the traffic lights are still the
          OS's), so this band is what you drag it by. */}
      <NavPill account={account} onOpen={(k) => setInspector(k)} />

      <main className="standby-stage">
        <StandbyHome eng={eng} onActuator={runActuator} />
        {/* The tray's Supervision echo draws the SAME instrument as the home
            (§3.4). Derived once here and handed down rather than rebuilt
            inside the tray, so the miniature and the board cannot disagree —
            and the same reason the version ladder rides down with it: the
            Shell already holds one reading of the update probe. */}
        <InspectorHost
          open={inspector}
          instrument={frameFor(board, containers)}
          update={eng.update}
          version={eng.version}
          onClose={() => setInspector(null)}
        />
        {echo && <EchoLine key={echo} verb={echo} />}
        {/* The coachmark annotates the home's own parts, so it lives in the
            stage that holds them (§3.6's deterministic anchoring) rather than
            over the whole window — the same reason the tray is mounted here. */}
        {showCoach && <Coachmark onClose={() => setShowCoach(false)} />}
      </main>

      {/* Always mounted: the palette owns its own exit (§3.5), so it has to
          outlive the close it was asked for. `open` stays the authority. */}
      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
        onRun={runCommand}
      />
    </div>
  );
}

/** The transient command echo (echo-to-teach) — names the verb you just ran.
 *
 *  §2.4 lists the echo line among the things that animate, so its arrival is a
 *  house entrance rather than a CSS keyframe: one engine, one curve, and it
 *  collapses to an instant appearance under reduced motion like everything
 *  else. The `key` on the caller's element retires the old verb, so a second
 *  command re-runs the entrance instead of silently swapping the word. */
function EchoLine({ verb }: { verb: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (ref.current) enter(ref.current, { duration: DUR.micro });
    },
    { dependencies: [verb], scope: ref },
  );

  return (
    <div ref={ref} className="echo-line" role="status" aria-live="polite">
      ran <span className="mono">{verb}</span>
    </div>
  );
}

// The search and gear glyphs left with the top bar they labelled. The pill
// carries words, not icons, and the palette they stood for is ⌘K — which the
// tour, the coachmark and every command's own echo all name.

