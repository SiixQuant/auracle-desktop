// LifecycleBelt — the strategy conveyor belt.
//
// One visible spine for the active strategy: where it sits in its
// lifecycle (draft → research → backtested → paper → live) and the single
// next action. Rendered once in Forge.tsx so it spans BOTH Agent and Code
// modes — the lifecycle is the same wherever you're working.
//
// The heavy lifting (backtest, deploy) lives in Houston; the belt routes
// to the working Houston deep-link and is aware of Houston's health, so a
// CTA is never a dead button. Clicking a stage sets the strategy's state
// (synced to Houston when the stack is up). Promoting to live is a gated,
// explicit human action that opens Houston — the desktop never places an
// order itself.

import { useEffect, useState } from "react";

import {
  backtestUrl,
  BELT_STAGES,
  deployUrl,
  HOUSTON_BASE,
  nextStep,
  probeHouston,
  STAGE_META,
} from "@/lib/lifecycle";
import { openInBrowser, type StrategyState } from "@/lib/tauri";

interface LifecycleBeltProps {
  /** Active strategy file (rel path), or null when nothing is open. */
  activePath: string | null;
  /** Lifecycle state of the active strategy. */
  state: StrategyState;
  /** Set the active strategy's state (synced to Houston when online). */
  onChangeState: (next: StrategyState) => void;
}

export default function LifecycleBelt({
  activePath,
  state,
  onChangeState,
}: LifecycleBeltProps) {
  const [houston, setHouston] = useState<"checking" | "online" | "offline">(
    "checking",
  );

  // Re-probe Houston whenever the active strategy changes — the belt's CTA
  // depends on whether the backtest/deploy target is reachable.
  useEffect(() => {
    if (!activePath) return;
    let cancelled = false;
    const controller = new AbortController();
    setHouston("checking");
    probeHouston(controller.signal).then((s) => {
      if (!cancelled) setHouston(s);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activePath]);

  if (!activePath) {
    return (
      <div className="belt belt--empty">
        <span className="muted">
          Select or create a strategy to see its lifecycle.
        </span>
      </div>
    );
  }

  const step = nextStep(state);
  const currentIdx = BELT_STAGES.indexOf(state);
  const isArchived = state === "archived";
  const offline = houston === "offline";

  const runStep = async () => {
    if (offline) return;
    switch (step.kind) {
      case "backtest":
        await openInBrowser(backtestUrl(activePath));
        break;
      case "deploy-paper":
        await openInBrowser(deployUrl(activePath, "paper"));
        break;
      case "promote-live": {
        const ok = window.confirm(
          "Promote to LIVE — real capital.\n\n" +
            "This opens Houston to schedule this strategy against your live " +
            "broker account, where real orders can be placed. Houston applies " +
            "its own confirmation and the install's live kill-switch before " +
            "anything trades.\n\nOpen the live deployment screen in Houston?",
        );
        if (!ok) return;
        await openInBrowser(deployUrl(activePath, "live"));
        break;
      }
      case "manage":
        await openInBrowser(`${HOUSTON_BASE}/ui/forge`);
        break;
      case "none":
        break;
    }
  };

  return (
    <div className="belt">
      <div className="belt-track" role="list" aria-label="Strategy lifecycle">
        {BELT_STAGES.map((s, i) => {
          const status = isArchived
            ? "future"
            : i < currentIdx
              ? "past"
              : i === currentIdx
                ? "current"
                : "future";
          return (
            <button
              key={s}
              type="button"
              role="listitem"
              className={`belt-node belt-node--${status}`}
              title={STAGE_META[s].blurb}
              aria-current={status === "current"}
              onClick={() => onChangeState(s)}
            >
              <span className="belt-dot" aria-hidden="true" />
              <span className="belt-label">{STAGE_META[s].label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`belt-archive ${isArchived ? "active" : ""}`}
          title={STAGE_META.archived.blurb}
          onClick={() => onChangeState(isArchived ? "draft" : "archived")}
        >
          {isArchived ? "Archived" : "Archive"}
        </button>
      </div>

      {step.kind !== "none" && (
        <div className="belt-action">
          {offline && (
            <span className="belt-hint muted">
              Start Auracle to {step.label.toLowerCase()}
            </span>
          )}
          <button
            type="button"
            className={`belt-cta ${step.guarded ? "belt-cta--live" : ""}`}
            disabled={offline}
            onClick={runStep}
            title={offline ? "Houston (the Auracle stack) is offline" : undefined}
          >
            {step.label} →
          </button>
        </div>
      )}
    </div>
  );
}
