// Settings — install state, Docker presence, launcher updates.
//
// License management lives on the Dashboard (see views/dashboard.js)
// so customers see it on first launch. Keeping it out of Settings
// avoids two places to enter the same key + the confusion that
// comes with that.

import { invoke } from '../app.js';

export function renderSettings(root) {
  root.innerHTML = `
    <h1>Settings</h1>

    <h2>View Mode</h2>
    <div class="card">
      <p class="muted" style="margin:0 0 12px">
        Choose how the Auracle dashboard opens when you click
        <strong>Open Auracle</strong>.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="radio" name="view-mode" value="browser" id="vm-browser" style="margin-top:3px">
          <div>
            <div><strong>External browser</strong></div>
            <div class="muted" style="font-size:13px">
              Opens in your default browser. Lower memory, any
              browser you want.
            </div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="radio" name="view-mode" value="embedded" id="vm-embedded" style="margin-top:3px">
          <div>
            <div><strong>Embedded window</strong></div>
            <div class="muted" style="font-size:13px">
              Opens inside a second Auracle Desktop window. Feels
              more like one app; costs a bit more RAM.
            </div>
          </div>
        </label>
      </div>
    </div>

    <h2>Installation</h2>
    <div class="card">
      <div class="row">
        <div>
          <div>Auracle install directory</div>
          <div class="muted mono" id="install-path">checking…</div>
        </div>
        <button class="ghost" id="btn-install" disabled>Run First-Time Install</button>
      </div>
      <div class="row">
        <div>Docker Desktop</div>
        <div id="docker-status" class="muted mono">checking…</div>
      </div>
    </div>

    <h2>Updates</h2>
    <div class="card">
      <div class="row">
        <div>
          <div>Auracle Desktop launcher version</div>
          <div class="muted mono" id="version-line">v?</div>
        </div>
        <button class="ghost" id="btn-check-update">Check for Update</button>
      </div>
      <div id="update-result" class="muted mono" style="margin-top:8px"></div>
    </div>
  `;

  // View mode — load current preference, wire up persistence
  invoke('get_view_mode').then(mode => {
    const el = document.querySelector(`input[name="view-mode"][value="${mode}"]`);
    if (el) el.checked = true;
  }).catch(() => {
    document.getElementById('vm-browser').checked = true;
  });
  document.querySelectorAll('input[name="view-mode"]').forEach(radio => {
    radio.addEventListener('change', async (e) => {
      if (!e.target.checked) return;
      try {
        await invoke('set_view_mode', { mode: e.target.value });
      } catch (err) {
        // Persistence failed — revert the radio so what the user
        // sees matches what's actually saved.
        console.warn('set_view_mode failed:', err);
      }
    });
  });

  // Install path + Docker
  invoke('install_path').then(p => {
    document.getElementById('install-path').textContent = p;
  }).catch(err => {
    document.getElementById('install-path').textContent = 'unavailable: ' + err;
  });
  invoke('is_installed').then(installed => {
    const btn = document.getElementById('btn-install');
    btn.disabled = false;
    btn.textContent = installed ? 'Already installed' : 'Run First-Time Install';
    btn.disabled = installed;
    if (!installed) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Installing…';
        try {
          await invoke('run_first_install');
          btn.textContent = 'Done — restart launcher to continue';
        } catch (err) {
          btn.textContent = 'Failed: ' + err;
          btn.disabled = false;
        }
      });
    }
  });
  invoke('docker_status').catch(err => {
    // Defense-in-depth: backend used to swallow spawn errors and
    // never resolve, leaving the UI stuck on "checking..." forever.
    // It's fixed in 0.2.2+ but a stuck label is worse than a wrong
    // one, so render a fallback if the promise still rejects.
    const el = document.getElementById('docker-status');
    if (el) el.innerHTML = `<span class="badge err">check failed</span> — ${escapeHtml(String(err))}`;
    return null;
  }).then(s => {
    if (!s) return;
    const el = document.getElementById('docker-status');
    if (!s.installed) {
      el.innerHTML = '<span class="badge err">not installed</span> — <a href="#" id="docker-install-link">install Docker Desktop</a>';
      const link = document.getElementById('docker-install-link');
      link?.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = await invoke('docker_install_url');
        if (window.__TAURI__?.opener?.openUrl) {
          window.__TAURI__.opener.openUrl(url);
        }
      });
      return;
    }
    if (!s.running) {
      el.innerHTML = '<span class="badge warn">installed but not running</span> — start Docker Desktop';
      return;
    }
    el.innerHTML = `<span class="badge ok">running</span> — ${escapeHtml(s.version || 'docker')}`;
  });

  // Version + update
  invoke('current_version').then(v => {
    document.getElementById('version-line').textContent = `v${v}`;
  });
  document.getElementById('btn-check-update').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    const out = document.getElementById('update-result');
    try {
      const info = await invoke('check_for_update');
      if (!info.available) {
        out.textContent = `Up to date (v${info.current}).`;
        btn.textContent = 'Check for Update';
        btn.disabled = false;
        return;
      }
      out.innerHTML = `<span class="badge ok">v${escapeHtml(info.version)} available</span>`;
      btn.textContent = `Download + Install v${info.version}`;
      btn.disabled = false;
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        try {
          await invoke('install_update');
          out.textContent = 'Installed but restart did not fire — quit + relaunch manually.';
        } catch (err) {
          const msg = String(err);
          if (/closed|connection/i.test(msg)) {
            out.textContent = 'Restarting on the new version…';
          } else {
            out.textContent = 'Install failed: ' + msg;
            btn.disabled = false;
            btn.textContent = 'Retry install';
          }
        }
      };
    } catch (err) {
      out.textContent = 'Error: ' + err;
      btn.disabled = false;
      btn.textContent = 'Check for Update';
    }
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
