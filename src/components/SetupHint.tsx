// SetupHint — the actionable "you have no owner account yet" affordance.
//
// Every owner-gated launcher action (save an AI key, load prefs, connect a
// broker) fails with the same engine signal when first-run setup hasn't
// been done: there's no owner account, so the on-box key handoff returns
// nothing. Rather than a dead-end red error, point the user at the engine's
// first-run wizard (license activation → create your account), which stays
// reachable even in the headless web profile.

import { openEngineSetup } from "@/lib/tauri";

export default function SetupHint({ compact }: { compact?: boolean }) {
  return (
    <div className={`setup-hint${compact ? " is-compact" : ""}`}>
      {!compact && (
        <span className="setup-hint__msg">
          No account yet — finish first-run setup (activate your license, then
          create your account) before this works.
        </span>
      )}
      <button
        type="button"
        className="setup-hint__btn"
        onClick={() => void openEngineSetup()}
      >
        Finish setup →
      </button>
    </div>
  );
}
