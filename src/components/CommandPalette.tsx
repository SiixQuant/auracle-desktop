// CommandPalette — ⌘K over the Standby home. The instrument's voice tube.
//
// Design authority: launcher-redesign-direction.md §1 (depth surfaces are
// "machined parts of the same instrument: opaque planes, hairline
// edges, no glass, no glow"), §2.2 (the mono-label register), §2.4 (the motion
// vocabulary) and §3.5 ("Command palette"). Slice 7 of the redesign.
//
// Fuzzy-runs every action and destination. Destructive verbs (restart a
// container) take a double-Enter / double-click confirm so the hands stay
// on the keyboard without an accidental fire. The result is always one of
// the commands it was given — it can never suggest something that would
// fail. Running a command echoes its verb (echo-to-teach, in the Shell).
//
// What slice 7 changed here, and nothing else:
//   · the CSS pop keyframe became a GSAP move (§3.5: "scale .98→1 + y −6→0,
//     180ms"), which is why `open` is mirrored into local state — exactly the
//     tray's pattern (InspectorHost.tsx): the panel has to outlive the close it
//     was asked for in order to animate it. `onClose` still fires the instant
//     it is asked for, and both directions collapse to zero under reduced
//     motion (a zero-length tween still RUNS, so the unmount can't strand).
//   · the arm state ("— press again to confirm") became its own `--warn` span
//     instead of a string concatenated into the title, and the `live` tag took
//     the `--err-soft` fill §3.5 asks for. Same words, same mechanic.
//   · the group tag took the mono-label register (§2.2 names "palette groups"
//     as one of its three uses).
//
// DELIBERATE READING of §3.5's "groups render as mono-uppercase section
// labels": they are rendered in the mono-label REGISTER, on the row, and NOT
// as section headers. `rankCommands` returns one flat, fuzzy-scored, state-
// ranked order in which groups interleave by design — the incident verb floats
// to the top past its own group, and a query scores across every group at once.
// Bucketing that list under headers would have to re-sort it, which would throw
// away the ranking that is the palette's whole reason for existing.

import { useEffect, useMemo, useRef, useState } from "react";

import { DUR, enter, exit, gsap, useGSAP } from "@/fx/motion";
import { rankCommands, type Command } from "@/lib/commands";

/** §3.5: "scale .98→1 + y −6→0". The panel seats itself over the board; it
 *  does not fly in. */
const RISE = 6;
const SCALE = 0.98;

export default function CommandPalette({
  open,
  commands,
  onClose,
  onRun,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
  onRun: (c: Command) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // What is actually in the DOM: the palette while it is open, plus one that
  // has been asked to close and is still sliding out. `open` remains the
  // authority — this only lets the exit finish.
  const [shown, setShown] = useState(open);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);

  // Every open is a fresh palette: empty query, first row selected, nothing
  // armed. Mounting used to do this; now that the element outlives its close,
  // the reset is explicit.
  useEffect(() => {
    if (!open) {
      // Hand the keyboard back the moment the close is asked for, rather than
      // when the exit lands — the Shell's single-key hotkeys are gated on "is
      // the user typing", and a still-focused input would swallow them for the
      // length of the animation.
      inputRef.current?.blur();
      return;
    }
    setShown(true);
    setQuery("");
    setSel(0);
    setConfirmId(null);
  }, [open]);

  // …and take the keyboard once the panel is actually in the DOM. This is a
  // separate effect on purpose: on the first open, `shown` is still false when
  // the effect above runs, so the input does not exist yet to be focused.
  useEffect(() => {
    if (open && shown) inputRef.current?.focus();
  }, [open, shown]);

  useEffect(() => {
    setSel(0);
    setConfirmId(null);
  }, [query]);

  // The move (§3.5). Both directions run through the house helpers, so both
  // collapse to zero under `prefers-reduced-motion` — and a zero-duration tween
  // still RUNS, which is what keeps the unmount gated on `onComplete` safe.
  useGSAP(
    () => {
      const panel = panelRef.current;
      const scrim = scrimRef.current;
      if (!panel || !scrim) return;
      // An open can countermand a close mid-flight (⌘K toggles), so never let
      // two moves fight over the same panel.
      gsap.killTweensOf([panel, scrim]);
      if (open) {
        gsap.set([panel, scrim], { clearProps: "opacity,transform" });
        enter(panel, { y: -RISE, scale: SCALE, duration: DUR.exit });
        enter(scrim, { duration: DUR.exit });
        return;
      }
      exit(panel, { y: -RISE, scale: SCALE, duration: DUR.exit });
      exit(scrim, { duration: DUR.exit, onComplete: () => setShown(false) });
    },
    { dependencies: [open, shown] },
  );

  if (!shown) return null;

  const fire = (c: Command | undefined) => {
    if (!c) return;
    if (c.destructive && confirmId !== c.id) {
      setConfirmId(c.id);
      return;
    }
    onRun(c);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, ranked.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      fire(ranked[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmdk-scrim" ref={scrimRef} onClick={onClose}>
      <div
        className="cmdk"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmdk__input">
          <svg
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="M13.5 13.5 L17 17" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a command…"
            aria-label="Command"
          />
          <span className="cmdk__tag">live-sourced</span>
        </div>

        <div className="cmdk__list" role="listbox" aria-label="Commands">
          {ranked.length === 0 ? (
            <div className="cmdk__empty">No commands match.</div>
          ) : (
            ranked.map((c, i) => {
              const confirming = confirmId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`cmdk__item${i === sel ? " sel" : ""}`}
                  role="option"
                  aria-selected={i === sel}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => fire(c)}
                >
                  <span className="cmdk__title">
                    {c.title}
                    {confirming && (
                      <span className="cmdk__arm">— press again to confirm</span>
                    )}
                    {c.destructive && <span className="cmdk__danger">live</span>}
                  </span>
                  <span className="cmdk__group">{c.group}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="cmdk__foot">
          can&apos;t suggest a command that would fail · ↑↓ move · ↵ run · esc close
        </div>
      </div>
    </div>
  );
}
