// TickersGrid widget — live multi-symbol ticker tape.
//
// Spec shape:
//   {
//     "type": "tickers_grid",
//     "title": "Watchlist",
//     "data_source": { "tool": "inline", "args": {} },
//     "symbols": ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
//     "interval_ms": 2000,         // poll cadence per symbol (500-60000)
//     "show_spread": true,         // optional: render bid/ask spread row
//     "columns": 5                 // optional: layout density (default auto)
//   }
//
// Subscribes each symbol to the broker tick stream
// (brokerStreamSubscribe). Each `broker-tick` event with a matching
// symbol updates the corresponding card. Cards flash green/red for
// ~300ms on each tick that moves the price so the user has a
// visual cue that data is live. Tracks the data_quality flag per
// tick — if the user has real-time IBKR data each tick moves;
// if delayed, the card still receives ticks at `interval_ms` but
// the price field stays flat between IBKR's 15-min cadence.
//
// On unmount or symbol-list change, unsubscribes the previous set
// so the underlying poll loops stop. The streaming surface is
// refcounted, so multiple TickersGrid widgets sharing a symbol
// share one poll.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  cmd,
  onEvent,
  type BrokerDataQuality,
  type BrokerTickEvent,
} from "@/lib/tauri";
import type { WidgetRenderState } from "./types";

interface TickerState {
  last: number | null;
  prev: number | null;
  bid: number | null;
  ask: number | null;
  quality: BrokerDataQuality;
  ts: number | null;
  flash: "up" | "down" | null;
}

const EMPTY: TickerState = {
  last: null,
  prev: null,
  bid: null,
  ask: null,
  quality: "unknown",
  ts: null,
  flash: null,
};

export default function TickersGrid({
  state,
}: {
  state: WidgetRenderState;
}): ReactElement {
  const rawSymbols = (state.spec.symbols as string[] | undefined) ?? [];
  // De-dup + uppercase so the agent passing "spy" + "SPY" doesn't
  // produce two subscriptions.
  const symbols = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of rawSymbols) {
      const u = String(s).trim().toUpperCase();
      if (u && !seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
    return out;
  }, [rawSymbols]);

  const intervalMs = Math.max(
    500,
    Math.min(60000, (state.spec.interval_ms as number | undefined) ?? 2000),
  );
  const showSpread = state.spec.show_spread !== false;
  const columns =
    (state.spec.columns as number | undefined) ?? Math.min(symbols.length, 4);

  const [ticks, setTicks] = useState<Record<string, TickerState>>(() => {
    const init: Record<string, TickerState> = {};
    for (const s of symbols) init[s] = EMPTY;
    return init;
  });

  // Track flash-clear timers per symbol so we don't leak them when
  // ticks land back-to-back.
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  // Subscription lifecycle. Re-runs when the symbol set changes —
  // unsubscribe old, subscribe new, replace the tick map.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // Reset the tick map to match the current symbol set so a stale
    // tick from a previously-subscribed symbol can't write into a
    // slot it no longer occupies.
    setTicks((prev) => {
      const next: Record<string, TickerState> = {};
      for (const s of symbols) next[s] = prev[s] ?? EMPTY;
      return next;
    });

    // Subscribe all symbols. Done in parallel — each subscribe is
    // a cheap IPC roundtrip, no need to serialize.
    Promise.all(
      symbols.map((s) =>
        cmd.brokerStreamSubscribe(s, intervalMs).catch((err) => {
          console.warn(`broker_stream_subscribe(${s}) failed:`, err);
        }),
      ),
    );

    // Single event listener fans out to per-symbol updates. One
    // listener handles N symbols vs. N listeners — fewer IPC hops
    // through the Tauri event channel.
    onEvent<BrokerTickEvent>("broker-tick", (tick) => {
      const sym = tick.symbol.toUpperCase();
      if (cancelled) return;
      setTicks((prev) => {
        if (!(sym in prev)) return prev; // not one of ours
        const prevSlot = prev[sym] ?? EMPTY;
        const next: TickerState = {
          last: tick.last,
          prev: prevSlot.last,
          bid: tick.bid,
          ask: tick.ask,
          quality: tick.data_quality,
          ts: tick.ts,
          flash:
            tick.last !== null && prevSlot.last !== null
              ? tick.last > prevSlot.last
                ? "up"
                : tick.last < prevSlot.last
                  ? "down"
                  : prevSlot.flash
              : prevSlot.flash,
        };
        return { ...prev, [sym]: next };
      });
      // Clear the flash after ~300ms so consecutive ticks each get
      // their own visual cue.
      const existing = flashTimers.current.get(sym);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        if (cancelled) return;
        setTicks((prev) => {
          const slot = prev[sym];
          if (!slot) return prev;
          return { ...prev, [sym]: { ...slot, flash: null } };
        });
        flashTimers.current.delete(sym);
      }, 300);
      flashTimers.current.set(sym, timer);
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
      // Drop subscriptions — refcounted on the backend so other
      // widgets sharing the same symbol stay alive.
      for (const s of symbols) {
        cmd.brokerStreamUnsubscribe(s).catch(() => {});
      }
      for (const t of flashTimers.current.values()) clearTimeout(t);
      flashTimers.current.clear();
    };
  }, [symbols, intervalMs]);

  if (symbols.length === 0) {
    return (
      <div className="muted mono" style={{ padding: 12, fontSize: 12 }}>
        tickers_grid: no symbols declared in the spec
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(120px, 1fr))`,
        gap: 8,
        padding: 12,
      }}
    >
      {symbols.map((sym) => {
        const t = ticks[sym] ?? EMPTY;
        return (
          <TickerCard key={sym} symbol={sym} tick={t} showSpread={showSpread} />
        );
      })}
    </div>
  );
}

function TickerCard({
  symbol,
  tick,
  showSpread,
}: {
  symbol: string;
  tick: TickerState;
  showSpread: boolean;
}) {
  const flashBg =
    tick.flash === "up"
      ? "rgba(74,222,128,0.18)"
      : tick.flash === "down"
        ? "rgba(248,113,113,0.18)"
        : "var(--bg-alt)";

  const changeAbs =
    tick.last !== null && tick.prev !== null ? tick.last - tick.prev : null;
  const changePct =
    tick.last !== null && tick.prev !== null && tick.prev !== 0
      ? (tick.last - tick.prev) / tick.prev
      : null;
  const positive = changeAbs !== null && changeAbs > 0;
  const negative = changeAbs !== null && changeAbs < 0;

  const priceColor = positive
    ? "var(--ok, #4ade80)"
    : negative
      ? "var(--err, #f87171)"
      : "var(--fg)";

  return (
    <div
      style={{
        padding: 10,
        background: flashBg,
        border: "1px solid var(--border)",
        borderRadius: 4,
        transition: "background 200ms",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
        }}
      >
        <strong style={{ fontSize: 12, letterSpacing: 0.3 }}>{symbol}</strong>
        <span
          className="mono"
          style={{
            fontSize: 9,
            padding: "1px 5px",
            background:
              tick.quality === "realtime"
                ? "rgba(74,222,128,0.15)"
                : tick.quality === "delayed"
                  ? "rgba(251,191,36,0.15)"
                  : "rgba(148,163,184,0.15)",
            color:
              tick.quality === "realtime"
                ? "#86efac"
                : tick.quality === "delayed"
                  ? "#fcd34d"
                  : "#cbd5e1",
            borderRadius: 999,
            textTransform: "lowercase",
            letterSpacing: 0.2,
          }}
          title={`Data quality: ${tick.quality}`}
        >
          {tick.quality === "realtime"
            ? "live"
            : tick.quality === "delayed"
              ? "15m"
              : tick.quality === "unknown"
                ? "—"
                : tick.quality}
        </span>
      </div>
      <div
        className="mono"
        style={{
          fontSize: 18,
          fontWeight: 500,
          color: priceColor,
        }}
      >
        {tick.last !== null
          ? tick.last.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })
          : "—"}
      </div>
      {changeAbs !== null && (
        <div
          className="mono"
          style={{ fontSize: 10, color: priceColor, marginTop: 2 }}
        >
          {positive ? "+" : ""}
          {changeAbs.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
          {changePct !== null && (
            <>
              {" "}
              ({positive ? "+" : ""}
              {(changePct * 100).toFixed(2)}%)
            </>
          )}
        </div>
      )}
      {showSpread && (tick.bid !== null || tick.ask !== null) && (
        <div
          className="mono muted"
          style={{ fontSize: 10, marginTop: 4 }}
        >
          {tick.bid !== null
            ? tick.bid.toFixed(2)
            : "—"}
          {" / "}
          {tick.ask !== null
            ? tick.ask.toFixed(2)
            : "—"}
        </div>
      )}
    </div>
  );
}
