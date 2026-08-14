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
// title bar, so this band is what you drag it by; the capsule's own buttons sit
// inside the band and keep their clicks, because only the element carrying
// `data-tauri-drag-region` starts a drag.

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
    <header className="pill-bar" data-tauri-drag-region>
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
