// ParticleWordmark — the launcher home's centrepiece.
//
// ─── Provenance ───────────────────────────────────────────────────
// The particle engine is vendored and adapted from react-bits ParticleText,
// © David Haz, licensed MIT (https://github.com/DavidHDev/react-bits). The
// React wrapper and the purple gradient are dropped; the 2D-canvas sampler and
// its gather math are kept. This is a private, adapted copy inside a product;
// it is never published as a package. See src/assets/fonts/OFL-NOTICES.txt for
// the third-party notices this app ships under. It is the same engine that
// backs the marketing site's hero (auracle-marketing/js/particle-text.js);
// this file is its launcher port.
//
// ─── What this is ─────────────────────────────────────────────────
// The brand word "Auracle" sampled into a field of particles on one 2D canvas.
// The letters gather from a scatter when the home appears, re-form on hover,
// and sit still at rest. It replaces the Orrery instrument on the home (owner
// direction: "we don't need an Orrery"). What the Orrery carried in ink — the
// engine's health — is still on the home in WORDS (the verdict sentence beside
// it), and the Status tray is still one press away from the pill, ⌘K, and the
// `s` key, so nothing that instrument did is lost with it; the home simply
// leads with the mark instead of the mechanism.
//
// ─── What it is careful about ─────────────────────────────────────
//   1. THE POWER LAW (§4, fx/ambient.ts). No private clock: the field reads
//      the same cadence as the dot-field, so it is asleep while the window is
//      hidden and never chases 60fps while blurred. And it does not run
//      forever — once the word is formed the loop STOPS, so a settled home
//      costs zero frames. Hover re-arms it; the gather runs, lands, and stops
//      again. Geometry is re-measured on every resume, because a hidden
//      WKWebView delivers neither rAF nor ResizeObserver (Risk 2).
//   2. REDUCED MOTION IS ONE FRAME (§2.4). Not a slower gather and not an empty
//      box: the formed word is painted once, on its targets, and never moves.
//   3. IT DOES NOT CHASE THE POINTER. The dot-field disables its cursor bulge
//      by default for exactly this reason — a home stage is texture, not a toy.
//      The word re-forms on hover as a one-shot; there is no idle drift and no
//      per-frame repel. Ink on cream, no glow: the institutional voice.
//   4. IT IS NOT A CONTROL. A wordmark that is not a button must not pretend to
//      be one, so the canvas is inert and the mark is exposed to assistive tech
//      as an image of its own word — the verdict line remains the spoken truth.

import { memo, useEffect, useRef } from "react";

import {
  ambientCadence,
  parseRgba,
  readAmbientEnv,
  shouldPaint,
  watchAmbientEnv,
  type AmbientCadence,
} from "@/fx/ambient";

const TWO_PI = Math.PI * 2;

/** The field's fixed character. Deliberately not props — one home, one mark. */
const SPEC = {
  /** Off-target throw the particles gather in from, in CSS px. */
  scatter: 180,
  /** Gather duration, ms — a touch quicker than the web hero's 1600, to match
   *  the launcher's calmer, more mechanical tempo. */
  gatherMs: 1500,
  /** Per-particle stagger across the gather, ms (scaled by each seed). */
  staggerMs: 380,
  /** Drawn particle size in CSS px before the per-glyph-alpha taper. Kept small
   *  so the word reads as a fine ink stipple rather than a blocky mass. */
  particleSize: 2,
  /** Sampling stride in offscreen px — one candidate target per `density`². */
  density: 4,
  /** The word never grows past this fraction of the box width. */
  widthFit: 0.92,
  /** …nor this fraction of the box height. */
  heightFit: 0.72,
  /** Geist within its weight axis — a legible particle mass, not a hairline. */
  fontWeight: 700,
  /** Retina backing store is worth it; a 3× one is fill cost nobody can see. */
  dprCap: 2,
} as const;

type Particle = {
  targetX: number;
  targetY: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  size: number;
  seed: number;
  depth: number;
  delay: number;
};

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Resolve when the requested font face is actually ready, so the glyph the
 *  sampler rasters is the brand's and not a fallback measured at the wrong
 *  metrics. Best-effort: never rejects, so a font that fails to load still
 *  lets the field draw (in whatever face the box computed to). */
function waitForFonts(font: string): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return Promise.resolve();
  }
  let loaded: Promise<unknown>;
  try {
    loaded = document.fonts.load(font);
  } catch {
    loaded = Promise.resolve();
  }
  return Promise.resolve(loaded)
    .catch(() => {})
    .then(() => document.fonts.ready)
    .then(() => {})
    .catch(() => {});
}

function ParticleWordmarkImpl({ text = "Auracle" }: { text?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, SPEC.dprCap);

    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let inkCss = "rgb(35, 35, 35)";
    let gathering = false;
    let gatherStart = 0;
    let raf: number | null = null;
    let sampleRaf: number | null = null;
    let lastPaint = 0;
    let buildId = 0;
    let cadence: AmbientCadence = ambientCadence(readAmbientEnv());

    function drawParticle(p: Particle) {
      const s = p.size;
      if (s <= 2.1) {
        ctx!.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        return;
      }
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, s / 2, 0, TWO_PI);
      ctx!.fill();
    }

    /** One frame. During the gather the particles ease from their scatter to
     *  their targets and fade in; at rest they sit exactly on their targets at
     *  full ink. No drift, no repel — a settled word does not move. */
    function render(now: number) {
      ctx!.clearRect(0, 0, width, height);
      if (!width || !height || particles.length === 0) return;
      ctx!.fillStyle = inkCss;

      let complete = true;
      for (const p of particles) {
        if (gathering) {
          const local = (now - gatherStart - p.delay) / SPEC.gatherMs;
          const progress = clamp(local, 0, 1);
          const eased = easeOutCubic(progress);
          p.x = p.startX + (p.targetX - p.startX) * eased;
          p.y = p.startY + (p.targetY - p.startY) * eased;
          if (progress < 1) complete = false;
          ctx!.globalAlpha = clamp(0.4 + progress * 0.6, 0, 1);
        } else {
          p.x = p.targetX;
          p.y = p.targetY;
          ctx!.globalAlpha = 1;
        }
        drawParticle(p);
      }
      ctx!.globalAlpha = 1;
      if (gathering && complete) gathering = false;
    }

    function stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    }

    /** Run the loop only while there is something to animate. The loop paints
     *  on the cadence's frame gate and, the moment the word is fully formed,
     *  stops itself — so a home at rest is not repainting an identical frame. */
    function loop(now: number) {
      raf = requestAnimationFrame(loop);
      if (!shouldPaint(now - lastPaint, cadence)) return;
      render(now);
      lastPaint = now;
      if (!gathering) stop();
    }

    function ensureLoop() {
      if (cadence.animating && raf === null) {
        lastPaint = 0;
        raf = requestAnimationFrame(loop);
      }
    }

    /** Throw the particles out to a seeded scatter and start the clock. Only
     *  ever called when motion is allowed (a reduced-motion field is placed on
     *  its targets in `sample` and never gathers). */
    function startGather(fromScatter: boolean) {
      if (particles.length === 0) return;
      for (const p of particles) {
        if (fromScatter) {
          const angle = p.seed * TWO_PI;
          const distance = SPEC.scatter * (0.35 + p.depth * 0.75);
          p.x = p.targetX + Math.cos(angle) * distance + (p.depth - 0.5) * SPEC.scatter * 0.55;
          p.y = p.targetY + Math.sin(angle) * distance + (p.seed - 0.5) * SPEC.scatter * 0.55;
        }
        p.startX = p.x;
        p.startY = p.y;
        p.delay = p.seed * SPEC.staggerMs;
      }
      gatherStart = performance.now();
      gathering = true;
    }

    /** Measure the box, raster the word, and build the particle set. Async only
     *  because it waits for the brand font; a stale run (another sample queued,
     *  or the effect torn down) is dropped by the buildId guard. */
    async function sample() {
      const id = ++buildId;
      const rect = host!.getBoundingClientRect();
      width = Math.floor(rect.width);
      height = Math.floor(rect.height);
      if (width <= 0 || height <= 0) return;

      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      canvas!.style.width = "100%";
      canvas!.style.height = "100%";
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cs = window.getComputedStyle(host!);
      const family = cs.fontFamily || "sans-serif";
      const ink = parseRgba(cs.color);
      if (ink) inkCss = `rgb(${ink.r}, ${ink.g}, ${ink.b})`;

      const offscreen = document.createElement("canvas");
      const off = offscreen.getContext("2d", { willReadFrequently: true });
      if (!off) return;

      const content = String(text || " ");
      const maxTextWidth = width * SPEC.widthFit;

      // Fit the word to the box in one scale step: text width is linear in font
      // size for a given face, so a single measure-and-scale lands it. Height
      // caps it too, so a short window never clips the caps.
      let size = Math.min(height * SPEC.heightFit, 220);
      off.font = `${SPEC.fontWeight} ${size}px ${family}`;
      await waitForFonts(off.font);
      if (id !== buildId) return;
      off.font = `${SPEC.fontWeight} ${size}px ${family}`;
      const measured = Math.max(1, off.measureText(content).width);
      size = Math.max(16, Math.min(size, size * (maxTextWidth / measured)));

      const font = `${SPEC.fontWeight} ${size}px ${family}`;
      off.font = font;
      const metrics = off.measureText(content);
      const left = Math.ceil(metrics.actualBoundingBoxLeft || 0);
      const right = Math.ceil(metrics.actualBoundingBoxRight || metrics.width);
      const ascent = Math.ceil(metrics.actualBoundingBoxAscent || size * 0.78);
      const descent = Math.ceil(metrics.actualBoundingBoxDescent || size * 0.22);
      const padding = Math.max(12, Math.ceil(size * 0.08));
      const textWidth = Math.max(1, left + right);
      const textHeight = Math.max(1, ascent + descent);

      offscreen.width = textWidth + padding * 2;
      offscreen.height = textHeight + padding * 2;
      off.clearRect(0, 0, offscreen.width, offscreen.height);
      off.font = font;
      off.textAlign = "left";
      off.textBaseline = "alphabetic";
      off.fillStyle = "#ffffff";
      off.fillText(content, padding - left, padding + ascent);

      const data = off.getImageData(0, 0, offscreen.width, offscreen.height).data;
      const targets: { x: number; y: number; alpha: number }[] = [];
      const stepPx = Math.max(2, Math.floor(SPEC.density));
      const originX = width / 2 - offscreen.width / 2;
      const originY = height / 2 - offscreen.height / 2;
      for (let y = 0; y < offscreen.height; y += stepPx) {
        for (let x = 0; x < offscreen.width; x += stepPx) {
          const alpha = data[(y * offscreen.width + x) * 4 + 3];
          if (alpha > 40) {
            targets.push({ x: originX + x, y: originY + y, alpha: alpha / 255 });
          }
        }
      }

      const maxParticles = Math.max(700, Math.min(5000, Math.floor((width * height) / 100)));
      const stride = Math.max(1, Math.ceil(targets.length / maxParticles));
      const env = readAmbientEnv();

      particles = targets
        .filter((_, i) => i % stride === 0)
        .map((target, index) => {
          const seed = ((index * 9301 + 49297) % 233280) / 233280;
          const depth = 0.45 + (((index * 233 + 97) % 1000) / 1000) * 0.9;
          const angle = seed * TWO_PI;
          const distance = SPEC.scatter * (0.35 + depth * 0.75);
          const startX = target.x + Math.cos(angle) * distance + (seed - 0.5) * SPEC.scatter * 0.45;
          const startY = target.y + Math.sin(angle) * distance + (depth - 0.9) * SPEC.scatter * 0.45;
          return {
            targetX: target.x,
            targetY: target.y,
            startX,
            startY,
            x: env.reducedMotion ? target.x : startX,
            y: env.reducedMotion ? target.y : startY,
            size: Math.max(0.6, SPEC.particleSize * (0.75 + target.alpha * 0.45)),
            seed,
            depth,
            delay: seed * SPEC.staggerMs,
          };
        });

      cadence = ambientCadence(env);
      if (env.reducedMotion || !cadence.animating) {
        // Reduced motion, or a hidden/blurred first paint: land the word and
        // draw it once. If we are merely blurred it still reads correctly, and
        // a later focus/hover can re-form it.
        gathering = false;
        for (const p of particles) {
          p.x = p.targetX;
          p.y = p.targetY;
        }
        if (cadence.paints) render(performance.now());
      } else {
        startGather(false);
        ensureLoop();
      }
    }

    function queueSample() {
      if (sampleRaf !== null) cancelAnimationFrame(sampleRaf);
      sampleRaf = requestAnimationFrame(() => {
        sampleRaf = null;
        void sample();
      });
    }

    /** A tier change (hide/show, focus/blur, reduced-motion flip). Re-measure
     *  first — the box may have changed while we were suspended — then either
     *  keep animating an in-flight gather or settle to a static frame. */
    function sync() {
      cadence = ambientCadence(readAmbientEnv());
      if (!cadence.paints) {
        stop();
        return;
      }
      if (particles.length === 0) {
        queueSample();
        return;
      }
      if (gathering && cadence.animating) {
        ensureLoop();
      } else {
        render(performance.now());
      }
    }

    /** Re-form on hover — a one-shot, only when motion is allowed. */
    function onPointerEnter() {
      if (!cadence.animating) return;
      startGather(true);
      ensureLoop();
    }

    // ResizeObserver catches the initial layout and any window resize while
    // visible; watchAmbientEnv catches the resume a hidden webview's observer
    // never fires. Both funnel through the buildId-guarded sampler.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(queueSample) : null;
    if (ro) ro.observe(host);
    else queueSample();
    const unwatch = watchAmbientEnv(sync);
    host.addEventListener("pointerenter", onPointerEnter);

    return () => {
      buildId += 1;
      stop();
      if (sampleRaf !== null) cancelAnimationFrame(sampleRaf);
      if (ro) ro.disconnect();
      unwatch();
      host.removeEventListener("pointerenter", onPointerEnter);
    };
  }, [text]);

  return (
    <div ref={hostRef} className="wordmark" role="img" aria-label={text}>
      <canvas ref={canvasRef} className="wordmark__canvas" aria-hidden="true" />
    </div>
  );
}

/** The home's centrepiece: the brand word as a particle field, asleep whenever
 *  the window is and still whenever it has nothing to say. */
const ParticleWordmark = memo(ParticleWordmarkImpl);
ParticleWordmark.displayName = "ParticleWordmark";

export default ParticleWordmark;
