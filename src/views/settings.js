// Settings — license key entry, install path, update controls.

import { invoke } from '../app.js';

export function renderSettings(root) {
  root.innerHTML = `
    <h1>Settings</h1>

    <h2>License Key</h2>
    <div class="card">
      <p class="muted">
        Paste your license key from your purchase email — accepts
        <code>akey_…</code> (Stripe), <code>polar_…</code> (legacy
        Polar), or a JWT starting with <code>eyJ…</code>
        (enterprise / offline). Stored securely in your OS keychain
        — never in plain text on disk.
      </p>
      <input type="password" id="license-input" placeholder="akey_… or polar_… or eyJ…" autocomplete="off">
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
        <button class="primary" id="license-save">Save</button>
        <button class="ghost danger" id="license-clear">Clear</button>
        <span id="license-status" class="muted mono"></span>
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

    <h2>About</h2>
    <div class="card">
      <p class="muted">
        Auracle Desktop is a thin shell around the Auracle Docker Compose
        stack — Houston (web UI + REST), the strategy scheduler, MCP
        server, JupyterLab, and TimescaleDB. Launcher repository:
        <a href="#" id="repo-link">github.com/SiixQuant/auracle-desktop</a>.
      </p>
    </div>
  `;

  // License key
  refreshLicense();
  document.getElementById('license-save').addEventListener('click', async () => {
    const value = document.getElementById('license-input').value.trim();
    if (!value) return;
    try {
      await invoke('license_set', { value });
      document.getElementById('license-input').value = '';
      document.getElementById('license-status').textContent = 'Saved to OS keychain.';
      setTimeout(refreshLicense, 1000);
    } catch (err) {
      document.getElementById('license-status').textContent = 'Error: ' + err;
    }
  });
  document.getElementById('license-clear').addEventListener('click', async () => {
    if (!confirm('Remove the stored license key from this machine? You can paste it again anytime from your email.')) return;
    try {
      await invoke('license_clear');
      document.getElementById('license-status').textContent = 'Cleared.';
      refreshLicense();
    } catch (err) {
      document.getElementById('license-status').textContent = 'Error: ' + err;
    }
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
  invoke('docker_status').then(s => {
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
      // Update available — flip the button into a one-click installer.
      // The label change is the affordance: same physical button, new
      // intent. Avoids needing a second DOM element for the rare path.
      out.innerHTML = `<span class="badge ok">v${escapeHtml(info.version)} available</span>`;
      btn.textContent = `Download + Install v${info.version}`;
      btn.disabled = false;
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        try {
          await invoke('install_update');
          // install_update calls app.restart() which never returns —
          // we shouldn't reach this line. If we do, the IPC succeeded
          // but the restart didn't fire; surface that.
          out.textContent = 'Installed but restart did not fire — quit + relaunch manually.';
        } catch (err) {
          const msg = String(err);
          // The IPC connection closes when the app restarts under us —
          // that's the success path, not a failure. Recognize the
          // connection-closed signature and treat as expected.
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

async function refreshLicense() {
  try {
    const value = await invoke('license_get');
    const status = document.getElementById('license-status');
    if (value) {
      status.textContent = `Stored (${value.slice(0, 12)}…)`;
    } else {
      status.textContent = 'No license key stored.';
    }
  } catch (err) {
    document.getElementById('license-status').textContent = 'Cannot read keychain: ' + err;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
