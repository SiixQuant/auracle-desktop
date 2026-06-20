// Coachmark — the one-time "learn the anatomy" overlay for the Standby
// home. Three beats (lamp / button / vitals), gated on localStorage so it
// shows once on first contact and is replayable from the palette ("Show
// home tips"). Dismiss persists; replay does not re-arm the auto-show.

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
        <h3>Your desk, at a glance</h3>
        <div className="coach__beat">
          <span className="coach__n">1</span>
          <div>
            The lamp is your one status — calm green means ready, red means something
            needs you.
          </div>
        </div>
        <div className="coach__beat">
          <span className="coach__n">2</span>
          <div>
            The button is always your next move — launch, start the engine, or connect a
            broker.
          </div>
        </div>
        <div className="coach__beat">
          <span className="coach__n">3</span>
          <div>
            Press a vital (or ⌘K) to go deeper — connections, supervision, account.
          </div>
        </div>
        <button type="button" className="coach__done" onClick={done}>
          Got it
        </button>
      </div>
    </div>
  );
}
