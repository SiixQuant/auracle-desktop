// Coachmark — the one-time "learn the anatomy" overlay for the Standby home.
//
// Design authority: launcher-redesign-direction.md §3.6 ("Coachmark") — "three
// sequential hairline callouts that point at the real bands — instrument →
// verb → ledger — each a small mono card with a connecting hairline; 'Got it'
// completes. Fixed band layout makes anchoring deterministic (no measurement
// gymnastics)." Slice 7 of the redesign.
//
// It is gated on localStorage so it shows once on first contact and is
// replayable from the palette ("Show home tips"). Dismiss persists; replay does
// not re-arm the auto-show. Those semantics are untouched by this slice.
//
// The anchoring: this overlay repeats `.standby`'s own layout, so each callout
// sits over the thing it is talking about without measuring anything — which
// is the deterministic anchoring §3.6 is describing. It renders INSIDE the
// standby stage (the Shell) for the same reason the tray does: the parts it
// annotates are in there, and a window-level overlay would have to subtract the
// chrome by hand to line up with them.
//
// THE COPY. A tour that describes a part that no longer exists is worse than no
// tour, so the beats are rewritten every time the home is. The ledger beat went
// with the ledger: there are two things on this home now — the instrument and
// the verb — and everything the third beat used to point at is one door away,
// which is what the verb's beat says instead.

const COACH_KEY = "auracle_standby_coach_seen";

/** True when the coachmark has already been dismissed (or storage is
 *  unavailable — in which case we don't nag). */
export function coachSeen(): boolean {
  try {
    return !!localStorage.getItem(COACH_KEY);
  } catch {
    return true;
  }
}

/** The beats, in the home's own order. `band` names the region each one is
 *  anchored in; `link` is which way its connecting hairline runs to reach the
 *  thing it is pointing at. */
const BEATS = [
  {
    band: "instrument",
    label: "01 · the instrument",
    link: "across",
    body: "Your one status, drawn as the mark: a body on the ring for each container that really reported. It turns while the stack is healthy, goes off-tempo when a service degrades, and stands still on a dashed ring when the engine is down. Press it for Status.",
  },
  {
    band: "verb",
    label: "02 · the verb",
    link: "across",
    body: "One button, and it is always your next move — start the engine, then open your workspace. The line above it says the same state in words, and a line below it appears only when something needs you. Everything else — containers, versions, what's new, help — is behind Status; ⌘K reaches the rest.",
  },
] as const;

export default function Coachmark({ onClose }: { onClose: () => void }) {
  const done = () => {
    try {
      localStorage.setItem(COACH_KEY, "1");
    } catch {
      // storage unavailable — the in-session dismissal still applies
    }
    onClose();
  };

  return (
    <div className="coach-scrim" onClick={done}>
      <div
        className="coach"
        role="dialog"
        aria-modal="true"
        aria-label="Home tips"
        onClick={(e) => e.stopPropagation()}
      >
        {BEATS.map((beat, i) => (
          <div
            key={beat.band}
            className={`coach__callout coach__callout--${beat.band}`}
          >
            <div className="coach__card">
              <span className="coach__label">{beat.label}</span>
              <p className="coach__text">{beat.body}</p>
              {i === BEATS.length - 1 && (
                <button type="button" className="coach__done" onClick={done}>
                  Got it
                </button>
              )}
            </div>
            <span
              className={`coach__link coach__link--${beat.link}`}
              aria-hidden="true"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
