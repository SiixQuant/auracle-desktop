// Settings — view-mode toggle, install + Docker state, launcher updates.
//
// License management lives on the Dashboard so customers see it on
// first launch. Keeping it out of Settings avoids two places to
// enter the same key + the confusion that comes with that.

import { useEffect, useState } from "react";

import IncidentCard from "@/components/IncidentCard";
import BrokerConnectionsCard from "@/views/BrokerConnections";
import {
  cmd,
  openInBrowser,
  type DockerStatus,
  type UpdateInfo,
  type ViewMode,
} from "@/lib/tauri";

export default function Settings() {
  return (
    <>
      <h1>Settings</h1>
      <WorkspaceCard />
      <BrokerConnectionsCard />
      <SystemCard />
    </>
  );
}

// ── Workspace ───────────────────────────────────────────────────
//
// How the one platform door ("Open Auracle") opens. A binary choice
// — rendered as a compact segmented toggle (same control language as
// Forge's Agent|Code switch) instead of a two-radio block, with a
// one-line caption describing the active choice.

function WorkspaceCard() {
  const [mode, setMode] = useState<ViewMode>("browser");

  useEffect(() => {
    cmd.getViewMode().then(setMode).catch(() => setMode("browser"));
  }, []);

  const change = async (next: ViewMode) => {
    setMode(next);
    try {
      await cmd.setViewMode(next);
    } catch (err) {
      // Persistence failed — log + leave the UI showing the
      // intent. The next reload will reconcile from disk.
      console.warn("set_view_mode failed:", err);
    }
  };

  return (
    <>
      <h2>Workspace</h2>
      <div className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <div>
            <div>Where Open Auracle opens</div>
            <div className="muted fs-sm mt-1">
              {mode === "embedded"
                ? "In its own window. Feels native, uses a bit more memory."
                : "In your default browser. Uses less memory."}
            </div>
          </div>
          <div className="seg-toggle" role="tablist" aria-label="Open Auracle in">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "browser"}
              className={`seg-tab ${mode === "browser" ? "active" : ""}`}
              onClick={() => change("browser")}
            >
              Browser
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "embedded"}
              className={`seg-tab ${mode === "embedded" ? "active" : ""}`}
              onClick={() => change("embedded")}
            >
              Embedded
            </button>
          </div>
        </div>
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
  const [installPath, setInstallPath] = useState("checking…");
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
    cmd.installPath()
      .then((p) => setInstallPath(p))
      .catch((err) => setInstallPath("unavailable: " + String(err)));

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
    <>
      <h2>System</h2>
      <div className="card">
        <div className="row">
          <div>
            <div>Auracle install directory</div>
            <div className="muted mono">{installPath}</div>
          </div>
          <button
            type="button"
            className="ghost"
            disabled={installed === null || installed || installing}
            onClick={runInstall}
          >
            {installLabel}
          </button>
        </div>
        <div className="row">
          <div>Docker Desktop</div>
          <DockerChip status={docker} />
        </div>
        <DockerIncident
          status={docker}
          error={dockerError}
          onRetry={loadDocker}
        />
        <div className="pane-head mt-4">
          <span className="pane-head__label">Launcher version</span>
          <div className="pane-head__actions">
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
                {checking ? "Checking…" : "Check for Update"}
              </button>
            )}
          </div>
        </div>
        <div className="hstack">
          <span className="muted mono">v{version}</span>
          {updateAvailable && (
            <span className="chip warn">v{info!.version} available</span>
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
    </>
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
  return (
    <div className="hstack">
      <span className="chip ok">running</span>
      <span className="muted mono fs-xs">{status.version || "docker"}</span>
    </div>
  );
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
