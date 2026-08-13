// InspectorHost — the tray. The back of the instrument.
//
// Design authority: launcher-redesign-direction.md §1 (depth surfaces are
// "machined parts of the same instrument: opaque charcoal planes, hairline
// edges, no glass, no glow") and §3.4 ("The Tray — inspectors"). Slice 6 of
// the redesign.
//
// "The Standby" home shows only status + the next move. Everything denser lives
// one calm layer deep: pressing a status (status-is-the-door), a ledger cell,
// or the top-bar gear slides a full-height right tray OVER a dimmed-but-still-
// live home. The home keeps polling behind it (the engine read is shared, owned
// by the Shell), so finishing a flow shows the instrument turn the moment the
// engine confirms. Esc / scrim-click closes; one tray at a time, no stacking.
// The inspectors RE-HOST the existing control-plane cards verbatim — a re-host,
// not a rewrite, and this slice re-skins them, it does not re-derive them.
//
// What slice 6 changed here, and nothing else:
//   · the floating centred card became a docked tray (§3.4's geometry) that
//     enters on a mechanical slide and LEAVES on one too — which is why `open`
//     is mirrored into local state: the panel has to outlive the close it was
//     asked for in order to animate it. Every external semantic is unchanged;
//     `onClose` still fires the instant it is asked for.
//   · the ✕ glyph became an `esc` keycap (§3.4) — same button, same handler,
//     same label, now naming the key that does the same thing.
//   · Supervision leads with the instrument (§3.4), handed the SAME frame the
//     home is drawing rather than deriving a second one.
//
// Connections (brokers / data sources) moved to the IDE — there is no
// connections or account inspector here. The tray keeps engine supervision,
// the agent + system settings, and the Updates/Changelog/FAQ/Support surfaces.

import { useEffect, useRef, useState } from "react";

import LifecycleInspector from "@/components/LifecycleInspector";
import PairPhoneInspector from "@/components/PairPhoneInspector";
import SupervisionInspector from "@/components/SupervisionInspector";
import {
  ChangelogInspector,
  FaqInspector,
  SupportInspector,
} from "@/components/HubSurfaces";
import { DUR, EASE, enter, exit, gsap, useGSAP } from "@/fx/motion";
import type { OrreryFrame } from "@/fx/orrery";
import {
  AdvancedDrawer,
  GeneralCard,
  GithubCard,
  IntelligenceCard,
  LicenseCard,
  UpdatesInspector,
} from "@/views/Settings";

export type InspectorKey =
  | "supervision"
  | "intelligence"
  | "system"
  | "updates"
  | "changelog"
  | "help"
  | "lifecycle"
  | "pair";

const TITLES: Record<InspectorKey, string> = {
  supervision: "Supervision",
  intelligence: "Intelligence",
  system: "System",
  updates: "Updates",
  changelog: "Changelog",
  help: "Help",
  lifecycle: "Strategy lifecycle",
  pair: "Pair a phone",
};

/** How far the tray sits off its dock before it slides in (§3.4: "x +16→0 +
 *  opacity, 240ms aur-mech"). Small on purpose: this is a part seating itself,
 *  not a panel flying in from off-screen. */
const DOCK_OFFSET = 16;

export default function InspectorHost({
  open,
  instrument,
  onClose,
}: {
  open: InspectorKey | null;
  /** The home's own instrument frame, for Supervision's echo. Passed down
   *  rather than re-derived so the miniature and the board can never disagree
   *  about what the stack is doing. */
  instrument?: OrreryFrame;
  onClose: () => void;
}) {
  // What is actually in the DOM: whatever is open, plus a tray that has been
  // asked to close and is still sliding out. `open` remains the authority —
  // this only lets the exit finish.
  const [shown, setShown] = useState<InspectorKey | null>(open);
  const scrimRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) setShown(open);
  }, [open]);

  // Esc closes — keyboard-first, never a modal that traps you.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // The mechanical move (§3.4). Both directions run through the house helpers,
  // so both collapse to zero under `prefers-reduced-motion` — and a zero-length
  // tween still RUNS (fx/motion.ts), which is what keeps the unmount below
  // gated on `onComplete` safe: the tray cannot be stranded half-open.
  useGSAP(
    () => {
      const tray = trayRef.current;
      const scrim = scrimRef.current;
      if (!tray || !scrim) return;
      // A close can be countermanded mid-slide (Esc, then the hotkey again),
      // so never let two moves fight over the same panel: drop whatever is in
      // flight before starting the next one.
      gsap.killTweensOf([tray, scrim]);
      if (open) {
        // …and start the entrance from the resting state, so `from` records
        // the dock as its destination rather than wherever an interrupted
        // exit had got to.
        gsap.set([tray, scrim], { clearProps: "opacity,transform" });
        enter(tray, { x: DOCK_OFFSET, duration: DUR.enter, ease: EASE.mech });
        enter(scrim, { duration: DUR.scrim });
        return;
      }
      exit(tray, { x: DOCK_OFFSET, duration: DUR.exit });
      exit(scrim, { duration: DUR.exit, onComplete: () => setShown(null) });
    },
    { dependencies: [open, shown] },
  );

  if (!shown) return null;

  return (
    <>
      <div className="insp-scrim" ref={scrimRef} onClick={onClose} aria-hidden="true" />
      <div className="insp-stage">
        <aside
          className="insp"
          ref={trayRef}
          role="dialog"
          aria-modal="true"
          aria-label={TITLES[shown]}
        >
          <div className="insp__head">
            <h2 className="insp__title">{TITLES[shown]}</h2>
            <button
              type="button"
              className="insp__esc"
              onClick={onClose}
              aria-label="Close"
            >
              esc
            </button>
          </div>
          <div className="insp__body">
            <InspectorBody which={shown} instrument={instrument} />
          </div>
        </aside>
      </div>
    </>
  );
}

function InspectorBody({
  which,
  instrument,
}: {
  which: InspectorKey;
  instrument?: OrreryFrame;
}) {
  switch (which) {
    case "supervision":
      return <SupervisionInspector instrument={instrument} />;
    case "lifecycle":
      return <LifecycleInspector />;
    case "pair":
      // Phone pairing (Auracle iOS spine, M5) — palette-reachable while
      // the iOS app is pre-release.
      return <PairPhoneInspector />;
    case "intelligence":
      return <IntelligenceCard />;
    case "updates":
      // The hub's update home — one "Update Auracle" action that brings the
      // whole stack (engine, IDE, launcher) current in a single pass.
      return <UpdatesInspector />;
    case "changelog":
      return <ChangelogInspector />;
    case "help":
      // FAQ + Support merged into one Help surface — one fewer popup.
      return (
        <>
          <FaqInspector />
          <SupportInspector />
        </>
      );
    case "system":
      // Settings only — all update controls now live in the Updates surface.
      return (
        <>
          <LicenseCard />
          <GeneralCard />
          <GithubCard />
          <AdvancedDrawer />
        </>
      );
  }
}
