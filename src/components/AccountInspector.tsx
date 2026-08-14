// AccountInspector — who is signed in, and the two things that belong to them.
//
// The nav pill's account chip opens this. It is a RE-HOME: the licence card and
// the GitHub card were already written, and were living in the Settings tray
// beside engine preferences and the diagnostics drawer. They are not settings —
// they are identity — so they moved here, behind the chip that shows the
// account they belong to, and Settings kept the preferences.
//
// The one new thing is the identity row itself, and it is deliberately thin:
// the engine owns the session, so this reads it and quotes it. When there is no
// email on the session the row says the session is not readable rather than
// inventing an owner — the same law the chip's label obeys (`lib/identity.ts`).

import { useEffect, useState } from "react";

import { cmd, type AccountSession } from "@/lib/tauri";
import { GithubCard, LicenseCard } from "@/views/Settings";

export default function AccountInspector() {
  // undefined = the probe hasn't answered; null = it answered with nothing.
  const [session, setSession] = useState<AccountSession | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    cmd
      .clerkSession()
      .then((s) => !cancelled && setSession(s))
      .catch(() => !cancelled && setSession(null));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <span className="card-title">Signed in</span>
          {session?.tier && <span className="chip neutral">{session.tier}</span>}
        </div>
        {session === undefined ? (
          <div className="muted fs-sm">Checking…</div>
        ) : session?.email ? (
          <div className="row">
            <span className="key-label">email</span>
            <span className="mono fs-sm">{session.email}</span>
          </div>
        ) : (
          // No fabricated owner. The chip that opened this panel says the same
          // thing in one word ("account"), and this says it in a sentence.
          <p className="muted fs-sm m-0 lh-relaxed">
            The engine isn&apos;t reporting a signed-in account right now. Your
            licence and GitHub sign-in below are unaffected — they live on this
            machine.
          </p>
        )}
        <p className="muted fs-xs mt-2 m-0 lh-relaxed">
          The session is the engine&apos;s, shared with the Auracle IDE — signing
          in on either app signs you in on both.
        </p>
      </div>

      <LicenseCard />
      <GithubCard />
    </>
  );
}
