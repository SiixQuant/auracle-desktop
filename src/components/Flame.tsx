// Flame — the official Auracle mark (white flame "A" with an emerald
// inner core; source of truth: auracle/branding/auracle-mark.svg).
//
// Three forms:
//   <Flame />                 small static mark for the rail/brand.
//   <Flame animated fill />   hero treatment — the mark seated on a
//                             dark disc with two slowly-pulsing emerald
//                             aura rings ("aura" + "oracle"). `fill`
//                             stretches it to its container.

export default function Flame({
  size = 22,
  animated = false,
  fill = false,
}: {
  size?: number;
  animated?: boolean;
  fill?: boolean;
}) {
  const dim = fill
    ? ({ width: "100%", height: "100%" } as const)
    : ({ width: size, height: size } as const);

  if (animated) {
    return (
      <svg
        {...dim}
        viewBox="0 0 160 160"
        aria-hidden="true"
        style={fill ? { position: "absolute", inset: 0 } : undefined}
      >
        <circle className="flame-aura" cx="80" cy="80" r="50" fill="none" stroke="#10b981" strokeWidth="1.4" />
        <circle className="flame-aura b" cx="80" cy="80" r="34" fill="none" stroke="#10b981" strokeWidth="1.4" />
        <circle cx="80" cy="80" r="22" fill="#0f151c" />
        <g transform="translate(62,62) scale(1.15)">
          <path d="M16 3 L29 27 L22 27 L16 16 L10 27 L3 27 Z" fill="#f3f6f9" />
          <path d="M16 11 L21 21 L11 21 Z" fill="#10b981" />
        </g>
      </svg>
    );
  }

  return (
    <svg {...dim} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3 L29 27 L22 27 L16 16 L10 27 L3 27 Z" fill="#f3f6f9" />
      <path d="M16 11 L21 21 L11 21 Z" fill="#10b981" />
    </svg>
  );
}
