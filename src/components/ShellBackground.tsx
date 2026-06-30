// ShellBackground — the home's ambient backdrop.
//
// The SAME animated WebGL dot-reveal shader as the sign-in screen
// (CanvasRevealEffect), so the launcher home and sign-in share one living
// backdrop that moves identically — dots reveal from the centre and twinkle.
//
// Surfaces layered above this (hub cards, the inspector scrim) must NOT use a
// CSS `backdrop-filter`: macOS WebKit (the WKWebView the app runs in) cannot
// blur a WebGL canvas, so a frosted panel over one renders as a flat black
// rectangle. Instead those surfaces use translucent fills (the sign-in's own
// treatment) and the dots read softly through them. Removing backdrop-filter
// also means the Chromium dev preview now renders this exactly as WKWebView
// does — no engine-specific divergence to chase.
import { CanvasRevealEffect } from "@/components/ui/canvas-reveal-effect";

export default function ShellBackground() {
  return (
    <div className="shell-bg" aria-hidden="true">
      {/* Live shader — same component + params as the sign-in screen. */}
      <div className="shell-bg__canvas">
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
      </div>
      {/* Static dot field — shown only under prefers-reduced-motion (the canvas
          is hidden via CSS), so motion-sensitive users still get the texture. */}
      <div className="shell-bg__dots" />
      {/* Readability overlays. A flat veil + a centred vignette darken where the
          lamp/headline/verb sit; symmetric top/bottom fades keep the hub cards
          and status row legible while the dots stay bright at the edges. */}
      <div className="absolute inset-0 bg-black/15" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,0,0,0.5)_0%,_transparent_70%)]" />
      <div className="absolute top-0 left-0 right-0 h-1/3 bg-gradient-to-b from-black to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-gradient-to-t from-black to-transparent" />
    </div>
  );
}
