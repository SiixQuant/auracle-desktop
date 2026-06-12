// IncidentCard — the one shape for "something is wrong".
//
// Five surfaces used to hand-roll incident renderings (a bespoke
// conflict banner, chip+string rows, bare muted text, silent omission).
// This is the shared contract: severity chip, a named cause in plain
// words, at most ONE action, optional muted detail, an optional
// children slot for consequence notes or log tails. Built entirely
// from existing primitives (.banner, .chip, .hstack, type utilities)
// — zero new CSS.
//
// Honesty rules baked in: no action prop means no button (a disabled
// button for an OS action the launcher cannot invoke would be a lie);
// action failures render inside the card, below context, as the last
// element.

import { useState } from "react";

export default function IncidentCard({
  severity,
  cause,
  detail,
  action,
  children,
}: {
  severity: "warn" | "err";
  /** Plain-sentence statement of what is wrong. This IS the title. */
  cause: string;
  /** One short muted line under the cause (guidance, identifiers). */
  detail?: string;
  /** At most one action. `primary` marks it as the recommended path
   *  (.primary styling); default is a quiet ghost button. `busy`
   *  lets the caller drive label swaps through its own state. */
  action?: {
    label: string;
    onClick: () => void | Promise<void>;
    busy?: boolean;
    primary?: boolean;
  };
  children?: React.ReactNode;
}) {
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async () => {
    if (!action) return;
    setActionError(null);
    try {
      await action.onClick();
    } catch (err) {
      setActionError(String(err));
    }
  };

  return (
    <div className={`banner ${severity}`}>
      <div className="hstack">
        <span className={`chip ${severity}`}>{severity}</span>
        <span style={{ flex: 1 }}>{cause}</span>
        {action && (
          <button
            type="button"
            className={action.primary ? "primary fs-xs" : "ghost btn-sm"}
            disabled={action.busy}
            onClick={() => {
              void run();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
      {detail && <div className="mt-2 muted fs-2xs">{detail}</div>}
      {children}
      {actionError && (
        <div className="mono err-text mt-2">{actionError}</div>
      )}
    </div>
  );
}
