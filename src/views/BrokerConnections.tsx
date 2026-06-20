// Connections — ONE capability-tagged directory for everything this
// install connects to: execution brokers, crypto venues, AND market-data
// providers, in a single list.
//
// Why one list (not a Brokers card + a Data Sources card): the engine
// already models every connector by capability — each carries
// provides_data + provides_execution (broker_connections.rs, sourced
// from the engine's /ui/api/connectors registry). A "data source" is
// just a connection with provides_data:true, provides_execution:false;
// IBKR is data+execution. So two cards were redundant — they're merged
// here, grouped but never split.
//
// Layout (the connections-directory pattern used by Stripe / Datadog /
// Linear): a search box + category filter, then status-first sections —
// "Your connections" pinned on top, then the catalog grouped by category
// (Brokers · Crypto exchanges · Market data). Each row is a fixed 4-zone
// lane: monogram · name + asset chips + capability badges · status pill ·
// one action that FITS the connector.
//
// The connect action is per-connector, derived from engine truth:
//   * execution-capable broker (IBKR) → the in-app gateway/portal login
//     (the IbeamSetup sub-card + a one-click Sign in).
//   * data-only provider with a key flow (Polygon / EODHD / …) → the
//     API-key entry/test form (dataKeySave / dataKeyTest → /ui/api/keys),
//     expanded inline under the row.
//   * anything with no real launcher flow yet → "coming soon", no action.
//
// Honesty contract:
//   * Data / Trade capability badges reflect REAL engine + adapter
//     support (provides_data / provides_execution from the engine
//     registry). They are neutral, hairline chips — never colored — so
//     they describe a source's capability without implying a live
//     connection.
//   * The colored status pill is the ONLY claim about this launcher's
//     connection. A data-key provider shows "Saved" (not "connected")
//     until a Test passes; the "configured"/"verified" badge is engine
//     truth. "Coming soon" rows are dimmed, carry no action, and are
//     aria-disabled, so a non-connectable source can never be misread as
//     working.
//   * A key VALUE is never logged, never placed in a URL, never displayed.

import { useCallback, useEffect, useMemo, useState } from "react";

import IncidentCard from "@/components/IncidentCard";
import { useSettings } from "@/lib/settings";
import IbeamSetup from "@/views/IbeamSetup";
// Official broker marks — used under nominative fair use to identify the
// connection (full provenance in each SVG's header). ONLY verified,
// in-repo official assets belong here; brokers without one fall back to
// a neutral text placeholder rather than an invented logo.
import alpacaLogo from "@/assets/brokers/alpaca.svg";
import ibkrLogo from "@/assets/brokers/ibkr.svg";
import {
  cmd,
  openInBrowser,
  type BrokerState,
  type BrokerStatus,
} from "@/lib/tauri";

// ── Data-key providers (engine `market_data` key category) ──────────
//
// These connect by an API key saved through the engine's /ui/api/keys
// surface (the door the retired Houston "Key Master" used). The list is
// the engine's PROVIDER_CATEGORIES["market_data"].members from
// auracle/keys.py — kept in sync with the engine; an unknown provider is
// rejected with a 404 by /ui/api/keys.
//
// Some of these (polygon, eodhd) also appear in the connector registry
// with real capability truth; the others (nasdaq_data_link, brain,
// coingecko) live ONLY in the key category, so we synthesize a data row
// for any that the registry doesn't already carry — keeping ONE list.
const DATA_KEY_PROVIDERS: Record<string, { label: string; hint: string }> = {
  polygon: { label: "Polygon.io", hint: "polygon api key" },
  eodhd: { label: "EOD Historical Data", hint: "eodhd api token" },
  nasdaq_data_link: {
    label: "Nasdaq Data Link (Sharadar)",
    hint: "ndl key",
  },
  brain: {
    label: "Brain Company (BSI / BLMCF)",
    hint: "Brain subscription key",
  },
  coingecko: {
    label: "CoinGecko Pro",
    hint: "CG-… (Pro key — free tier needs none)",
  },
};

/** True when a connector connects by a data-provider API key (the
 *  /ui/api/keys flow), so the row shows the key entry/test form instead
 *  of a broker login. */
function isDataKeyProvider(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DATA_KEY_PROVIDERS, id);
}

/** Merge the engine connector catalog with the data-key providers into
 *  ONE row model. Pure (no IO) so it's unit-testable. Data-key providers
 *  the registry already carries (polygon, eodhd) are left as-is — they
 *  keep their engine capability truth and just gain the key action via
 *  isDataKeyProvider. Data-key providers the registry does NOT carry
 *  (nasdaq_data_link, brain, coingecko) are appended as synthesized
 *  data-only rows so they appear in the same list rather than a second
 *  card. Synthesized rows claim provides_data:true (they exist to feed
 *  market data) and never claim execution. */
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
      connect_method: "none",
      // A data-key provider isn't a wired adapter, so its base "state"
      // is not_implemented; the row treats it as connectable purely
      // because it has the key form (isDataKeyProvider), so it lands in
      // "Your connections" with the Save/Test action, NOT "coming soon".
      state: { state: "not_implemented" },
    });
  }
  return [...catalog, ...synthesized];
}

export default function ConnectionsCard() {
  const [statuses, setStatuses] = useState<BrokerStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [houstonConflict, setHoustonConflict] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await cmd.forgeBrokerStatus();
      // Fold the data-key providers into the same list — one unified
      // directory of everything this install connects to.
      setStatuses(mergeDataKeyProviders(result));
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshing(false);
    }
    // Probe for the Houston-managed IBKR gateway container — it's
    // the predecessor of the launcher's ibeam path and the two
    // can't coexist (both bind port 5000). Surface a clear
    // conflict notice if it's running so the user knows to take
    // one path or the other.
    try {
      const found = await cmd.dockerContainerRunning([
        "auracle-cpgateway",
        "auracle-ibgateway",
        "ibgateway",
        "cpgateway",
      ]);
      setHoustonConflict(found);
    } catch {
      setHoustonConflict(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 15s ONLY while the user has the Settings view
  // open AND there's at least one broker mid-flight (unauthenticated
  // is the most common case — they clicked Connect, the login window
  // popped open, now they're entering credentials; we want to flip
  // the card to Connected the moment that completes without making
  // them hit Refresh).
  useEffect(() => {
    if (!statuses) return;
    const needsPoll = statuses.some(
      (s) =>
        s.state.state === "unauthenticated" || s.state.state === "offline",
    );
    if (!needsPoll) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, 15000);
    return () => clearInterval(interval);
  }, [statuses, refresh]);

  return (
    <div className="card directory-well">
      {/* The section's mono-label already says "Connections" — drop the
          redundant card-title here, but keep the Refresh action,
          right-aligned. */}
      <div className="card-head card-head--action-only">
        <button
          type="button"
          className="ghost btn-sm"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>
      <p className="muted fs-sm m-0 mb-3">
        One place for brokers, crypto venues, and market data — IBKR signs in
        in-app, providers take an API key, all right here.
      </p>
      {houstonConflict && (
        <HoustonConflictBanner
          containerName={houstonConflict}
          onResolved={refresh}
        />
      )}
      {error && <div className="mono err-text mb-3">{error}</div>}
      {!statuses && !error && (
        <div className="muted fs-xs mt-1">Checking…</div>
      )}
      {statuses && <ConnectionsDirectory statuses={statuses} onRefresh={refresh} />}
    </div>
  );
}

// ── Directory ───────────────────────────────────────────────────────

const CATEGORY_ORDER: BrokerStatus["category"][] = ["broker", "crypto", "data"];
const CATEGORY_LABEL: Record<BrokerStatus["category"], string> = {
  broker: "Brokers",
  crypto: "Crypto exchanges",
  data: "Market data",
};
type Filter = "all" | BrokerStatus["category"];

/** A connection has a real launcher flow when it's a wired adapter (any
 *  state other than not_implemented) OR it's a data-key provider (it
 *  takes an API key here). Coming-soon catalog rows are everything else. */
function connectable(b: BrokerStatus): boolean {
  return b.state.state !== "not_implemented" || isDataKeyProvider(b.id);
}

function ConnectionsDirectory({
  statuses,
  onRefresh,
}: {
  statuses: BrokerStatus[];
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const q = query.trim().toLowerCase();
  const matchesSearch = (b: BrokerStatus) =>
    !q ||
    b.label.toLowerCase().includes(q) ||
    b.category.toLowerCase().includes(q) ||
    b.description.toLowerCase().includes(q) ||
    b.assets.some((a) => a.toLowerCase().includes(q));

  // "Your connections" = sources with a real connect flow (a wired
  // adapter or a data-key provider). Shown status-first and filtered by
  // SEARCH only (never by the category chip) so a live connection never
  // vanishes when the user filters to a category it doesn't belong to.
  const connected = useMemo(
    () => statuses.filter((b) => connectable(b) && matchesSearch(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses, q],
  );
  // The catalog respects both search and the category chip.
  const catalog = useMemo(
    () =>
      statuses.filter(
        (b) =>
          !connectable(b) &&
          matchesSearch(b) &&
          (filter === "all" || b.category === filter),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses, filter, q],
  );
  const totalShown = connected.length + catalog.length;

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input
            type="text"
            value={query}
            placeholder="Search brokers and data sources"
            aria-label="Search brokers and data sources"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="dir-filters" role="tablist" aria-label="Filter by type">
          {(["all", "broker", "crypto", "data"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`dir-filter ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : CATEGORY_LABEL[f]}
            </button>
          ))}
        </div>
      </div>

      {totalShown === 0 && (
        <div className="muted fs-sm dir-empty">
          No sources match “{query.trim()}”.{" "}
          <button type="button" className="linklike" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      )}

      {connected.length > 0 && (
        <section className="dir-section">
          <div className="dir-section__head">
            <span>Your connections</span>
            <span className="dir-section__count">{connected.length}</span>
          </div>
          {connected.map((b) => (
            <DirectoryRow key={b.id} broker={b} onRefresh={onRefresh} />
          ))}
        </section>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const rows = catalog.filter((b) => b.category === cat);
        if (rows.length === 0) return null;
        return (
          <section className="dir-section" key={cat}>
            <div className="dir-section__head">
              <span>{CATEGORY_LABEL[cat]}</span>
              <span className="dir-section__count">{rows.length}</span>
            </div>
            {rows.map((b) => (
              <DirectoryRow key={b.id} broker={b} onRefresh={onRefresh} />
            ))}
          </section>
        );
      })}

      <p className="dir-legend">
        <span className="cap-badge"><DataIcon />Data</span> = engine can pull
        market data ·{" "}
        <span className="cap-badge"><TradeIcon />Trade</span> = can place orders ·{" "}
        <span className="method-tag method-tag--portal">Portal</span> = sign in
        through the broker&apos;s own secure login, opened right here —
        Interactive Brokers connects this way in-app.{" "}
        <span className="method-tag">API key</span> data providers (Polygon,
        EODHD, …) take a key right here in the row.{" "}
        <span className="method-tag">Wallet</span> brokers and the remaining
        API-key brokers (Alpaca, ClearStreet, Hyperliquid) are coming soon to
        the launcher.
      </p>
    </>
  );
}

// ── Row ─────────────────────────────────────────────────────────────

function DirectoryRow({
  broker,
  onRefresh,
}: {
  broker: BrokerStatus;
  onRefresh: () => void;
}) {
  const isIbkr = broker.id === "ibkr";
  const isDataKey = isDataKeyProvider(broker.id);
  // A row is "coming soon" only when it has NO real launcher flow — a
  // wired adapter that's not_implemented AND not a data-key provider.
  const soon = broker.state.state === "not_implemented" && !isDataKey;

  return (
    <div
      className={`dir-row ${soon ? "is-soon" : ""}`}
      aria-disabled={soon || undefined}
    >
      <div className="dir-row__top">
        <BrokerIcon id={broker.id} label={broker.label} />
        <div className="dir-row__meta">
          <div className="dir-name">
            {broker.label}
            {soon && <span className="sr-only"> (not yet available)</span>}
          </div>
          <div className="dir-tags">
            <AssetChips assets={broker.assets} />
            <CapabilityBadges
              data={broker.provides_data}
              trade={broker.provides_execution}
            />
            <ConnectMethodTag
              method={broker.connect_method}
              isDataKey={isDataKey}
            />
          </div>
        </div>
        <StatePill state={broker.state} isDataKey={isDataKey} />
        <div className="dir-row__action">
          <RowAction broker={broker} onRefresh={onRefresh} />
        </div>
      </div>
      {isIbkr && !soon && (
        <div className="dir-row__expand">
          <IbeamSetup onStateChange={onRefresh} />
        </div>
      )}
      {isDataKey && (
        <div className="dir-row__expand">
          <DataKeyForm providerId={broker.id} />
        </div>
      )}
    </div>
  );
}

/** One primary action per row, mapped to what the connector actually
 *  supports. Coming-soon (wired adapter, not_implemented) returns null —
 *  structurally impossible to show a clickable connect on a
 *  non-integrated source (honesty contract). Data-key providers have no
 *  trailing button (their action is the inline Save/Test form below);
 *  the column stays empty so every status pill keeps its x-position. For
 *  IBKR the managed gateway lifecycle lives in the IbeamSetup sub-card,
 *  but when the gateway is up-and-unauthenticated the row offers a
 *  one-click "Sign in" that opens the broker's own Client Portal login. */
function RowAction({
  broker,
  onRefresh,
}: {
  broker: BrokerStatus;
  onRefresh: () => void;
}) {
  // Data-key providers carry their action in the inline form, not a
  // trailing button.
  if (isDataKeyProvider(broker.id)) return null;
  if (broker.state.state === "not_implemented") return null;
  if (broker.id === "ibkr") {
    if (broker.state.state === "unauthenticated") {
      return (
        <IbkrSignInButton
          loginUrl={broker.state.login_url}
          onRefresh={onRefresh}
        />
      );
    }
    return null; // offline/connected/error handled by the IbeamSetup card
  }
  if (broker.state.state === "error") {
    return (
      <button type="button" className="ghost btn-sm" onClick={onRefresh}>
        Retry
      </button>
    );
  }
  return null;
}

/** Inline API-key entry/test for a data-key provider, expanded under the
 *  row. Saves through the engine's /ui/api/keys surface over loopback.
 *
 *  HONESTY: a key is only "verified" after a Test passes — never inferred
 *  from a Save. Save shows "Saved", not "connected". The "configured"
 *  badge is read from the shared settings aggregate (engine truth — the
 *  engine reports whether a key is on file, never the value). A 409 (paid
 *  tier, vault unavailable) surfaces a plain remediation, never a fake
 *  success. The key value never leaves the input → IPC body; it is never
 *  logged or displayed. */
function DataKeyForm({ providerId }: { providerId: string }) {
  const { settings, refresh } = useSettings();
  const meta = DATA_KEY_PROVIDERS[providerId];
  const configured = settings?.data_keys?.[providerId]?.configured ?? false;

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
      await cmd.dataKeySave(providerId, v);
      setStatus("Saved.");
      // Refresh the shared aggregate so the "configured" badge updates
      // from engine truth (the saved key is on file now).
      refresh();
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
      const ok = await cmd.dataKeyTest(providerId);
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
    <div className="datakey-form">
      <div className="hstack mb-2">
        <span className="muted fs-xs" style={{ flex: 1 }}>
          {configured
            ? "A key is on file. Paste a new one to replace it."
            : "Add an API key so this provider's data works."}
        </span>
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
          placeholder={meta?.hint ?? "api key"}
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

/** Opens the IBKR Client Portal login in the launcher's embedded webview
 *  (open_ibkr_login), falling back to the system browser if the embedded
 *  window can't be created. Re-probes shortly after so the row flips to
 *  "connected" once the user signs in + approves 2FA. */
function IbkrSignInButton({
  loginUrl,
  onRefresh,
}: {
  loginUrl: string;
  onRefresh: () => void;
}) {
  const [opening, setOpening] = useState(false);
  return (
    <button
      type="button"
      className="primary btn-sm"
      disabled={opening}
      onClick={async () => {
        setOpening(true);
        try {
          await cmd.openIbkrLogin(loginUrl);
        } catch (err) {
          console.warn("openIbkrLogin failed, falling back to browser:", err);
          await openInBrowser(loginUrl);
        } finally {
          setOpening(false);
        }
        setTimeout(onRefresh, 4000);
      }}
    >
      {opening ? "Opening…" : "Sign in"}
    </button>
  );
}

function StatePill({
  state,
  isDataKey,
}: {
  state: BrokerState;
  isDataKey: boolean;
}) {
  // A data-key provider's not_implemented base state is not "coming
  // soon" — it just means "needs a key". The configured/verified truth
  // lives in the inline form's badge, so the pill stays quiet here.
  if (state.state === "not_implemented" && isDataKey) {
    return <span className="dir-pill soon">add key</span>;
  }
  const cfg: Record<
    BrokerState["state"],
    { variant: string; label: string }
  > = {
    // Novice-readable connection states (word, not just color).
    offline: { variant: "warn", label: "not connected" },
    unauthenticated: { variant: "warn", label: "waiting for sign-in" },
    connected: { variant: "ok", label: "connected" },
    error: { variant: "err", label: "failed" },
    not_implemented: { variant: "soon", label: "coming soon" },
  };
  const s = cfg[state.state];
  return <span className={`dir-pill ${s.variant}`}>{s.label}</span>;
}

// ── Atoms ───────────────────────────────────────────────────────────

const ASSET_LABEL: Record<string, string> = {
  equities: "Stocks",
  options: "Options",
  futures: "Futures",
  forex: "Forex",
  crypto: "Crypto",
  indices: "Indices",
  metals: "Metals",
};

function AssetChips({ assets }: { assets: string[] }) {
  const shown = assets.slice(0, 3);
  const extra = assets.length - shown.length;
  return (
    <>
      {shown.map((a) => (
        <span key={a} className="achip">
          {ASSET_LABEL[a] ?? a}
        </span>
      ))}
      {extra > 0 && <span className="achip achip--more">+{extra}</span>}
    </>
  );
}

function CapabilityBadges({
  data,
  trade,
}: {
  data: boolean;
  trade: boolean;
}) {
  return (
    <>
      {data && (
        <span className="cap-badge" title="Engine can pull market data">
          <DataIcon />
          Data
        </span>
      )}
      {trade && (
        <span className="cap-badge" title="Can place orders">
          <TradeIcon />
          Trade
        </span>
      )}
    </>
  );
}

/** How you connect this source from the launcher. "Portal" = an
 *  in-launcher gateway login flow exists today (accent). A data-key
 *  provider shows an accented "API key" tag because it IS connectable
 *  here (the inline form). The other "api_key"/"wallet" brokers are
 *  neutral — honest that there's no in-launcher flow yet. Data-only
 *  registry rows that aren't key-enterable ("none") show nothing. */
function ConnectMethodTag({
  method,
  isDataKey,
}: {
  method: BrokerStatus["connect_method"];
  isDataKey: boolean;
}) {
  // A connectable data-key provider: accented "API key" — it takes a key
  // right here, so the tag is live, not the neutral "no flow yet" tone.
  if (isDataKey) {
    return (
      <span
        className="method-tag method-tag--portal"
        title="Connects with an API key, entered right here in the row"
      >
        API key
      </span>
    );
  }
  if (method === "none") return null;
  const cfg: Record<string, { label: string; cls: string; title: string }> = {
    gateway: {
      label: "Portal",
      cls: "method-tag method-tag--portal",
      title: "Connect through the broker's secure login, opened from here",
    },
    api_key: {
      label: "API key",
      cls: "method-tag",
      title: "Connects with an API key (no in-launcher portal yet)",
    },
    wallet: {
      label: "Wallet",
      cls: "method-tag",
      title: "Connects with a signing wallet (no in-launcher portal)",
    },
  };
  const c = cfg[method];
  if (!c) return null;
  return <span className={c.cls} title={c.title}>{c.label}</span>;
}

/** The connector's official mark where a verified, license-permitted
 *  in-repo asset exists; otherwise a NEUTRAL, brand-agnostic initials
 *  placeholder. A per-broker COLOR would be a homemade logo
 *  approximation, so the placeholder is deliberately monochrome — the
 *  always-visible text label (not the icon) identifies the broker. */
const OFFICIAL_LOGOS: Record<string, string> = {
  ibkr: ibkrLogo,
  alpaca: alpacaLogo,
};

function BrokerIcon({ id, label }: { id: string; label: string }) {
  const logo = OFFICIAL_LOGOS[id];
  if (logo) {
    return (
      <div className="dir-logo dir-logo--official" aria-hidden="true">
        <img src={logo} alt="" />
      </div>
    );
  }
  const initials = label
    .replace(/[^A-Za-z0-9 ]/g, "")
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="dir-logo dir-logo--placeholder" aria-hidden="true">
      {initials}
    </div>
  );
}

// ── Houston gateway conflict (port 5000) ────────────────────────────

/** Port conflict — Houston's bundled IBKR gateway and the launcher's
 *  ibeam container both bind localhost:5000, so one has to yield.
 *  Operates directly on the detected container name (no compose
 *  intermediary) so it works even when the stack's .env is missing
 *  optional vars that would fail compose before the rm. */
function HoustonConflictBanner({
  containerName,
  onResolved,
}: {
  containerName: string;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <IncidentCard
      severity="warn"
      cause="Port already in use — the stack's IBKR gateway holds localhost:5000."
      detail={`container: ${containerName}`}
      action={{
        label: busy ? "Stopping…" : "Free the port",
        primary: true,
        busy,
        onClick: async () => {
          setBusy(true);
          try {
            await cmd.dockerRemoveContainer(containerName);
            onResolved();
          } finally {
            setBusy(false);
          }
        },
      }}
    >
      <p className="muted fs-2xs m-0 lh-relaxed mt-2">
        Freeing it lets the launcher host the connection for every surface
        and re-log in on IBKR&apos;s daily session reset.
      </p>
    </IncidentCard>
  );
}

// ── Icons (inline, currentColor) ────────────────────────────────────

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function DataIcon() {
  // Database cylinder — clearly distinct from the Trade chart glyph.
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <ellipse cx="8" cy="4" rx="5" ry="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function TradeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M3 9l3-3 2.5 2.5L13 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 4h3v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
