# CI workflow templates

These two YAML files belong under `.github/workflows/` but the
initial push used a GitHub OAuth token without the `workflow`
scope so they couldn't land in their proper home.

## To activate

```bash
gh auth refresh -h github.com -s workflow
# Paste the one-time code in the browser

git mv docs/ci-templates/pr.yml      .github/workflows/pr.yml
git mv docs/ci-templates/release.yml .github/workflows/release.yml
git rmdir docs/ci-templates 2>/dev/null
git commit -m "ci: enable PR + release workflows"
git push
```

After that:
- `pr.yml` runs `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` on every PR
- `release.yml` builds + signs + uploads cross-platform binaries on a `v*.*.*` tag push

## Required repo secrets (Settings → Secrets and variables → Actions)

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the `.p12` from Apple Developer portal |
| `APPLE_CERTIFICATE_PASSWORD` | password protecting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `"Developer ID Application: AuraPoint Capital LLC (TEAMID)"` |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | app-specific password for `notarytool` |
| `APPLE_TEAM_ID` | 10-char Apple team identifier |
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key from `tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password protecting the above |
| `WINDOWS_CERT_PFX` | base64 of the EV code-signing `.pfx` |
| `WINDOWS_CERT_PASSWORD` | password for the `.pfx` |

Without these the workflow still runs but emits unsigned artifacts —
useful for internal testing, blocked by Gatekeeper / SmartScreen for
end users.
