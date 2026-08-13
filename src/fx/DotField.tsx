// DotField — the launcher's ambient stage.
//
// ─── Provenance ───────────────────────────────────────────────────
// Vendored and adapted from react-bits, © 2026 David Haz, licensed
// MIT + Commons Clause License Condition v1.0.
//   Source: https://github.com/DavidHDev/react-bits
//           src/ts-default/Backgrounds/DotField/DotField.tsx @ c7109dc
// The licence grants use, modification and distribution "as part of an
// application, website, or product" and bars only selling or redistributing
// the components themselves. This file is a private, adapted copy inside a
// product; it is never published as a package. See src/assets/fonts/
// OFL-NOTICES.txt for the third-party notices this ships under.
//
// ─── What this is ─────────────────────────────────────────────────
// Design authority: launcher-redesign-direction.md §4 ("react-bits — adopt as
// quarry"). Slice 3 of the redesign. This replaces the WebGL dot-reveal shader
// that used to back the home and the sign-in screen, and with it the app's
// only three.js / react-three-fiber consumer. The launcher now owns **zero**
// WebGL contexts — which retires the platform's worst-behaved surface
// (WKWebView drops GL contexts on sleep, and cannot blur one behind a
// backdrop-filter; both are documented project scars).
//
// ─── What changed from the source ─────────────────────────────────
//   · TypeScript throughout, no `[key: string]: unknown` prop passthrough.
//   · Ink comes from the house tokens (`--stage-dot` α.05, brightening to
//     `--stage-dot-near` α.09 within 240px of the focus point, §2.1) instead
//     of the source's purple linear gradient. The falloff is PRECOMPUTED per
//     dot into a handful of tiers and drawn as one batched path each, so a
//     ~3k-dot field costs six `fill()` calls and no per-dot state changes.
//   · Sparkle and the SVG cursor-glow layer: deleted (glitter is not
//     institutional voice, and the glow layer was a second DOM element
//     animating every frame).
//   · Cursor bulge: OFF by default — a status instrument should not chase the
//     pointer — and kept only as an opt-in flag (§4). Its window listener is
//     attached only when it is enabled, so the default path pays nothing.
//   · Geometry is fixed, not props: the dot count is a stated perf budget
//     (§4 / Risk 3), so it lives in `FIELD` where a test can hold it.
//   · Drift is driven by wall-clock rather than a frame counter, so the tempo
//     is identical whether the field is painting at 60fps or 30.
//   · The rAF loop is gated by `ambientCadence` — suspended when the document
//     is hidden, halved when the window is blurred, never started at all under
//     prefers-reduced-motion (one static frame instead). Geometry is
//     re-measured on every resume, because a hidden WKWebView delivers neither
//     rAF nor ResizeObserver and cached sizes cannot be trusted across a hide
//     (redesign doc, Risk 2).

import { memo, useEffect, useRef } from "react";

import {
  DRIFT,
  FIELD,
  ambientCadence,
  gridSpec,
  inkRamp,
  readAmbientEnv,
  readStageInk,
  shouldPaint,
  tierAt,
  watchAmbientEnv,
} from "@/fx/ambient";
import { cn } from "@/lib/utils";

const TWO_PI = Math.PI * 2;

/** Opt-in cursor bulge (§4): dots within this radius of the pointer lean away
 *  from it. A whisper — the displacement is a fraction of the dot spacing, so
 *  the lattice bends rather than scattering. */
const BULGE = { radius: 40, push: 6, ease: 0.15 } as const;

type Dot = {
  /** lattice anchor */
  ax: number;
  ay: number;
  /** rendered position (equal to the anchor unless the bulge is on) */
  x: number;
  y: number;
};

export interface DotFieldProps {
  /** Positioning/stacking for the host element. The field is always absolute,
   *  inset-0 and pointer-transparent; this is for z-index and the like. */
  className?: string;
  /** Focus point of the brightness ramp, as a fraction of the box. Defaults to
   *  dead centre; the home points it at the instrument. */
  focusX?: number;
  focusY?: number;
  /** Opt in to the cursor bulge. Off by default, deliberately. */
  bulge?: boolean;
}

function DotFieldImpl({
  className,
  focusX = 0.5,
  focusY = 0.5,
  bulge = false,
}: DotFieldProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Every input below is baked into the precomputed lattice, so each one is a
  // dependency: change the focus point and the field is rebuilt around it.
  // They are constants at both call sites, so this never actually re-runs.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const ink = readStageInk();
    const tierInk = inkRamp(ink.base, ink.near);
    const dpr = Math.min(window.devicePixelRatio || 1, FIELD.dprCap);
    const start = performance.now();

    /** Dots bucketed by ink tier — the bucket a dot lands in depends only on
     *  its anchor, so this survives both drift and bulge. */
    let tiers: Dot[][] = [];
    let width = 0;
    let height = 0;
    let raf: number | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPaint = 0;
    let cadence = ambientCadence(readAmbientEnv());
    const pointer = { x: -9999, y: -9999 };

    /** Re-measure the box and, if it moved, rebuild the lattice. Returns true
     *  when the canvas was resized (which also clears it). */
    function measure(): boolean {
      const rect = host!.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w <= 0 || h <= 0) return false;
      if (w === width && h === height && tiers.length > 0) return false;

      width = w;
      height = h;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const grid = gridSpec(w, h);
      const cx = w * focusX;
      const cy = h * focusY;
      const next: Dot[][] = Array.from({ length: FIELD.tiers }, () => []);
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.cols; col++) {
          const ax = grid.padX + col * FIELD.step + FIELD.step / 2;
          const ay = grid.padY + row * FIELD.step + FIELD.step / 2;
          const dx = ax - cx;
          const dy = ay - cy;
          next[tierAt(Math.sqrt(dx * dx + dy * dy))].push({ ax, ay, x: ax, y: ay });
        }
      }
      tiers = next;
      return true;
    }

    /** Ease every dot toward its bulged target. Only ever called with the
     *  opt-in flag on. */
    function relax() {
      const r2 = BULGE.radius * BULGE.radius;
      for (let t = 0; t < tiers.length; t++) {
        const dots = tiers[t];
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          let tx = d.ax;
          let ty = d.ay;
          const dx = pointer.x - d.ax;
          const dy = pointer.y - d.ay;
          const dist2 = dx * dx + dy * dy;
          if (dist2 < r2) {
            const dist = Math.sqrt(dist2) || 1e-6;
            const fall = 1 - dist / BULGE.radius;
            const push = fall * fall * BULGE.push;
            tx -= (dx / dist) * push;
            ty -= (dy / dist) * push;
          }
          d.x += (tx - d.x) * BULGE.ease;
          d.y += (ty - d.y) * BULGE.ease;
        }
      }
    }

    function paint(now: number) {
      if (!width || !height) return;
      if (bulge) relax();
      const phase = cadence.drift ? ((now - start) / 1000) * DRIFT.rate : 0;
      const r = FIELD.dotRadius;

      ctx!.clearRect(0, 0, width, height);
      for (let t = 0; t < tiers.length; t++) {
        const dots = tiers[t];
        if (dots.length === 0) continue;
        ctx!.fillStyle = tierInk[t];
        ctx!.beginPath();
        for (let i = 0; i < dots.length; i++) {
          const d = dots[i];
          let x = d.x;
          let y = d.y;
          if (phase !== 0) {
            y += Math.sin(d.ax * DRIFT.freq + phase) * DRIFT.amplitude;
            x +=
              Math.cos(d.ay * DRIFT.freq + phase * 0.7) *
              DRIFT.amplitude *
              0.5;
          }
          ctx!.moveTo(x + r, y);
          ctx!.arc(x, y, r, 0, TWO_PI);
        }
        ctx!.fill();
      }
      lastPaint = now;
    }

    function loop(now: number) {
      raf = requestAnimationFrame(loop);
      if (shouldPaint(now - lastPaint, cadence)) paint(now);
    }

    function stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    }

    /** Apply the current tier. Every resume re-measures BEFORE the first frame
     *  (Risk 2): a hidden webview delivers no resize/rAF, so the geometry we
     *  cached before the hide may describe a window that no longer exists. */
    function sync() {
      cadence = ambientCadence(readAmbientEnv());
      if (!cadence.paints) {
        stop();
        return;
      }
      const now = performance.now();
      measure();
      paint(now);
      if (cadence.animating) {
        if (raf === null) raf = requestAnimationFrame(loop);
      } else {
        stop();
      }
    }

    // Resize is debounced: WebKit fires it continuously through a live drag,
    // and each one rebuilds the whole lattice.
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!cadence.paints) return;
        measure();
        paint(performance.now());
      }, 100);
    }

    function onPointerMove(e: MouseEvent) {
      const rect = host!.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    }

    sync();
    window.addEventListener("resize", onResize);
    const unwatch = watchAmbientEnv(sync);
    if (bulge) {
      window.addEventListener("mousemove", onPointerMove, { passive: true });
    }

    return () => {
      stop();
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      if (bulge) window.removeEventListener("mousemove", onPointerMove);
      unwatch();
    };
  }, [bulge, focusX, focusY]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={cn("dot-field", className)}
    >
      <canvas ref={canvasRef} className="dot-field__canvas" />
    </div>
  );
}

/** The ambient stage: a whisper-dim lattice of dots behind everything, on a
 *  single 2D canvas, non-interactive, and asleep whenever the window is. */
const DotField = memo(DotFieldImpl);
DotField.displayName = "DotField";

export default DotField;
