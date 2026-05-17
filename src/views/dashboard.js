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

  document.getElementById('btn-open').addEventListener('click', () => {
    invoke('current_health').then(h => {
      const url = h?.state === 'healthy'
        ? 'http://localhost:1969/ui/dashboard'
        : 'http://localhost:1969/ui/setup';
      if (window.__TAURI__?.opener?.openUrl) {
        window.__TAURI__.opener.openUrl(url);
      } else {
        window.open(url, '_blank');
      }
    }).catch(() => {
      // Health check failed (no install yet). Try opening anyway —
      // if Houston is up at the default port the browser will reach
      // it; if not the user sees their normal "site unreachable"
      // page, which is clearer than a Tauri error dialog.
      const url = 'http://localhost:1969/ui/setup';
      if (window.__TAURI__?.opener?.openUrl) {
        window.__TAURI__.opener.openUrl(url);
      } else {
        window.open(url, '_blank');
      }
    });
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
    // License is set — surface a one-line confirmation pill but
    // don't take up the whole top of the page. Customers who want
    // to change keys do it from Settings.
    wrap.innerHTML = `
      <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div>
          <strong>License active</strong>
          <div class="muted mono" style="margin-top:2px">${escapeHtml(stored.slice(0, 16))}…</div>
        </div>
        <span class="badge ok">activated</span>
      </div>
    `;
    return;
  }

  // No license stored — big welcoming activation card.
  wrap.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">Activate Auracle</h2>
      <p class="muted" style="margin:0 0 12px">
        Paste your license key from your purchase email to activate.
        Accepts <code>akey_…</code> (Stripe), <code>polar_…</code>
        (legacy), or a JWT starting with <code>eyJ…</code>
        (enterprise / offline). Stored in your OS keychain — never
        on disk.
      </p>
      <input type="password" id="dash-license-input"
             placeholder="akey_… or polar_… or eyJ…" autocomplete="off">
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="primary" id="dash-license-save">Save license key</button>
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
      // Re-render the license section so the activation card
      // collapses into the one-line confirmation pill.
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
