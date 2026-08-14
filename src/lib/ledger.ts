// ledger.ts — the version truth ladder, as a pure value.
//
// This module was Band 3 of the home: one mono row that merged the engine
// vital, the version cell and two destinations —
//
//     engine Healthy · v0.8.37 · What's new · Help
//
// The row is gone. A launcher in the gaming mould keeps its stage clear, so
// every reading it carried moved into the Status inspector, where the
// components that already own those readings render them
// (`components/StatusInspector.tsx`): the engine vital and the container
// console are Supervision's, "What's new" is the Changelog's, "Help" is the
// FAQ + Support pair's.
//
// What has no other owner — and is the one piece of real logic the band ever
// held — is the version cell's truth ladder, so that is what stayed here, in
// the pure half, where it is a test rather than a promise:
//
//   THE LADDER NEVER SKIPS A RUNG. "Up to date" is a CLAIM, and the launcher
//   may only make it once the update probe has actually answered. Until then
//   the cell says what it really knows: the installed version, or just the
//   product name if even that hasn't loaded.
//
// `waiting` survives the move as the rung's own marker. It no longer drives an
// underline sweep — the ladder is a reading now, not a door — but it is still
// the one rung on which an update genuinely exists, and the difference between
// "an update is published" and "we have not asked yet" is exactly the honesty
// this module exists to keep.

import type { UpdateInfo } from "./tauri.ts";

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
  /** True exactly on the `update` rung: a published update really exists. */
  waiting: boolean;
}

/** What the cell says when nothing has answered yet. Not "Up to date", not a
 *  version, not an empty string — the product's name is the only thing we can
 *  stand behind before the first probe returns. */
export const UNKNOWN_VERSION_LABEL = "Auracle";

/** The version/update cell — the ladder, in one place.
 *
 *  Reproduced verbatim from the footer, and then the band, that this cell has
 *  outlived, because it was already right: the launcher never claims to be
 *  current until the check has come back. */
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
    };
  }
  if (update) {
    return { rung: "current", label: `Up to date${ver}`, waiting: false };
  }
  if (version) {
    return { rung: "version", label: `v${version}`, waiting: false };
  }
  return { rung: "unknown", label: UNKNOWN_VERSION_LABEL, waiting: false };
}
