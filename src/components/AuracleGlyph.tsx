// Auracle orbital mark — the brand glyph (vector-traced from the master art).
// Uses currentColor, so it inherits the surrounding text color: ink on the
// cream home, and it flips automatically inside the black tray. One source for
// every in-app placement of the mark.
//
// The vectors themselves live in `fx/glyph.ts` — this component is the mark as
// an SVG element, and the ambient field (`fx/ascii.ts`) is the same mark
// as a raster stencil. Two consumers, one set of paths, so neither can drift.
import { GLYPH_ART } from "@/fx/glyph";

export function AuracleGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox={GLYPH_ART.viewBox}
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <g transform={GLYPH_ART.transform}>
        {GLYPH_ART.paths.map((d) => (
          <path key={d.slice(0, 12)} d={d} />
        ))}
      </g>
    </svg>
  );
}
