// SharedSettings — one coherent read of the engine's owner-gated
// settings aggregate, shared across every Settings card.
//
// Why a context: the License, System, General (engine prefs), and AI-model
// cards all want a consistent picture of engine state (tier,
// which keys are configured, which AI model is set). Without this, each
// card would poll the engine independently and drift. The provider loads
// once, refreshes on window focus, and runs a low-frequency etag poll
// that only re-renders consumers when the engine's etag actually changes.
//
// HONESTY: the aggregate never carries secret VALUES — only "configured"
// flags. A failed load is surfaced as `error`, never as a fake-empty
// success, so a card can tell "not configured" apart from "couldn't ask".

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cmd, type SettingsAggregate } from "@/lib/tauri";

/** How often to re-check the engine for a changed etag. Deliberately
 *  low-frequency — this is a backstop for changes made in another
 *  surface (the IDE), not a hot path. Focus refresh covers the common
 *  "user came back to the window" case faster. */
const POLL_MS = 20_000;

interface SharedSettings {
  /** The latest aggregate, or null before the first successful load. */
  settings: SettingsAggregate | null;
  /** True until the first load attempt resolves (success or failure). */
  loading: boolean;
  /** Set when the last load failed; cleared on the next success. */
  error: string | null;
  /** Force an immediate reload (e.g. right after a save). */
  refresh: () => void;
}

const Ctx = createContext<SharedSettings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsAggregate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  // Track the last-seen etag so the poll only updates state on a real
  // change (avoids re-rendering every consumer every POLL_MS).
  const etagRef = useRef<string | null>(null);
  // Serialize loads so an in-flight request can't be clobbered by an
  // overlapping focus/poll/refresh.
  const inFlightRef = useRef(false);

  const load = useCallback(async (force: boolean) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await cmd.settingsGet();
      if (!mountedRef.current) return;
      // Only push new state when the etag changed (or on a forced/first
      // load). Cheap guard against needless re-renders on the poll path.
      if (force || next.etag !== etagRef.current) {
        etagRef.current = next.etag;
        setSettings(next);
      }
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      // Keep any prior good snapshot visible; surface the error so a
      // card can show "couldn't reach the engine" rather than empty.
      setError(String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
      inFlightRef.current = false;
    }
  }, []);

  // Initial load.
  useEffect(() => {
    mountedRef.current = true;
    void load(true);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  // Refresh when the window regains focus — the user may have changed
  // settings in the IDE while away.
  useEffect(() => {
    const onFocus = () => void load(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // Low-frequency etag poll. Skips while the document is hidden so a
  // backgrounded launcher doesn't hammer the engine.
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void load(false);
    }, POLL_MS);
    return () => window.clearInterval(handle);
  }, [load]);

  const refresh = useCallback(() => void load(true), [load]);

  return (
    <Ctx.Provider value={{ settings, loading, error, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

/** Read the shared settings. Safe to call outside a provider — returns a
 *  null/no-op shape so a card renders its "nothing yet" state instead of
 *  throwing (e.g. in isolated tests). */
export function useSettings(): SharedSettings {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return { settings: null, loading: false, error: null, refresh: () => {} };
}
