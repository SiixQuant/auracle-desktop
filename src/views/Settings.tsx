// Settings — install + Docker state, launcher updates, broker connections.
//
// License management lives on the Dashboard so customers see it on
// first launch. Keeping it out of Settings avoids two places to
// enter the same key + the confusion that comes with that.

import { useEffect, useState } from "react";

import ConfirmRow from "@/components/ConfirmRow";
import IncidentCard from "@/components/IncidentCard";
import {
  cmd,
  openInBrowser,
  type DockerStatus,
  type UpdateInfo,
} from "@/lib/tauri";

export default function Settings() {
  return (
    <div className="settings">
      <h1>Settings</h1>
      <div className="settings-grid">
        <div className="sgcell"><LicenseCard /></div>
        <div className="sgcell"><SystemCard /></div>
      </div>
    </div>
  );
}

// ── License ──────────────────────────────────────────────────────
//
// Moved here from the home in the v7.1 hub: license is a one-time
// global setup, not a daily glance. The rail shows the tier
// (Community / Licensed); full management lives here.

function LicenseCard() {
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStored(await cmd.licenseGet());
    } catch {
      setStored(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (stored === undefined) return null;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">License</span>
        {stored && !editing && <span className="badge ok">activated</span>}
      </div>
      {stored && !editing ? (
        <>
          <div className="wrap-row">
            <span className="mono fs-sm" style={{ flex: 1 }}>{stored.slice(0, 16)}…</span>
            <button type="button" className="ghost btn-sm" onClick={() => setEditing(true)}>
              Change
            </button>
            <ConfirmRow
              trigger="Clear"
              title="Remove the stored license key?"
              body="You can paste it again from your purchase email anytime."
              confirmLabel="Remove"
              compact
              onConfirm={async () => {
                setClearError(null);
                try {
                  await cmd.licenseClear();
                  await refresh();
                } catch (err) {
                  setClearError("Could not clear: " + err);
                }
              }}
            />
          </div>
          {clearError && <div className="err-text fs-xs mt-2">{clearError}</div>}
        </>
      ) : (
        <ActivationCard
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      )}
    </div>
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
      // Flip the running engine's tier now (best-effort). The web License
      // page used to do this; the portal is gone, so the launcher owns it.
      // The key is already in the vault, so engine-unreachable is not fatal.
      try {
        const tier = await cmd.licenseActivateEngine(v);
        setStatus(
          tier
            ? `Activated — ${tier} tier.`
            : "Saved. The engine will apply it on next start.",
        );
      } catch (err) {
        setStatus("Saved to the vault, but the engine couldn't activate it: " + err);
      }
      setTimeout(onSaved, 800);
    } catch (err) {
      setStatus("Could not save: " + err);
    }
  };

  return (
    <>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        You&apos;re on the free plan. Paste a key to upgrade.
      </p>
      <form
        className="hstack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          placeholder="Paste license key (akey_…)"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="primary btn-sm">
          Save
        </button>
      </form>
      <div className="hstack mt-2">
        <span
          className={
            /^(Could not|Paste)/.test(status) ? "err-text fs-xs" : "muted mono fs-xs"
          }
        >
          {status}
        </span>
      </div>
    </>
  );
}

// ── System (install · docker · launcher updates) ────────────────
//
// Installation and Updates were two sections for one concern —
// "system & maintenance." Merged into a single card: install
// directory, Docker state, and the launcher version + update
// control, in that order.

function SystemCard() {
  // Install + Docker
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLabel, setInstallLabel] = useState("Run First-Time Install");
  const [docker, setDocker] = useState<DockerStatus | null | "error">(null);
  const [dockerError, setDockerError] = useState<string | null>(null);

  // Launcher updates
  const [version, setVersion] = useState("?");
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [resultText, setResultText] = useState("");
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    cmd.isInstalled().then((v) => {
      setInstalled(v);
      setInstallLabel(v ? "Already installed" : "Run First-Time Install");
    });

    void loadDocker();

    cmd.currentVersion().then(setVersion).catch(() => setVersion("?"));
  }, []);

  // Defense-in-depth: the backend used to swallow spawn errors and
  // never resolve, leaving the UI stuck on "checking..." forever.
  // Fixed in 0.2.2+, but a stuck label is worse than a wrong one, so
  // a rejection still lands as an explicit error state — and the
  // incident card can retry it.
  const loadDocker = async () => {
    try {
      const s = await cmd.dockerStatus();
      setDocker(s);
      setDockerError(null);
    } catch (err) {
      setDocker("error");
      setDockerError(String(err));
    }
  };

  const runInstall = async () => {
    setInstalling(true);
    setInstallLabel("Installing…");
    try {
      await cmd.runFirstInstall();
      setInstallLabel("Done — restart launcher to continue");
    } catch (err) {
      setInstallLabel("Failed: " + String(err));
      setInstalling(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setResultText("");
    try {
      const got = await cmd.checkForUpdate();
      setInfo(got);
      if (!got.available) {
        setResultText(`Up to date (v${got.current}).`);
      }
    } catch (err) {
      setResultText("Error: " + String(err));
    } finally {
      setChecking(false);
    }
  };

  const installUpdate = async () => {
    setUpdating(true);
    setResultText("");
    try {
      await cmd.installUpdate();
      // install_update restarts the process before replying, so a
      // resolved promise means the reply raced the exit — it is the
      // same restart, not a separate outcome.
      setResultText("Restarting on the new version.");
    } catch (err) {
      const msg = String(err);
      // The backend dying mid-invoke IS the success signal; match the
      // strings each webview emits when the process goes away.
      if (/closed|connection|communicating|reset/i.test(msg)) {
        setResultText("Restarting on the new version.");
      } else {
        setResultText("Install failed: " + msg);
        setUpdating(false);
      }
    }
  };

  const updateAvailable = info?.available && !!info.version;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">System</span>
      </div>
        <div className="row">
          <div>Trading engine</div>
          {installed ? (
            <span className="chip ok">installed</span>
          ) : (
            <button
              type="button"
              className="ghost btn-sm"
              disabled={installed === null || installing}
              onClick={runInstall}
            >
              {installLabel}
            </button>
          )}
        </div>
        <div className="row">
          <div>Docker</div>
          <DockerChip status={docker} />
        </div>
        <DockerIncident
          status={docker}
          error={dockerError}
          onRetry={loadDocker}
        />
        <div className="row">
          <div className="hstack">
            <span>Launcher</span>
            <span className="muted mono fs-xs">v{version}</span>
            {updateAvailable && (
              <span className="chip warn">v{info!.version} available</span>
            )}
          </div>
          {updateAvailable ? (
            <button
              type="button"
              className="primary btn-sm"
              disabled={updating}
              onClick={installUpdate}
            >
              {updating ? "Installing…" : `Install v${info!.version}`}
            </button>
          ) : (
            <button
              type="button"
              className="ghost btn-sm"
              disabled={checking}
              onClick={check}
            >
              {checking ? "Checking…" : "Check for update"}
            </button>
          )}
        </div>
        {updateAvailable && info?.notes && (
          <div className="mt-2">
            <div className="muted fs-2xs mb-2">Release notes</div>
            <div
              className="muted fs-xs lh-relaxed"
              style={{ maxHeight: 66, overflow: "hidden", whiteSpace: "pre-line" }}
            >
              {info.notes}
            </div>
          </div>
        )}
        {updating && !resultText && (
          <div className="banner info mt-2 m-0">
            Downloading and installing — the launcher will restart
            automatically.
          </div>
        )}
        {resultText && (
          <div
            className={
              /^(Install failed|Error)/.test(resultText)
                ? "err-text fs-xs mt-2"
                : "muted fs-xs mt-2"
            }
          >
            {resultText}
          </div>
        )}
      </div>
  );
}

/** Glance tier: the chip that lives in the Docker row's right cell.
 *  Incident states escalate to a full-width IncidentCard BELOW the
 *  row (banners are never row children) — see DockerIncident. */
function DockerChip({ status }: { status: DockerStatus | null | "error" }) {
  if (status === null) return <span className="chip neutral">checking</span>;
  if (status === "error") return <span className="chip err">check failed</span>;
  if (!status.installed) return <span className="chip err">not installed</span>;
  if (!status.running) return <span className="chip warn">not running</span>;
  return <span className="chip ok">running</span>;
}

/** Act tier: the shared incident contract for the three Docker
 *  failure states. Healthy and checking render nothing here. */
function DockerIncident({
  status,
  error,
  onRetry,
}: {
  status: DockerStatus | null | "error";
  error: string | null;
  onRetry: () => Promise<void>;
}) {
  if (status === null) return null;

  if (status === "error") {
    return (
      <IncidentCard
        severity="err"
        cause="Docker status check failed."
        detail={error ?? undefined}
        action={{ label: "Retry", onClick: onRetry }}
      />
    );
  }
  if (!status.installed) {
    return (
      <IncidentCard
        severity="err"
        cause="Docker Desktop is not installed."
        action={{
          label: "Download Docker Desktop",
          onClick: async () => {
            try {
              const url = await cmd.dockerInstallUrl();
              await openInBrowser(url);
            } catch (err) {
              console.warn("docker install url fetch failed:", err);
            }
          },
        }}
      />
    );
  }
  if (!status.running) {
    return (
      <IncidentCard
        severity="warn"
        cause="Docker is installed but not running."
        detail="Open Docker Desktop to start it, then return here."
      />
    );
  }
  return null;
}
