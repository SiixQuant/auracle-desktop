import { lazy, Suspense } from "react";

// Reuse the sign-in screen's exact animated dot-matrix background so the home
// matches it. Lazy so the WebGL/three deps stay in the shared sign-in chunk
// rather than the main bundle.
const CanvasRevealEffect = lazy(() =>
  import("@/components/ui/sign-in-flow-1").then((m) => ({
    default: m.CanvasRevealEffect,
  })),
);

/** The sign-in background, rendered fixed behind the home content. */
export default function ShellBackground() {
  return (
    <div className="shell-bg" aria-hidden="true">
      <Suspense fallback={null}>
        <CanvasRevealEffect
          animationSpeed={3}
          containerClassName="bg-black"
          colors={[
            [255, 255, 255],
            [255, 255, 255],
          ]}
          dotSize={6}
          reverse={false}
        />
      </Suspense>
      {/* Same overlays as the sign-in: darken the centre for legibility, fade
          the top edge. */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,0,0,1)_0%,_transparent_100%)]" />
      <div className="absolute top-0 left-0 right-0 h-1/3 bg-gradient-to-b from-black to-transparent" />
    </div>
  );
}
