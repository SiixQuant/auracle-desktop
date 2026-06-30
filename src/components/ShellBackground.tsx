// ShellBackground — the home's ambient backdrop: a CSS-rendered dot field.
//
// Deliberately NOT a WebGL canvas. macOS WebKit (the WKWebView the app runs in)
// cannot apply a CSS `backdrop-filter` blur over a WebGL canvas, so glass panels
// layered above one render as flat dark rectangles instead of frosted glass. A
// CSS/DOM dot field IS blurrable, so the inspector panels and hub cards become
// real frosted glass — the dots blur softly through them, iOS-style. (Bonus: no
// three.js / WebGL dependency in the bundle.)
export default function ShellBackground() {
  return (
    <div className="shell-bg" aria-hidden="true">
      <div className="shell-bg__dots" />
      {/* Readability overlays — flat veil + a soft centered vignette + symmetric
          top/bottom fades. Kept light: the dots must stay visible enough to
          read through the frosted panels above them. */}
      <div className="absolute inset-0 bg-black/12" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(0,0,0,0.35)_0%,_transparent_100%)]" />
      <div className="absolute top-0 left-0 right-0 h-1/3 bg-gradient-to-b from-black to-transparent" />
      <div className="absolute bottom-0 left-0 right-0 h-1/3 bg-gradient-to-t from-black to-transparent" />
    </div>
  );
}
