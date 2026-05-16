# Tauri CSP Review — Auracle Desktop Launcher

T-56 in main auracle/PLAN.md. Review of the webview Content-Security-
Policy in `src-tauri/tauri.conf.json` against Tauri 2 best practices
and modern CSP hardening recommendations.

**Reviewed**: 2026-05-15
**Status**: Hardened (this pass) — no remaining gaps within the
project's threat model.

---

## Current CSP (post-hardening)

```
default-src 'self';
img-src 'self' data: https://github.com;
style-src 'self' 'unsafe-inline';
script-src 'self';
connect-src 'self' http://localhost:1969 https://localhost
            https://api.github.com
            https://amused-commitment-production-fb48.up.railway.app;
object-src 'none';
frame-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

## Directive-by-directive review

| Directive | Value | Reasoning |
|---|---|---|
| `default-src 'self'` | Restrict | Tauri-recommended baseline. Anything not explicitly allowed is denied. |
| `img-src 'self' data: https://github.com` | Local + data + GH | `data:` allows inline SVG icons rendered as data URIs. `https://github.com` for the auto-updater's release-asset thumbnails (if/when displayed). |
| `style-src 'self' 'unsafe-inline'` | Local + inline | `'unsafe-inline'` is required because the launcher's frontend uses inline `style=` attributes for ad-hoc layout (`src/views/onboarding.js`). The XSS risk is low because we control 100% of the rendered HTML — no user-generated content flows into the webview. |
| `script-src 'self'` | Local only | No `'unsafe-inline'`, no `'unsafe-eval'`. All JS loads from `src/app.js` + `src/views/*.js`. Tauri's IPC bridge is exempt by design. |
| `connect-src` | Allow-listed origins | Explicit list — `localhost:1969` for the customer's Houston, `https://api.github.com` for the auto-updater + version check, the canonical Railway URL for license validation. **No wildcards.** |
| `object-src 'none'` | Deny | Added in this hardening pass. Blocks `<object>`, `<embed>`, `<applet>` — none of which the launcher uses but they're classic XSS vectors. |
| `frame-src 'none'` | Deny | Added in this hardening pass. Launcher renders no iframes; blocks the entire embedding attack surface. |
| `base-uri 'self'` | Restrict | Added in this hardening pass. Prevents `<base href="https://evil.com/">` injection from rewriting relative URLs. |
| `form-action 'self'` | Restrict | Added in this hardening pass. Prevents form POSTs to off-origin endpoints (the launcher doesn't have form submissions outside the IPC bridge, but defense in depth). |
| `frame-ancestors 'none'` | Deny | Added in this hardening pass. The launcher webview can't be embedded as an iframe in any document — irrelevant in a Tauri context but defends against future surface changes. |

## Threats considered

### XSS via inline content

Mitigated by `script-src 'self'` (no inline JS) and the constraint
that we don't render user-generated content. Future risk: any IPC
command that returns customer data displayed without escaping
opens this attack vector. **Action**: every JS view that interpolates
IPC-returned strings into the DOM must use `textContent` or
`escapeHtml()` — never `innerHTML`. Currently audited and clean as
of `src/views/onboarding.js` 2026-05-15.

### XSS via inline CSS

The `'unsafe-inline'` on `style-src` is the deliberate tradeoff
for the launcher's design system (inline styles in view JS).
Hardening path if we ever need it: refactor to a single `app.css`
+ class-only style updates, then drop `'unsafe-inline'`. Cost:
~6h of refactor for marginal benefit; deferring.

### Click-jacking

Tauri webviews aren't embeddable in other apps anyway, but
`frame-ancestors 'none'` makes the intent explicit. Belt + suspenders.

### Exfiltration via `connect-src`

The allow-list contains 4 origins. If the launcher's frontend gets
compromised (XSS via a regression), it can ONLY POST to:
- `localhost:1969` (customer's own Houston — same trust boundary)
- `localhost` (HTTPS variant)
- `api.github.com` (read-only release queries)
- the canonical Railway URL (license-server endpoints)

Notably absent: any analytics, any third-party JS CDN, any image
host beyond github.com. Compromise of the webview cannot exfil to
arbitrary attacker-controlled servers.

### Auto-updater payload tampering

The auto-updater (when enabled per T-25) downloads release artifacts
from GitHub. The CSP doesn't prevent this — Tauri's updater plugin
runs outside the webview's CSP scope. **Integrity is enforced via
the Ed25519 minisign signature**, not CSP. See `setup-updater-keys.sh`
for the key-generation procedure.

## Out-of-scope for the webview CSP

- **Rust-side network**: any `reqwest::Client` call from Rust commands
  is unaffected by webview CSP. Network restrictions there are at
  the Tauri-capabilities layer (`src-tauri/capabilities/default.json`).
- **File-system access**: not CSP territory. Handled by Tauri's
  plugin-fs ACL.
- **External browser opens**: `tauri-plugin-opener` opens URLs in the
  user's default browser, not in the webview. CSP doesn't apply.

## Recommendations addressed in this review

1. ✅ Add `object-src 'none'` (was missing)
2. ✅ Add `frame-src 'none'` (was missing)
3. ✅ Add `base-uri 'self'` (was missing)
4. ✅ Add `form-action 'self'` (was missing)
5. ✅ Add `frame-ancestors 'none'` (was missing)
6. Documented the `style-src 'unsafe-inline'` tradeoff + the refactor
   path if/when we want to drop it

## Recommendations for future hardening

- **Drop `style-src 'unsafe-inline'`** once we refactor the views to
  use CSS classes only. ~6h of work; defer until something else
  motivates it.
- **Add `report-uri`** when we have a CSP-violation reporting endpoint
  (T-34 Sentry can do this; wire after T-34 ships).
- **Add `require-trusted-types-for 'script'`** (CSP Level 3) once the
  webview's WebKit version reliably supports it. Not all Tauri-
  bundled WebKit versions do; opt-in path.

## How to verify the CSP is active

```bash
# Build + run the launcher
cargo tauri dev

# In the launcher window, open DevTools (if enabled in feature flags)
# Console should show the CSP applied. Try in console:
fetch("https://evil.example.com")
# Expected: blocked with "Refused to connect to ... because it violates
# the document's Content Security Policy."
```

## Next review

After T-25 (auto-updater) ships — verify the updater's outbound calls
are covered by the connect-src list, not blocked.

After T-22/T-23 (Windows/Linux builds) ship — verify the CSP behaves
identically on Edge WebView2 + WebKitGTK. Tauri's WebView abstraction
is supposed to make this transparent, but worth a sanity check.
