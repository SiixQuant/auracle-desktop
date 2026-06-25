// HubSurfaces — the launcher hub's lightweight-but-REAL inspector bodies:
// Changelog, FAQ, and Support. Each is rendered inside the right-docked
// InspectorHost, so they match the rest of the control plane's card +
// dark-theme conventions. No dead controls: every button here resolves to
// a concrete action (open a URL, copy a real diagnostics blob, send mail).

import { useState } from "react";

// Bundled at build time from the repo's CHANGELOG.md — real release notes,
// shown in-app with no network dependency. (vite/client types the ?raw
// import as a string.)
import changelogText from "../../CHANGELOG.md?raw";
import {
  FAQ,
  ISSUES_URL,
  RELEASES_URL,
  SUPPORT_EMAIL,
  collectDiagnostics,
  copyToClipboard,
  openIssues,
  openReleases,
  openSupportEmail,
} from "@/lib/hub";

// ── Changelog ───────────────────────────────────────────────────────
//
// Shows the bundled CHANGELOG.md verbatim (plain text — never rendered as
// HTML) with a link out to the full GitHub releases page for older
// entries + downloads.

export function ChangelogInspector() {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Changelog</span>
        <button
          type="button"
          className="ghost btn-sm"
          onClick={() => void openReleases()}
        >
          All releases ↗
        </button>
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        What changed in each release of Auracle Desktop.
      </p>
      <pre className="changelog-text">{changelogText}</pre>
      <p className="muted fs-xs mt-3 m-0 lh-relaxed">
        Older entries and downloads live on the{" "}
        <button type="button" className="linklike" onClick={() => void openReleases()}>
          releases page
        </button>
        .
      </p>
    </div>
  );
}

// ── FAQ ─────────────────────────────────────────────────────────────
//
// A static, in-app accordion of real Q&As (lib/hub.ts). Includes the
// "where did broker connections go?" answer for the reduction.

export function FaqInspector() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">FAQ</span>
      </div>
      <div className="faq-list">
        {FAQ.map((entry, i) => {
          const isOpen = open === i;
          return (
            <div className={`faq-item${isOpen ? " is-open" : ""}`} key={i}>
              <button
                type="button"
                className="faq-q"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : i)}
              >
                <span className={`faq-chev${isOpen ? " open" : ""}`} aria-hidden="true">
                  ›
                </span>
                {entry.q}
              </button>
              {isOpen && <p className="faq-a">{entry.a}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Support ─────────────────────────────────────────────────────────
//
// Contact email + a "Copy diagnostics" button wired to a REAL diagnostics
// blob (collectDiagnostics) built from live engine/Docker/IDE probes. Copy
// it, then email it or attach it to a GitHub issue.

export function SupportInspector() {
  const [diag, setDiag] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const text = await collectDiagnostics();
      setDiag(text);
      setCopied(await copyToClipboard(text));
    } finally {
      setBusy(false);
    }
  };

  const emailUs = async () => {
    // Make sure the email carries the diagnostics — collect if not yet done.
    const body = diag ?? (await collectDiagnostics());
    setDiag(body);
    void openSupportEmail(
      "Auracle Desktop support",
      `Describe the issue here.\n\n--- diagnostics ---\n${body}`,
    );
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Support</span>
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        Stuck? Copy your diagnostics, then email us or open a GitHub issue —
        including them helps us help you faster.
      </p>

      <div className="row">
        <div>Email</div>
        <button type="button" className="ghost btn-sm" onClick={() => void emailUs()}>
          {SUPPORT_EMAIL} ↗
        </button>
      </div>
      <div className="row">
        <div>GitHub issues</div>
        <button type="button" className="ghost btn-sm" onClick={() => void openIssues()}>
          Open issues ↗
        </button>
      </div>

      <div className="mt-3">
        <button
          type="button"
          className="primary btn-sm"
          disabled={busy}
          onClick={() => void copy()}
        >
          {busy ? "Collecting…" : "Copy diagnostics"}
        </button>
        {copied && <span className="muted fs-xs ml-2">Copied to clipboard.</span>}
        {diag && !copied && !busy && (
          <span className="muted fs-xs ml-2">
            Couldn&apos;t copy automatically — select the text below.
          </span>
        )}
      </div>

      {diag && <pre className="diag-text mt-2">{diag}</pre>}

      <p className="muted fs-2xs mt-3 m-0 lh-relaxed">
        Diagnostics include your launcher version and the engine, Docker, and
        IDE status — no keys or credentials.
      </p>

      <p className="sr-only">
        Support email {SUPPORT_EMAIL}; issues at {ISSUES_URL}; releases at{" "}
        {RELEASES_URL}.
      </p>
    </div>
  );
}
