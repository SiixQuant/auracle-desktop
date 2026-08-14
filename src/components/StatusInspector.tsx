// StatusInspector — the launcher's one information surface.
//
// The home used to carry a mono ledger along its floor: the engine vital, the
// version truth ladder, "What's new", "Help". A launcher in the gaming mould
// carries none of that on the stage — the stage is art, one sentence and one
// verb — so all four readings moved in here, behind the pill's ENGINE.
//
// This is a RE-HOME, not a rewrite. Every block below is the component that
// already owned that reading:
//
//   · the instrument's still echo + the stack verbs + the per-container
//     console  →  SupervisionInspector (unchanged)
//   · the four-rung version ladder                →  lib/ledger.ts (pure, tested)
//   · What's new                                  →  ChangelogInspector
//   · Help                                        →  FaqInspector + SupportInspector
//
// The one thing that did NOT come with the ledger is its update door. Auracle
// installs its own updates (src-tauri/src/commands/scheduled_update.rs), so the
// ladder reads here and offers nothing to press — a reading, not a control.

import {
  ChangelogInspector,
  FaqInspector,
  SupportInspector,
} from "@/components/HubSurfaces";
import SupervisionInspector from "@/components/SupervisionInspector";
import type { OrreryFrame } from "@/fx/orrery";
import { versionCell } from "@/lib/ledger";
import type { UpdateInfo } from "@/lib/tauri";

export default function StatusInspector({
  instrument,
  update,
  version,
}: {
  /** The home's own instrument frame, for Supervision's echo. */
  instrument?: OrreryFrame;
  /** The launcher self-update probe, as `useEngineState` last read it. */
  update?: UpdateInfo | null;
  /** The installed launcher version. */
  version?: string | null;
}) {
  return (
    <>
      <SupervisionInspector instrument={instrument} />
      <VersionCard update={update} version={version} />
      <ChangelogInspector />
      <FaqInspector />
      <SupportInspector />
    </>
  );
}

/** The version truth ladder, read-only.
 *
 *  `versionCell` is the same pure ladder the ledger used, with the same law:
 *  it may not claim "Up to date" until the probe has actually answered, so the
 *  rungs below it — the installed version, or just the product's name — are
 *  what the card says until then. */
function VersionCard({
  update,
  version,
}: {
  update?: UpdateInfo | null;
  version?: string | null;
}) {
  const cell = versionCell(update, version);
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Version</span>
      </div>
      <div className="row">
        <span className="key-label">launcher</span>
        <span className="mono fs-sm">{cell.label}</span>
      </div>
      <p className="muted fs-xs mt-2 m-0 lh-relaxed">
        Updates install themselves: the launcher checks once a week and
        restarts on the new version. There is nothing to press.
      </p>
    </div>
  );
}
