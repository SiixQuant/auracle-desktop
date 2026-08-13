// ledger.ts — the home's third band, as a pure value.
//
// Design authority: launcher-redesign-direction.md §1 (the chamber sketch) and
// §3.3 ("Band 3 — The Ledger"). Slice 5 of the redesign.
//
// The ledger is one mono row that merges what used to be two rows and a footer:
//
//     engine Healthy · v0.8.37 · What's new · Help
//
// This module is the PURE half of it — the same split slices 3 and 4 used for
// the ambient stage and the instrument. It decides WHAT each cell says; the
// component decides how it is inked. The split exists so the one piece of real
// logic in the band — the version cell's truth ladder — is a test rather than a
// promise.
//
// The three laws it encodes:
//
//   1. THE LADDER NEVER SKIPS A RUNG. "Up to date" is a CLAIM, and the launcher
//      may only make it once the update probe has actually answered. Until then
//      the cell says what it really knows: the installed version, or just the
//      product name if even that hasn't loaded. `waiting` is likewise true only
//      on the rung where an update genuinely exists — the one-time underline
//      sweep is a fact about the machine, not a decoration.
//
//   2. NOTHING IS RE-DERIVED. The engine cell is the aggregator's own `Vital`,
//      folded into the row: same value, same dot, same freshness, same
//      provenance, same door. This slice re-skins truth; `aggregator.ts` stays
//      untouched, and a stale reading still refuses to quote a value it can no
//      longer stand behind.
//
//   3. EVERY STATE KEEPS A FULL ROW. All six rungs of the aggregator's ladder
//      (checking / starting / down / degraded / needsSetup / ready) produce the
//      same four cells. The ledger never empties out, because "we don't know"
//      is itself something the row has to say.

import type { BoardState, DotTone, Vital } from "./aggregator.ts";
import type { UpdateInfo } from "./tauri.ts";

/** Which inspector a ledger cell opens. A string union rather than the
 *  component's `InspectorKey` so this module stays free of anything React. */
export type LedgerTarget = "supervision" | "updates" | "changelog" | "help";

/** The rungs of the version cell's truth ladder, brightest first. */
export type VersionRung =
  /** An update is published and newer than what's installed. */
  | "update"
  /** The probe answered and we are current. */
  | "current"
  /** No answer yet, but we know which version is installed. */
  | "version"
  /** Nothing has loaded — the cell says only what the product is called. */
  | "unknown";

export interface VersionCell {
  rung: VersionRung;
  label: string;
  /** True exactly on the `update` rung: the cell reads bright and takes the
   *  one-time underline sweep (§2.4 — once, never a loop). */
  waiting: boolean;
  target: "updates";
}

/** The engine vital, as a ledger cell. */
export interface VitalCell {
  key: Vital["key"];
  /** The mono-label key, e.g. `engine`. */
  label: string;
  /** What the cell reads — the vital's value, or "stale" when the reading is
   *  too old to stand behind. */
  value: string;
  dot: DotTone;
  stale: boolean;
  /** One-line provenance for the interrogable hover/focus. */
  provenance?: string;
  /** The inspector this cell opens, or null when the vital has no door. */
  target: Extract<LedgerTarget, "supervision"> | null;
}

/** A plain destination cell — no state, just a door. */
export interface LinkCell {
  label: string;
  target: Extract<LedgerTarget, "changelog" | "help">;
}

export interface Ledger {
  /** One cell per vital the board reports, in the board's own order. */
  vitals: VitalCell[];
  version: VersionCell;
  links: LinkCell[];
}

/** The row's fixed tail (§3.3). Static because these two are destinations, not
 *  readings — there is no state in which the launcher can't offer them. */
export const LEDGER_LINKS: readonly LinkCell[] = [
  { label: "What’s new", target: "changelog" },
  { label: "Help", target: "help" },
] as const;

/** What the cell says when nothing has answered yet. Not "Up to date", not a
 *  version, not an empty string — the product's name is the only thing we can
 *  stand behind before the first probe returns. */
export const UNKNOWN_VERSION_LABEL = "Auracle";

/** The version/update cell — the ladder, in one place.
 *
 *  Reproduced verbatim from the footer this band replaces, because it was
 *  already right: the launcher never claims to be current until the check has
 *  come back. Moving it here is what makes that claim testable. */
export function versionCell(
  update: UpdateInfo | null | undefined,
  version: string | null | undefined,
): VersionCell {
  const ver = version ? ` · v${version}` : "";
  if (update?.available) {
    return {
      rung: "update",
      label: `Update available${update.version ? ` · v${update.version}` : ""}`,
      waiting: true,
      target: "updates",
    };
  }
  if (update) {
    return { rung: "current", label: `Up to date${ver}`, waiting: false, target: "updates" };
  }
  if (version) {
    return { rung: "version", label: `v${version}`, waiting: false, target: "updates" };
  }
  return {
    rung: "unknown",
    label: UNKNOWN_VERSION_LABEL,
    waiting: false,
    target: "updates",
  };
}

/** One of the board's vitals, folded into the row. A stale reading shows the
 *  word "stale" rather than a number it can no longer vouch for — the freshness
 *  rule the vitals row carried, kept intact by the merge. */
export function vitalCell(v: Vital): VitalCell {
  const stale = v.freshness === "stale";
  return {
    key: v.key,
    label: v.label,
    value: stale ? "stale" : v.value,
    dot: v.dot,
    stale,
    provenance: v.provenance,
    target: v.door,
  };
}

/** The whole band: board + update truth → the four cells of §3.3. */
export function buildLedger(
  board: BoardState,
  update: UpdateInfo | null | undefined,
  version: string | null | undefined,
): Ledger {
  return {
    vitals: board.vitals.map(vitalCell),
    version: versionCell(update, version),
    links: [...LEDGER_LINKS],
  };
}
