// Onboarding — first-run wizard. 3 screens per the launcher plan §4.1:
//   1. Welcome + Docker check
//   2. License key entry (optional, can skip for Community)
//   3. Run installer with live progress
//
// Auto-shown by app.js when is_installed() returns false.
// Subscribes to the 'installer-progress' Tauri event for live
// stepper updates while install.sh runs.

import { invoke } from '../app.js';

let step = 1;
let licenseKey = '';

export function renderOnboarding(root) {
  root.innerHTML = `
    <div class="card" style="max-width:640px;margin:48px auto;padding:32px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px">
        <span class="logo-dot" style="background:var(--accent);width:14px;height:14px"></span>
        <h1 style="margin:0">Welcome to Auracle Desktop</h1>
      </div>

      <div id="step-stepper" style="display:flex;gap:12px;margin-bottom:32px">
        ${[1, 2, 3].map(n => `
          <div data-step="${n}" class="onboard-step" style="flex:1;
              padding:8px 0;border-top:3px solid var(--border);
              text-align:center;font-size:11px;color:var(--muted)">
            Step ${n}
          </div>`).join('')}
      </div>

      <div id="step-body"></div>

      <div id="step-actions" style="display:flex;justify-content:space-between;
            margin-top:32px;padding-top:24px;border-top:1px solid var(--border)">
      </div>
    </div>
  `;
  showStep(1);
}

function showStep(n) {
  step = n;
  document.querySelectorAll('.onboard-step').forEach((el, i) => {
    el.style.borderTopColor = (i + 1) <= n ? 'var(--accent)' : 'var(--border)';
    el.style.color = (i + 1) <= n ? 'var(--fg-2)' : 'var(--muted)';
  });
  if (n === 1) renderStep1();
  if (n === 2) renderStep2();
  if (n === 3) renderStep3();
}

// ── Step 1: Welcome + Docker check ──────────────────────────────────

function renderStep1() {
  const body = document.getElementById('step-body');
  body.innerHTML = `
    <h2 style="margin-top:0">Let's get you set up</h2>
    <p>Auracle Desktop manages a self-hosted algorithmic-trading platform that runs locally on your machine. The first thing it needs is a working Docker runtime.</p>
    <h2>Docker check</h2>
    <div id="docker-check" class="muted mono" style="font-size:11px">checking…</div>
    <h2>What you'll get after install</h2>
    <ul style="padding-left:20px;color:var(--muted);font-size:13px;line-height:1.6">
      <li>Web dashboard at <code>localhost:1969</code> for backtests + live strategy management</li>
      <li>JupyterLab at <code>localhost:1969/jupyter</code> for research notebooks</li>
      <li>MCP server so Claude / Cursor can drive Auracle as an agent</li>
      <li>TimescaleDB for tick-level price storage</li>
    </ul>
  `;
  invoke('docker_status').then(s => {
    const el = document.getElementById('docker-check');
    if (!s.installed) {
      // T-83: deep-link to the direct Docker Desktop installer
      // for the user's OS + arch (returned in s.install_url). Also
      // expose the docker.com landing page as the "verify the
      // source" path. After clicking download, the onboarding view
      // polls every 5 seconds for Docker to appear so the user
      // doesn't have to manually click "Check again."
      el.innerHTML = `
        <span class="badge err">not installed</span>
        — <a href="#" id="dl-docker">download Docker Desktop directly</a>
        (<a href="#" id="dl-docker-page" style="font-size:11px">verify the source</a>),
        then re-launch to continue. We'll auto-detect when it's installed.`;
      document.getElementById('dl-docker').addEventListener('click', async (e) => {
        e.preventDefault();
        if (window.__TAURI__?.opener?.openUrl) {
          window.__TAURI__.opener.openUrl(
            s.install_url || 'https://www.docker.com/products/docker-desktop/');
        }
        // Begin polling for Docker availability
        startDockerPoll();
      });
      document.getElementById('dl-docker-page').addEventListener('click', async (e) => {
        e.preventDefault();
        if (window.__TAURI__?.opener?.openUrl) {
          try {
            const landingUrl = await invoke('docker_install_landing_url');
            window.__TAURI__.opener.openUrl(landingUrl);
          } catch {
            window.__TAURI__.opener.openUrl('https://www.docker.com/products/docker-desktop/');
          }
        }
      });
      renderActions({ next: false });
      return;
    }
    if (!s.running) {
      const niceName = runtimeName(s.runtime);
      el.innerHTML = `
        <span class="badge warn">installed but not running</span>
        — start <strong>${escapeHtml(niceName)}</strong> first, then come back.`;
      renderActions({ next: false });
      return;
    }
    const niceName = runtimeName(s.runtime);
    el.innerHTML = `
      <span class="badge ok">running</span>
      ${escapeHtml(s.version || 'docker')} (<strong>${escapeHtml(niceName)}</strong>)`;
    renderActions({ next: true });
  });
}

// T-83: poll docker_status every 5s after the user clicks the
// direct-download link. Re-renders step 1 when Docker becomes
// available — no manual "Check again" required.
let _dockerPollTimer = null;
function startDockerPoll() {
  if (_dockerPollTimer) return;
  _dockerPollTimer = setInterval(async () => {
    try {
      const s = await invoke('docker_status');
      if (s.installed && s.running) {
        clearInterval(_dockerPollTimer);
        _dockerPollTimer = null;
        renderStep1();   // re-renders with the "running" badge + enables Next
      }
    } catch {
      // Transient errors during poll are fine; keep trying
    }
  }, 5000);
}

function runtimeName(r) {
  return ({
    'docker-desktop': 'Docker Desktop',
    'orbstack': 'OrbStack',
    'colima': 'Colima',
    'rancher': 'Rancher Desktop',
    'engine': 'Docker Engine',
  })[r] || 'Docker';
}

// ── Step 2: License key ─────────────────────────────────────────────

function renderStep2() {
  const body = document.getElementById('step-body');
  body.innerHTML = `
    <h2 style="margin-top:0">License key</h2>
    <p class="muted">Paste your <code>akey_…</code> license key from your Auracle purchase email. Stored securely in your OS keychain — never on disk.</p>
    <input type="password" id="onboard-license" placeholder="akey_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off">
    <div id="license-feedback" class="muted mono" style="font-size:11px;margin-top:8px"></div>
    <p class="muted" style="font-size:12px;margin-top:24px">
      Don't have a key yet? Click <strong>Skip for Community tier</strong> below — you can add one anytime from Settings → License Key. Community gives you 1 strategy + 3 schedules + IBKR data.
    </p>
  `;
  // If a key is already stored (re-running onboarding), prefill the input.
  invoke('license_get').then(stored => {
    if (stored) {
      document.getElementById('onboard-license').value = stored;
      document.getElementById('license-feedback').textContent =
        `Already stored (${stored.slice(0, 12)}…) — click Next to continue.`;
    }
  }).catch(() => {});
  renderActions({ next: true, nextLabel: 'Next', skipLabel: 'Skip for Community tier' });
}

// ── Step 3: Pre-flight checks + Run installer ──────────────────────

function renderStep3() {
  const body = document.getElementById('step-body');
  body.innerHTML = `
    <h2 style="margin-top:0">Pre-flight check</h2>
    <p class="muted">Verifying your machine is ready before we pull anything. This takes a few seconds.</p>
    <div id="preflight-results" style="margin:16px 0"></div>
    <div id="preflight-actions" style="margin-top:12px"></div>
    <div id="install-area" style="display:none">
      <h2 style="margin-top:24px">Setting up Auracle</h2>
      <p class="muted">Pulling Docker images and starting services. This typically takes 3–8 minutes on a fresh machine.</p>
      <div style="margin:24px 0">
        <div class="muted mono" style="font-size:11px;margin-bottom:8px" id="install-phase">starting…</div>
        <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
          <div id="install-bar" style="height:100%;width:0%;background:var(--accent);
               transition:width 0.4s ease"></div>
        </div>
      </div>
      <div id="install-message" class="muted" style="font-size:13px;min-height:40px"></div>
      <details style="margin-top:16px">
        <summary class="muted" style="cursor:pointer;font-size:12px">Show installer log</summary>
        <pre id="install-log" class="logs" style="margin-top:8px;font-size:10px;max-height:200px"></pre>
      </details>
    </div>
  `;
  renderActions({ next: false, hideSkip: true });
  runPreflightThenInstall();
}

function runPreflightThenInstall() {
  const results = document.getElementById('preflight-results');
  const actions = document.getElementById('preflight-actions');
  results.innerHTML = '<div class="muted mono" style="font-size:11px">running checks…</div>';
  actions.innerHTML = '';

  invoke('preflight_check').then(report => {
    renderPreflight(report);
    if (report.can_install) {
      // Auto-advance after a short pause so the user can see the
      // green checkmarks before the screen swaps.
      setTimeout(() => beginInstall(), 1200);
    } else {
      actions.innerHTML = `
        <p class="muted" style="font-size:12px;margin:12px 0">
          Fix the items above and re-check. The install can't run while critical checks are failing.
        </p>
        <button class="primary" id="recheck-btn">Re-check</button>
      `;
      document.getElementById('recheck-btn')?.addEventListener('click', runPreflightThenInstall);
    }
  }).catch(err => {
    results.innerHTML = `<span class="err">Pre-flight check failed:</span> ${escapeHtml(String(err))}`;
    actions.innerHTML = `<button class="primary" id="recheck-btn">Re-check</button>`;
    document.getElementById('recheck-btn')?.addEventListener('click', runPreflightThenInstall);
  });
}

function renderPreflight(report) {
  const results = document.getElementById('preflight-results');
  results.innerHTML = report.checks.map(c => {
    const icon = c.passed ? '✓' : (c.level === 'warning' ? '!' : '✗');
    const cls = c.passed ? 'ok' : (c.level === 'warning' ? 'warn' : 'err');
    const rem = c.remediation
      ? `<div class="muted" style="font-size:11px;margin-left:24px;margin-top:4px">${escapeHtml(c.remediation)}</div>`
      : '';
    return `
      <div style="margin:8px 0">
        <span class="badge ${cls}" style="display:inline-block;min-width:18px;text-align:center">${icon}</span>
        <strong style="margin-left:6px">${escapeHtml(c.name)}</strong>
        <div class="muted" style="font-size:12px;margin-left:24px">${escapeHtml(c.message)}</div>
        ${rem}
      </div>
    `;
  }).join('');
}

function beginInstall() {
  document.getElementById('preflight-actions').innerHTML = '';
  document.getElementById('install-area').style.display = 'block';

  // Save the license key from step 2 if the user entered one.
  // (Length >= 16 is the loosest valid-key heuristic; the server
  // validates the actual format. Anything shorter is almost
  // certainly a typo / placeholder.)
  const inputVal = (document.getElementById('onboard-license')?.value || '').trim();
  const savePromise = inputVal && inputVal.length >= 16
    ? invoke('license_set', { value: inputVal }).catch(() => {})
    : Promise.resolve();

  // Subscribe to installer-progress events.
  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('installer-progress', (event) => {
      const p = event.payload || {};
      if (p.phase) document.getElementById('install-phase').textContent = p.phase.replace(/_/g, ' ');
      if (typeof p.percent === 'number') document.getElementById('install-bar').style.width = `${p.percent}%`;
      if (p.message) document.getElementById('install-message').textContent = p.message;
      if (p.line) {
        const log = document.getElementById('install-log');
        log.textContent += p.line + '\n';
        log.scrollTop = log.scrollHeight;
      }
    });
  }

  savePromise.then(() => invoke('run_first_install')).then(() => {
    document.getElementById('install-message').innerHTML =
      '<span class="ok">Auracle is running. Opening dashboard…</span>';
    setTimeout(() => {
      if (window.__TAURI__?.opener?.openUrl) {
        window.__TAURI__.opener.openUrl('http://localhost:1969/ui/setup');
      }
      location.reload();
    }, 1500);
  }).catch(err => {
    document.getElementById('install-message').innerHTML =
      `<span class="err">Install failed:</span> ${escapeHtml(String(err))}<br><br>
       <button class="ghost" id="retry-install">Retry</button>
       <button class="ghost" id="back-to-step2">Back</button>`;
    document.getElementById('retry-install')?.addEventListener('click', () => renderStep3());
    document.getElementById('back-to-step2')?.addEventListener('click', () => showStep(2));
  });
}

// ── Action buttons (Next / Back / Skip) ─────────────────────────────

function renderActions({ next, nextLabel, skipLabel, hideSkip }) {
  const el = document.getElementById('step-actions');
  el.innerHTML = '';

  if (step > 1) {
    const back = document.createElement('button');
    back.className = 'ghost';
    back.textContent = '← Back';
    back.addEventListener('click', () => showStep(step - 1));
    el.appendChild(back);
  } else {
    el.appendChild(document.createElement('div'));
  }

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.gap = '8px';

  if (step === 2 && !hideSkip) {
    const skip = document.createElement('button');
    skip.className = 'ghost';
    skip.textContent = skipLabel || 'Skip';
    skip.addEventListener('click', () => {
      // Wipe any existing key on skip — operator who skips wanted
      // Community tier; existing key would override.
      invoke('license_clear').catch(() => {}).finally(() => showStep(3));
    });
    right.appendChild(skip);
  }

  if (next) {
    const nx = document.createElement('button');
    nx.className = 'primary';
    nx.textContent = step === 3 ? 'Done' : (nextLabel || 'Next →');
    nx.addEventListener('click', () => {
      if (step === 1) showStep(2);
      else if (step === 2) showStep(3);
    });
    right.appendChild(nx);
  }
  el.appendChild(right);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
