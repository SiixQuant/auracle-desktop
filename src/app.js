// Auracle Desktop — frontend entry point.
//
// Minimal SPA router that swaps view partials into #view-root.
// Backend access goes through window.__TAURI__.core.invoke('cmd_name', args).
// The /src-tauri/src/lib.rs file declares which commands are
// callable; calling anything not registered there throws.
//
// Production launcher will probably reach for Vue or React, but
// the scaffolding stays trivial so the Rust + frontend contract
// can be exercised today.

import { renderDashboard } from './views/dashboard.js';
import { renderSettings } from './views/settings.js';
import { renderOnboarding } from './views/onboarding.js';

const VIEWS = {
  dashboard: renderDashboard,
  settings: renderSettings,
  onboarding: renderOnboarding,
};

// Tauri's invoke API. In a non-Tauri context (e.g. opening
// index.html in a browser for static rendering checks) we stub
// it with rejected promises so view code can still mount and
// surface the missing-backend state instead of crashing on
// undefined.
export const invoke = (cmd, args = {}) => {
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return Promise.reject(
    new Error(`Tauri backend not available — running outside the launcher? (cmd=${cmd})`)
  );
};

// Tab switching.
const tabs = document.querySelectorAll('.tab');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelector('.tab.active')?.classList.remove('active');
    tab.classList.add('active');
    showView(tab.dataset.view);
  });
});

function showView(name) {
  const root = document.getElementById('view-root');
  root.innerHTML = '';
  const renderer = VIEWS[name] || VIEWS.dashboard;
  renderer(root);
}

// First-run gate: if the stack isn't installed yet, force the
// onboarding wizard regardless of which tab is active. The wizard
// does its own navigation and reload()s when install completes,
// dropping the user into the regular Dashboard view.
async function bootstrapView() {
  try {
    const installed = await invoke('is_installed');
    if (!installed) {
      // Hide the tab nav during onboarding — the wizard owns the
      // whole window during first-run.
      document.querySelector('.tabs')?.style?.setProperty('display', 'none');
      showView('onboarding');
      return;
    }
  } catch (_) {
    // Backend unavailable — fall through to dashboard so the user
    // at least sees a (failing) status instead of a blank screen.
  }
  showView('dashboard');
}
bootstrapView();

// Background: poll the Rust core's healthcheck snapshot every 5 s
// to update the topbar status dot. The Rust side runs its OWN
// 30-s poll against /healthz; this 5-s tick is just to refresh
// the cached snapshot in the UI without round-tripping to
// localhost.
const dot = document.getElementById('status-dot');
async function refreshTopBarDot() {
  try {
    const snapshot = await invoke('current_health');
    dot.classList.remove('healthy', 'degraded', 'down', 'starting');
    if (snapshot && snapshot.state) {
      dot.classList.add(snapshot.state);
      dot.title = `Stack: ${snapshot.state}`;
    }
  } catch (_) {
    // Backend unavailable (running in browser, or Rust just
    // started). Leave the dot at its default muted color.
  }
}
refreshTopBarDot();
setInterval(refreshTopBarDot, 5000);

// Show the launcher version in the topbar.
invoke('current_version').then(v => {
  document.getElementById('launcher-version').textContent = `v${v}`;
}).catch(() => {});
