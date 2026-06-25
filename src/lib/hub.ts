// Hub surfaces — the static content + helpers behind the launcher's
// Changelog / FAQ / Support inspectors.
//
// The launcher is now a global hub: Open workspace, Settings, Updates,
// Changelog, FAQ, Support, and first-run stack setup. Connections (brokers
// and data sources) live in the IDE. These constants + helpers keep the
// hub's lightweight-but-REAL surfaces honest — every control resolves to a
// concrete URL, a bundled document, or a real IPC call.

import { cmd, openInBrowser } from "@/lib/tauri";

// Repo + contact constants (verified from README/SECURITY).
export const RELEASES_URL =
  "https://github.com/SiixQuant/auracle-desktop/releases";
export const ISSUES_URL =
  "https://github.com/SiixQuant/auracle-desktop/issues";
export const SUPPORT_EMAIL = "contact@aurapointcapital.com";

/** Open the GitHub releases page (the canonical changelog + downloads). */
export function openReleases(): Promise<void> {
  return openInBrowser(RELEASES_URL);
}

/** Open a prefilled support email in the user's mail client. */
export function openSupportEmail(subject: string, body: string): Promise<void> {
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
  return openInBrowser(url);
}

/** Open the GitHub issues page. */
export function openIssues(): Promise<void> {
  return openInBrowser(ISSUES_URL);
}

// ── FAQ ─────────────────────────────────────────────────────────────
//
// A handful of REAL questions, answered in plain language. Kept here (not
// inline in the component) so the copy is reviewable in one place and the
// component stays presentational.

export interface FaqEntry {
  q: string;
  a: string;
}

export const FAQ: FaqEntry[] = [
  {
    q: "How do I set up the trading stack?",
    a: "The first time you open the launcher it walks you through setup: install or start Docker, pull the engine's images, and install the Auracle IDE. You can re-run that any time from the home screen's “Re-run setup”.",
  },
  {
    q: "Where did broker connections go?",
    a: "Brokers and data sources now connect inside the workspace (the Auracle IDE), not the launcher. Open the workspace, then use its Connections panel to link IBKR or add a data-provider API key. The launcher is just the hub that starts the engine and opens the workspace.",
  },
  {
    q: "How do updates work?",
    a: "The launcher updates itself and installs Auracle IDE updates for you — open Updates to check and install. The engine's Docker images update from Supervision → Pull update. You never have to update the IDE by hand.",
  },
  {
    q: "The engine won't start — what do I check?",
    a: "Open Supervision from the home screen. It shows Docker's state and each container's health, with a Restart per service and Start / Stop / Pull-update for the whole stack. Most “won't start” cases are Docker not running yet.",
  },
  {
    q: "Where do I get help?",
    a: "Open Support — copy your version + engine diagnostics, then email them to us or file a GitHub issue. The more detail you include, the faster we can help.",
  },
];

// ── Diagnostics ─────────────────────────────────────────────────────
//
// There's no dedicated diagnostics IPC command, so Support assembles a
// real, copy-pasteable report from the version + live engine/Docker probes
// the launcher already exposes. Every line is sourced — never fabricated.

/** Build a plain-text diagnostics blob from real launcher + engine state.
 *  Each probe is best-effort: a failed probe is reported as such rather
 *  than omitted, so the report is honest about what couldn't be read. */
export async function collectDiagnostics(): Promise<string> {
  const lines: string[] = ["Auracle Desktop diagnostics", ""];

  const ts = new Date().toISOString();
  lines.push(`generated: ${ts}`);
  lines.push(`platform: ${navigatorPlatform()}`);

  lines.push(await probe("launcher version", () => cmd.currentVersion()));
  lines.push(
    await probe("engine installed", async () =>
      String(await cmd.isInstalled()),
    ),
  );
  lines.push(
    await probe("engine health", async () => {
      const h = await cmd.currentHealth();
      return h ? `${h.state}${h.last_error ? ` (${h.last_error})` : ""}` : "no probe yet";
    }),
  );
  lines.push(
    await probe("docker", async () => {
      const d = await cmd.dockerStatus();
      return `installed=${d.installed} running=${d.running}${
        d.version ? ` version=${d.version}` : ""
      }${d.runtime ? ` runtime=${d.runtime}` : ""}`;
    }),
  );
  lines.push(
    await probe("auracle ide", async () => {
      const i = await cmd.ideCheckUpdate();
      return `installed=${i.installed}${
        i.installed_version ? ` version=${i.installed_version}` : ""
      }${i.latest_version ? ` latest=${i.latest_version}` : ""}`;
    }),
  );

  return lines.join("\n");
}

async function probe(label: string, fn: () => Promise<string>): Promise<string> {
  try {
    return `${label}: ${await fn()}`;
  } catch (err) {
    return `${label}: (unavailable — ${String(err)})`;
  }
}

function navigatorPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.userAgent || "unknown";
}

/** Copy text to the clipboard. Returns true on success. Uses the standard
 *  Clipboard API available in the Tauri WebView. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}
