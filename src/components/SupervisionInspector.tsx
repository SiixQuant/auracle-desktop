// SupervisionInspector — the per-container ops console.
//
// The engine vital opens this. It surfaces what's already on the wire:
// each container's state/health with a per-row Restart, stack-level
// Start/Stop/Pull-update, and the Docker fault as an IncidentCard.
// HONESTY: there is no generic per-container log binding, so no panel
// claims logs it can't source. (Broker gateways — IBKR and friends — are
// supervised inside the IDE now, alongside the connections themselves.)

import { useCallback, useEffect, useRef, useState } from "react";

import IncidentCard from "@/components/IncidentCard";
import {
  cmd,
  openInBrowser,
  type ContainerStatus,
  type DockerStatus,
  type HealthSnapshot,
} from "@/lib/tauri";

export default function SupervisionInspector() {
  const [containers, setContainers] = useState<ContainerStatus[] | null>(null);
  const [docker, setDocker] = useState<DockerStatus | null | "error">(null);
  const [dockerErr, setDockerErr] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthSnapshot | null | "error">(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const s = await cmd.stackStatus();
      if (mounted.current) setContainers(s.containers);
    } catch {
      if (mounted.current) setContainers([]);
    }
    try {
      setDocker(await cmd.dockerStatus());
      setDockerErr(null);
    } catch (err) {
      setDocker("error");
      setDockerErr(String(err));
    }
    try {
      setHealth(await cmd.currentHealth());
    } catch {
      setHealth("error");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNote("");
    try {
      await fn();
      await load();
      if (mounted.current) setNote(`${label} — done.`);
    } catch (err) {
      if (mounted.current) setNote(`${label} failed: ${String(err)}`);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <>
      {/* Engine + Docker glance */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Stack</span>
          <div className="hstack">
            <button
              type="button"
              className="ghost btn-sm"
              disabled={busy !== null}
              onClick={() => void act("Pull update", cmd.stackPullUpdate)}
            >
              Pull update
            </button>
            <button
              type="button"
              className="ghost btn-sm"
              disabled={busy !== null}
              onClick={() => void act("Start", cmd.stackStart)}
            >
              Start
            </button>
            <button
              type="button"
              className="ghost btn-sm"
              disabled={busy !== null}
              onClick={() => void act("Stop", cmd.stackStop)}
            >
              Stop
            </button>
          </div>
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
        {note && (
          <div
            className={/failed/.test(note) ? "err-text fs-xs mt-2" : "muted fs-xs mt-2"}
          >
            {note}
          </div>
        )}
        <DockerFault status={docker} error={dockerErr} onRetry={load} />
      </div>

      {/* Per-container console */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Containers</span>
          <button type="button" className="ghost btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        {containers === null ? (
          <div className="muted fs-sm">Checking…</div>
        ) : containers.length === 0 ? (
          <div className="muted fs-sm">No containers running.</div>
        ) : (
          containers.map((c) => (
            <div className="row" key={c.name}>
              <div className="hstack">
                <span className={`sdot ${containerDot(c)}`} />
                <span className="mono fs-sm">{c.name}</span>
                <span className="muted fs-2xs">{c.health || c.state}</span>
              </div>
              <button
                type="button"
                className="ghost btn-sm"
                disabled={busy !== null}
                onClick={() =>
                  void act(`Restart ${c.name}`, () => cmd.stackRestartContainer(c.name))
                }
              >
                {busy === `Restart ${c.name}` ? "Restarting…" : "Restart"}
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function containerDot(c: ContainerStatus): string {
  const s = (c.health || c.state || "").toLowerCase();
  if (s.includes("healthy") || s.includes("running") || s.includes("up")) return "ok";
  if (s.includes("restart") || s.includes("starting")) return "warn";
  if (s.includes("exit") || s.includes("dead") || s.includes("unhealthy")) return "err";
  return "";
}

function DockerFault({
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
              await openInBrowser(await cmd.dockerInstallUrl());
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
