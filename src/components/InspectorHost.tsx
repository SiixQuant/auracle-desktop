// InspectorHost — the drill-don't-traverse depth layer.
//
// "The Standby" home shows only status + the next move. Everything denser
// lives one calm layer deep: pressing a status (status-is-the-door), a hub
// card, or the top-bar gear/agent slides a right-docked inspector OVER a
// dimmed-but-still-live home. The home keeps polling behind the sheet (the
// engine read is shared, owned by the Shell), so finishing a flow shows the
// lamp flip the instant the engine confirms. Esc / scrim-click closes; one
// inspector open at a time (no stacking). The inspectors RE-HOST the
// existing control-plane cards verbatim — a re-host, not a rewrite.
//
// Connections (brokers / data sources) moved to the IDE — there is no
// connections or account inspector here. The hub keeps engine supervision,
// the agent + system settings, and the Updates/Changelog/FAQ/Support
// surfaces.

import { useEffect } from "react";

import LifecycleInspector from "@/components/LifecycleInspector";
import SupervisionInspector from "@/components/SupervisionInspector";
import {
  ChangelogInspector,
  FaqInspector,
  SupportInspector,
} from "@/components/HubSurfaces";
import {
  AdvancedDrawer,
  GeneralCard,
  GithubCard,
  IdeUpdateCard,
  IntelligenceCard,
  LicenseCard,
  SystemCard,
} from "@/views/Settings";

export type InspectorKey =
  | "supervision"
  | "intelligence"
  | "system"
  | "updates"
  | "changelog"
  | "faq"
  | "support"
  | "lifecycle";

const TITLES: Record<InspectorKey, string> = {
  supervision: "Supervision",
  intelligence: "Intelligence",
  system: "System",
  updates: "Updates",
  changelog: "Changelog",
  faq: "FAQ",
  support: "Support",
  lifecycle: "Strategy lifecycle",
};

export default function InspectorHost({
  open,
  onClose,
}: {
  open: InspectorKey | null;
  onClose: () => void;
}) {
  // Esc closes — keyboard-first, never a modal that traps you.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="insp-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="insp" role="dialog" aria-modal="true" aria-label={TITLES[open]}>
        <div className="insp__head">
          <h2 className="insp__title">{TITLES[open]}</h2>
          <button type="button" className="insp__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="insp__body">
          <InspectorBody which={open} />
        </div>
      </aside>
    </>
  );
}

function InspectorBody({ which }: { which: InspectorKey }) {
  switch (which) {
    case "supervision":
      return <SupervisionInspector />;
    case "lifecycle":
      return <LifecycleInspector />;
    case "intelligence":
      return <IntelligenceCard />;
    case "updates":
      // The hub's update home — reuses the launcher's existing update
      // mechanism: the launcher self-update (SystemCard) + the
      // launcher-managed Auracle IDE update (IdeUpdateCard).
      return (
        <>
          <SystemCard />
          <IdeUpdateCard />
        </>
      );
    case "changelog":
      return <ChangelogInspector />;
    case "faq":
      return <FaqInspector />;
    case "support":
      return <SupportInspector />;
    case "system":
      return (
        <>
          <LicenseCard />
          <GeneralCard />
          <GithubCard />
          <SystemCard />
          <IdeUpdateCard />
          <AdvancedDrawer />
        </>
      );
  }
}
