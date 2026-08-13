// OrreryEcho — the instrument, small and still, at the top of the tray.
//
// Design authority: launcher-redesign-direction.md §3.4 (supervision: "a
// miniature static orrery echo (same encoding as home — teaches the mapping)").
// Slice 6 of the redesign.
//
// Opening Supervision is opening the back of the instrument, so the back opens
// on the instrument. The echo draws the SAME FRAME the home is drawing — the
// value arrives from the Shell rather than being re-derived here, so the two
// cannot disagree — with the same ring style, the same core hue, the same body
// ink, and bodies on the same seats (`seatPoint` walks the orbit exactly the
// way MotionPath carries the live ones). Read the ring above the list, then
// read the list: the amber dot up there is the amber row down here.
//
// Three things it deliberately does NOT do:
//
//   · turn. A second orbit revolving inside a tray would compete with the one
//     on the board behind it and say nothing the home isn't already saying.
//     Still is also free: no tween, no ticker load, §4's budget untouched.
//   · claim. It carries no words, no counts and no hover flags — the ledger
//     under it is where a container's own report is quoted.
//   · interact. The home's instrument is a button because it is a door to
//     here; from inside, that door leads nowhere, and a control that does
//     nothing is a dead control.

import {
  ECHO,
  ECHO_CHROME_DOTS,
  GEOM,
  RING_GAPPED_PATH,
  RING_PATH,
  SEAM_PATH,
  seatPoint,
  type OrreryFrame,
} from "@/fx/orrery";

export default function OrreryEcho({ frame }: { frame: OrreryFrame }) {
  return (
    <div className="orrery-echo" aria-hidden="true">
      <svg
        className="orrery__svg"
        viewBox={ECHO.viewBox}
        width={ECHO.size}
        height={ECHO.height}
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

        {frame.chrome &&
          ECHO_CHROME_DOTS.map((dot) => (
            <circle
              key={`${dot.x},${dot.y}`}
              className="orrery__chrome"
              cx={dot.x}
              cy={dot.y}
              r={dot.r}
            />
          ))}

        <g className="orrery__core" data-tone={frame.core}>
          <circle
            className="orrery__halo"
            cx={GEOM.cx}
            cy={GEOM.cy}
            r={ECHO.halo}
          />
          <circle
            className="orrery__dot"
            cx={GEOM.cx}
            cy={GEOM.cy}
            r={ECHO.core}
          />
        </g>

        {frame.bodies.map((body) => {
          const seat = seatPoint(body.seed);
          return (
            <circle
              key={body.id}
              className="orrery__mass"
              data-tone={body.tone}
              cx={seat.x}
              cy={seat.y}
              r={ECHO.body}
            />
          );
        })}
      </svg>
    </div>
  );
}
