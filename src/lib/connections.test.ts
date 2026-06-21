// Tests for the Connections directory's pure logic — the row-model merge,
// the connectable predicate, and the data-quality → health mapping that
// decides whether a connected broker is actually trade-ready.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  connectable,
  DATA_KEY_PROVIDERS,
  healthFromQuality,
  isDataKeyProvider,
  mergeDataKeyProviders,
} from "./connections.ts";
import type { BrokerStatus } from "./tauri.ts";

const broker = (over: Partial<BrokerStatus>): BrokerStatus => ({
  id: "ibkr",
  label: "Interactive Brokers",
  description: "",
  capabilities: [],
  category: "broker",
  assets: ["equities"],
  provides_data: true,
  provides_execution: true,
  connect_method: "gateway",
  state: { state: "offline", hint: "" },
  ...over,
});

test("mergeDataKeyProviders appends only providers the catalog lacks", () => {
  const merged = mergeDataKeyProviders([broker({ id: "polygon", category: "data" })]);
  const ids = merged.map((b) => b.id);
  // polygon was already present → not duplicated.
  assert.equal(ids.filter((i) => i === "polygon").length, 1);
  // the other key providers got synthesized.
  for (const id of Object.keys(DATA_KEY_PROVIDERS)) {
    if (id === "polygon") continue;
    assert.ok(ids.includes(id), `expected synthesized ${id}`);
  }
});

test("synthesized data-key rows claim data, never execution", () => {
  const merged = mergeDataKeyProviders([]);
  const eodhd = merged.find((b) => b.id === "eodhd");
  assert.ok(eodhd);
  assert.equal(eodhd!.provides_data, true);
  assert.equal(eodhd!.provides_execution, false);
  assert.equal(eodhd!.category, "data");
});

test("connectable: wired adapters and data-key providers, not coming-soon", () => {
  assert.equal(connectable(broker({ state: { state: "connected", account_id: "U1", account_label: null } })), true);
  assert.equal(connectable(broker({ state: { state: "offline", hint: "" } })), true);
  // a coming-soon adapter that is NOT a data-key provider
  assert.equal(connectable(broker({ id: "tradier", state: { state: "not_implemented" } })), false);
  // a coming-soon adapter that IS a data-key provider stays connectable (key form)
  assert.equal(connectable(broker({ id: "coingecko", category: "data", state: { state: "not_implemented" } })), true);
  assert.equal(isDataKeyProvider("coingecko"), true);
  assert.equal(isDataKeyProvider("ibkr"), false);
});

test("healthFromQuality: only realtime is trade-ready/ok", () => {
  assert.deepEqual(healthFromQuality("realtime"), { tone: "ok", word: "real-time" });
  assert.deepEqual(healthFromQuality("delayed"), { tone: "warn", word: "delayed" });
  assert.equal(healthFromQuality("frozen").tone, "warn");
  // unknown / missing stays silent (empty word) rather than alarming
  assert.equal(healthFromQuality("unknown").word, "");
  assert.equal(healthFromQuality(null).word, "");
  assert.equal(healthFromQuality(undefined).word, "");
});
