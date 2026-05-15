// Dashboard — the launcher's "home". Shows stack overall status
// + a big "Open Auracle" button for the most-common action.
//
// Refresh cadence: stack_status() every 5 s (cheap — wraps
// `docker compose ps --format json`). Renders a per-container
// row with state + health badges.

import { invoke } from '../app.js';

let pollHandle = null;

export function renderDashboard(root) {
  root.innerHTML = `
    <h1>Auracle Stack</h1>

    <div class="card" id="stack-summary">
      <div class="row">
        <div>
          <div><strong id="overall-state">Loading…</strong></div>
          <div class="muted mono" id="overall-detail">checking docker compose ps…</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="ghost" id="btn-stop">Stop</button>
          <button class="primary" id="btn-start">Start</button>
        </div>
      </div>
    </div>

    <h2>Quick Actions</h2>
    <div class="card">
      <div class="row">
        <div>Open the Auracle dashboard in your browser</div>
        <button class="primary" id="btn-open">Open Auracle</button>
      </div>
      <div class="row">
        <div>Pull the latest images and recreate changed containers</div>
        <button class="ghost" id="btn-pull">Pull Update</button>
      </div>
    </div>

    <h2>Containers</h2>
    <div id="containers" class="card">
      <div class="muted">Loading containers…</div>
    </div>
  `;

  document.getElementById('btn-open').addEventListener('click', () => {
    invoke('current_health').then(h => {
      const url = h?.state === 'healthy'
        ? 'http://localhost:1969/ui/dashboard'
        : 'http://localhost:1969/ui/setup';
      // Tauri's opener plugin handles the platform-specific
      // open-in-default-browser. Falls through silently when
      // running in plain browser (the link won't work but
      // the call won't crash).
      if (window.__TAURI__?.opener?.openUrl) {
        window.__TAURI__.opener.openUrl(url);
      } else {
        window.open(url, '_blank');
      }
    });
  });

  document.getElementById('btn-start').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Starting…';
    try {
      await invoke('stack_start');
      await refresh();
    } catch (err) {
      alert('Could not start stack: ' + err);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Start';
    }
  });

  document.getElementById('btn-stop').addEventListener('click', async (e) => {
    if (!confirm('Stop the Auracle stack? Live strategies will halt.')) return;
    e.target.disabled = true;
    e.target.textContent = 'Stopping…';
    try {
      await invoke('stack_stop');
      await refresh();
    } catch (err) {
      alert('Could not stop stack: ' + err);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Stop';
    }
  });

  document.getElementById('btn-pull').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Pulling…';
    try {
      await invoke('stack_pull_update');
      alert('Update pulled. Containers recreated.');
      await refresh();
    } catch (err) {
      alert('Update failed: ' + err);
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Pull Update';
    }
  });

  refresh();
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(refresh, 5000);
}

async function refresh() {
  try {
    const status = await invoke('stack_status');
    const overall = status.overall || 'unknown';
    document.getElementById('overall-state').textContent =
      overall.charAt(0).toUpperCase() + overall.slice(1);
    document.getElementById('overall-detail').textContent =
      `${status.containers.length} container(s) tracked`;

    const wrap = document.getElementById('containers');
    if (status.containers.length === 0) {
      wrap.innerHTML = `
        <div class="muted">
          No stack found. Run the first-time install from
          Settings → Install to get started.
        </div>`;
      return;
    }
    wrap.innerHTML = status.containers.map(c => `
      <div class="row">
        <div>
          <div><strong>${escapeHtml(c.name)}</strong></div>
          <div class="muted mono">state: ${escapeHtml(c.state)}${c.health ? ' · health: ' + escapeHtml(c.health) : ''}</div>
        </div>
        <div>
          ${badgeFor(c)}
        </div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('overall-state').textContent = 'Backend unavailable';
    document.getElementById('overall-detail').textContent = String(err);
  }
}

function badgeFor(c) {
  if (c.state !== 'running') return '<span class="badge err">down</span>';
  if (c.health === 'unhealthy') return '<span class="badge err">unhealthy</span>';
  if (c.health === 'starting') return '<span class="badge warn">starting</span>';
  return '<span class="badge ok">healthy</span>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
