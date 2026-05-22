# MCP sidecar — architecture + build pipeline

Auracle Desktop bundles the MCP server (`auracle/mcp/server.py` from
the main Auracle repo) as a native binary inside the .app so Forge's
chat can call platform tools without requiring the Docker stack to be
running. This doc covers the cross-repo build flow, the runtime
supervisor (already in `src-tauri/src/commands/mcp_sidecar.rs`), and
the JSON-RPC tool-use loop that Phase 4d will add to the chat command.

## What the sidecar does

The MCP server speaks JSON-RPC 2.0 over stdio. The Auracle MCP server
exposes 23 tools, including:

- `read_strategy(rel_path)` — read a strategy from disk
- `list_universes()` — universe IDs registered in the master
- `list_recent_runs(limit)` — recent backtest runs
- `run_backtest(strategy, universe, start, end)` — kick off a backtest
- `read_backtest_result(run_id)` — full metrics + equity curve
- `current_positions()` — live IBKR positions
- ... and 17 more

See `auracle/mcp/server.py` for the canonical list. New tools added
there automatically ship with the next sidecar build.

## Where the binary comes from

The Python source lives in the main Auracle repo
(`auracle/mcp/server.py` + transitive imports). Auracle Desktop ships
a pre-built native binary so customers don't need Python installed.

Three cross-repo paths considered:

| Path | When | Why we picked it |
|---|---|---|
| **Pull from GitHub Releases** ✓ | Selected | Main Auracle repo's release pipeline produces sidecar artifacts on each tag; auracle-desktop's release pipeline downloads them at bundle time. Clean separation of concerns; each repo owns its own source. |
| Submodule the auracle Python source | Rejected | Would couple the desktop release cadence to the platform release cadence + bloat the repo. |
| Bundle the auracle source + run PyInstaller in auracle-desktop's CI | Rejected | Same coupling issue + much slower CI (have to run PyInstaller across 4 platforms per desktop release). |

## Build pipeline (lives in main Auracle repo)

In the main Auracle repo, `services/mcp/build-sidecar.sh` runs
PyInstaller against `auracle/mcp/server.py` and emits a single-file
binary per platform:

```
auracle-mcp-macos-arm64
auracle-mcp-macos-x86_64
auracle-mcp-windows-x86_64.exe
auracle-mcp-linux-x86_64
```

GitHub Actions matrix builds these on every git tag matching
`mcp-sidecar-v*` and uploads them as release assets. The auracle-
desktop bundler then fetches them based on the build target's
platform/arch tuple.

Approximate sizes (PyInstaller --onefile output): ~25 MB per
platform. The Python interpreter is the bulk; tree-shaking with
`--exclude-module` for the parts of the auracle package the MCP
server doesn't actually need keeps it under 30 MB.

## How auracle-desktop ships it

In `tauri.conf.json`, the `bundle.resources` list includes the
sidecar binary path. Tauri copies it into the .app bundle's
`Contents/Resources/` (or platform equivalent) at build time. At
runtime the supervisor in `mcp_sidecar.rs` resolves the resource
path via `app.path().resource_dir().join("auracle-mcp")` and spawns
it as a subprocess.

For dev builds (`tauri dev`), the sidecar is optional — if the binary
isn't on disk yet, `mcp_sidecar_status()` returns `not_bundled` and
Forge's chat falls back to direct-Anthropic without tool-calling. The
chat still works; it just can't read backtests / list universes /
etc. on its own.

## Runtime lifecycle (current shape)

```
                          Tauri startup
                                |
                                v
                  +---  mcp_sidecar_start  ---+
                  |                            |
        binary present?                  binary missing?
                  |                            |
                  v                            v
         spawn subprocess              return NotBundled
                  |                    Forge falls back to
                  v                    direct-Anthropic chat
           process running
                  |
                  v
       Phase 4d: stdin/stdout pipes are
       wired to a JSON-RPC client that
       the chat command queries for
       tool definitions + tool calls.
                  |
                  v
          Tauri window closes
                  |
                  v
          mcp_sidecar_stop()
              child.kill()
              child.wait()
```

The supervisor handles:

- Spawn-once: `start()` is idempotent — calling against an already-
  running process returns Ok immediately.
- Crash detection: `status()` calls `try_wait()` on the child;
  a non-None exit code clears the slot and surfaces as `Crashed`.
- Clean shutdown: `stop()` sends SIGTERM via `Child::kill` then
  waits. Phase 4d will switch to a JSON-RPC shutdown notification
  + brief grace period before SIGTERM so any in-flight tool call
  can finish cleanly.

## What Phase 4d adds (not in this commit)

1. **JSON-RPC client** in Rust that talks to the sidecar over its
   stdin/stdout pipes. Sends `initialize` on spawn; receives the
   tool catalog.
2. **Tool exposure** in the chat command — `forge_chat_stream`
   appends the tool catalog to the Anthropic request body as the
   `tools` parameter (per the Messages API tool-use spec).
3. **Tool-use loop** — when Claude's response includes a
   `tool_use` content block, the chat command:
   - Forwards the call to the sidecar via JSON-RPC
   - Captures the result
   - Appends a `tool_result` block to the conversation
   - Calls Anthropic again to get the next turn
   - Loops until Claude returns plain text with no more tool calls
4. **UI surface** — chat panel renders tool calls as collapsible
   cards ("Claude called `read_strategy(momentum.py)` → returned
   2.3 KB").

Estimated effort for Phase 4d: ~3 focused days. The supervisor
foundation here is the prerequisite — without a running sidecar
there's nothing for the JSON-RPC client to connect to.

## Build instructions (until the Auracle-repo pipeline ships)

Until the main Auracle repo's GitHub Actions workflow is in place,
you can build the sidecar locally for dev testing:

```bash
# In the main Auracle repo:
cd ~/auracle
python -m pip install pyinstaller
pyinstaller --onefile \
    --name auracle-mcp \
    --hidden-import auracle.db \
    --hidden-import auracle.broker.ibkr \
    --hidden-import auracle.brokers \
    auracle/mcp/server.py

# Copy the binary into the desktop repo's resource dir:
cp dist/auracle-mcp ~/auracle-desktop/src-tauri/resources/auracle-mcp
chmod +x ~/auracle-desktop/src-tauri/resources/auracle-mcp

# Add it to tauri.conf.json (one-time):
#   "bundle": { "resources": ["resources/auracle-mcp"] }

# Then: tauri dev
# mcp_sidecar_status should now return Running after start().
```

## Why not just bundle the Docker MCP container?

We considered this. The Docker MCP container is what the main
Auracle stack uses internally. Reasons against:

1. Requires Docker on the customer's machine just to use Forge's
   chat — defeats the "standalone" promise.
2. ~700 MB image vs ~25 MB native binary.
3. Cold-start latency: Docker spinup is multiple seconds vs
   ~100ms for the native binary.

The Docker container remains the right answer for the full Auracle
stack (where Docker is already required). The native sidecar is the
right answer for the desktop launcher, where Docker is opt-in.
