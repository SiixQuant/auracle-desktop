// Diagnostics — health detail + common-fix buttons.
// Mirrors §4.4 of the launcher plan.

import { invoke } from '../app.js';

export function renderDiagnostics(root) {
  root.innerHTML = `
    <h1>Diagnostics</h1>

    <div class="card">
      <h2 style="margin-top:0">Health Snapshot</h2>
      <pre id="health-block" class="logs">loading…</pre>
      <button class="ghost" id="btn-recheck" style="margin-top:12px">Re-check Now</button>
    </div>

    <h2>Common Fixes</h2>
    <div class="card">
      <div class="row">
        <div>Restart the entire stack</div>
        <button class="ghost" id="fix-restart-all">Restart Stack</button>
      </div>
      <div class="row">
        <div>Re-pull all images (catches "stale image" issues)</div>
        <button class="ghost" id="fix-pull">Re-pull Images</button>
      </div>
      <div class="row">
        <div>Restart Houston only (web UI + REST)</div>
        <button class="ghost" id="fix-houston">Restart Houston</button>
      </div>
      <div class="row">
        <div>Restart scheduler only (cron-driven jobs)</div>
        <button class="ghost" id="fix-scheduler">Restart Scheduler</button>
      </div>
    </div>

    <p class="muted" style="margin-top:24px;font-size:11px">
      For more detailed troubleshooting, see the
      <a href="#" id="docs-link">Auracle docs</a> or open a
      <a href="#" id="issue-link">GitHub issue</a> with your diagnostics.
    </p>
  `;

  refresh();
  document.getElementById('btn-recheck').addEventListener('click', refresh);
  document.getElementById('fix-restart-all').addEventListener('click', () => runFix('compose restart',
    async () => { await invoke('stack_stop'); await invoke('stack_start'); }));
  document.getElementById('fix-pull').addEventListener('click', () => runFix('docker compose pull',
    () => invoke('stack_pull_update')));
  document.getElementById('fix-houston').addEventListener('click', () => runFix('restart houston',
    () => invoke('stack_restart_container', { name: 'houston' })));
  document.getElementById('fix-scheduler').addEventListener('click', () => runFix('restart scheduler',
    () => invoke('stack_restart_container', { name: 'scheduler' })));
}

async function refresh() {
  const health = await invoke('healthcheck_now').catch(e => ({ error: String(e) }));
  const stack = await invoke('stack_status').catch(e => ({ error: String(e) }));
  document.getElementById('health-block').textContent =
    JSON.stringify({ health, stack }, null, 2);
}

async function runFix(label, fn) {
  if (!confirm(`Run: ${label}?`)) return;
  try {
    await fn();
    alert(`Done: ${label}`);
    refresh();
  } catch (err) {
    alert(`Failed: ${err}`);
  }
}
