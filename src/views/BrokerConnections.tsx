// BrokerConnections — a compact, enterprise-grade connections
// directory for the Settings page.
//
// Layout (per the connections-directory pattern used by Stripe / Datadog
// / Linear): a search box + category filter, then status-first sections
// — "Connected" pinned on top, then the catalog grouped by category
// (Brokers · Crypto exchanges · Market data). Each row is a fixed
// 4-zone lane: monogram · name + asset chips + capability badges ·
// status pill · one action.
//
// Honesty contract:
//   * The Data / Trade capability badges reflect REAL engine + adapter
//     support (broker_connections.rs sets provides_data /
//     provides_execution from what actually ships). They are neutral,
//     hairline chips — never colored — so they describe a source's
//     capability without implying a live connection.
//   * The colored status pill is the ONLY claim about this launcher's
//     connection. "Coming soon" rows are dimmed, carry no action
//     button (structurally — the action switch returns null), and are
//     aria-disabled, so a non-connectable source can never be misread
//     as working.
//   * IBKR is the one source with a one-click connect flow today; its
//     row hosts the IbeamSetup sub-card.

import { useCallback, useEffect, useMemo, useState } from "react";

import IncidentCard from "@/components/IncidentCard";
import IbeamSetup from "@/views/IbeamSetup";
// Official broker marks — used under nominative fair use to identify the
// connection (full provenance in each SVG's header). ONLY verified,
// in-repo official assets belong here; brokers without one fall back to
// a neutral text placeholder rather than an invented logo.
import alpacaLogo from "@/assets/brokers/alpaca.svg";
import ibkrLogo from "@/assets/brokers/ibkr.svg";
import {
  cmd,
  openIdePanel,
  openInBrowser,
  type BrokerState,
  type BrokerStatus,
} from "@/lib/tauri";

export default function BrokerConnectionsCard() {
  const [statuses, setStatuses] = useState<BrokerStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [houstonConflict, setHoustonConflict] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await cmd.forgeBrokerStatus();
      setStatuses(result);
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
    <div className="card">
      <div className="card-head">
        <span className="card-title">Connections</span>
        <button
          type="button"
          className="ghost btn-sm"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>
      <p className="muted fs-sm m-0 mb-2">
        Connect once — used everywhere in Auracle.
      </p>
      {/* The single canonical door to broker setup. IBKR connects in-app
          below; every API-key / wallet broker (Alpaca, ClearStreet,
          Hyperliquid, …) is set up via the IDE's native broker-connect
          wizard, reached by deep-linking into the IDE's connections panel.
          Opens a real credential form — never implies a connection that
          isn't there. */}
      <button
        type="button"
        className="primary btn-sm mb-3"
        onClick={() => openIdePanel("connections")}
      >
        Connect a broker
      </button>
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
      {statuses && <BrokerDirectory statuses={statuses} onRefresh={refresh} />}
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

function BrokerDirectory({
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

  const connectable = (b: BrokerStatus) => b.state.state !== "not_implemented";

  // "Your connections" = sources with a real connect flow. Shown
  // status-first and filtered by SEARCH only (never by the category
  // chip) so a live connection never vanishes when the user filters
  // to a category it doesn't belong to.
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
        <span className="method-tag">API key</span> and{" "}
        <span className="method-tag">Wallet</span> brokers (Alpaca, ClearStreet,
        Hyperliquid) are set up with <strong>Connect a broker</strong> above.
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
  const soon = broker.state.state === "not_implemented";

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
            <ConnectMethodTag method={broker.connect_method} />
          </div>
        </div>
        <StatePill state={broker.state} />
        <div className="dir-row__action">
          <RowAction broker={broker} onRefresh={onRefresh} />
        </div>
      </div>
      {isIbkr && !soon && (
        <div className="dir-row__expand">
          <IbeamSetup onStateChange={onRefresh} />
        </div>
      )}
    </div>
  );
}

/** One primary action per row, mapped 1:1 to state. Coming-soon returns
 *  null — structurally impossible to show a clickable connect on a
 *  non-integrated source (honesty contract). For IBKR, the managed
 *  gateway lifecycle lives in the IbeamSetup sub-card, but when the
 *  gateway is up-and-unauthenticated the row offers a one-click "Sign in"
 *  that opens the broker's own Client Portal login (the portal-open the
 *  earlier wizard had). */
function RowAction({
  broker,
  onRefresh,
}: {
  broker: BrokerStatus;
  onRefresh: () => void;
}) {
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

function StatePill({ state }: { state: BrokerState }) {
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

/** How you connect this broker from the launcher. "Portal" = an
 *  in-launcher gateway login flow exists today (accent); the others are
 *  honest about the real method so a non-portal broker is never mistaken
 *  for one. Data-only providers ("none") show nothing — they aren't a
 *  broker login. */
function ConnectMethodTag({ method }: { method: BrokerStatus["connect_method"] }) {
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
