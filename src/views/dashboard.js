// Dashboard — the launcher's home view.
//
// Three sections, rendered conditionally:
//
//   1. License activation card — only shown when no license key is
//      stored in the OS keychain. This is the first thing a customer
//      sees on first launch so they can't miss it.
//
//   2. Quick Actions — "Open Auracle" (always shown — opens the
//      web UI in the default browser). Other actions only appear
//      when there's something to act on.
//
//   3. Containers — only rendered if the launcher detects an
//      installed stack (i.e. docker compose ps returns rows). When
//      no install is present (the AURACLE_INSTALL_DIR is missing
//      or empty), this section is silently omitted rather than
//      showing a "Backend unavailable" error — the user doesn't
//      need to know the launcher tried and failed when the answer
//      is just "there's nothing installed here yet."
//
// Refresh cadence: stack status is polled every 5 s when the
// section is visible. When the section is hidden, no polling
// happens (saves a docker-compose-ps subprocess every 5 s on
// customer machines without an install yet).

import { invoke } from '../app.js';

let pollHandle = null;

export function renderDashboard(root) {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }

  root.innerHTML = `
    <h1>Auracle</h1>

    <div id="license-section"></div>

    <h2>Quick Actions</h2>
    <div class="card">
      <div class="row">
        <div>Open the Auracle dashboard in your browser</div>
        <button class="primary" id="btn-open">Open Auracle</button>
      </div>
    </div>

    <div id="containers-section"></div>
  `;

  document.getElementById('btn-open').addEventListener('click', async () => {
    // Two-mode open: embedded WebviewWindow (native feel) or
    // external browser. Preference lives in view-mode.json; default
    // is 'browser' for a fresh install (matches pre-v0.2.0 behavior).
    let mode = 'browser';
    try {
      mode = await invoke('get_view_mode');
    } catch (_) {
      // Backend unavailable — fall through to the browser path.
    }
    if (mode === 'embedded') {
      try {
        await invoke('open_embedded_auracle');
        return;
      } catch (err) {
        // Embedded window failed to spawn — fall through to browser
        // so the customer still gets where they were going. Toast
        // the underlying error so they know why the window didn't
        // pop the way they expected.
        console.warn('embedded open failed, falling back to browser:', err);
      }
    }
    // Browser path
    let url = 'http://localhost:1969/ui/setup';
    try {
      const h = await invoke('current_health');
      if (h?.state === 'healthy') url = 'http://localhost:1969/ui/dashboard';
    } catch (_) {}
    if (window.__TAURI__?.opener?.openUrl) {
      window.__TAURI__.opener.openUrl(url);
    } else {
      window.open(url, '_blank');
    }
  });

  renderLicenseSection();
  renderContainersSection();
}

// ── License activation ──────────────────────────────────────────

async function renderLicenseSection() {
  const wrap = document.getElementById('license-section');
  if (!wrap) return;

  let stored;
  try {
    stored = await invoke('license_get');
  } catch (_) {
    // Keychain access failed — likely first launch with no
    // permission yet. Show the prompt so they can save one
    // (which will trigger the keychain permission grant).
    stored = null;
  }

  if (stored) {
    // License is set — confirmation pill with Change + Clear so
    // customers can correct a wrong-key paste without hunting
    // through Settings. The dashboard is the only place license
    // lives in the launcher UI.
    wrap.innerHTML = `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <strong>License active</strong>
          <div class="muted mono" style="margin-top:2px">${escapeHtml(stored.slice(0, 16))}…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ok">activated</span>
          <button class="ghost" id="dash-license-change">Change</button>
          <button class="ghost danger" id="dash-license-clear">Clear</button>
        </div>
      </div>
    `;
    document.getElementById('dash-license-change').addEventListener('click', () => {
      // Re-render as the activation card so the input is editable.
      // We don't pre-fill the old key — license keys are secret and
      // the textbox is type=password; leaving the field blank is
      // safer than re-displaying.
      renderActivationCard(wrap);
    });
    document.getElementById('dash-license-clear').addEventListener('click', async () => {
      if (!confirm('Remove the stored license key? You can paste it again from your email anytime.')) return;
      try {
        await invoke('license_clear');
        renderLicenseSection();
      } catch (err) {
        alert('Could not clear: ' + err);
      }
    });
    return;
  }

  renderActivationCard(wrap);
}

function renderActivationCard(wrap) {
  wrap.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">Activate Auracle</h2>
      <p class="muted" style="margin:0 0 12px">
        Paste the license key from your purchase email.
      </p>
      <input type="password" id="dash-license-input"
             placeholder="akey_…" autocomplete="off">
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="primary" id="dash-license-save">Save</button>
        <span id="dash-license-status" class="muted mono"></span>
      </div>
    </div>
  `;

  document.getElementById('dash-license-save').addEventListener('click', async () => {
    const input = document.getElementById('dash-license-input');
    const status = document.getElementById('dash-license-status');
    const value = input.value.trim();
    if (!value) {
      status.textContent = 'Paste a key first.';
      return;
    }
    try {
      await invoke('license_set', { value });
      status.textContent = 'Saved.';
      // Re-render so the activation card collapses to the pill.
      setTimeout(renderLicenseSection, 600);
    } catch (err) {
      status.textContent = 'Could not save: ' + err;
    }
  });
}

// ── Containers ──────────────────────────────────────────────────

async function renderContainersSection() {
  const wrap = document.getElementById('containers-section');
  if (!wrap) return;

  // Initial probe — if the stack isn't installed or docker compose
  // ps fails, omit the section entirely (no error dialog, no broken
  // buttons). Customers see a clean dashboard until they install.
  let initial;
  try {
    initial = await invoke('stack_status');
  } catch (_) {
    return; // section stays empty + invisible
  }
  if (!initial || !initial.containers || initial.containers.length === 0) {
    return; // no containers tracked — no section needed
  }

  // Stack is real — render header + first paint.
  wrap.innerHTML = `
    <h2>Containers</h2>
    <div id="containers" class="card"></div>
  `;
  paintContainers(initial);

  // Start polling. Saved in module-level pollHandle so re-renders
  // (e.g. tab switch back to dashboard) reset the timer cleanly.
  pollHandle = setInterval(async () => {
    try {
      const status = await invoke('stack_status');
      paintContainers(status);
    } catch (_) {
      // Transient docker-compose error — leave the previous paint
      // up rather than blanking the section.
    }
  }, 5000);
}

function paintContainers(status) {
  const wrap = document.getElementById('containers');
  if (!wrap) return;
  if (!status.containers || status.containers.length === 0) {
    wrap.innerHTML = '<div class="muted">No containers running.</div>';
    return;
  }
  wrap.innerHTML = status.containers.map(c => `
    <div class="row">
      <div>
        <strong>${escapeHtml(c.name)}</strong>
        <div class="muted mono" style="margin-top:2px">
          state: ${escapeHtml(c.state)}${c.health ? ' · health: ' + escapeHtml(c.health) : ''}
        </div>
      </div>
      ${badgeFor(c)}
    </div>
  `).join('');
}

function badgeFor(c) {
  if (c.state !== 'running')      return '<span class="badge err">down</span>';
  if (c.health === 'unhealthy')   return '<span class="badge err">unhealthy</span>';
  if (c.health === 'starting')    return '<span class="badge warn">starting</span>';
  return '<span class="badge ok">healthy</span>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
