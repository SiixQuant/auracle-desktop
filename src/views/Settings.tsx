// Settings — view-mode toggle, install + Docker state, launcher updates.
//
// License management lives on the Dashboard so customers see it on
// first launch. Keeping it out of Settings avoids two places to
// enter the same key + the confusion that comes with that.

import { useEffect, useState } from "react";

import {
  cmd,
  openInBrowser,
  pickDirectory,
  type DockerStatus,
  type UpdateInfo,
  type ViewMode,
} from "@/lib/tauri";

export default function Settings() {
  return (
    <>
      <h1>Settings</h1>
      <ViewModeCard />
      <ForgeCard />
      <InstallCard />
      <UpdatesCard />
    </>
  );
}

// ── Forge ───────────────────────────────────────────────────────

function ForgeCard() {
  const [keyState, setKeyState] = useState<"loading" | "set" | "unset">(
    "loading",
  );
  const [keyHint, setKeyHint] = useState<string>("");
  const [editingKey, setEditingKey] = useState(false);
  const [stratDir, setStratDir] = useState<string>("loading…");
  const [savingDir, setSavingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  const refreshKey = async () => {
    try {
      const v = await cmd.anthropicKeyGet();
      if (v) {
        setKeyState("set");
        // Show a short prefix so the operator can confirm WHICH key
        // is stored (multiple Anthropic workspace keys is common) —
        // but never expose enough to reconstruct.
        setKeyHint(v.slice(0, 12) + "…");
      } else {
        setKeyState("unset");
        setKeyHint("");
      }
    } catch (err) {
      setKeyState("unset");
      setKeyHint(String(err));
    }
  };

  const refreshDir = async () => {
    try {
      const p = await cmd.forgeStrategiesDir();
      setStratDir(p);
    } catch (err) {
      setStratDir("unavailable: " + String(err));
    }
  };

  useEffect(() => {
    refreshKey();
    refreshDir();
  }, []);

  const browseDir = async () => {
    setDirError(null);
    try {
      const picked = await pickDirectory({
        title: "Pick the strategies directory",
        defaultPath: stratDir.startsWith("/") ? stratDir : undefined,
      });
      if (!picked) return; // user cancelled
      setSavingDir(true);
      await cmd.forgeSetStrategiesDir(picked);
      setStratDir(picked);
    } catch (err) {
      setDirError(String(err));
    } finally {
      setSavingDir(false);
    }
  };

  return (
    <>
      <h2>Forge</h2>
      <div className="card">
        <div className="row">
          <div>
            <div>Anthropic API key</div>
            <div className="muted mono">
              {keyState === "loading"
                ? "checking…"
                : keyState === "set"
                  ? keyHint
                  : "not set"}
            </div>
          </div>
          {keyState === "set" && !editingKey && (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="ghost"
                onClick={() => setEditingKey(true)}
              >
                Change
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={async () => {
                  if (
                    !confirm(
                      "Remove the stored Anthropic key? Chat in Forge will stop working until you set it again.",
                    )
                  )
                    return;
                  try {
                    await cmd.anthropicKeyClear();
                    refreshKey();
                  } catch (err) {
                    alert("Could not clear: " + String(err));
                  }
                }}
              >
                Clear
              </button>
            </div>
          )}
          {(keyState === "unset" || editingKey) && (
            <ApiKeyInline
              onCancel={() => setEditingKey(false)}
              onSaved={() => {
                setEditingKey(false);
                refreshKey();
              }}
            />
          )}
        </div>
        <div className="row">
          <div>
            <div>Strategies directory</div>
            <div className="muted mono" title={stratDir}>
              {stratDir}
            </div>
            {dirError && (
              <div
                className="muted mono"
                style={{ color: "var(--err)", marginTop: 4 }}
              >
                {dirError}
              </div>
            )}
          </div>
          <button
            type="button"
            className="ghost"
            disabled={savingDir}
            onClick={browseDir}
          >
            {savingDir ? "Saving…" : "Browse"}
          </button>
        </div>
        <div className="row">
          <div>
            <div>Default model</div>
            <div className="muted mono">claude-sonnet-4-20250514</div>
          </div>
          <span className="muted mono" style={{ fontSize: 11 }}>
            model picker — coming in Phase 2
          </span>
        </div>
      </div>
    </>
  );
}

function ApiKeyInline({
  onSaved,
  onCancel,
}: {
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setErr("Paste a key first.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await cmd.anthropicKeySet(v);
      onSaved();
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: "flex-end",
        flex: 1,
        maxWidth: 380,
      }}
    >
      <input
        type="password"
        placeholder="sk-ant-…"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: "100%" }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {err && (
        <div className="muted mono" style={{ color: "var(--err)" }}>
          {err}
        </div>
      )}
    </div>
  );
}

// ── View mode ───────────────────────────────────────────────────

function ViewModeCard() {
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
      <h2>View Mode</h2>
      <div className="card">
        <p className="muted" style={{ margin: "0 0 12px" }}>
          Choose how the Auracle dashboard opens when you click{" "}
          <strong>Open Auracle</strong>.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ViewModeRadio
            label="External browser"
            description="Opens in your default browser. Lower memory; any browser you want."
            value="browser"
            current={mode}
            onChange={change}
          />
          <ViewModeRadio
            label="Embedded window"
            description="Opens inside a second Auracle Desktop window. Feels more like one app; costs a bit more RAM."
            value="embedded"
            current={mode}
            onChange={change}
          />
        </div>
      </div>
    </>
  );
}

function ViewModeRadio({
  label,
  description,
  value,
  current,
  onChange,
}: {
  label: string;
  description: string;
  value: ViewMode;
  current: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        cursor: "pointer",
      }}
    >
      <input
        type="radio"
        name="view-mode"
        value={value}
        checked={current === value}
        onChange={() => onChange(value)}
        style={{ marginTop: 3 }}
      />
      <div>
        <div>
          <strong>{label}</strong>
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          {description}
        </div>
      </div>
    </label>
  );
}

// ── Installation + Docker ───────────────────────────────────────

function InstallCard() {
  const [installPath, setInstallPath] = useState("checking…");
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLabel, setInstallLabel] = useState("Run First-Time Install");
  const [docker, setDocker] = useState<DockerStatus | null | "error">(null);
  const [dockerError, setDockerError] = useState<string | null>(null);

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

  return (
    <>
      <h2>Installation</h2>
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

// ── Updates ─────────────────────────────────────────────────────

function UpdatesCard() {
  const [version, setVersion] = useState("?");
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [resultText, setResultText] = useState("");
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    cmd.currentVersion().then(setVersion).catch(() => setVersion("?"));
  }, []);

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

  const install = async () => {
    setInstalling(true);
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
        setInstalling(false);
      }
    }
  };

  const updateAvailable = info?.available && !!info.version;

  return (
    <>
      <h2>Updates</h2>
      <div className="card">
        <div className="row">
          <div>
            <div>Auracle Desktop launcher version</div>
            <div className="muted mono">v{version}</div>
          </div>
          {updateAvailable ? (
            <button
              type="button"
              className="primary"
              disabled={installing}
              onClick={install}
            >
              {installing
                ? "Installing…"
                : `Download + Install v${info!.version}`}
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
        {resultText && (
          <div className="muted mono" style={{ marginTop: 8 }}>
            {resultText}
          </div>
        )}
        {updateAvailable && !resultText && (
          <div className="muted mono" style={{ marginTop: 8 }}>
            <span className="badge ok">v{info!.version} available</span>
          </div>
        )}
      </div>
    </>
  );
}
