// Connections — ONE capability-tagged directory for everything this
// install connects to (execution brokers, crypto venues, market-data
// providers), with a focused "rising sheet" connect flow per source.
//
// Interaction ("The Riser"): the directory is a lean, searchable list.
// Tapping a connectable row raises a focused connect sheet OVER the dimmed
// list — big official logo, the real-time/delayed health banner, then the
// minimal vaulted form (IBKR creds, or a data provider's API key) — so the
// connect controls are never buried below the fold and Connect is always
// reachable. Back / the dimmed scrim / Esc dismiss it.
//
// Why one list (not a Brokers card + a Data Sources card): the engine
// already models every connector by capability — provides_data +
// provides_execution (broker_connections.rs, from /ui/api/connectors). A
// "data source" is a connection with provides_data:true; IBKR is both. So
// two cards were redundant — merged here, grouped but never split.
//
// Honesty contract:
//   * Data / Trade badges reflect REAL engine + adapter support
//     (provides_data / provides_execution). Neutral hairline chips.
//   * The colored status pill is the ONLY claim about this launcher's
//     connection. For an execution broker that's connected, a second
//     health word (real-time / delayed) reflects engine data-quality
//     truth — because a strategy can't trade on delayed data.
//   * Official broker marks are used under nominative fair use to identify
//     the connection. Marks are ASSET-DRIVEN: any verified SVG dropped in
//     src/assets/brokers/<id>.svg is used automatically; a connector with
//     no verified mark falls back to a neutral monogram — never an
//     invented logo.
//   * A key/credential VALUE is never logged, placed in a URL, or shown.

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  connectable,
  DATA_KEY_PROVIDERS,
  healthFromQuality,
  isDataKeyProvider,
  mergeDataKeyProviders,
} from "@/lib/connections";
import { useSettings } from "@/lib/settings";
import IbkrConnect from "@/views/IbkrConnect";
import {
  cmd,
  type BrokerMarketDataStatus,
  type BrokerState,
  type BrokerStatus,
} from "@/lib/tauri";

// ── Official marks (asset-driven) ───────────────────────────────────
//
// Every *.svg in src/assets/brokers is mapped by filename → connector id
// at build time (Vite glob). Drop a verified official mark named for the
// engine connector id (e.g. `polygon.svg`) and it renders with no code
// change — this is how we "pull every sourceable mark" incrementally
// while keeping the honesty rule: official asset or monogram, never a fake.
const LOGO_URLS = import.meta.glob("../assets/brokers/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function officialLogo(id: string): string | null {
  const want = `/${id.toLowerCase()}.svg`;
  const key = Object.keys(LOGO_URLS).find((p) => p.toLowerCase().endsWith(want));
  return key ? LOGO_URLS[key] : null;
}

// ── Card ────────────────────────────────────────────────────────────

export default function ConnectionsCard() {
  const [statuses, setStatuses] = useState<BrokerStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The market-data quality of the connected execution broker (IBKR),
  // used for the per-row health word and the sheet's health banner.
  const [mdStatus, setMdStatus] = useState<BrokerMarketDataStatus | null>(null);
  // The connector whose connect sheet is open (null = list).
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await cmd.forgeBrokerStatus();
      setStatuses(mergeDataKeyProviders(result));
      // Probe data quality only when an execution broker is connected —
      // that's the only case where real-time-vs-delayed matters.
      const liveExec = result.some(
        (b) => b.provides_execution && b.state.state === "connected",
      );
      if (liveExec) {
        try {
          setMdStatus(await cmd.brokerMarketDataStatus());
        } catch {
          setMdStatus(null);
        }
      } else {
        setMdStatus(null);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 15s while a connection is mid-flight (the user
  // clicked Connect and the gateway is coming up) so the row flips to
  // connected without a manual Refresh.
  useEffect(() => {
    if (!statuses) return;
    const needsPoll = statuses.some(
      (s) => s.state.state === "unauthenticated" || s.state.state === "offline",
    );
    if (!needsPoll) return;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, 15000);
    return () => clearInterval(interval);
  }, [statuses, refresh]);

  const active = useMemo(
    () => statuses?.find((b) => b.id === activeId) ?? null,
    [statuses, activeId],
  );

  // Esc closes the sheet (before the inspector's own Esc handler).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setActiveId(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);

  return (
    <div className="card directory-well conn-root">
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
      <div className="conn-scroll">
        {error && <div className="mono err-text mb-3">{error}</div>}
        {!statuses && !error && <div className="muted fs-xs mt-1">Checking…</div>}
        {statuses && (
          <ConnectionsDirectory
            statuses={statuses}
            mdStatus={mdStatus}
            onOpen={setActiveId}
          />
        )}
      </div>

      {active && (
        <>
          <div
            className="riser-scrim"
            onClick={() => setActiveId(null)}
            aria-hidden="true"
          />
          <ConnectSheet
            broker={active}
            mdStatus={mdStatus}
            onClose={() => setActiveId(null)}
            onRefresh={refresh}
          />
        </>
      )}
    </div>
  );
}

// ── Directory (list) ────────────────────────────────────────────────

const CATEGORY_ORDER: BrokerStatus["category"][] = ["broker", "crypto", "data"];
const CATEGORY_LABEL: Record<BrokerStatus["category"], string> = {
  broker: "Brokers",
  crypto: "Crypto venues",
  data: "Market data",
};

function ConnectionsDirectory({
  statuses,
  mdStatus,
  onOpen,
}: {
  statuses: BrokerStatus[];
  mdStatus: BrokerMarketDataStatus | null;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showSoon, setShowSoon] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = (b: BrokerStatus) =>
    !q ||
    b.label.toLowerCase().includes(q) ||
    b.category.toLowerCase().includes(q) ||
    b.description.toLowerCase().includes(q) ||
    b.assets.some((a) => a.toLowerCase().includes(q));

  // Connectable-first: everything you can connect now is shown; coming-soon
  // is tucked behind one disclosure so the list stays about what works.
  const live = useMemo(
    () => statuses.filter((b) => connectable(b) && matches(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses, q],
  );
  const soon = useMemo(
    () => statuses.filter((b) => !connectable(b) && matches(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses, q],
  );

  // Group the live set: brokers (incl. crypto execution) first, then data.
  const liveByCat = (cat: BrokerStatus["category"]) =>
    live.filter((b) => b.category === cat);

  const empty = live.length + soon.length === 0;

  return (
    <>
      <div className="dir-toolbar">
        <div className="dir-search">
          <SearchIcon />
          <input
            type="text"
            value={query}
            placeholder="Search"
            aria-label="Search brokers and data sources"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {empty && (
        <div className="muted fs-sm dir-empty">
          No sources match “{query.trim()}”.{" "}
          <button type="button" className="linklike" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const rows = liveByCat(cat);
        if (rows.length === 0) return null;
        return (
          <section className="dir-section" key={cat}>
            <div className="dir-section__head">
              <span>{CATEGORY_LABEL[cat]}</span>
              <span className="dir-section__count">{rows.length}</span>
            </div>
            {rows.map((b) => (
              <DirectoryRow
                key={b.id}
                broker={b}
                mdStatus={mdStatus}
                onOpen={() => onOpen(b.id)}
              />
            ))}
          </section>
        );
      })}

      {soon.length > 0 && (
        <div className="dir-more">
          <button
            type="button"
            className="dir-more__btn"
            aria-expanded={showSoon}
            onClick={() => setShowSoon((v) => !v)}
          >
            <span className={`dir-more__chev ${showSoon ? "open" : ""}`}>›</span>
            More — coming soon
            <span className="dir-more__count">{soon.length}</span>
          </button>
          {showSoon &&
            soon.map((b) => (
              <DirectoryRow key={b.id} broker={b} mdStatus={null} soon />
            ))}
        </div>
      )}
    </>
  );
}

// ── Row ─────────────────────────────────────────────────────────────

function DirectoryRow({
  broker,
  mdStatus,
  onOpen,
  soon,
}: {
  broker: BrokerStatus;
  mdStatus: BrokerMarketDataStatus | null;
  onOpen?: () => void;
  soon?: boolean;
}) {
  const canOpen = !soon && !!onOpen;
  // Health word: only for a connected execution broker, from engine truth.
  const showHealth =
    broker.provides_execution && broker.state.state === "connected";
  const health = showHealth ? healthFromQuality(mdStatus?.us_equity) : null;

  return (
    <div
      className={`dir-row ${soon ? "is-soon" : ""} ${canOpen ? "is-expandable" : ""}`}
      aria-disabled={soon || undefined}
    >
      <div
        className="dir-row__top"
        role={canOpen ? "button" : undefined}
        tabIndex={canOpen ? 0 : undefined}
        onClick={canOpen ? onOpen : undefined}
        onKeyDown={
          canOpen
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen?.();
                }
              }
            : undefined
        }
      >
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
          </div>
        </div>
        <div className="dir-row__statestack">
          <StatePill state={broker.state} isDataKey={isDataKeyProvider(broker.id)} />
          {health && health.word && (
            <span className={`health-word ${health.tone}`}>{health.word}</span>
          )}
        </div>
        <span className="dir-row__chev" aria-hidden="true">
          {canOpen ? "›" : ""}
        </span>
      </div>
    </div>
  );
}

// ── Connect sheet (rises over the dimmed list) ──────────────────────

function ConnectSheet({
  broker,
  mdStatus,
  onClose,
  onRefresh,
}: {
  broker: BrokerStatus;
  mdStatus: BrokerMarketDataStatus | null;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const isIbkr = broker.id.toLowerCase() === "ibkr";
  const isDataKey = isDataKeyProvider(broker.id);
  const connected = broker.state.state === "connected";

  return (
    <div
      className="riser-sheet"
      role="dialog"
      aria-label={`Connect ${broker.label}`}
    >
      <div className="riser-handle" aria-hidden="true" />
      <button type="button" className="riser-back" onClick={onClose}>
        <span aria-hidden="true">‹</span> Connections
      </button>

      <div className="riser-hero">
        <BrokerIcon id={broker.id} label={broker.label} large />
        <div className="riser-title">{broker.label}</div>
        <div className="dir-tags riser-chips">
          <AssetChips assets={broker.assets} />
          <CapabilityBadges
            data={broker.provides_data}
            trade={broker.provides_execution}
          />
        </div>
      </div>

      {isIbkr && connected && <HealthBanner mdStatus={mdStatus} />}

      <div className="riser-body">
        {isIbkr && <IbkrConnect onStateChange={onRefresh} onLater={onClose} />}
        {isDataKey && <DataKeyForm providerId={broker.id} />}
        {!isIbkr && !isDataKey && (
          <p className="muted fs-sm m-0 lh-relaxed">Not available yet.</p>
        )}
      </div>
    </div>
  );
}

/** The real-time-vs-delayed verdict, shown where the user connects. Driven
 *  by engine truth (BrokerMarketDataStatus). Delayed surfaces the engine's
 *  own subscription hint VERBATIM — never a hardcoded per-broker string —
 *  so the remediation is always accurate to the user's assets. */
function HealthBanner({ mdStatus }: { mdStatus: BrokerMarketDataStatus | null }) {
  const q = mdStatus?.us_equity;
  if (q === "realtime") {
    return (
      <div className="health-banner ok">
        <strong>Real-time data.</strong> Ready to trade.
      </div>
    );
  }
  if (q === "delayed" || q === "frozen" || q === "halted") {
    return (
      <div className="health-banner warn">
        <strong>Delayed data — live trading paused.</strong>
        {mdStatus?.hint ? ` ${mdStatus.hint}` : ""}
      </div>
    );
  }
  return null;
}

/** Inline API-key entry/test for a data-key provider. Saves through the
 *  engine's /ui/api/keys surface over loopback. A key is "verified" only
 *  after a Test passes — never inferred from a Save. The key value never
 *  leaves the input → IPC body; never logged or displayed. */
function DataKeyForm({ providerId }: { providerId: string }) {
  const { settings, refresh } = useSettings();
  const meta = DATA_KEY_PROVIDERS[providerId];
  const configured = settings?.data_keys?.[providerId]?.configured ?? false;

  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
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
            ? "Key saved. Paste a new one to replace it."
            : "Add this provider’s API key."}
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

function StatePill({
  state,
  isDataKey,
}: {
  state: BrokerState;
  isDataKey: boolean;
}) {
  if (state.state === "not_implemented" && isDataKey) {
    return <span className="dir-pill soon">add key</span>;
  }
  const cfg: Record<BrokerState["state"], { variant: string; label: string }> = {
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

function CapabilityBadges({ data, trade }: { data: boolean; trade: boolean }) {
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

/** Official mark where a verified in-repo asset exists (asset-driven via
 *  the LOGO_URLS glob); otherwise a neutral monochrome initials
 *  placeholder. The always-visible text label — not the icon — carries
 *  identity, so the placeholder is deliberately brand-agnostic. */
function BrokerIcon({
  id,
  label,
  large,
}: {
  id: string;
  label: string;
  large?: boolean;
}) {
  const logo = officialLogo(id);
  const cls = `dir-logo ${large ? "dir-logo--hero" : ""}`;
  if (logo) {
    return (
      <div className={`${cls} dir-logo--official`} aria-hidden="true">
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
    <div className={`${cls} dir-logo--placeholder`} aria-hidden="true">
      {initials}
    </div>
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
