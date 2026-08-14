// NavPill — the launcher's whole navigation, in one capsule.
//
// The site's menu grammar, launcher-sized: a black capsule floating top-centre
// on the cream ground, dotted hairline, mono uppercase. It carries FOUR things
// and may never carry a fifth —
//
//     ◐  ENGINE   SETTINGS                              ggonzalez
//
//   · the mark, small and white — the launcher saying its own name;
//   · ENGINE   → Status: the engine's vitals, its containers, the version
//                ladder, what's new, help;
//   · SETTINGS → the settings surface;
//   · the account chip, right-aligned — the signed-in email's local part, or
//     the name of the door when there is no email to show (`lib/identity.ts`).
//
// Everything else in the product is reached from inside those two surfaces or
// from ⌘K. That is the reduction: the chrome used to carry a wordmark, a search
// button and a gear, and the home under it carried a ledger of six more doors.
// There is no manual update control here, or anywhere — Auracle updates itself.
//
// It is also the window's drag strip. The window runs with macOS's overlay
// title bar, so this band — capsule included — is what you drag it by.
//
// The region is `deep`, which is Tauri's own word for "anything in this subtree
// drags". With the bare attribute only a direct hit on the band itself counted,
// which made the capsule — the one thing up here you would actually reach for —
// a dead zone, and at the 600px minimum width left almost nothing to grab but
// the corner the traffic lights already own. The buttons keep their clicks
// either way: Tauri stops walking the moment it meets a clickable element, so a
// button never starts a drag.

import { AuracleGlyph } from "@/components/AuracleGlyph";
import type { InspectorKey } from "@/components/InspectorHost";
import { accountChipLabel } from "@/lib/identity";
import type { AccountSession } from "@/lib/tauri";

export default function NavPill({
  account,
  onOpen,
}: {
  /** The engine's shared session, as the Shell last read it. Undefined while
   *  the probe is still out — the chip names its door until then rather than
   *  flickering an identity into place. */
  account?: AccountSession | null;
  onOpen: (key: InspectorKey) => void;
}) {
  const chip = accountChipLabel(account);

  return (
    <header className="pill-bar" data-tauri-drag-region="deep">
      <nav className="pill" aria-label="Main">
        <AuracleGlyph className="pill__mark" />
        <button type="button" className="pill__item" onClick={() => onOpen("status")}>
          Engine
        </button>
        <button type="button" className="pill__item" onClick={() => onOpen("system")}>
          Settings
        </button>
        <button
          type="button"
          className="pill__account"
          onClick={() => onOpen("account")}
          aria-label={`Account — ${chip}`}
        >
          {chip}
        </button>
      </nav>
    </header>
  );
}
