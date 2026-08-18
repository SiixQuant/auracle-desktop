// StandbyHome — the launcher home: a stage, an instrument, a sentence, a verb.
//
// Design authority: launcher-redesign-direction.md §1 (the chamber sketch) and
// §3.3 ("Home — The Orrery"), as the premium-launcher slice recomposed them.
//
//     ┌──────────────────────────────────────────────┐
//     │                       ·  ENGINE · SETTINGS  ·│  the pill (the Shell's)
//     │                                              │
//     │                      ╭──────────╮            │  THE INSTRUMENT,
//     │                      │  orrery  │            │  key-art scale,
//     │                      ╰──────────╯            │  right of centre
//     │  Everything's ready.                         │  THE VERDICT (display)
//     │  [ Open workspace ]                          │  one accent verb
//     └──────────────────────────────────────────────┘
//
// What changed: the mono ledger along the floor — the engine vital, the version
// ladder, What's new, Help — moved WHOLE into the Status inspector. Nothing was
// dropped; it is one door away instead of always on screen, which is what buys
// the instrument its size and the verb its silence. The home now carries
// exactly what a gaming launcher carries: art, one line, one button.
//
// The composition is still a pure derivation of one engine snapshot — the
// verdict, the verb and the instrument all come from `deriveBoard`. This file
// holds the ink and the tweens; the decisions live in `lib/aggregator.ts`
// (untouched by this slice, and untouchable by it: it is the seam).

import { useRef } from "react";

import ParticleWordmark from "@/fx/ParticleWordmark";
import { revealWords, useGSAP } from "@/fx/motion";
import {
  attentionLine,
  deriveBoard,
  type ActuatorState,
} from "@/lib/aggregator";
import type { EngineStateHook } from "@/lib/useEngineState";

export default function StandbyHome({
  eng,
  onActuator,
}: {
  /** Shared live engine read (owned by the Shell, so the home keeps
   *  polling behind an open inspector). */
  eng: EngineStateHook;
  /** Run the home's one verb — owned by the Shell so the palette and the
   *  button trigger the same action. */
  onActuator: () => void;
}) {
  const board = deriveBoard(eng.state);
  const { actuator } = board;
  const attention = attentionLine(board, {
    engineErr: eng.engineErr,
    ideError: eng.ideError,
  });

  return (
    <div className="standby">
      {/* ── The key art — the brand word, seated right of centre ─────
          Its own cell, so the cluster below can never be pushed under it: at
          any window this product opens in, the words have their own room. The
          word gathers on arrival and re-forms on hover; engine health is read
          from the verdict beside it, and Status stays a press away (the pill,
          ⌘K, or the `s` key). */}
      <div className="standby__figure">
        <ParticleWordmark text="Auracle" />
      </div>

      {/* ── The cluster — one sentence, one verb, one quiet line ───── */}
      <div className="standby__cluster">
        <Verdict line={board.systemLine} />
        <Actuator actuator={actuator} onClick={onActuator} />
        {attention && <div className="standby__attention">{attention}</div>}
      </div>
    </div>
  );
}

// ── The Verdict ─────────────────────────────────────────────────────

/** The system line, in the display register, arriving word by word (§2.4).
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

// ── The one verb ────────────────────────────────────────────────────

/** The actuator: the only accent on the screen and the only thing to press.
 *
 *  Its reason line is NOT rendered here any more. There is one quiet line on
 *  this home and the cluster owns it (`attentionLine`), so a disabled verb's
 *  reason arrives there — below the verb, in the same place a failure would —
 *  instead of the two of them stacking a second explanatory row between the
 *  button and the floor. The `title` stays: the reason is still on the control
 *  itself for a pointer, which is what makes it a legible disabled button
 *  rather than a dead one. */
function Actuator({
  actuator,
  onClick,
}: {
  actuator: ActuatorState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`standby__actuator${actuator.action === "starting" ? " is-progress" : ""}`}
      onClick={onClick}
      disabled={actuator.disabled}
      title={actuator.reason}
    >
      <span>{actuator.label}</span>
    </button>
  );
}
