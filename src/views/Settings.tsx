// Settings — install + Docker state, launcher updates, broker connections.
//
// License management lives on the Dashboard so customers see it on
// first launch. Keeping it out of Settings avoids two places to
// enter the same key + the confusion that comes with that.

import { useCallback, useEffect, useRef, useState } from "react";

import ConfirmRow from "@/components/ConfirmRow";
import IncidentCard from "@/components/IncidentCard";
import BrokerConnectionsCard from "@/views/BrokerConnections";
import { useSettings } from "@/lib/settings";
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
        <div className="sgcell"><DataSourcesCard /></div>
        <div className="sgcell"><AiModelCard /></div>
        <div className="sgcell"><GithubCard /></div>
        <div className="sgcell full"><BrokerConnectionsCard /></div>
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
  const { settings, refresh: refreshShared } = useSettings();
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

  // The engine's live tier comes from the shared aggregate, so the card
  // reflects what the engine actually applied (not just what's in the vault).
  const tier = settings?.tier;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">License</span>
        {tier && <span className="chip neutral">{tier}</span>}
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
            // Pull the engine's new tier into the shared aggregate.
            refreshShared();
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

// ── Data sources (third-party data-provider API keys) ───────────
//
// Native replacement for the retired Houston "Key Master" web page,
// scoped to DATA providers (broker credentials live in the Broker
// Connections card below). Each row saves through the engine's
// /ui/api/keys surface over loopback (owner key handoff + CSRF).
//
// Honesty law: a row is only marked "verified" after a Test actually
// passes. Saving a key never implies it works — Save shows "Saved",
// not "connected". The "configured" badge is read from the shared
// settings aggregate (the engine reports whether a key is on file —
// never the value), so the card reflects one coherent state instead
// of probing independently.

// The provider list is the engine's `market_data` category from
// auracle/keys.py (PROVIDER_CATEGORIES["market_data"].members) — the
// data-provider keys Key Master manages. Kept in sync with the engine;
// an unknown provider would be rejected with a 404 by /ui/api/keys.
const DATA_PROVIDERS: { id: string; label: string; hint: string }[] = [
  { id: "polygon", label: "Polygon.io", hint: "polygon api key" },
  { id: "eodhd", label: "EOD Historical Data", hint: "eodhd api token" },
  { id: "nasdaq_data_link", label: "Nasdaq Data Link (Sharadar)", hint: "ndl key" },
  { id: "brain", label: "Brain Company (BSI / BLMCF)", hint: "Brain subscription key" },
  { id: "coingecko", label: "CoinGecko Pro", hint: "CG-… (Pro key — free tier needs none)" },
];

function DataSourcesCard() {
  const { settings, refresh } = useSettings();
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Data sources</span>
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        Add API keys for third-party market-data providers so non-IBKR
        data works. Keys are saved to your local engine, encrypted at rest.
      </p>
      {DATA_PROVIDERS.map((p) => (
        <DataProviderRow
          key={p.id}
          provider={p}
          configured={settings?.data_keys?.[p.id]?.configured ?? false}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

function DataProviderRow({
  provider,
  configured,
  onChanged,
}: {
  provider: { id: string; label: string; hint: string };
  configured: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  // "verified" only after a Test passes. Never inferred from a Save.
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

  const save = async () => {
    const v = value.trim();
    if (!v) {
      setStatus("Paste a key first.");
      return;
    }
    setBusy("save");
    setStatus("");
    setVerified(false);
    try {
      await cmd.dataKeySave(provider.id, v);
      setStatus("Saved.");
      // Refresh the shared aggregate so the "configured" badge updates
      // from engine truth (the saved key is on file now).
      onChanged();
    } catch (err) {
      setStatus("Could not save: " + String(err));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setStatus("");
    try {
      const ok = await cmd.dataKeyTest(provider.id);
      setVerified(ok);
      setStatus(ok ? "Test passed." : "Test failed — the provider rejected the key.");
    } catch (err) {
      setVerified(false);
      setStatus("Could not test: " + String(err));
    } finally {
      setBusy(null);
    }
  };

  const isError = /^(Could not|Paste|Test failed)/.test(status);

  return (
    <div className="mt-3">
      <div className="hstack mb-2">
        <span className="fs-sm" style={{ flex: 1 }}>{provider.label}</span>
        {verified ? (
          <span className="badge ok">verified</span>
        ) : (
          configured && <span className="badge neutral">configured</span>
        )}
      </div>
      <form
        className="hstack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          placeholder={provider.hint}
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // Editing the key invalidates a prior Test verdict.
            if (verified) setVerified(false);
          }}
        />
        <button type="submit" className="primary btn-sm" disabled={busy !== null}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="ghost btn-sm"
          disabled={busy !== null}
          onClick={() => void test()}
        >
          {busy === "test" ? "Testing…" : "Test"}
        </button>
      </form>
      {status && (
        <div className={isError ? "err-text fs-xs mt-2" : "muted mono fs-xs mt-2"}>
          {status}
        </div>
      )}
    </div>
  );
}

// ── AI model (provider + model + key → engine vault) ────────────
//
// Native door for the LLM the engine/agent uses. Provider picker +
// model id + an API-key field. On save the launcher PUTs the AI-model
// settings to the engine (the key rides to the engine vault and never
// crosses back). The "configured" state comes from the shared
// aggregate — the engine reports whether a key is on file, never the
// value. A 409 (vault unavailable on a paid install) surfaces a plain
// remediation line, never a fake success.

const AI_PROVIDERS: { id: string; label: string; placeholder: string }[] = [
  { id: "anthropic", label: "Anthropic", placeholder: "claude-…" },
  { id: "openai", label: "OpenAI", placeholder: "gpt-…" },
  { id: "google", label: "Google", placeholder: "gemini-…" },
  { id: "openrouter", label: "OpenRouter", placeholder: "vendor/model" },
];

function AiModelCard() {
  const { settings, refresh } = useSettings();
  const current = settings?.ai_model;

  const [provider, setProvider] = useState("anthropic");
  const [modelId, setModelId] = useState("");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // Seed the form from the engine the first time the aggregate lands.
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !current) return;
    if (current.provider) setProvider(current.provider);
    if (current.model_id) setModelId(current.model_id);
    setSeeded(true);
  }, [current, seeded]);

  const ph =
    AI_PROVIDERS.find((p) => p.id === provider)?.placeholder ?? "model id";

  const save = async () => {
    const m = modelId.trim();
    if (!m) {
      setStatus("Enter a model id first.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      // The key (when present) rides to the engine vault. An empty key
      // leaves the stored one untouched — so changing only the model
      // never wipes the saved key. The etag guards against clobbering a
      // change made in another surface (the IDE).
      await cmd.settingsPut(
        {
          ai_model: {
            provider,
            model_id: m,
            ...(key.trim() ? { key: key.trim() } : {}),
          },
        },
        settings?.etag,
      );
      setKey("");
      setStatus("Saved.");
      refresh();
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const isError = !/^Saved\.?$/.test(status) && status !== "";

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">AI model</span>
        {current?.configured && <span className="badge ok">key on file</span>}
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        The model the assistant uses. Pick a provider, set the model, and
        paste a key — the key is stored in your local engine&apos;s vault.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="hstack mb-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            aria-label="AI provider"
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder={ph}
            autoComplete="off"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            aria-label="Model id"
          />
        </div>
        <div className="hstack">
          <input
            type="password"
            placeholder={
              current?.configured ? "Replace key (leave blank to keep)" : "Paste API key"
            }
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="API key"
          />
          <button type="submit" className="primary btn-sm" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
      {status && (
        <div className={isError ? "err-text fs-xs mt-2 lh-relaxed" : "muted mono fs-xs mt-2"}>
          {status}
        </div>
      )}
    </div>
  );
}

// ── GitHub (device-flow sign-in) ────────────────────────────────
//
// The user's own GitHub for git push/pull. The Rust side runs the
// OAuth device flow and stores the access token in the system git
// credential helper — the token never crosses this boundary. This is
// the shared GitHub path the IDE inherits, surfaced here so it can be
// connected from the launcher too.

type GithubPhase =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "connected"; login?: string | null }
  | { kind: "idle" }
  | { kind: "awaiting"; userCode: string; uri: string }
  | { kind: "error"; message: string };

function GithubCard() {
  const [phase, setPhase] = useState<GithubPhase>({ kind: "loading" });
  const mountedRef = useRef(true);
  const pollRef = useRef<number | null>(null);

  const clearPoll = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    cmd
      .githubAuthStatus()
      .then((s) => {
        if (!mountedRef.current) return;
        if (!s.configured) setPhase({ kind: "not_configured" });
        else if (s.connected) setPhase({ kind: "connected", login: s.login });
        else setPhase({ kind: "idle" });
      })
      .catch(() => {
        if (mountedRef.current) setPhase({ kind: "idle" });
      });
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll]);

  // Recursive poll honoring GitHub's interval; nudges up on slow_down
  // (another "pending"). The token is stored by the Rust side; it never
  // crosses this boundary.
  const poll = useCallback(
    (deviceCode: string, intervalSec: number) => {
      clearPoll();
      pollRef.current = window.setTimeout(async () => {
        try {
          const res = await cmd.githubDevicePoll(deviceCode);
          if (!mountedRef.current) return;
          if (res.status === "authorized") {
            setPhase({ kind: "connected", login: res.login });
            clearPoll();
          } else if (res.status === "pending") {
            poll(deviceCode, intervalSec + 1);
          } else {
            setPhase({ kind: "error", message: "Sign-in didn't complete. Try again." });
            clearPoll();
          }
        } catch {
          if (!mountedRef.current) return;
          setPhase({ kind: "error", message: "Sign-in didn't complete. Try again." });
          clearPoll();
        }
      }, intervalSec * 1000);
    },
    [clearPoll],
  );

  const signIn = useCallback(async () => {
    try {
      const s = await cmd.githubDeviceStart();
      if (!mountedRef.current) return;
      setPhase({ kind: "awaiting", userCode: s.user_code, uri: s.verification_uri });
      openInBrowser(s.verification_uri).catch(() => {});
      poll(s.device_code, Math.max(1, s.interval));
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = String(err);
      if (msg.toLowerCase().includes("isn't configured")) {
        setPhase({ kind: "not_configured" });
      } else {
        setPhase({ kind: "error", message: "Couldn't start GitHub sign-in. Try again." });
      }
    }
  }, [poll]);

  if (phase.kind === "loading") return null;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">GitHub</span>
        {phase.kind === "connected" && <span className="badge ok">signed in</span>}
      </div>
      {phase.kind === "not_configured" ? (
        <p className="muted fs-sm m-0 lh-relaxed">
          GitHub sign-in isn&apos;t configured in this build.
        </p>
      ) : phase.kind === "connected" ? (
        <p className="muted fs-sm m-0 lh-relaxed">
          Signed in{phase.login ? ` as ${phase.login}` : ""}. Your git push and
          pull use this account — the IDE inherits it too.
        </p>
      ) : phase.kind === "awaiting" ? (
        <div className="banner info m-0 lh-relaxed">
          Enter code <span className="mono">{phase.userCode}</span> at{" "}
          <button
            type="button"
            className="linklike"
            onClick={() => void openInBrowser(phase.uri)}
          >
            {phase.uri}
          </button>{" "}
          — this card updates once you authorize.
        </div>
      ) : (
        <>
          <p className="muted fs-sm m-0 mb-3 lh-relaxed">
            Sign in with GitHub so git push and pull just work — in the launcher
            and the IDE.
          </p>
          <button type="button" className="primary btn-sm" onClick={() => void signIn()}>
            Sign in with GitHub
          </button>
          {phase.kind === "error" && (
            <div className="err-text fs-xs mt-2 lh-relaxed">{phase.message}</div>
          )}
        </>
      )}
    </div>
  );
}
