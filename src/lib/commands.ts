// Command registry — the ⌘K palette + hotkeys nervous system.
//
// Because the Standby home shows little, the palette carries the density a
// power operator wants: every action and destination is a Command with a
// `verb` (the mono string echoed after it runs, so mouse users learn the
// keyboard path) and a state-derived `relevance` so the current incident
// floats to the top when something is red. `buildCommands` wires the
// callbacks; `rankCommands` + `fuzzyScore` are pure and unit-tested.

import type { BoardState, Door } from "@/lib/aggregator";
import type { ContainerStatus } from "@/lib/tauri";

export interface Command {
  id: string;
  /** Human title shown in the palette ("Start engine"). */
  title: string;
  /** Mono verb echoed after the command runs ("engine start"). */
  verb: string;
  group: string;
  /** Extra match text (synonyms) — never shown. */
  keywords?: string;
  /** Higher floats earlier with an empty query (state-aware ranking). */
  relevance: number;
  /** Live-money / stop-engine / clear verbs gate behind a confirm. */
  destructive?: boolean;
  run: () => void;
}

export interface CommandContext {
  board: BoardState;
  containers: ContainerStatus[];
  openInspector: (key: Door | "intelligence" | "system" | "lifecycle") => void;
  /** The home's one verb (launch / start engine / connect / …). */
  runActuator: () => void;
  restartContainer: (name: string) => void;
  refresh: () => void;
  openIdePanel: (panel: string) => void;
  openTutorial: () => void;
  showTips: () => void;
}

/** Build the full command list for the current state. The actuator command
 *  inherits the board's verb and gets top relevance when the board is in an
 *  incident (start/connect/degraded) — that's "incident-floats-to-top". */
export function buildCommands(ctx: CommandContext): Command[] {
  const a = ctx.board.actuator;
  const incident =
    a.action === "start" || a.action === "degraded" || a.action === "setup";

  const cmds: Command[] = [];

  // The one verb — only when it's actionable (not checking/starting).
  if (a.action !== "checking" && a.action !== "starting") {
    cmds.push({
      id: "actuator",
      title: a.label,
      verb: actuatorVerb(a.action),
      group: "Action",
      keywords: "launch start engine open workspace go finish setup first-run account owner",
      relevance: incident ? 100 : 60,
      destructive: false,
      run: ctx.runActuator,
    });
  }

  // Destinations (status-is-the-door, also reachable by name).
  const dests: Array<
    [Door | "intelligence" | "system" | "lifecycle", string, string, string]
  > = [
    ["supervision", "Open Supervision", "supervision", "engine docker containers logs"],
    ["lifecycle", "Open Strategy lifecycle", "lifecycle", "strategies belt draft paper live"],
    ["intelligence", "Open Intelligence", "intelligence", "agent model deepseek ai key"],
    ["system", "Open System", "system", "license updates preferences settings"],
  ];
  for (const [key, title, verb, keywords] of dests) {
    cmds.push({
      id: `open:${key}`,
      title,
      verb,
      group: "Go to",
      keywords,
      relevance: 20,
      run: () => ctx.openInspector(key),
    });
  }

  // Live-sourced: one restart command per real container.
  for (const c of ctx.containers) {
    cmds.push({
      id: `restart:${c.name}`,
      title: `Restart ${c.name}`,
      verb: `restart ${c.name}`,
      group: "Supervision",
      keywords: "container service stack",
      relevance: 10,
      destructive: true,
      run: () => ctx.restartContainer(c.name),
    });
  }

  // Workspace deep-links + utilities.
  const panels: Array<[string, string]> = [
    ["blotter", "Open blotter"],
    ["runs", "Open runs"],
    ["strategies", "Open strategies"],
  ];
  for (const [panel, title] of panels) {
    cmds.push({
      id: `panel:${panel}`,
      title,
      verb: `open ${panel}`,
      group: "Workspace",
      keywords: "ide trade orders",
      relevance: 6,
      run: () => ctx.openIdePanel(panel),
    });
  }

  cmds.push({
    id: "refresh",
    title: "Refresh status",
    verb: "refresh",
    group: "Action",
    keywords: "reload poll update",
    relevance: 8,
    run: ctx.refresh,
  });
  cmds.push({
    id: "tips",
    title: "Show home tips",
    verb: "tips",
    group: "Help",
    keywords: "coachmark anatomy lamp vitals learn",
    relevance: 4,
    run: ctx.showTips,
  });
  cmds.push({
    id: "tutorial",
    title: "Replay the tour",
    verb: "tour",
    group: "Help",
    keywords: "tutorial help onboarding coachmarks",
    relevance: 4,
    run: ctx.openTutorial,
  });

  return cmds;
}

function actuatorVerb(action: BoardState["actuator"]["action"]): string {
  switch (action) {
    case "launch":
      return "launch";
    case "start":
      return "engine start";
    case "degraded":
      return "supervision";
    case "setup":
      return "finish setup";
    default:
      return action;
  }
}

/** Subsequence fuzzy score: -1 = no match; higher = tighter. Rewards a
 *  prefix match and contiguous runs, so "sup" ranks "Open Supervision"
 *  above "Open Updates". Case-insensitive. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q === "") return 0;
  if (t.startsWith(q)) return 1000 - t.length; // strong prefix bonus
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastIdx = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      run = lastIdx === i - 1 ? run + 1 : 1;
      score += 10 + run * 5;
      lastIdx = i;
      qi++;
    }
  }
  if (qi < q.length) return -1; // not all query chars matched in order
  return score - t.length; // shorter targets win ties
}

/** Rank commands for a query. Empty query → state-aware order (relevance
 *  desc), so the incident verb is first. Non-empty → fuzzy filter over
 *  title + verb + keywords, tie-broken by relevance. */
export function rankCommands(cmds: Command[], query: string): Command[] {
  if (query.trim() === "") {
    return [...cmds].sort((a, b) => b.relevance - a.relevance);
  }
  return cmds
    .map((c) => {
      const s = Math.max(
        fuzzyScore(query, c.title),
        fuzzyScore(query, c.verb),
        c.keywords ? fuzzyScore(query, c.keywords) : -1,
      );
      return { c, s };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.c.relevance - a.c.relevance)
    .map((x) => x.c);
}
