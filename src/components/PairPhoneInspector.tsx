// PairPhoneInspector — hand this engine to a phone (Auracle iOS spine, M5).
//
// Mints a short-lived single-use pairing code from the engine, wraps it
// with this Mac's LAN URL into a QR, and — before showing anything
// scannable — reports whether the engine actually answers at that LAN
// address. The compose default binds the engine to loopback, so the
// truthful first-run state here is "LAN access is off" with the exact
// opt-in, never a QR that can't work. Palette-reachable (beta) while the
// iOS app is pre-release; the engine side of pairing is live either way.

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

import { cmd, type PairInfo } from "@/lib/tauri";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "lan-off"; info: PairInfo }
  | { kind: "ready"; info: PairInfo; qr: string; expiresAt: number };

export default function PairPhoneInspector() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());

  const mint = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const info = await cmd.mobilePairInfo();
      if (!info.reachable || !info.url) {
        setPhase({ kind: "lan-off", info });
        return;
      }
      // The iOS app's pair deep-link: engine URL + the single-use token.
      const payload =
        `auracle://pair?u=${encodeURIComponent(info.url)}` +
        `&t=${encodeURIComponent(info.token)}`;
      const qr = await QRCode.toDataURL(payload, { width: 480, margin: 1 });
      setPhase({
        kind: "ready",
        info,
        qr,
        expiresAt: Date.now() + info.expires_in * 1000,
      });
    } catch (err) {
      setPhase({ kind: "error", message: String(err) });
    }
  }, []);

  useEffect(() => {
    void mint();
  }, [mint]);

  // 1s tick for the expiry countdown — only while a code is on screen.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase.kind]);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Pair a phone</span>
        <button type="button" className="ghost btn-sm" onClick={() => void mint()}>
          New code
        </button>
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        Point the Auracle iPhone app (beta) at this engine. Codes are
        single-use and live for five minutes; the phone must be on the same
        network as this Mac.
      </p>
      <PairBody phase={phase} now={now} />
    </div>
  );
}

function PairBody({ phase, now }: { phase: Phase; now: number }) {
  switch (phase.kind) {
    case "loading":
      return <p className="muted fs-sm m-0">Minting a pairing code…</p>;

    case "error":
      return (
        <p className="muted fs-sm m-0 lh-relaxed">
          Couldn&apos;t mint a pairing code: {phase.message}
        </p>
      );

    case "lan-off":
      // The engine answered on loopback but not at the LAN address — the
      // secure default. Say exactly how to opt in; never render a QR that
      // can't connect.
      return (
        <div className="pair-lanoff">
          <p className="fs-sm m-0 mb-2 lh-relaxed">
            This engine isn&apos;t reachable from your network yet — by
            default it only answers on this Mac.
          </p>
          <ol className="pair-steps muted fs-sm">
            <li>
              Add <code>AURACLE_LAN_BIND=0.0.0.0</code> to the stack&apos;s{" "}
              <code>.env</code>
            </li>
            <li>Restart the engine</li>
            <li>Press &ldquo;New code&rdquo; above to check again</li>
          </ol>
          <p className="muted fs-xs m-0 lh-relaxed">
            Every request still needs your sign-in either way — this only
            changes who can knock.
            {phase.info.lan_ip
              ? ` This Mac's network address is ${phase.info.lan_ip}.`
              : " (No network address found — is this Mac online?)"}
          </p>
        </div>
      );

    case "ready": {
      const remaining = Math.max(
        0,
        Math.floor((phase.expiresAt - now) / 1000),
      );
      const mm = Math.floor(remaining / 60);
      const ss = String(remaining % 60).padStart(2, "0");
      return (
        <div className="pair-qr-wrap">
          <div className="pair-qr-tile">
            <img src={phase.qr} alt="Pairing QR code" width={200} height={200} />
          </div>
          <div className="pair-qr-side">
            <ol className="pair-steps muted fs-sm">
              <li>Install Auracle on your iPhone (beta)</li>
              <li>Choose &ldquo;Scan to pair&rdquo;</li>
              <li>Point the camera at this code</li>
            </ol>
            <p className="pair-url m-0">{phase.info.url}</p>
            <p className="muted fs-xs m-0 mt-2">
              {remaining > 0
                ? `Code expires in ${mm}:${ss}`
                : "This code expired — press New code."}
            </p>
          </div>
        </div>
      );
    }
  }
}
