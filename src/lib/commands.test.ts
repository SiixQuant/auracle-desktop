// Tests for the command palette's pure ranking — the part that decides
// what the operator sees first. Covers fuzzy matching, that the palette
// can only surface commands it was given (no fabricated suggestions), and
// the state-aware order that floats the current incident to the top.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fuzzyScore, rankCommands, type Command } from "./commands.ts";

const cmd = (id: string, title: string, verb: string, relevance: number): Command => ({
  id,
  title,
  verb,
  group: "x",
  relevance,
  run: () => {},
});

test("fuzzyScore: prefix beats scattered subsequence beats no-match", () => {
  const prefix = fuzzyScore("con", "connections"); // strong prefix bonus
  const scattered = fuzzyScore("con", "cannon"); // c…o…n in order, not a prefix
  assert.ok(prefix > scattered);
  assert.ok(scattered > 0);
  assert.equal(fuzzyScore("xyz", "connections"), -1); // chars not in order
});

test("fuzzyScore: empty query matches everything (score 0)", () => {
  assert.equal(fuzzyScore("", "anything"), 0);
});

test("rankCommands: empty query orders by relevance (incident first)", () => {
  const cmds = [
    cmd("open", "Open Connections", "connections", 20),
    cmd("act", "Start engine", "engine start", 100), // incident verb
    cmd("refresh", "Refresh status", "refresh", 8),
  ];
  const ranked = rankCommands(cmds, "");
  assert.equal(ranked[0].id, "act");
  assert.equal(ranked[ranked.length - 1].id, "refresh");
});

test("rankCommands: a query only surfaces matching commands", () => {
  const cmds = [
    cmd("a", "Open Connections", "connections", 20),
    cmd("b", "Start engine", "engine start", 100),
    cmd("c", "Open Account", "account", 20),
  ];
  const ranked = rankCommands(cmds, "conn");
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["a"],
  );
});

test("rankCommands: query match beats raw relevance", () => {
  const cmds = [
    cmd("act", "Start engine", "engine start", 100),
    cmd("acct", "Open Account", "account", 20),
  ];
  // "account" should win for the query even though "Start engine" has
  // higher base relevance — query relevance dominates.
  const ranked = rankCommands(cmds, "account");
  assert.equal(ranked[0].id, "acct");
});

test("rankCommands: matches keyword synonyms, not just the title", () => {
  const c: Command = { ...cmd("a", "Open Account", "account", 20), keywords: "pnl positions" };
  const ranked = rankCommands([c], "pnl");
  assert.equal(ranked.length, 1);
});
