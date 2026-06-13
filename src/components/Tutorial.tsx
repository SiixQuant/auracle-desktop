// Tutorial — a short, dismissible first-run walkthrough.
//
// Four steps, no jargon. Shown once after install (gated on a
// localStorage flag in App), and re-openable any time from Help.
// Pure presentational overlay; Skip and Done both call onClose.

import { useState } from "react";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Welcome to Auracle",
    body: "This launcher starts your local engine and opens the Auracle IDE — your quant workspace for taking an idea from research to live.",
  },
  {
    title: "One button: Launch",
    body: "Press Launch on the home screen. It opens the IDE already connected to your engine — no keys to copy, nothing to configure.",
  },
  {
    title: "Your account, at a glance",
    body: "Home shows your unrealized P&L, exposure, and data feed read live from your broker. Each number is stamped with when it was last updated, and turns amber if it goes stale.",
  },
  {
    title: "Settings & help",
    body: "Connect your broker, manage your license, and control the engine in Settings. You can reopen this tour any time from Help.",
  },
];

export default function Tutorial({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  const last = i === STEPS.length - 1;
  const step = STEPS[i];

  return (
    <div className="tut-overlay" role="dialog" aria-modal="true" aria-label="Getting started">
      <div className="tut-card">
        <div className="tut-step-label">
          Step {i + 1} of {STEPS.length}
        </div>
        <div className="tut-title">{step.title}</div>
        <p className="tut-body">{step.body}</p>
        <div className="tut-foot">
          <div className="tut-dots" aria-hidden="true">
            {STEPS.map((_, n) => (
              <span key={n} className={`tut-dot${n === i ? " on" : ""}`} />
            ))}
          </div>
          <div className="hstack">
            <button type="button" className="ghost btn-sm" onClick={onClose}>
              {last ? "Close" : "Skip"}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => (last ? onClose() : setI(i + 1))}
            >
              {last ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
