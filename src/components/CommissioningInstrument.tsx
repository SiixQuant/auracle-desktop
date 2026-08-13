// CommissioningInstrument — the orrery, being built.
//
// Design authority: launcher-redesign-direction.md §3.2 ("First-run —
// Commissioning"), whose install station is "the signature moment": a large
// ring arc sweeping with REAL percent, and then the one sanctioned ceremony in
// the whole product — the arc completes, the core ignites, the bodies fade in
// and the mechanism begins its first revolution. Slice 8 of the redesign.
//
// It is the same instrument the home draws, at an earlier moment in its life:
// the geometry, the ring path, the ink classes and the seat rules all come
// from `fx/orrery.ts`, so the frame this lands on IS the frame `Orrery.tsx`
// picks up a second later. That is what makes the handover a continuation
// rather than a cut — nothing about the instrument changes when the view does.
//
// It is NOT `Orrery.tsx`, for two reasons worth stating: that component is a
// button whose one job is to open Supervision, and there is no Supervision
// during a first run — a button that does nothing is a dead control, which
// this product does not have. And its body reconciler exists to survive a live
// container list changing under it; the ceremony takes ONE snapshot, once, and
// a reconciler for a list that cannot change would be machinery pretending to
// be careful.
//
// Two things it is careful about:
//
//   1. THE ARC IS SET, NEVER ANIMATED. `stroke-dashoffset` is written straight
//      from the last percent the installer reported, with no tween and no CSS
//      transition on it. So the arc moves exactly when — and only when — real
//      progress arrives, and a phase that stalls leaves it visibly parked.
//      `fx/commissioning.ts` proves the number is honest; this file's job is
//      to not smooth it afterwards.
//
//   2. THE CEREMONY IS CEREMONY. Every tween here goes through the house
//      helpers, so under `prefers-reduced-motion` the whole thing collapses to
//      an instant cut. Nothing the user needs to READ is gated on it — the
//      station's words are rendered by React from the same state, and the
//      handover's own timer is the wizard's, not the animation's.

import { useEffect, useRef } from "react";

import { MotionPathPlugin } from "gsap/MotionPathPlugin";

import {
  DUR,
  EASE,
  STAGGER,
  enter,
  exit,
  gsap,
  snapStatus,
  useGSAP,
  useReducedMotion,
} from "@/fx/motion";
import type { CommissioningView } from "@/fx/commissioning";
import {
  CHROME_DOTS,
  GEOM,
  REVOLUTION_SECONDS,
  RING_PATH,
  type OrreryFrame,
} from "@/fx/orrery";

gsap.registerPlugin(MotionPathPlugin);

/** How far the core's soft ring swells on the in-breath — the home's value,
 *  because it is the same core. */
const HALO_BREATH = 1.06;

/** The arc is drawn on a path whose length is declared as 1 (`pathLength`), so
 *  completion is the dash offset and no DOM measurement is involved: `1 - p`
 *  is exactly p of the ring, at any window size, on the first frame. */
const ARC_LENGTH = 1;

/** The arc's seat key — it arrives (and retires) exactly once, like a body. */
const ARC = "#arc";

/** A chrome dot's seat key. The mark's dots are not a machine, so they have no
 *  container name to be keyed by. */
const chromeSeat = (i: number) => `#chrome-${i}`;

export default function CommissioningInstrument({
  view,
  frame,
}: {
  /** The whole instrument, as a pure value (see fx/commissioning.ts). */
  view: CommissioningView;
  /** The assembled orbit — the home's own frame, built from the containers the
   *  install actually produced. Null until the engine has answered; an empty
   *  container list stays honest on its own (the frame falls back to the
   *  mark's two chrome dots, which carry nothing and never move). */
  frame: OrreryFrame | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<SVGGElement>(null);
  const breathRef = useRef<SVGGElement>(null);
  const haloRef = useRef<SVGCircleElement>(null);
  const arcRef = useRef<SVGPathElement>(null);
  const bodiesRef = useRef<SVGGElement>(null);

  const breathTl = useRef<gsap.core.Timeline | null>(null);
  const appliedCore = useRef(view.core);
  /** Which nodes have already been given their entrance and (where they are
   *  real bodies) their orbit, keyed by id. The container list can land a beat
   *  after the engine answers — the read is fired in parallel with the health
   *  poll, not awaited before the truth is shown — so the ceremony has to be
   *  able to receive a body late without either replaying itself or leaving
   *  the newcomer parked at the SVG origin. */
  const seated = useRef(new Set<string>());
  /** The motion-path tween each seated body is riding, kept so the reduced-
   *  motion preference can still reach them after the ceremony has run. See
   *  the pause/resume pass below. */
  const rides = useRef(new Map<string, gsap.core.Tween>());

  const reduced = useReducedMotion();

  const bodies = view.assembled && frame ? frame.bodies : [];
  const showChrome = view.assembled && (!frame || frame.chrome);
  const seatKey = bodies.map((b) => b.id).join("|");

  // ── The core: the hue snap, and the in-flight breath ─────────────
  //
  // The ignition IS this: a 120ms dip, the tone swapped at the trough, back
  // up. Status hues never crossfade (§2.4), so the core is never a colour the
  // machine was not in — least of all halfway lit while the engine is still
  // silent.
  useGSAP(
    () => {
      const el = coreRef.current;
      if (!el || appliedCore.current === view.core) return;
      const next = view.core;
      appliedCore.current = next;
      snapStatus(el, () => {
        el.dataset.tone = next;
      });
    },
    { dependencies: [view.core], scope: rootRef },
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
      if (!view.breath || reduced) return;
      const half = view.breath.period / 2;
      breathTl.current = gsap
        .timeline({ repeat: -1, yoyo: true })
        .to(el, { opacity: 1 - view.breath.opacityDelta, duration: half, ease: EASE.mech }, 0)
        .to(halo, { scale: HALO_BREATH, transformOrigin: "center", duration: half, ease: EASE.mech }, 0);
    },
    { dependencies: [view.breath, reduced], scope: rootRef },
  );

  // ── The ceremony (§3.2) ──────────────────────────────────────────
  //
  // Once per machine, and only after `waitForEngineHealthy` got a real answer
  // out of the engine. The arc — which has done its job — retires, the bodies
  // the install actually produced arrive, and the mechanism takes its first
  // turn. Under reduced motion every one of these times is zero and the
  // instrument is simply, immediately, assembled.
  useGSAP(
    () => {
      if (!view.assembled) return;

      if (arcRef.current && !seated.current.has(ARC)) {
        seated.current.add(ARC);
        exit(arcRef.current);
      }

      const group = bodiesRef.current;
      if (!group) return;
      const arriving = Array.from(
        group.querySelectorAll<SVGGElement>(".orrery__body"),
      ).filter((el) => !seated.current.has(el.dataset.seat ?? ""));
      if (arriving.length === 0) return;

      for (const el of arriving) {
        const id = el.dataset.seat ?? "";
        seated.current.add(id);
        const body = bodies.find((b) => b.id === id);
        // The mark's own chrome dots are drawn in place and never ride: they
        // are part of the ring's drawing, not a machine (§3.3). They still
        // arrive with the ceremony, because their arrival is the instrument
        // coming to rest as the logo.
        if (!body) continue;
        const ride = gsap.to(el, {
          duration: frame?.revolution ?? REVOLUTION_SECONDS,
          repeat: -1,
          ease: "none",
          motionPath: { path: RING_PATH, start: body.seed, end: body.seed + 1 },
        });
        ride.timeScale(body.tempo);
        rides.current.set(id, ride);
        // Seat it on the ring NOW rather than on the first tick — a GSAP tween
        // renders lazily, and under reduced motion (or a hidden window) that
        // first tick may never come.
        ride.progress(0);
        if (reduced) ride.pause();
      }

      enter(arriving, {
        duration: DUR.long,
        delay: DUR.snap,
        stagger: STAGGER.word,
      });
    },
    { dependencies: [view.assembled, seatKey, showChrome], scope: rootRef },
  );

  // The preference is live, so the mechanism has to be reachable after the
  // ceremony has already seated everything. Pausing only at creation (as this
  // did) left a flip mid-first-run stuck both ways: turn reduce ON and the
  // orbits kept looping for a user who had just asked them not to; turn it OFF
  // and they stayed frozen for the rest of the run. Same pass the home makes
  // (Orrery.tsx), for the same reason.
  useGSAP(
    () => {
      rides.current.forEach((ride) => {
        if (reduced) ride.pause();
        else ride.resume();
      });
    },
    { dependencies: [reduced, seatKey], scope: rootRef },
  );

  // StrictMode double-invokes effects and useGSAP reverts the first pass's
  // tweens with it; the bookkeeping that says "this node has already arrived"
  // has to go back with them or the second pass skips the ceremony and the
  // instrument sits still (Risk 5).
  useEffect(() => () => {
    seated.current.clear();
    rides.current.clear();
  }, []);

  const arc = view.arc;

  return (
    <div
      className="commission-instrument"
      ref={rootRef}
      // The instrument is a second reading of what the station says in words,
      // so it is hidden from assistive tech — except while an install is
      // genuinely under way, where it carries the only completion figure on
      // the screen and reports the installer's own number.
      {...(arc === null
        ? { "aria-hidden": true as const }
        : {
            role: "progressbar" as const,
            "aria-label": "Install progress",
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.round(arc * 100),
          })}
    >
      <svg
        className="orrery__svg"
        viewBox={`0 0 ${GEOM.size} ${GEOM.size}`}
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* The track: the same ring the home draws, in the same ink. */}
        <path
          className="orrery__ring"
          data-ring={view.ring}
          d={RING_PATH}
          vectorEffect="non-scaling-stroke"
        />

        {/* The commissioning arc. Its offset is written from the installer's
            own last percent with no tween and no transition — see the header. */}
        {arc !== null && (
          <path
            className="commission-arc"
            ref={arcRef}
            d={RING_PATH}
            pathLength={ARC_LENGTH}
            strokeDasharray={ARC_LENGTH}
            strokeDashoffset={ARC_LENGTH - arc}
            vectorEffect="non-scaling-stroke"
          />
        )}

        <g className="orrery__core" ref={coreRef} data-tone={appliedCore.current}>
          <g ref={breathRef}>
            <circle className="orrery__halo" ref={haloRef} cx={GEOM.cx} cy={GEOM.cy} r={GEOM.halo} />
            <circle className="orrery__dot" cx={GEOM.cx} cy={GEOM.cy} r={GEOM.core} />
          </g>
        </g>

        <g className="orrery__bodies" ref={bodiesRef}>
          {bodies.map((body) => (
            <g
              key={body.id}
              className="orrery__body"
              data-seat={body.id}
              data-tone={body.tone}
            >
              <circle className="orrery__mass" r={GEOM.body} />
            </g>
          ))}
          {showChrome &&
            CHROME_DOTS.map((dot, i) => (
              <g key={`${dot.x},${dot.y}`} className="orrery__body" data-seat={chromeSeat(i)}>
                <circle className="orrery__chrome" cx={dot.x} cy={dot.y} r={dot.r} />
              </g>
            ))}
        </g>
      </svg>
    </div>
  );
}
