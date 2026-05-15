# Contributing to Auracle Desktop

The launcher is a thin native shell over the Auracle Docker Compose stack. PRs welcome for bug fixes, new diagnostics, and OS-specific polish.

## Quick principles

1. **Don't grow the Rust core surface unnecessarily.** Every new `#[tauri::command]` is an attack surface — prefer composing existing commands on the frontend over adding new ones.
2. **Don't replace the web UI.** The launcher manages Auracle; the web UI is where you USE Auracle. Anything that's a "you would do this once a quarter" goes in the launcher; anything you do daily goes in Houston.
3. **Don't break Docker abstraction.** Talk to Docker via the CLI, never the socket directly. The CLI handles user-namespace + group checks we don't want to reimplement.
4. **Keep platform-specific code under `#[cfg(target_os = "...")]`** rather than runtime detection.

## Style

- Rust: `cargo fmt` + `cargo clippy --all-targets -- -D warnings` must pass (CI enforces). Comments explain WHY, not WHAT.
- JS: vanilla ES modules. No framework yet. If you reach for a build step, justify it in the PR description.
- CSS: small set of design tokens defined as `:root` CSS variables in `src/styles/app.css`. Add new tokens there rather than inlining colors / spacings.

## Testing

- Rust: `cargo test --no-default-features` from `src-tauri/`. Tauri commands that hit Docker need integration tests under `src-tauri/tests/`.
- Frontend: no harness yet. Manually verify in `cargo tauri dev` before PR.

## PRs

- One coherent change per PR.
- Title follows Conventional Commits: `feat(commands): add stack_inspect_volume`, `fix(tray): ...`, etc.
- Link the related issue.
- Update the README's "Roadmap" section if you ship a new phase deliverable.

## Releases

Maintainers only:

```bash
git tag v0.2.0
git push origin v0.2.0
# .github/workflows/release.yml builds + signs + uploads to GH Releases
```

Required secrets in the repo (Settings → Secrets → Actions): see comment header at the top of `.github/workflows/release.yml`.
