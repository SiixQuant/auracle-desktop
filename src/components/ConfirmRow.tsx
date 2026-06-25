// ConfirmRow — the in-surface destructive-action confirm.
//
// Native confirm()/alert() are banned in the launcher: Tauri's
// WKWebView can suppress them entirely, turning the guard into a
// silent no-op (loop memory M5). This is the one sanctioned pattern:
// a quiet ghost-danger trigger that swaps to a full-width banner row
// naming the consequences, with an explicit Confirm + Cancel.
//
// The armed flag is component state, so parent polling re-renders
// can't drop it. Inside a .wrap-row the armed banner wraps onto its
// own full-width line (flex-basis 100%).

import { useState } from "react";

export default function ConfirmRow({
  trigger,
  title,
  body,
  confirmLabel = "Confirm",
  busy = false,
  compact = false,
  onConfirm,
}: {
  /** Text on the quiet trigger button (e.g. "Uninstall", "Clear"). */
  trigger: string;
  /** Bolded question naming the action (e.g. "Clear license?"). */
  title: string;
  /** Consequence sentence shown beside the title. */
  body: string;
  confirmLabel?: string;
  busy?: boolean;
  /** Compact trigger for dense action rows (.fs-xs). */
  compact?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        className={`ghost danger${compact ? " fs-xs" : ""}`}
        disabled={busy}
        onClick={() => setArmed(true)}
      >
        {trigger}
      </button>
    );
  }
  return (
    <div className="banner err hstack m-0" style={{ flexBasis: "100%" }}>
      <span style={{ flex: 1 }}>
        <strong>{title}</strong> {body}
      </span>
      <button
        type="button"
        className="ghost danger btn-sm"
        disabled={busy}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="ghost btn-sm" onClick={() => setArmed(false)}>
        Cancel
      </button>
    </div>
  );
}
