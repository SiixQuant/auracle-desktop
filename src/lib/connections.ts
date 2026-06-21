// Connections — pure, IO-free logic for the Connections directory.
//
// Split out of BrokerConnections.tsx so it's unit-testable under
// `node --test` (the component carries JSX + Vite asset globs that the
// type-stripping test runner can't parse). Everything here is a pure
// function over engine truth.

import type { BrokerDataQuality, BrokerStatus } from "./tauri.ts";

// Data-key providers (engine `market_data` key category) — connect by an
// API key saved through /ui/api/keys. Mirrors the engine's
// PROVIDER_CATEGORIES["market_data"].members (auracle/keys.py).
export const DATA_KEY_PROVIDERS: Record<string, { label: string; hint: string }> = {
  polygon: { label: "Polygon.io", hint: "polygon api key" },
  eodhd: { label: "EOD Historical Data", hint: "eodhd api token" },
  nasdaq_data_link: { label: "Nasdaq Data Link (Sharadar)", hint: "ndl key" },
  brain: { label: "Brain Company (BSI / BLMCF)", hint: "Brain subscription key" },
  coingecko: { label: "CoinGecko Pro", hint: "CG-… (Pro key — free tier needs none)" },
};

export function isDataKeyProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DATA_KEY_PROVIDERS, id);
}

/** Merge the engine connector catalog with the data-key providers into ONE
 *  row model. Providers the registry already carries keep their engine
 *  capability truth; the rest are appended as data-only rows so everything
 *  stays in one list. */
export function mergeDataKeyProviders(catalog: BrokerStatus[]): BrokerStatus[] {
  const present = new Set(catalog.map((b) => b.id.toLowerCase()));
  const synthesized: BrokerStatus[] = [];
  for (const [id, meta] of Object.entries(DATA_KEY_PROVIDERS)) {
    if (present.has(id.toLowerCase())) continue;
    synthesized.push({
      id,
      label: meta.label,
      description: "Market-data provider — connects with an API key.",
      capabilities: [],
      category: "data",
      assets: [],
      provides_data: true,
      provides_execution: false,
      connect_method: "api_key",
      state: { state: "not_implemented" },
    });
  }
  return [...catalog, ...synthesized];
}

/** A connection has a real launcher flow when it's a wired adapter (any
 *  state other than not_implemented) OR it's a data-key provider. */
export function connectable(b: BrokerStatus): boolean {
  return b.state.state !== "not_implemented" || isDataKeyProvider(b.id);
}

export type HealthTone = "ok" | "warn" | "muted";

/** Map an engine data-quality tier to a tone + plain word for the list
 *  health line. "realtime" is the only trade-ready state; everything else
 *  is non-green (the engine refuses to trade on delayed data). "unknown"
 *  stays silent rather than alarming. */
export function healthFromQuality(
  q: BrokerDataQuality | null | undefined,
): { tone: HealthTone; word: string } {
  if (q === "realtime") return { tone: "ok", word: "real-time" };
  if (q === "delayed") return { tone: "warn", word: "delayed" };
  if (q === "frozen" || q === "halted") return { tone: "warn", word: q };
  if (q === "closed") return { tone: "muted", word: "market closed" };
  return { tone: "muted", word: "" };
}
