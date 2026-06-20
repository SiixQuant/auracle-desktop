// CommandPalette — ⌘K over the Standby home.
//
// Fuzzy-runs every action and destination. Destructive verbs (restart a
// container) take a double-Enter / double-click confirm so the hands stay
// on the keyboard without an accidental fire. The result is always one of
// the commands it was given — it can never suggest something that would
// fail. Running a command echoes its verb (echo-to-teach, in the Shell).

import { useEffect, useMemo, useRef, useState } from "react";

import { rankCommands, type Command } from "@/lib/commands";

export default function CommandPalette({
  commands,
  onClose,
  onRun,
}: {
  commands: Command[];
  onClose: () => void;
  onRun: (c: Command) => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ranked = useMemo(() => rankCommands(commands, query), [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setSel(0);
    setConfirmId(null);
  }, [query]);

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
    <div className="cmdk-scrim" onClick={onClose}>
      <div
        className="cmdk"
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
                    {confirming ? `${c.title} — press again to confirm` : c.title}
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
