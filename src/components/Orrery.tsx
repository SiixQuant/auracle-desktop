// Orrery — the launcher's centrepiece instrument.
//
// Design authority: launcher-redesign-direction.md §1 (the concept), §2.5 (the
// orbital mark) and §3.3 ("Band 1 — The Instrument"). Slice 4 of the redesign.
// It replaces the 108px status lamp: the engine core sits at the centre and
// every REAL container reported by `stackStatus()` is a body on a hairline
// ring. Healthy, the mechanism turns — 60s to the revolution, sub-perceptual,
// so it reads as "your desk is live" before a single word does. Degraded, the
// affected body goes amber and falls visibly off the beat. Down, the whole
// mechanism spins down to a stop and the ring goes dashed: a stopped watch,
// unmistakable and calm.
//
// This file is the IMPERATIVE half of the instrument and owns nothing but SVG
// nodes and tweens. Every decision — which bodies exist, what they mean, what
// the core and ring do in each state, where the mark's own dots sit — is made
// in `fx/orrery.ts`, which is pure and tested. If you are changing WHAT the
// instrument says, that is the file; this one only makes it move.
//
// Three things it is careful about:
//
//   1. HONESTY AS MOTION. Status hues never crossfade — the core snaps at the
//      trough of a 120ms dip (`snapStatus`), and so does a body's ink. Nothing
//      here tweens a number, and no body's ANGLE means anything: seeds are
//      deterministic and the revolution is ambience. The only data-carrying
//      properties on this surface are ink and the mono flag, both quoted
//      straight from the container's own report.
//
//   2. THE POWER LAW. Everything rides the shared GSAP ticker, which
//      `fx/motion.ts` already governs against `fx/ambient.ts` — asleep while
//      the document is hidden, 30fps while the window is blurred, 60fps when
//      focused. So the instrument suspends with the rest of the app for free
//      and cannot disagree with the dot-field about what "hidden" means.
//      Under `prefers-reduced-motion` nothing loops at all: the bodies are
//      seeked to their seeded angles and paused — one static frame.
//
//   3. LOOPS ARE NOT TRANSITIONS. The revolution (60s) and the core's breath
//      (4s / 1.2s) are continuous ambience and use raw gsap, deliberately
//      bypassing the house helpers — §2.4's 800ms ceiling governs state
//      changes, and clamping an orbit to it would turn the instrument into a
//      spinner. Every TRANSITION here (entrance, exit, spin-down, hue snap)
//      goes through the gated helpers and obeys the ceiling and the kill
//      switch.

import { useCallback, useEffect, useRef, useState } from "react";

import { MotionPathPlugin } from "gsap/MotionPathPlugin";

import {
  DUR,
  EASE,
  enter,
  exit,
  gsap,
  mech,
  snapStatus,
  useGSAP,
  useReducedMotion,
} from "@/fx/motion";
import {
  CHROME_DOTS,
  GEOM,
  RING_GAPPED_PATH,
  RING_PATH,
  SEAM_PATH,
  type BodyTone,
  type OrreryBody,
  type OrreryFrame,
} from "@/fx/orrery";

// MotionPath is what lets a body be paused, seeked and re-tempoed — none of
// which SVG's `animateMotion` (what the lamp used) can do. Registered at module
// load, once, exactly like the eases in fx/motion.ts.
gsap.registerPlugin(MotionPathPlugin);

/** How far the core's soft ring swells on the in-breath. */
const HALO_BREATH = 1.06;

export default function Orrery({
  frame,
  onOpen,
}: {
  /** The whole instrument, as a pure value. See fx/orrery.ts. */
  frame: OrreryFrame;
  /** Status-is-the-door: the instrument opens Supervision (§3.3). */
  onOpen?: () => void;
}) {
  const rootRef = useRef<HTMLButtonElement>(null);
  const coreRef = useRef<SVGGElement>(null);
  const breathRef = useRef<SVGGElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);

  /** Live SVG node per body id. */
  const nodes = useRef(new Map<string, SVGGElement>());
  /** The motion-path tween each body is riding. Created when a body appears
   *  and never recreated, so a body already in flight keeps its angle when the
   *  container list changes underneath it. */
  const rides = useRef(new Map<string, gsap.core.Tween>());
  /** Per-body tempo (1, or off-beat) and the hue currently painted on it. */
  const tempos = useRef(new Map<string, number>());
  const tones = useRef(new Map<string, BodyTone>());
  /** Bodies part-way through leaving. Kept per id so a container that comes
   *  back before its fade finishes can be caught and un-faded — otherwise a
   *  stack that bounces (down, then up again, common while the window is
   *  hidden and nothing has been ticking) would show a live body dimming. */
  const exits = useRef(new Map<string, gsap.core.Tween>());
  /** The mechanism's global tempo: 1 turning, 0 stopped, tweened between the
   *  two so a stop reads as a spin-down rather than a UI fade (§2.4). */
  const drive = useRef({ scale: frame.running ? 1 : 0 });
  const breathTl = useRef<gsap.core.Timeline | null>(null);
  const appliedCore = useRef(frame.core);

  const reduced = useReducedMotion();

  // What is actually in the DOM: the frame's bodies, plus any body that has
  // left the frame and is still fading out. Never derived straight from the
  // frame — a body has to outlive its own departure to be able to animate it.
  const [rendered, setRendered] = useState<OrreryBody[]>(() => frame.bodies);
  const renderedRef = useRef<OrreryBody[]>(frame.bodies);
  const commit = useCallback((next: OrreryBody[]) => {
    renderedRef.current = next;
    setRendered(next);
  }, []);

  const setNode = useCallback((id: string) => (el: SVGGElement | null) => {
    if (el) nodes.current.set(id, el);
  }, []);

  // Signatures, so the effects below run on real changes rather than on every
  // parent render (the frame is a fresh object each time it is derived).
  const bodiesKey = frame.bodies
    .map((b) => `${b.id}:${b.tone}:${b.tempo}`)
    .join("|");
  const renderedKey = rendered.map((b) => b.id).join("|");

  const applyTempo = useCallback(() => {
    rides.current.forEach((ride, id) => {
      ride.timeScale((tempos.current.get(id) ?? 1) * drive.current.scale);
    });
  }, []);

  // ── Reconcile: who is on the instrument ─────────────────────────
  useGSAP(
    () => {
      const want = frame.bodies;
      const wanted = new Set(want.map((b) => b.id));

      // Back from the dead: a container that reappears before its fade
      // finished keeps the orbit it was already riding, and gets its ink back.
      for (const body of want) {
        const dying = exits.current.get(body.id);
        if (!dying) continue;
        dying.kill();
        exits.current.delete(body.id);
        const el = nodes.current.get(body.id);
        if (el) gsap.set(el, { opacity: 1 });
      }

      const leaving = renderedRef.current.filter((b) => !wanted.has(b.id));
      commit([...want, ...leaving]);

      const drop = (id: string) => {
        rides.current.get(id)?.kill();
        rides.current.delete(id);
        nodes.current.delete(id);
        tones.current.delete(id);
        tempos.current.delete(id);
        exits.current.delete(id);
        commit(renderedRef.current.filter((b) => b.id !== id));
      };
      for (const body of leaving) {
        if (exits.current.has(body.id)) continue; // already on its way out
        const el = nodes.current.get(body.id);
        if (!el) {
          drop(body.id);
          continue;
        }
        // When the mechanism is stopping, the bodies wait for it: the orbit
        // spins down first (below), THEN they fade. A machine stops, and only
        // then do its parts go dark.
        exits.current.set(
          body.id,
          exit(el, {
            delay: frame.running ? 0 : DUR.long,
            onComplete: () => drop(body.id),
          }),
        );
      }
    },
    { dependencies: [bodiesKey], scope: rootRef },
  );

  // ── Mount: give each new body its orbit ─────────────────────────
  useGSAP(
    () => {
      for (const body of rendered) {
        const el = nodes.current.get(body.id);
        if (!el) continue;
        if (!tones.current.has(body.id)) {
          el.dataset.tone = body.tone;
          tones.current.set(body.id, body.tone);
        }
        if (rides.current.has(body.id)) continue;

        // The revolution: a raw, continuous loop (see the header note), seeded
        // at a deterministic point on the very path the ring is drawn from.
        const ride = gsap.to(el, {
          duration: frame.revolution,
          repeat: -1,
          ease: "none",
          motionPath: {
            path: RING_PATH,
            start: body.seed,
            end: body.seed + 1,
          },
        });
        rides.current.set(body.id, ride);
        tempos.current.set(body.id, body.tempo);
        ride.timeScale(body.tempo * drive.current.scale);
        // Put the body on the ring NOW rather than on the first tick. A GSAP
        // tween renders lazily, so without this it sits at the SVG origin
        // until the ticker next runs — which is one frame in a live window,
        // and FOREVER under reduced motion (it is paused before that frame
        // ever arrives) or while the window is hidden.
        ride.progress(0);
        if (reduced) ride.pause();
        // Bodies fade in as their containers actually report — during a start
        // sequence that reads as one-by-one, because that is how they arrive.
        enter(el);
      }
    },
    { dependencies: [renderedKey, reduced], scope: rootRef },
  );

  // ── Tempo: the beat, and stopping it ────────────────────────────
  useGSAP(
    () => {
      for (const body of frame.bodies) {
        tempos.current.set(body.id, body.tempo);
        const el = nodes.current.get(body.id);
        const painted = tones.current.get(body.id);
        if (el && painted !== undefined && painted !== body.tone) {
          // A hue never crossfades: it snaps at the trough of a short dip.
          const next = body.tone;
          tones.current.set(body.id, next);
          snapStatus(el, () => {
            el.dataset.tone = next;
          });
        }
      }
      rides.current.forEach((ride) => {
        if (reduced) ride.pause();
        else ride.resume();
      });

      const target = frame.running ? 1 : 0;
      if (drive.current.scale === target) {
        applyTempo();
        return;
      }
      mech(drive.current, {
        scale: target,
        duration: DUR.long,
        overwrite: true,
        onUpdate: applyTempo,
        onComplete: applyTempo,
      });
    },
    { dependencies: [bodiesKey, frame.running, reduced], scope: rootRef },
  );

  // ── The core: hue snaps, and the in-flight breath ───────────────
  useGSAP(
    () => {
      const el = coreRef.current;
      if (!el || appliedCore.current === frame.core) return;
      const next = frame.core;
      appliedCore.current = next;
      snapStatus(el, () => {
        el.dataset.tone = next;
      });
    },
    { dependencies: [frame.core], scope: rootRef },
  );

  useGSAP(
    () => {
      breathTl.current?.kill();
      breathTl.current = null;
      const el = breathRef.current;
      const halo = haloRef.current;
      if (!el || !halo) return;
      gsap.set(el, { opacity: 1 });
      gsap.set(halo, { scale: 1, transformOrigin: "center" });
      // Reduced motion: the core is simply lit. No breath, no exceptions.
      if (!frame.breath || reduced) return;
      const half = frame.breath.period / 2;
      breathTl.current = gsap
        .timeline({ repeat: -1, yoyo: true })
        .to(el, {
          opacity: 1 - frame.breath.opacityDelta,
          duration: half,
          ease: EASE.mech,
        }, 0)
        .to(halo, {
          scale: HALO_BREATH,
          transformOrigin: "center",
          duration: half,
          ease: EASE.mech,
        }, 0);
    },
    { dependencies: [frame.breath, reduced], scope: rootRef },
  );

  // React 18 StrictMode double-invokes effects: the first pass's tweens are
  // reverted by useGSAP's cleanup, so the bookkeeping that says "this body is
  // already riding" has to be cleared with them or the second pass skips
  // creating the orbits and the instrument sits still (Risk 5).
  useEffect(
    () => () => {
      rides.current.clear();
      tones.current.clear();
      tempos.current.clear();
      exits.current.clear();
    },
    [],
  );

  return (
    <button
      type="button"
      ref={rootRef}
      className="orrery"
      onClick={onOpen}
      aria-label="Engine status — open Supervision"
    >
      {/* Decorative-informational (§ACCESSIBILITY): the instrument is a second
          reading of a verdict that is already stated in words underneath it,
          so it is hidden from assistive tech and the button carries the one
          label. The verdict line remains the accessible source of truth. */}
      <svg
        className="orrery__svg"
        viewBox={`0 0 ${GEOM.size} ${GEOM.size}`}
        aria-hidden="true"
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          className="orrery__ring"
          data-ring={frame.ring}
          d={frame.ring === "seam" ? RING_GAPPED_PATH : RING_PATH}
          vectorEffect="non-scaling-stroke"
        />
        {frame.ring === "seam" && (
          <path
            className="orrery__seam"
            d={SEAM_PATH}
            vectorEffect="non-scaling-stroke"
          />
        )}

        {/* The mark's own two dots. Chrome, not bodies: they appear only when
            there is no machine to show, and they carry nothing. */}
        {frame.chrome &&
          CHROME_DOTS.map((dot) => (
            <circle
              key={`${dot.x},${dot.y}`}
              className="orrery__chrome"
              cx={dot.x}
              cy={dot.y}
              r={dot.r}
            />
          ))}

        <g className="orrery__core" ref={coreRef} data-tone={appliedCore.current}>
          <g ref={breathRef}>
            <circle
              className="orrery__halo"
              ref={haloRef}
              cx={GEOM.cx}
              cy={GEOM.cy}
              r={GEOM.halo}
            />
            <circle
              className="orrery__dot"
              cx={GEOM.cx}
              cy={GEOM.cy}
              r={GEOM.core}
            />
          </g>
        </g>

        <g className="orrery__bodies">
          {rendered.map((body) => (
            <g key={body.id} className="orrery__body" ref={setNode(body.id)}>
              <circle className="orrery__hit" r={GEOM.hit} />
              <circle className="orrery__mass" r={GEOM.body} />
              <text className="orrery__flag" y={-GEOM.hit}>
                {body.flag}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </button>
  );
}
