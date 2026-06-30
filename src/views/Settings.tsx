// Settings cards — the launcher's control-plane controls.
//
// "The Standby" home dissolves the old Settings PAGE into right-docked
// inspectors reached by pressing the status they govern (status-is-the-
// door) or the top-bar gear/agent. This module is now the shared library
// of those cards; the InspectorHost composes them into inspectors. There
// is no Settings page anymore — you fix a thing by pressing the thing
// that told you it's wrong.
//
// HONESTY laws (carried over verbatim): configured-flags come from the
// engine; saving a key shows "Saved", never "connected"; a Test gates
// "verified"; a 409 surfaces a plain remediation, never a fake success;
// a key value is never displayed, stored, or logged; "couldn't reach the
// engine" is distinct from "nothing configured".

import { useCallback, useEffect, useRef, useState } from "react";

import ConfirmRow from "@/components/ConfirmRow";
import IncidentCard from "@/components/IncidentCard";
import SetupHint from "@/components/SetupHint";
import Tutorial from "@/components/Tutorial";
import {
  AGENTS,
  agentById,
  agentIdFromEngineProvider,
  buildAiModelPatch,
} from "@/lib/intelligence";
import { waitForEngineHealthy } from "@/lib/onboarding";
import { useSettings } from "@/lib/settings";
import {
  cmd,
  needsOwnerSetup,
  openInBrowser,
  type DockerStatus,
  type HealthSnapshot,
  type IdeUpdateInfo,
  type PreflightReport,
  type UpdateInfo,
} from "@/lib/tauri";

// ── License ──────────────────────────────────────────────────────
//
// License is a one-time global setup. The rail shows the tier; full
// management lives here. The engine's live tier comes from the shared
// aggregate, so the card reflects what the engine actually applied (not
// just what's in the vault).

export function LicenseCard() {
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
      // Flip the running engine's tier now (best-effort). The key is
      // already in the vault, so engine-unreachable is not fatal.
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

// ── General (engine preferences) ─────────────────────────────────
//
// Surfaces engine preferences that used to be engine-only (and only
// reachable through the retired Houston web pages). Reads `prefs` from
// the shared aggregate and renders each as a real toggle that PUTs
// {prefs:{...}} — etag-guarded, so a change made in the IDE can't be
// clobbered. The card is data-driven off the prefs the engine reports,
// so a future engine pref appears without a launcher rewrite.
//
// HONESTY: a 409 surfaces a plain "changed elsewhere — reload" line, not
// a fake success. An unreachable engine is distinct from "no prefs".

// Friendly labels + help for the prefs we know about. Unknown keys fall
// back to a humanized key name so a new engine pref is still operable.
const PREF_META: Record<string, { label: string; help: string }> = {
  yfinance_auto_ingest: {
    label: "Auto-ingest market data (yfinance)",
    help: "When on, the engine pulls missing daily bars from yfinance on demand. Turn off to lock backtests to a chosen provider for reproducibility.",
  },
};

function humanizePrefKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function GeneralCard() {
  const { settings, loading, error, refresh } = useSettings();
  const prefs = settings?.prefs;

  // Only boolean prefs render as toggles. ai_model_* live in the
  // Intelligence card; non-boolean prefs would need a different control,
  // so they're skipped here rather than mis-rendered.
  const boolKeys = prefs
    ? Object.keys(prefs)
        .filter((k) => typeof prefs[k] === "boolean")
        .sort()
    : [];

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">General</span>
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        Engine preferences shared across the launcher and the IDE.
      </p>
      {settings === null ? (
        error ? (
          needsOwnerSetup(error) ? (
            <SetupHint />
          ) : (
            <div className="muted fs-xs lh-relaxed">
              Can&apos;t reach the engine right now — it may still be starting.{" "}
              <button type="button" className="linklike" onClick={refresh}>
                Retry
              </button>
            </div>
          )
        ) : (
          <div className="muted fs-sm">{loading ? "Loading…" : "No preferences."}</div>
        )
      ) : boolKeys.length === 0 ? (
        <div className="muted fs-sm">No adjustable preferences.</div>
      ) : (
        boolKeys.map((key) => (
          <PrefToggle
            key={key}
            prefKey={key}
            value={prefs![key] as boolean}
            etag={settings.etag}
            onChanged={refresh}
          />
        ))
      )}
    </div>
  );
}

function PrefToggle({
  prefKey,
  value,
  etag,
  onChanged,
}: {
  prefKey: string;
  value: boolean;
  etag: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const meta = PREF_META[prefKey];

  const toggle = async () => {
    setBusy(true);
    setStatus("");
    try {
      await cmd.settingsPut({ prefs: { [prefKey]: !value } }, etag);
      // Re-read from engine truth — never optimistically flip the UI.
      onChanged();
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fs-sm">{meta?.label ?? humanizePrefKey(prefKey)}</div>
          {meta?.help && (
            <div className="muted fs-xs mt-1 lh-relaxed">{meta.help}</div>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-label={meta?.label ?? humanizePrefKey(prefKey)}
          className={`pref-switch${value ? " on" : ""}`}
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span className="pref-switch__knob" />
        </button>
      </div>
      {status && <div className="err-text fs-xs mt-2 lh-relaxed">{status}</div>}
    </div>
  );
}

// ── Update Auracle — one action for the whole stack ─────────────────
//
// The hub's Updates home. A SINGLE "Update Auracle" button brings every
// piece of the local stack current in one pass: the trading-engine images,
// the Auracle IDE, and the launcher itself (applied LAST, because the
// launcher self-update restarts the app). The rows beneath are read-only
// status — the one button drives all of them, so the panel never shows more
// than one update control.

type StepState = "run" | "done" | "skip" | "fail";

export function UpdatesInspector() {
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [engineInstalled, setEngineInstalled] = useState<boolean | null>(null);
  const [docker, setDocker] = useState<DockerStatus | null | "error">(null);
  const [launcherVersion, setLauncherVersion] = useState("?");
  const [launcher, setLauncher] = useState<UpdateInfo | null>(null);
  const [ide, setIde] = useState<IdeUpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<{ label: string; state: StepState }[]>([]);
  const [result, setResult] = useState("");
  const [resultErr, setResultErr] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [inst, dock, ver, lInfo, iInfo] = await Promise.all([
      cmd.isInstalled().catch(() => null),
      cmd.dockerStatus().catch(() => "error" as const),
      cmd.currentVersion().catch(() => "?"),
      cmd.checkForUpdate().catch(() => null),
      cmd.ideCheckUpdate().catch(() => null),
    ]);
    setEngineInstalled(inst);
    setDocker(dock);
    setLauncherVersion(ver);
    setLauncher(lInfo);
    setIde(iInfo);
    // Every probe failing means there's no Tauri backend — we're running
    // outside the launcher. Say so plainly instead of faking status.
    setUnavailable(
      inst === null && lInfo === null && iInfo === null && dock === "error",
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dockerReady =
    docker !== null && docker !== "error" && docker.installed && docker.running;
  const launcherUpdate = !!launcher?.available && !!launcher.version;
  const ideUpdate =
    !!ide?.update_available && !!ide.asset_url && !ide.unsupported_platform;
  const engineNeedsInstall = engineInstalled === false;
  const updateAvailable = launcherUpdate || ideUpdate || engineNeedsInstall;

  const updateAll = useCallback(async () => {
    setBusy(true);
    setResult("");
    setResultErr(false);
    const log: { label: string; state: StepState }[] = [];
    const failures: string[] = [];
    const add = (label: string): number => {
      log.push({ label, state: "run" });
      setSteps([...log]);
      return log.length - 1;
    };
    const mark = (i: number, state: StepState) => {
      log[i].state = state;
      setSteps([...log]);
    };
    // Run one step independently. A failure is recorded and surfaced, but it
    // never aborts the rest — so a flaky engine pull (e.g. an older launcher's
    // Docker-PATH bug) can't block the launcher self-update that ships the very
    // fix for it. Each piece gets as current as it can in a single pass.
    const step = async (label: string, fn: () => Promise<unknown>) => {
      const i = add(label);
      try {
        await fn();
        mark(i, "done");
      } catch (err) {
        mark(i, "fail");
        failures.push(`${label.toLowerCase()} (${String(err)})`);
      }
    };
    try {
      // 1. Trading-engine images (need Docker).
      if (!dockerReady) {
        mark(add("Trading engine — Docker not running"), "skip");
      } else if (engineInstalled === false) {
        await step("Installing the trading engine", async () => {
          await cmd.runFirstInstall();
          await waitForEngineHealthy(() => cmd.healthcheckNow()).catch(
            () => false,
          );
        });
      } else if (engineInstalled === true) {
        // The engine was already installed and running. A failed image refresh
        // (no newer images, a registry hiccup) does NOT take a running engine
        // down — so don't alarm with a red error. Only treat it as a real
        // failure if the engine actually stopped serving; otherwise report it
        // calmly: nothing is broken.
        const i = add("Updating the trading engine");
        try {
          await cmd.stackPullUpdate();
          mark(i, "done");
        } catch (err) {
          const stillUp = await waitForEngineHealthy(
            () => cmd.healthcheckNow(),
            { attempts: 1 },
          ).catch(() => false);
          if (stillUp) {
            log[i].label = "Trading engine — running on the current version";
            mark(i, "skip");
          } else {
            mark(i, "fail");
            failures.push(`trading engine (${String(err)})`);
          }
        }
      }
      // 2. Auracle IDE.
      if (ideUpdate && ide) {
        await step("Updating the Auracle IDE", () =>
          cmd.ideDownloadAndInstall(
            ide.asset_url as string,
            ide.asset_size ?? null,
            ide.latest_version ?? "",
          ),
        );
      }
      // 3. Launcher — LAST, and ALWAYS attempted even if an earlier step
      //    failed: installing it restarts the app, and it's what delivers fixes
      //    to those earlier steps. The restart races the IPC close, so a
      //    connection-dropped error here is the expected success path.
      if (launcherUpdate) {
        const i = add("Updating the launcher — restarting");
        try {
          await cmd.installUpdate();
          mark(i, "done");
          setResult("Restarting on the new version.");
          return;
        } catch (err) {
          const msg = String(err);
          if (/closed|connection|communicating|reset/i.test(msg)) {
            mark(i, "done");
            setResult("Restarting on the new version.");
            return;
          }
          mark(i, "fail");
          failures.push(`launcher (${msg})`);
        }
      }
      await refresh();
      if (failures.length > 0) {
        setResultErr(true);
        setResult("Some updates couldn't finish — " + failures.join("; "));
      } else {
        setResult(
          log.some((s) => s.state === "done")
            ? "Auracle is up to date."
            : "Already up to date.",
        );
      }
    } finally {
      setBusy(false);
    }
  }, [docker, dockerReady, engineInstalled, ide, ideUpdate, launcherUpdate, refresh]);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Update Auracle</span>
        {!loading &&
          !unavailable &&
          (updateAvailable ? (
            <span className="chip warn">update available</span>
          ) : (
            <span className="chip ok">up to date</span>
          ))}
      </div>

      {unavailable ? (
        <div className="muted fs-xs">
          Updates are managed by the launcher. Open Auracle from the launcher
          app to check for and install updates.
        </div>
      ) : (
        <>
          <div className="muted fs-xs mb-2">
            One action brings the whole stack current — trading engine, IDE,
            and launcher.
          </div>

          <button
            type="button"
            className="primary"
            style={{ width: "100%" }}
            disabled={loading || busy}
            onClick={() => void updateAll()}
          >
            {busy ? "Updating…" : loading ? "Checking…" : "Update Auracle"}
          </button>

          {steps.length > 0 && (
            <div className="mt-2">
              {steps.map((s, i) => (
                <div key={i} className="row fs-xs">
                  <span className="muted">{s.label}</span>
                  <span
                    className={s.state === "fail" ? "err-text" : "muted mono"}
                  >
                    {s.state === "run"
                      ? "…"
                      : s.state === "done"
                        ? "done"
                        : s.state === "fail"
                          ? "failed"
                          : "skipped"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {result && (
            <div className={resultErr ? "err-text fs-xs mt-2" : "muted fs-xs mt-2"}>
              {result}
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <div className="row">
              <span>Trading engine</span>
              <span className={`chip ${engineInstalled ? "ok" : "neutral"}`}>
                {engineInstalled === null
                  ? "checking"
                  : engineInstalled
                    ? "installed"
                    : "will install"}
              </span>
            </div>
            <div className="row">
              <span>Docker</span>
              <DockerChip status={docker} />
            </div>
            <div className="row">
              <span className="hstack">
                <span>Launcher</span>
                <span className="muted mono fs-xs">v{launcherVersion}</span>
              </span>
              {launcherUpdate ? (
                <span className="chip warn">v{launcher!.version}</span>
              ) : (
                <span className="chip ok">current</span>
              )}
            </div>
            <div className="row">
              <span className="hstack">
                <span>Auracle IDE</span>
                <span className="muted mono fs-xs">
                  {ide?.installed
                    ? ide.version_tracked
                      ? `v${ide.installed_version}`
                      : "installed"
                    : "not installed"}
                </span>
              </span>
              {ideUpdate ? (
                <span className="chip warn">
                  {ide?.installed ? `v${ide.latest_version}` : "install"}
                </span>
              ) : ide?.installed ? (
                <span className="chip ok">current</span>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Glance tier: the chip that lives in the Docker row's right cell. The
 *  full incident readout + retry lives in the Advanced drawer. */
function DockerChip({ status }: { status: DockerStatus | null | "error" }) {
  if (status === null) return <span className="chip neutral">checking</span>;
  if (status === "error") return <span className="chip err">check failed</span>;
  if (!status.installed) return <span className="chip err">not installed</span>;
  if (!status.running) return <span className="chip warn">not running</span>;
  return <span className="chip ok">running</span>;
}

/** Act tier: the shared incident contract for the three Docker failure
 *  states. Healthy and checking render nothing. Lives in the Advanced
 *  drawer's health readout, not the slim System card. */
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

// ── Intelligence (the agent the IDE uses) ───────────────────────
//
// The control plane's home for the coding agent. One opinionated default
// — the Auracle Agent, wrapping DeepSeek over the user's own loopback
// engine with their own key — plus frontier bring-your-own-key
// alternatives (Claude / GPT / Gemini). A single default-agent selector
// the IDE consumes. One Save persists both the selection and any new key
// together, so a selection never points at a key the vault refused.
//
// HONESTY: the "key on file" flag comes from the engine aggregate
// (configured), never from the launcher. The launcher never displays a
// secret. A 409 (vault unavailable on a paid install, or a concurrent
// change) surfaces a plain remediation line, never a fake success.
//
// The agent HARNESS (system prompt, tools, MCP wiring) is a documented
// placeholder owned by the IDE side — this card only configures the
// selection + the key. See src/lib/intelligence.ts for the engine vs
// IDE identity mapping.

export function IntelligenceCard() {
  const { settings, refresh } = useSettings();
  const current = settings?.ai_model;

  const [agentId, setAgentId] = useState(AGENTS[0].id);
  const [modelOverride, setModelOverride] = useState("");
  const [key, setKey] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // Seed the form from the engine the first time the aggregate lands.
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (seeded || !current) return;
    setAgentId(agentIdFromEngineProvider(current.provider));
    // A stored model id different from the agent's canonical model is an
    // override the user set — surface it so a re-save doesn't drop it.
    const seededAgent = agentById(agentIdFromEngineProvider(current.provider));
    if (current.model_id && current.model_id !== seededAgent?.engineModel) {
      setModelOverride(current.model_id);
    }
    setSeeded(true);
  }, [current, seeded]);

  const agent = agentById(agentId) ?? AGENTS[0];
  // The configured flag is only meaningful for the currently-SELECTED
  // engine provider (the engine reports configured for the stored
  // selection). Show "key on file" when the selected agent matches the
  // engine's stored provider and that provider has a key.
  const selectionMatchesEngine =
    current != null && current.provider === agent.engineProvider;
  const keyOnFile = selectionMatchesEngine && (current?.configured ?? false);

  const save = async () => {
    setBusy(true);
    setStatus("");
    try {
      // buildAiModelPatch supplies the engine-valid provider + model and
      // only includes a non-empty key (so a selection change never wipes
      // a stored key). The etag guards a concurrent change in the IDE.
      const patch = buildAiModelPatch(agentId, modelOverride, key);
      await cmd.settingsPut({ ai_model: patch }, settings?.etag);
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
      {/* The section's mono-label already says "Intelligence" — drop the
          redundant card-title. Keep the "key on file" badge, right-aligned. */}
      {keyOnFile && (
        <div className="card-head card-head--action-only">
          <span className="badge ok">key on file</span>
        </div>
      )}
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        The agent the IDE uses. The Auracle Agent is the default — it wraps
        DeepSeek over your own engine on <span className="mono">127.0.0.1</span>,
        so your prompts and key stay on your machine. Frontier models are
        bring-your-own-key alternatives.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="vstack" style={{ gap: 0 }}>
          {AGENTS.map((a) => {
            const selected = a.id === agentId;
            return (
              <label key={a.id} className={`agent-row${selected ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="default-agent"
                  value={a.id}
                  checked={selected}
                  onChange={() => {
                    setAgentId(a.id);
                    setModelOverride("");
                    setStatus("");
                  }}
                  aria-label={a.label}
                />
                <span className="agent-row__body">
                  <span className="hstack">
                    <span className="fs-sm" style={{ fontWeight: 500 }}>
                      {a.label}
                    </span>
                    {a.isDefault && <span className="badge neutral">default</span>}
                  </span>
                  <span className="muted fs-xs lh-relaxed">{a.blurb}</span>
                </span>
              </label>
            );
          })}
        </div>

        {agent.prerequisite && (
          <p className="muted fs-xs mt-3 mb-0 lh-relaxed">{agent.prerequisite}</p>
        )}

        <div className="hstack mt-3">
          <input
            type="password"
            placeholder={
              keyOnFile ? "Replace key (leave blank to keep)" : agent.keyPlaceholder
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

      {status && !needsOwnerSetup(status) && (
        <div className={isError ? "err-text fs-xs mt-2 lh-relaxed" : "muted mono fs-xs mt-2"}>
          {status}
        </div>
      )}
      {needsOwnerSetup(status) && <SetupHint />}
    </div>
  );
}

// ── GitHub (device-flow sign-in) ────────────────────────────────
//
// The user's own GitHub for git push/pull. The Rust side runs the OAuth
// device flow and stores the access token in the system git credential
// helper — the token never crosses this boundary. The IDE inherits it.

type GithubPhase =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "connected"; login?: string | null }
  | { kind: "idle" }
  | { kind: "awaiting"; userCode: string; uri: string }
  | { kind: "error"; message: string };

export function GithubCard() {
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

  // Nothing to show while probing, or when this build can't do GitHub
  // sign-in at all — hide the card rather than surfacing a dead row.
  if (phase.kind === "loading" || phase.kind === "not_configured") return null;

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">GitHub</span>
        {phase.kind === "connected" && <span className="badge ok">signed in</span>}
      </div>
      {phase.kind === "connected" ? (
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

// ── Advanced / Diagnostics drawer ───────────────────────────────
//
// Collapsed by default each session (no persisted "open" — the calm view
// is the default every time the launcher opens). Holds the developer- and
// troubleshooting-only material that used to compete for attention in the
// everyday view: preflight checks, the detailed Docker/health readout,
// the open-in-IDE-vs-browser preference, and the first-run tutorial entry.

type LaunchTarget = "ide" | "browser";
const LAUNCH_TARGET_KEY = "auracle_launch_target";

export function AdvancedDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <section className="adv-drawer">
      <button
        type="button"
        className="adv-drawer__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`adv-drawer__caret${open ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
        Advanced / Diagnostics
      </button>
      {open && (
        <div className="settings-grid mt-2">
          <div className="sgcell">
            <PreflightDrawerCard />
          </div>
          <div className="sgcell">
            <HealthReadoutCard />
          </div>
          <div className="sgcell">
            <LaunchTargetCard />
          </div>
          <div className="sgcell">
            <TutorialCard />
          </div>
        </div>
      )}
    </section>
  );
}

/** Preflight — run the install readiness checks deliberately, on demand,
 *  instead of being shown them constantly on the main view. */
function PreflightDrawerCard() {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      // Post-install, our own stack holds the required ports — tell
      // preflight so expected occupancy isn't flagged as a conflict.
      let expectPortsInUse = false;
      try {
        const [inst, dk] = await Promise.all([
          cmd.isInstalled(),
          cmd.dockerStatus(),
        ]);
        expectPortsInUse = !!inst && !!dk?.running;
      } catch {
        // fall back to strict (fresh-install) behavior
      }
      setReport(await cmd.preflightCheck(expectPortsInUse));
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Preflight checks</span>
        <button type="button" className="ghost btn-sm" disabled={running} onClick={run}>
          {running ? "Running…" : "Run checks"}
        </button>
      </div>
      <p className="muted fs-sm m-0 lh-relaxed">
        Checks Docker, disk space, and ports.
      </p>
      {error && <div className="err-text fs-xs mt-2 lh-relaxed">{error}</div>}
      {report &&
        report.checks.map((c, i) => {
          const variant = c.passed ? "ok" : c.level === "warning" ? "warn" : "err";
          const label = c.passed ? "pass" : c.level === "warning" ? "warn" : "fail";
          return (
            <div key={i} className="mt-3">
              <div className="row">
                <span className="fs-sm">{c.name}</span>
                <span className={`chip ${variant}`}>{label}</span>
              </div>
              <div className="muted fs-xs mt-1 lh-relaxed">{c.message}</div>
              {c.remediation && !c.passed && (
                <div className="muted fs-xs mt-1 lh-relaxed">{c.remediation}</div>
              )}
            </div>
          );
        })}
    </div>
  );
}

/** The detailed Docker/health readout — the full incident detail + retry
 *  that the slim System card deliberately omits. */
function HealthReadoutCard() {
  const [docker, setDocker] = useState<DockerStatus | null | "error">(null);
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null | "error">(null);

  const load = useCallback(async () => {
    try {
      setDocker(await cmd.dockerStatus());
      setDockerError(null);
    } catch (err) {
      setDocker("error");
      setDockerError(String(err));
    }
    try {
      setHealth(await cmd.currentHealth());
    } catch {
      setHealth("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Engine &amp; Docker health</span>
        <button type="button" className="ghost btn-sm" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="row">
        <div>Engine</div>
        {health === null ? (
          <span className="chip neutral">checking</span>
        ) : health === "error" ? (
          <span className="chip err">unreachable</span>
        ) : (
          <span className={`chip ${health.state === "healthy" ? "ok" : "warn"}`}>
            {health.state}
          </span>
        )}
      </div>
      {health && health !== "error" && health.last_error && (
        <div className="muted fs-xs mt-1 lh-relaxed">{health.last_error}</div>
      )}
      <div className="row">
        <div>Docker</div>
        <DockerChip status={docker} />
      </div>
      <DockerIncident status={docker} error={dockerError} onRetry={load} />
    </div>
  );
}

/** Open-in-IDE vs browser — a developer preference that used to occupy a
 *  top-level card. Stored locally; consumed by the launch action. */
function LaunchTargetCard() {
  const [target, setTarget] = useState<LaunchTarget>(() => {
    try {
      return localStorage.getItem(LAUNCH_TARGET_KEY) === "browser"
        ? "browser"
        : "ide";
    } catch {
      return "ide";
    }
  });

  const choose = (t: LaunchTarget) => {
    setTarget(t);
    try {
      localStorage.setItem(LAUNCH_TARGET_KEY, t);
    } catch {
      // localStorage unavailable — the in-memory choice still applies.
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Open workspace in</span>
      </div>
      <p className="muted fs-sm m-0 mb-3 lh-relaxed">
        Where the launcher opens your workspace. The IDE is the default home;
        the browser is a fallback for diagnostics.
      </p>
      <div className="seg-toggle" role="group" aria-label="Open workspace in">
        <button
          type="button"
          className={`seg-tab${target === "ide" ? " active" : ""}`}
          aria-pressed={target === "ide"}
          onClick={() => choose("ide")}
        >
          IDE
        </button>
        <button
          type="button"
          className={`seg-tab${target === "browser" ? " active" : ""}`}
          aria-pressed={target === "browser"}
          onClick={() => choose("browser")}
        >
          Browser
        </button>
      </div>
    </div>
  );
}

/** First-run tutorial entry — replay the tour on demand from the drawer
 *  rather than having it block the main view. */
function TutorialCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">First-run tutorial</span>
      </div>
      <div className="row">
        <div>
          <div>Take the tour</div>
          <div className="muted fs-sm mt-1">A short walkthrough of the launcher.</div>
        </div>
        <button type="button" className="ghost btn-sm" onClick={() => setOpen(true)}>
          Open tour
        </button>
      </div>
      {open && <Tutorial onClose={() => setOpen(false)} />}
    </div>
  );
}
