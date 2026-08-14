// AsciiField — the launcher's ambient stage, as characters.
//
// Ported from the field shipped on the site (`auracle-marketing/js/ledger.js`,
// the `ascii-field` module) and re-materialed for the cream ground. It stands
// in for `DotField` on the signed-in home; the dot field remains the stage on
// commissioning and sign-in.
//
// The pure half is `fx/ascii.ts` — the ramp, the composition, the pointer
// model and the power law. This file owns the canvas and nothing else:
//
//   BUILD   size the backing store to the box × dpr, lay the cell grid over
//           it, rasterise the mark into a one-pixel-per-cell stencil, read it
//           back as luminance, and draw the whole grid once.
//   FRAME   relax the cells the pointer has touched, lift the ones it is on
//           now, repaint ONLY what changed, and promote one drifting cell
//           every 240ms. A frame is a few hundred cells, never six thousand.
//   POWER   `createStageRunner` holds §3's table: rAF cancelled while hidden,
//           30fps blurred, 60fps focused, and one static render — no loop at
//           all — under `prefers-reduced-motion`. Every input to that table is
//           watched, including live flips of the media query itself, so a
//           preference changed mid-session takes effect without a reload.
//
// Two carried-over fixes worth naming, because both are bugs that were paid
// for once already:
//
//   · THE BOX, NOT THE CALLBACK. A `ResizeObserver` fires once on observe, and
//     the tempting reading — "the first one is that freebie, skip it" — holds
//     only while that freebie arrives before anything moves. It does not have
//     to: with frames suspended, the first callback delivered can be the one
//     carrying the new size. `resync()` compares the measured box instead, so
//     it cannot be fooled by delivery order, and a resize that lands back on
//     the same box costs one measurement and no repaint.
//   · MEASURE ON RESUME. A hidden webview delivers neither rAF nor
//     ResizeObserver, so a size cached across a hide may describe a window
//     that no longer exists. The runner measures before the first render of
//     every resume (DESIGN.md §3).

import { memo, useEffect, useRef } from "react";

import {
  CELL,
  DRIFT,
  POINTER,
  RAMP,
  RAMP_LAST,
  STENCIL_BG,
  type AsciiInk,
  cellFont,
  createStageRunner,
  fillFor,
  floorGlyph,
  glyphAt,
  glyphForLuminance,
  gridFor,
  liftAt,
  luminanceOf,
  markPlacements,
  markSvgDataUri,
  readAsciiInk,
  readMonoFace,
  relax,
} from "@/fx/ascii";
import { readAmbientEnv, watchAmbientEnv } from "@/fx/ambient";
import { cn } from "@/lib/utils";

/** The stencil is rasterised once, this large, and downsampled to one pixel
 *  per cell — the browser's own area-average is the dither. Comfortably above
 *  any grid we compose it into. */
const STENCIL_PX = 512;

/** ResizeObserver debounce. WebKit fires it continuously through a live drag,
 *  and each delivery could rebuild the whole grid. */
const RESIZE_SETTLE_MS = 180;

export interface AsciiFieldProps {
  /** Positioning/stacking for the host element. The field is always absolute,
   *  inset-0 and pointer-transparent; this is for z-index and the like. */
  className?: string;
}

function AsciiFieldImpl({ className }: AsciiFieldProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const ink: AsciiInk = readAsciiInk();
    const face = readMonoFace();

    let disposed = false;
    let mark: HTMLImageElement | null = null;
    let built = false;

    let cols = 0;
    let rows = 0;
    let viewW = 0;
    let viewH = 0;

    /** the ramp index the mark put in each cell */
    let level = new Uint8Array(0);
    /** 1 while the ambient drift holds a cell one step up */
    let drift = new Uint8Array(0);
    /** 0..1, how close the pointer is */
    let lift = new Float32Array(0);
    /** the lift each cell was last drawn at */
    let painted = new Float32Array(0);
    /** the ramp index each cell was last drawn at */
    let paintedGlyph = new Uint8Array(0);
    /** 1 while a cell is in `active` */
    let queued = new Uint8Array(0);
    /** the cells the drift is holding, oldest first */
    let held: number[] = [];
    /** cells with lift left to relax */
    let active: number[] = [];

    let pointerX = 0;
    let pointerY = 0;
    let hasPointer = false;
    let driftAt = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    // ── Drawing ───────────────────────────────────────────────────

    /** One cell, cleared and redrawn. The canvas is transparent over the cream
     *  ground, so clearing a cell IS erasing it, and a glyph at 0.92 of a
     *  square cell never reaches its neighbours' boxes. */
    function paintCell(i: number) {
      const cx = i % cols;
      const cy = (i - cx) / cols;
      const x = cx * CELL.size;
      const y = cy * CELL.size;
      const glyph = glyphAt(level[i], drift[i] === 1, lift[i]);

      ctx!.clearRect(x, y, CELL.size, CELL.size);
      if (glyph > 0) {
        ctx!.fillStyle = fillFor(glyph, lift[i], ink);
        ctx!.fillText(RAMP.charAt(glyph), x + CELL.size / 2, y + CELL.size / 2);
      }

      painted[i] = lift[i];
      paintedGlyph[i] = glyph;
    }

    /** The whole grid, at rest — which is also what a resume returns to: a
     *  stage that comes back has no lifted cells to honour, only its texture.
     *
     *  One pass per ramp step rather than one per cell: nine `fillStyle`
     *  changes for six thousand characters is the difference between a build
     *  that costs a frame and one that costs ten. */
    function render() {
      if (!built) return;

      lift.fill(0);
      painted.fill(0);
      queued.fill(0);
      drift.fill(0);
      held = [];
      active = [];

      ctx!.clearRect(0, 0, viewW, viewH);
      for (let glyph = 1; glyph <= RAMP_LAST; glyph++) {
        ctx!.fillStyle = fillFor(glyph, 0, ink);
        const ch = RAMP.charAt(glyph);
        for (let i = 0; i < level.length; i++) {
          if (level[i] !== glyph) continue;
          const cx = i % cols;
          ctx!.fillText(
            ch,
            cx * CELL.size + CELL.size / 2,
            ((i - cx) / cols) * CELL.size + CELL.size / 2,
          );
        }
      }
      paintedGlyph.set(level);
    }

    // ── Build ─────────────────────────────────────────────────────

    /** The image, onto the grid. One offscreen pixel per cell, so the
     *  browser's own downsample does the area-averaging and the pixel that
     *  comes back IS the cell's luminance. */
    function sample(): boolean {
      if (!mark) return false;
      const off = document.createElement("canvas");
      off.width = cols;
      off.height = rows;
      const octx = off.getContext("2d", { willReadFrequently: true });
      if (!octx) return false;

      octx.fillStyle = STENCIL_BG;
      octx.fillRect(0, 0, cols, rows);
      octx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in octx) octx.imageSmoothingQuality = "high";

      for (const p of markPlacements(cols, rows)) {
        octx.save();
        octx.translate(p.x, p.y);
        octx.rotate(p.rotation);
        octx.drawImage(mark, -p.size / 2, -p.size / 2, p.size, p.size);
        octx.restore();
      }

      const data = octx.getImageData(0, 0, cols, rows).data;
      const next = new Uint8Array(cols * rows);
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const i = cy * cols + cx;
          const lum = luminanceOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
          next[i] = floorGlyph(glyphForLuminance(lum), cx, cy);
        }
      }
      level = next;
      return true;
    }

    /** The grid, against the box it is actually occupying. A canvas is a
     *  replaced element: the stylesheet stretches the BOX, but the pixels
     *  inside it are whatever width/height say, so the two are kept in step by
     *  hand — at the device ratio, capped, or a retina panel draws the field
     *  at half resolution and the characters turn to mush. */
    function build() {
      const rect = host!.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w <= 0 || h <= 0 || !mark) return;

      const dpr = Math.min(window.devicePixelRatio || 1, CELL.dprCap);
      viewW = w;
      viewH = h;
      const grid = gridFor(w, h);
      cols = grid.cols;
      rows = grid.rows;

      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;

      // Resizing the backing store resets the context, so every piece of state
      // below has to be set after it, every time.
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.font = cellFont(face);

      built = false;
      if (!sample()) return;

      lift = new Float32Array(grid.count);
      painted = new Float32Array(grid.count);
      paintedGlyph = new Uint8Array(grid.count);
      queued = new Uint8Array(grid.count);
      drift = new Uint8Array(grid.count);
      held = [];
      active = [];
      built = true;
    }

    /** Cheap enough to ask on any suspicion and a no-op when the answer is no,
     *  which is what lets every path simply call it. */
    function resync() {
      const rect = host!.getBoundingClientRect();
      if (
        !built ||
        Math.round(rect.width) !== viewW ||
        Math.round(rect.height) !== viewH
      ) {
        build();
      }
    }

    // ── One frame ─────────────────────────────────────────────────

    function enqueue(i: number) {
      if (queued[i]) return;
      queued[i] = 1;
      active.push(i);
    }

    /** A handful of cells, one ramp step brighter, and the oldest handed back
     *  every time a new one is taken — so the field can never brighten as it
     *  ages: it is always the same two dozen cells out of thousands. */
    function driftOnce() {
      for (let tries = 0; tries < DRIFT.tries; tries++) {
        const i = Math.floor(Math.random() * level.length);
        if (!level[i] || drift[i]) continue;

        drift[i] = 1;
        held.push(i);
        paintCell(i);

        if (held.length > DRIFT.held) {
          const old = held.shift() as number;
          drift[old] = 0;
          paintCell(old);
        }
        return;
      }
    }

    function step(elapsed: number, now: number) {
      if (!built) return;

      // Relax first, then lift. Taking the greater of the two means a cell the
      // pointer is sitting still on holds its value instead of flickering.
      for (let n = 0; n < active.length; n++) {
        const i = active[n];
        lift[i] = relax(lift[i], elapsed);
      }

      if (hasPointer) {
        const rect = host!.getBoundingClientRect();
        const px = pointerX - rect.left;
        const py = pointerY - rect.top;
        const reach = Math.ceil(POINTER.radius / CELL.size);
        const cx0 = Math.max(0, Math.floor(px / CELL.size) - reach);
        const cx1 = Math.min(cols - 1, Math.floor(px / CELL.size) + reach);
        const cy0 = Math.max(0, Math.floor(py / CELL.size) - reach);
        const cy1 = Math.min(rows - 1, Math.floor(py / CELL.size) + reach);

        for (let cy = cy0; cy <= cy1; cy++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const i = cy * cols + cx;
            if (!level[i]) continue;
            const dx = (cx + 0.5) * CELL.size - px;
            const dy = (cy + 0.5) * CELL.size - py;
            const t = liftAt(Math.sqrt(dx * dx + dy * dy));
            if (t > lift[i]) {
              lift[i] = t;
              enqueue(i);
            }
          }
        }
      }

      // Repaint only what actually changed, and keep only what still has
      // somewhere to relax to.
      const next: number[] = [];
      for (let n = 0; n < active.length; n++) {
        const i = active[n];
        const glyph = glyphAt(level[i], drift[i] === 1, lift[i]);
        if (
          glyph !== paintedGlyph[i] ||
          Math.abs(lift[i] - painted[i]) > POINTER.eps ||
          (lift[i] === 0 && painted[i] !== 0)
        ) {
          paintCell(i);
        }
        if (lift[i] > 0) next.push(i);
        else queued[i] = 0;
      }
      active = next;

      if (now - driftAt >= DRIFT.tickMs) {
        driftAt = now;
        driftOnce();
      }
    }

    // ── The power law ─────────────────────────────────────────────

    const runner = createStageRunner({
      now: () => performance.now(),
      env: readAmbientEnv,
      measure: resync,
      render,
      step,
      schedule: (fn) => requestAnimationFrame(fn),
      cancel: (handle) => cancelAnimationFrame(handle),
    });

    // ── Wiring ────────────────────────────────────────────────────

    function onPointerMove(e: PointerEvent) {
      pointerX = e.clientX;
      pointerY = e.clientY;
      hasPointer = true;
    }

    /** The pointer left the document, or the window lost focus. Either way it
     *  is no longer over the field, and the cells it was holding relax. */
    function dropPointer() {
      hasPointer = false;
    }

    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => runner.sync(), RESIZE_SETTLE_MS);
    }

    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    observer?.observe(host);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", dropPointer, { passive: true });
    window.addEventListener("blur", dropPointer);
    const unwatch = watchAmbientEnv(() => runner.sync());

    /** The mark and the real face both have to be in hand before the first
     *  render — and under reduced motion the first render is the only one. A
     *  grid measured against fallback metrics is set in the wrong face. */
    let waiting = 2;
    function ready() {
      waiting -= 1;
      if (waiting > 0 || disposed) return;
      runner.sync();
    }

    const img = new Image();
    img.onload = () => {
      mark = img;
      ready();
    };
    // No mark, no field. The home is the three bands.
    img.onerror = () => {};
    img.src = markSvgDataUri(STENCIL_PX);

    if (document.fonts?.ready) document.fonts.ready.then(ready, ready);
    else ready();

    return () => {
      disposed = true;
      runner.stop();
      clearTimeout(resizeTimer);
      observer?.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", dropPointer);
      window.removeEventListener("blur", dropPointer);
      unwatch();
    };
  }, []);

  return (
    <div ref={hostRef} aria-hidden="true" className={cn("ascii-field", className)}>
      <canvas ref={canvasRef} className="ascii-field__canvas" />
    </div>
  );
}

/** The ambient stage: the mark, rendered as a field of characters behind
 *  everything, on a single 2D canvas, non-interactive except for the pointer's
 *  lift, and asleep whenever the window is. */
const AsciiField = memo(AsciiFieldImpl);
AsciiField.displayName = "AsciiField";

export default AsciiField;
