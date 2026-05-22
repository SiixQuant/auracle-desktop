// Dashboard — the launcher's home view.
//
// Three sections render conditionally:
//
//   1. License activation card — only when no license key is stored
//      in the OS keychain. First thing a customer sees on first
//      launch so they can't miss it.
//
//   2. Quick Actions — "Open Auracle" always; other actions only
//      when there's something to act on.
//
//   3. Containers — only when the launcher detects an installed
//      stack. When no install is present (AURACLE_INSTALL_DIR
//      missing/empty), the section is silently omitted rather than
//      showing a "backend unavailable" error.
//
// Stack status polls every 5s while this view is mounted. The
// effect cleanup tears the interval down on unmount so we're not
// spawning a docker-compose-ps subprocess every 5s after the user
// switches tabs.

import { useEffect, useState } from "react";

import {
  cmd,
  openInBrowser,
  type ContainerStatus,
  type StackStatus,
} from "@/lib/tauri";

export default function Dashboard() {
  return (
    <>
      <h1>Auracle</h1>
      <LicenseSection />
      <h2>Quick Actions</h2>
      <div className="card">
        <div className="row">
          <div>Open the Auracle dashboard in your browser</div>
          <OpenAuracleButton />
        </div>
      </div>
      <ContainersSection />
    </>
  );
}

// ── Open Auracle ────────────────────────────────────────────────

function OpenAuracleButton() {
  const onClick = async () => {
    // Two-mode open: embedded WebviewWindow (native feel) or
    // external browser. Preference lives in view-mode.json; default
    // is 'browser' for fresh installs (matches pre-v0.2.0 behavior).
    let mode: "browser" | "embedded" = "browser";
    try {
      mode = await cmd.getViewMode();
    } catch {
      // Backend unavailable — fall through to the browser path.
    }

    if (mode === "embedded") {
      try {
        await cmd.openEmbeddedAuracle();
        return;
      } catch (err) {
        // Embedded window failed to spawn — fall through to browser
        // so the customer still gets where they were going.
        console.warn("embedded open failed, falling back to browser:", err);
      }
    }

    // Browser path: prefer the dashboard URL if the stack is
    // healthy, otherwise drop the user on /ui/setup so they can
    // diagnose the failed startup.
    let url = "http://localhost:1969/ui/setup";
    try {
      const h = await cmd.currentHealth();
      if (h?.state === "healthy") url = "http://localhost:1969/ui/dashboard";
    } catch {
      // ignore
    }
    await openInBrowser(url);
  };

  return (
    <button type="button" className="primary" onClick={onClick}>
      Open Auracle
    </button>
  );
}

// ── License activation ──────────────────────────────────────────

function LicenseSection() {
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);

  const refresh = async () => {
    try {
      const value = await cmd.licenseGet();
      setStored(value);
    } catch {
      // Keychain access failed — likely first launch with no
      // permission yet. Show the prompt so they can save one
      // (which will trigger the keychain permission grant).
      setStored(null);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  if (stored === undefined) {
    return null; // initial fetch in flight
  }

  if (stored && !editing) {
    return (
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <strong>License active</strong>
          <div className="muted mono" style={{ marginTop: 2 }}>
            {stored.slice(0, 16)}…
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="badge ok">activated</span>
          <button
            type="button"
            className="ghost"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
          <button
            type="button"
            className="ghost danger"
            onClick={async () => {
              if (
                !confirm(
                  "Remove the stored license key? You can paste it again from your email anytime.",
                )
              )
                return;
              try {
                await cmd.licenseClear();
                refresh();
              } catch (err) {
                alert("Could not clear: " + err);
              }
            }}
          >
            Clear
          </button>
        </div>
      </div>
    );
  }

  return (
    <ActivationCard
      onSaved={() => {
        setEditing(false);
        refresh();
      }}
    />
  );
}

function ActivationCard({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setStatus("Paste a key first.");
      return;
    }
    try {
      await cmd.licenseSet(v);
      setStatus("Saved.");
      setTimeout(onSaved, 600);
    } catch (err) {
      setStatus("Could not save: " + err);
    }
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Activate Auracle</h2>
      <p className="muted" style={{ margin: "0 0 12px" }}>
        Paste the license key from your purchase email.
      </p>
      <input
        type="password"
        placeholder="akey_…"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div
        style={{
          marginTop: 12,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button type="button" className="primary" onClick={save}>
          Save
        </button>
        <span className="muted mono">{status}</span>
      </div>
    </div>
  );
}

// ── Containers ──────────────────────────────────────────────────

function ContainersSection() {
  const [status, setStatus] = useState<StackStatus | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let handle: number | undefined;

    const tick = async () => {
      try {
        const s = await cmd.stackStatus();
        if (!cancelled) setStatus(s);
      } catch {
        // Transient docker-compose error — leave the previous paint
        // up rather than blanking the section.
        if (!cancelled && status === undefined) setStatus(null);
      }
    };

    tick().then(() => {
      if (!cancelled) handle = window.setInterval(tick, 5_000);
    });

    return () => {
      cancelled = true;
      if (handle !== undefined) window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === undefined) return null;             // initial probe in flight
  if (!status || status.containers.length === 0) {
    return null;                                     // no install — silent
  }

  return (
    <>
      <h2>Containers</h2>
      <div className="card">
        {status.containers.map((c) => (
          <div className="row" key={c.name}>
            <div>
              <strong>{c.name}</strong>
              <div className="muted mono" style={{ marginTop: 2 }}>
                state: {c.state}
                {c.health ? ` · health: ${c.health}` : ""}
              </div>
            </div>
            {badgeFor(c)}
          </div>
        ))}
      </div>
    </>
  );
}

function badgeFor(c: ContainerStatus) {
  if (c.state !== "running")    return <span className="badge err">down</span>;
  if (c.health === "unhealthy") return <span className="badge err">unhealthy</span>;
  if (c.health === "starting")  return <span className="badge warn">starting</span>;
  return <span className="badge ok">healthy</span>;
}
