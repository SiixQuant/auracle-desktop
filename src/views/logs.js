// Logs — per-container log viewer with live tail.
// Calls invoke('container_logs', { name, tail }) and refreshes.

import { invoke } from '../app.js';

const CONTAINERS = ['houston', 'scheduler', 'mcp', 'jupyter', 'db', 'caddy'];
let selected = 'houston';
let tail = 200;
let pollHandle = null;

export function renderLogs(root) {
  root.innerHTML = `
    <h1>Logs</h1>

    <div class="card">
      <div class="row">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${CONTAINERS.map(name => `
            <button class="ghost" data-container="${name}">${name}</button>
          `).join('')}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <label class="muted">tail</label>
          <input type="text" id="tail-input" value="${tail}" style="width:80px;text-align:right">
          <button class="ghost" id="btn-refresh">Refresh</button>
        </div>
      </div>
      <pre id="log-block" class="logs">loading…</pre>
    </div>
  `;

  document.querySelectorAll('button[data-container]').forEach(btn => {
    btn.addEventListener('click', () => {
      selected = btn.dataset.container;
      refresh();
    });
  });
  document.getElementById('btn-refresh').addEventListener('click', refresh);
  document.getElementById('tail-input').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (n > 0 && n <= 2000) tail = n;
  });

  refresh();
  if (pollHandle) clearInterval(pollHandle);
  // Poll every 10 s while the Logs view is open. The destroy
  // semantics here are loose — switching tabs will leave the
  // interval running until the next showView() rewires
  // pollHandle. Acceptable for the scaffold.
  pollHandle = setInterval(refresh, 10000);
}

async function refresh() {
  const block = document.getElementById('log-block');
  if (!block) return; // user navigated away
  try {
    const lines = await invoke('container_logs', { name: selected, tail });
    block.textContent = lines.length ? lines.join('\n') : '(no log lines)';
    block.scrollTop = block.scrollHeight;
  } catch (err) {
    block.textContent = 'Error: ' + err;
  }
}
