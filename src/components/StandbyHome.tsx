// StandbyHome — the launcher home, as three bands on one charcoal chamber.
//
// Design authority: launcher-redesign-direction.md §1 (the chamber sketch) and
// §3.3 ("Home — The Orrery"). Slice 5 of the redesign.
//
//     ┌──────────────────────────────────────────────┐
//     │                THE INSTRUMENT                │  ~55% of the stage
//     │            Everything's ready.               │  THE VERDICT (serif)
//     │              [ Open workspace ]              │  one Nous-blue verb
//     │ engine Healthy · v0.8.37 · What's new · Help │  THE LEDGER (mono)
//     └──────────────────────────────────────────────┘
//
// What changed in this slice: the stacked rows under the verb — a footer of
// links, a re-run escape, and a separate vitals row — became ONE mono ledger
// pinned to the bottom band. Nothing was dropped in the merge: the engine
// vital kept its dot, its value, its freshness, its provenance and its door,
// and the update cell kept the exact truth ladder (it still refuses to say
// "Up to date" until the probe has answered). The three rows the merge
// reclaimed are what let the instrument reach the ~55% band §3.9 asks for.
//
// The composition is still a pure derivation of one engine snapshot: the
// verdict, the verb and the instrument come from `deriveBoard`, and the row
// from `buildLedger`. This file holds the ink and the three tweens; the
// decisions live in `lib/aggregator.ts` (untouched) and `lib/ledger.ts`.

import { Fragment, useRef } from "react";

import IncidentCard from "@/components/IncidentCard";
import Orrery from "@/components/Orrery";
import { DUR, EASE, gsap, mech, revealWords, useGSAP } from "@/fx/motion";
import { frameFor } from "@/fx/orrery";
import { deriveBoard, type ActuatorState, type Door } from "@/lib/aggregator";
import {
  buildLedger,
  type LinkCell,
  type VersionCell,
  type VitalCell,
} from "@/lib/ledger";
import type { ContainerStatus } from "@/lib/tauri";
import type { EngineStateHook } from "@/lib/useEngineState";
import type { InspectorKey } from "@/components/InspectorHost";

export default function StandbyHome({
  eng,
  containers,
  onActuator,
  onDoor,
  onCard,
  onRerunSetup,
}: {
  /** Shared live engine read (owned by the Shell, so the home keeps
   *  polling behind an open inspector). */
  eng: EngineStateHook;
  /** The stack as `stackStatus()` last reported it — the ONLY source of the
   *  instrument's bodies. Undefined means "we haven't been told", which the
   *  instrument renders as the mark at rest rather than as an empty machine. */
  containers?: ContainerStatus[];
  /** Run the home's one verb — owned by the Shell so the palette and the
   *  button trigger the same action. */
  onActuator: () => void;
  /** Open an inspector for a pressed status (status-is-the-door). */
  onDoor?: (door: Exclude<Door, null>) => void;
  /** Open one of the ledger's destinations (Updates / Changelog / Help). */
  onCard?: (key: InspectorKey) => void;
  /** Re-run the first-run stack setup (Docker + engine + IDE). */
  onRerunSetup?: () => void;
  /** Retained so the Shell/palette can still reach the agent inspector even
   *  though the home no longer shows an agent chip. */
  onAgent?: () => void;
}) {
  const board = deriveBoard(eng.state);
  const { actuator } = board;
  const ledger = buildLedger(board, eng.update, eng.version);

  // The row, in the sketch's order, with the separators woven in below. Built
  // as one list so a cell can never be dropped by an edit to the markup.
  const cells: { key: string; node: React.ReactNode }[] = [
    ...ledger.vitals.map((cell) => {
      const door = cell.target;
      return {
        key: `vital-${cell.key}`,
        node: (
          <LedgerVital cell={cell} onOpen={door ? () => onDoor?.(door) : undefined} />
        ),
      };
    }),
    {
      key: "version",
      node: <LedgerVersion cell={ledger.version} onOpen={() => onCard?.("updates")} />,
    },
    ...ledger.links.map((link) => ({
      key: link.target,
      node: <LedgerLink link={link} onOpen={() => onCard?.(link.target)} />,
    })),
  ];

  return (
    <div className="standby">
      {/* ── Band 1 — the instrument ───────────────────────────────── */}
      <div className="standby__instrument">
        <Orrery
          frame={frameFor(board, containers ?? [])}
          onOpen={() => onDoor?.("supervision")}
        />
      </div>

      {/* ── Band 2 — the verdict, and the one verb ────────────────── */}
      <div className="standby__verdict-band">
        <Verdict line={board.systemLine} />

        <Actuator actuator={actuator} onClick={onActuator} />

        {(eng.engineErr || eng.ideError) && (
          <div className="standby__err">{eng.engineErr || eng.ideError}</div>
        )}

        {board.lamp === "err" && (
          <div className="standby__incident">
            <IncidentCard
              severity="err"
              cause="The local engine isn't running."
              detail="Start it to continue, or open Supervision to see the stack."
              action={{ label: "Open Supervision", onClick: () => onDoor?.("supervision") }}
            />
          </div>
        )}
      </div>

      {/* ── Band 3 — the ledger ───────────────────────────────────── */}
      <div className="standby__ledger-band">
        <div className="ledger" role="group" aria-label="System ledger">
          {cells.map((cell, i) => (
            <Fragment key={cell.key}>
              {i > 0 && (
                <span className="ledger__sep" aria-hidden="true">
                  ·
                </span>
              )}
              {cell.node}
            </Fragment>
          ))}
        </div>

        {onRerunSetup && (
          <button type="button" className="standby__rerun" onClick={onRerunSetup}>
            Re-run setup
          </button>
        )}
      </div>
    </div>
  );
}

// ── Band 2 — The Verdict ────────────────────────────────────────────

/** The system line, in the display serif, arriving word by word (§2.4).
 *
 *  React owns the text and the `key` retires the whole element on a change, so
 *  the split markup can never outlive the sentence it was made from: the DOM
 *  holds exactly one line, and it is always the one the engine reports.
 *
 *  DELIBERATE DEVIATION from §2.4's "outgoing line 120ms opacity out". Fading
 *  the old line out FIRST means holding the previous sentence in state and
 *  committing the new one from a tween's `onComplete` — and this app sleeps its
 *  GSAP ticker whenever the window is hidden (§4's power law; the launcher is
 *  tray-resident and hidden most of its life). A slept ticker would strand the
 *  verdict on the previous sentence while the verb and the ledger beside it
 *  already read the new state — the home contradicting itself, which is the one
 *  thing this surface may never do. The entrance is ceremony and may wait for a
 *  tick; the sentence is truth and may not. So the line commits immediately and
 *  only its arrival is animated. */
function Verdict({ line }: { line: string }) {
  const ref = useRef<HTMLHeadingElement>(null);

  // `revealWords` returns its own teardown, which useGSAP runs on cleanup —
  // including on the element this key retires.
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      return revealWords(el);
    },
    { dependencies: [line], scope: ref },
  );

  return (
    <h1 key={line} ref={ref} className="standby__verdict">
      {line}
    </h1>
  );
}

// ── Band 2 — the one verb ───────────────────────────────────────────

function Actuator({
  actuator,
  onClick,
}: {
  actuator: ActuatorState;
  onClick: () => void;
}) {
  return (
    <div className="standby__actuator-wrap">
      <button
        type="button"
        className={`standby__actuator${actuator.action === "starting" ? " is-progress" : ""}`}
        onClick={onClick}
        disabled={actuator.disabled}
        title={actuator.reason}
      >
        <span>{actuator.label}</span>
      </button>
      {actuator.reason && actuator.disabled && (
        <div className="standby__act-reason">{actuator.reason}</div>
      )}
    </div>
  );
}

// ── Band 3 — The Ledger ─────────────────────────────────────────────

/** The engine vital, as the row's first cell: status dot, mono key, the
 *  engine's own word, and the provenance behind both (hover or focus it — the
 *  green dot stays auditable, which is what made it worth trusting). */
function LedgerVital({ cell, onOpen }: { cell: VitalCell; onOpen?: () => void }) {
  const body = (
    <>
      <span className={`ledger__dot ${cell.dot}`} aria-hidden="true" />
      <span className="ledger__key">{cell.label}</span>
      <span className="ledger__value">{cell.value}</span>
      {cell.provenance && <span className="ledger__prov">{cell.provenance}</span>}
    </>
  );

  // A vital with no door is not a control. Rendering it as a button that does
  // nothing would be a dead control, which this surface does not have.
  if (!onOpen) {
    return (
      <span className={`ledger__cell is-static${cell.stale ? " is-stale" : ""}`} title={cell.provenance}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`ledger__cell${cell.stale ? " is-stale" : ""}`}
      onClick={onOpen}
      title={cell.provenance}
    >
      {body}
    </button>
  );
}

/** The version / update cell — the truth ladder (`lib/ledger.ts`), inked.
 *
 *  On the one rung where an update is genuinely waiting, the cell goes bright
 *  and a blue underline sweeps out from the left. Once. It is a fact arriving,
 *  not an animation running: §2.4 allows the sweep exactly because it happens
 *  when the machine learns something, and forbids it from ever looping. */
function LedgerVersion({ cell, onOpen }: { cell: VersionCell; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useGSAP(
    () => {
      if (!cell.waiting) return;
      const rule = ref.current?.querySelector<HTMLElement>(".ledger__sweep");
      if (!rule) return;
      gsap.set(rule, { scaleX: 0, transformOrigin: "left center" });
      mech(rule, { scaleX: 1, duration: DUR.sweep, ease: EASE.enter });
    },
    { dependencies: [cell.waiting], scope: ref },
  );

  return (
    <button
      type="button"
      ref={ref}
      className={`ledger__cell${cell.waiting ? " is-waiting" : ""}`}
      onClick={onOpen}
    >
      <span className="ledger__value">{cell.label}</span>
      {cell.waiting && <span className="ledger__sweep" aria-hidden="true" />}
    </button>
  );
}

/** A plain destination — What's new, Help. */
function LedgerLink({ link, onOpen }: { link: LinkCell; onOpen: () => void }) {
  return (
    <button type="button" className="ledger__cell" onClick={onOpen}>
      <span className="ledger__value">{link.label}</span>
    </button>
  );
}
