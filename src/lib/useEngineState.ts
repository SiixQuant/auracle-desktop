// useEngineState — the launcher's shared live-data layer.
//
// One hook that runs the engine probes the whole hub reads from:
//   - health poll (30s, visible-only) → the lamp/System Line/Actuator
//   - launcher update check (best-effort, once)
//   - a 15s wall-clock tick so the "as of" stamp ages between polls
//
// It exposes the assembled `EngineState` (fed to deriveBoard) plus the
// two engine-truth actions (start / launch) and their in-flight + error
// state. Connections (brokers / data sources) moved to the IDE, so this
// hook no longer glances at any broker account, position, or market-data
// feed — the launcher is a global hub for the engine + workspace.

import { useCallback, useEffect, useRef, useState } from "react";

import type { EngineState } from "@/lib/aggregator";
import { cmd, type HealthSnapshot, type UpdateInfo } from "@/lib/tauri";

export interface EngineStateHook {
  /** The pure snapshot to feed deriveBoard(). */
  state: EngineState;
  /** Wall clock, ticked every 15s for the relative-age stamp. */
  now: number;
  /** Epoch ms of the last successful health poll. */
  lastOkAt: number | null;
  /** Launcher self-update info (for the System inspector / Maintenance). */
  update: UpdateInfo | null;
  /** Installed launcher version, for the home's update/changelog cards. */
  version: string | null;
  launching: boolean;
  ideError: string | null;
  engineErr: string | null;
  /** Bring the stack up, then poll to healthy. */
  startEngine: () => Promise<void>;
  /** Open the native IDE — refuses unless the engine is confirmed healthy. */
  launch: () => Promise<void>;
  /** Force an immediate health refresh. */
  refresh: () => void;
}

export function useEngineState(): EngineStateHook {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [ideError, setIdeError] = useState<string | null>(null);
  const [engineErr, setEngineErr] = useState<string | null>(null);
  // First-run gate: true once we've confirmed the healthy engine still has
  // no owner account. Undefined = we don't know yet (don't block the user).
  const [needsSetup, setNeedsSetup] = useState<boolean | undefined>(undefined);

  const mounted = useRef(true);
  // Latch: once an owner account exists it never un-exists, so stop probing.
  const ownerConfirmed = useRef(false);

  const pollHealth = useCallback(async () => {
    try {
      const h = await cmd.currentHealth();
      if (mounted.current) {
        setHealth(h);
        if (h) setLastOkAt(Date.now());
      }
      // When the engine is healthy, find out whether first-run setup is
      // finished (an owner account exists). Until it is, the home must offer
      // "Finish setup" — never "Open workspace" into a blank IDE (P0-10).
      // An indeterminate probe leaves needsSetup falsy so we never block on a
      // signal we can't read; the latch stops probing once an owner is found.
      if (h?.state === "healthy" && !ownerConfirmed.current) {
        try {
          const ns = await cmd.engineNeedsSetup();
          if (mounted.current && ns !== null) {
            setNeedsSetup(ns);
            if (ns === false) ownerConfirmed.current = true;
          }
        } catch {
          /* probe failed — leave the home as-is, don't block launch */
        }
      }
      return h;
    } catch {
      if (mounted.current) setHealth(null);
      return null;
    }
  }, []);

  // Health poll — 30s, visible-only.
  useEffect(() => {
    mounted.current = true;
    void pollHealth();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void pollHealth();
    }, 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
    };
  }, [pollHealth]);

  // Immediate refresh when the window regains focus.
  useEffect(() => {
    const onFocus = () => void pollHealth();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [pollHealth]);

  // Update check (best-effort, once).
  useEffect(() => {
    cmd.checkForUpdate().then(setUpdate).catch(() => setUpdate(null));
  }, []);

  // Installed launcher version (best-effort, once) — for the home cards.
  useEffect(() => {
    cmd.currentVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  // Relative-age clock for the "as of" stamp.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const startEngine = useCallback(async () => {
    setEngineErr(null);
    setStarting(true);
    try {
      await cmd.stackStart();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => window.setTimeout(r, 2_000));
        const h = await pollHealth();
        if (h?.state === "healthy") break;
      }
    } catch (err) {
      if (mounted.current) setEngineErr(String(err));
    } finally {
      if (mounted.current) setStarting(false);
    }
  }, [pollHealth]);

  const launch = useCallback(async () => {
    setIdeError(null);
    // Re-confirm health here — cached health can be a poll-interval stale,
    // and the Rust side re-confirms with a fresh /healthz poll as well.
    if (health?.state !== "healthy") {
      setIdeError(
        `The engine isn't ready (${health?.state ?? "checking"}). ` +
          `Start it and wait for "ready" before opening the workspace.`,
      );
      return;
    }
    setLaunching(true);
    try {
      await cmd.openAuracleIDE();
    } catch (err) {
      setIdeError(String(err));
    } finally {
      window.setTimeout(() => mounted.current && setLaunching(false), 1200);
    }
  }, [health]);

  const refresh = useCallback(() => {
    void pollHealth();
  }, [pollHealth]);

  const state: EngineState = { health, starting, needsSetup };

  return {
    state,
    now,
    lastOkAt,
    update,
    version,
    launching,
    ideError,
    engineErr,
    startEngine,
    launch,
    refresh,
  };
}
