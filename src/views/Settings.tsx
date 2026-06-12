// Settings — view-mode toggle, install + Docker state, launcher updates.
//
// License management lives on the Dashboard so customers see it on
// first launch. Keeping it out of Settings avoids two places to
// enter the same key + the confusion that comes with that.

import { useEffect, useState } from "react";

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

    cmd.dockerStatus()
      .then((s) => setDocker(s))
      .catch((err) => {
        // Defense-in-depth: backend used to swallow spawn errors and
        // never resolve, leaving the UI stuck on "checking..." forever.
        // It's fixed in 0.2.2+ but a stuck label is worse than a wrong
        // one, so render a fallback if the promise still rejects.
        setDocker("error");
        setDockerError(String(err));
      });

    cmd.currentVersion().then(setVersion).catch(() => setVersion("?"));
  }, []);

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
    setResultText("Downloading…");
    try {
      await cmd.installUpdate();
      setResultText(
        "Installed but restart did not fire — quit + relaunch manually.",
      );
    } catch (err) {
      const msg = String(err);
      if (/closed|connection/i.test(msg)) {
        setResultText("Restarting on the new version…");
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
          <DockerStatusBadge status={docker} error={dockerError} />
        </div>
        <div className="row">
          <div>
            <div>Auracle Desktop launcher version</div>
            <div className="muted mono">v{version}</div>
            {resultText && (
              <div className="muted mono mt-2">
                {resultText}
              </div>
            )}
          </div>
          {updateAvailable ? (
            <button
              type="button"
              className="primary"
              disabled={updating}
              onClick={installUpdate}
            >
              {updating ? "Installing…" : `Download + Install v${info!.version}`}
            </button>
          ) : (
            <button
              type="button"
              className="ghost"
              disabled={checking}
              onClick={check}
            >
              {checking ? "Checking…" : "Check for Update"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function DockerStatusBadge({
  status,
  error,
}: {
  status: DockerStatus | null | "error";
  error: string | null;
}) {
  if (status === null) return <div className="muted mono">checking…</div>;

  if (status === "error") {
    return (
      <div className="muted mono">
        <span className="badge err">check failed</span>
        {error ? ` — ${error}` : null}
      </div>
    );
  }

  if (!status.installed) {
    return (
      <div className="muted mono">
        <span className="badge err">not installed</span>
        {" — "}
        <a
          href="#"
          onClick={async (e) => {
            e.preventDefault();
            try {
              const url = await cmd.dockerInstallUrl();
              await openInBrowser(url);
            } catch (err) {
              console.warn("docker install url fetch failed:", err);
            }
          }}
        >
          install Docker Desktop
        </a>
      </div>
    );
  }

  if (!status.running) {
    return (
      <div className="muted mono">
        <span className="badge warn">installed but not running</span> — start
        Docker Desktop
      </div>
    );
  }

  return (
    <div className="muted mono">
      <span className="badge ok">running</span>
      {" "}
      {status.version || "docker"}
    </div>
  );
}

