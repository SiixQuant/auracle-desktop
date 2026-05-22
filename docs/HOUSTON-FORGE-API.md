# Houston ↔ Forge REST contract

Forge talks to Houston over `http://localhost:1969` for anything
that needs the authoritative source of truth — currently just
strategy lifecycle state, but the surface will grow as Forge gains
features (backtest results, deployment status, live order preview).

This document is the contract: Forge calls these endpoints with the
exact shapes documented below. The main Auracle repo implements
them in `auracle/houston/web/views/forge_api.py` (or equivalent).

## Design rules

1. **All endpoints under `/api/forge/`** so they're trivially
   isolatable for future migration to a dedicated cloud-tier API.
2. **Forge fails open.** When Houston is offline or returns 404
   (older Auracle without the endpoint), Forge falls back to its
   local Tauri-store cache. Nothing about Forge breaks when
   Houston is down — it just becomes single-machine-only.
3. **No auth in Phase 1.** Houston binds to `127.0.0.1` only;
   Forge runs on the same machine. When the cloud tier ships we
   add bearer tokens via the existing Houston auth model.

## Endpoints

### `GET /api/forge/strategies`

Bulk fetch of lifecycle state for every strategy Houston knows
about. Forge calls this when the Forge tab opens + whenever the
file tree refreshes.

**Response 200:**

```json
{
  "states": {
    "momentum/cross_section.py": "live",
    "drafts/rsi_test.py": "draft",
    "archived/old_pairs.py": "archived"
  }
}
```

The `states` map is keyed by `rel_path` (forward-slash separated,
relative to the configured strategies directory). Values are one
of:

- `"draft"` — never backtested
- `"backtested"` — has a recent backtest run
- `"paper"` — deployed to paper trading
- `"live"` — deployed to live trading
- `"archived"` — deliberately set aside

Strategies the user has on disk but Houston has never seen don't
need to appear in the map; Forge defaults absent entries to
`"draft"` client-side.

### `PATCH /api/forge/strategies/{rel_path}`

Update the lifecycle state for one strategy. `rel_path` in the URL
is percent-encoded by Forge before sending.

**Request body:**

```json
{ "state": "paper" }
```

**Response 204** on success. **Response 4xx** with a JSON error
body on validation failure:

```json
{ "error": "invalid state: foo" }
```

Forge writes the new state to its local cache **before** calling
this endpoint, so a failed PATCH doesn't lose the user's edit.
Next successful GET reconciles.

### Future endpoints (placeholders, not implemented in Phase 4b)

These are the next pieces Forge will need. Listed here so the
shape is agreed upon ahead of implementation.

#### `POST /api/forge/strategies/{rel_path}/backtest`

Kick off a backtest from inside Forge instead of deep-linking to
the Houston UI. Returns a `run_id` Forge can poll via the existing
`/api/backtests/{run_id}` endpoint.

#### `GET /api/forge/strategies/{rel_path}/runs?limit=5`

Recent backtest + paper-deploy run history for the sidebar. Lets
Forge show "last run: Sharpe 1.4 · 3 days ago" inline with the
state pill.

#### `GET /api/forge/strategies/{rel_path}/positions`

Current open positions for a live-deployed strategy. Lets Forge
show position pills next to the live indicator without a full
context switch into the Houston dashboard.

## Reference: Forge's local cache

When the GET above fails (network, 404, 5xx), Forge serves states
from a local cache in Tauri's store:

```
~/Library/Application Support/com.auracle.desktop/forge.json

{
  "strategies_dir": "/Users/.../auracle/strategies",
  "model": "claude-sonnet-4-20250514",
  "strategy_state_cache": {
    "momentum/cross_section.py": "live",
    ...
  }
}
```

PATCH writes to the cache first, then attempts Houston. So:

- Online: cache + Houston stay in sync.
- Offline: cache holds edits, next online GET overwrites cache
  with Houston's view (Forge treats Houston as authoritative).

This is a deliberate trade — the operator's local edits during an
outage are eventually reconciled away. The alternative (a
write-back queue) was rejected as overkill until we have
multi-user-per-install scenarios.
