/**
 * Router and bootstrap.
 *
 * Hash routing, no framework, no build. Every view is an async function that
 * fetches what it needs and calls render(). If one throws, the error is shown
 * on the page rather than swallowed into a console the secretary will never
 * open.
 */

import { api, init, session, setSession, clearSession, syncOffline } from './api.js';
import { crumbs, h, render, showPrint, stopPoll, toast } from './ui.js';
import { onQueueChange, queueSize } from './offline.js';

const routes = [
  [/^\/?$/, () => import('./views/rodeo.js').then((m) => m.listView())],
  [/^\/new$/, () => import('./views/setup.js').then((m) => m.setupView())],
  [/^\/rodeo\/([0-9a-f-]{36})$/, (id) =>
    import('./views/rodeo.js').then((m) => m.rodeoView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/daysheet$/, (id) =>
    import('./views/daysheet.js').then((m) => m.daySheetView(id, null))],
  [/^\/rodeo\/([0-9a-f-]{36})\/daysheet\/all$/, (id) =>
    import('./views/daysheet.js').then((m) => m.daySheetView(id, null))],
  [/^\/rodeo\/([0-9a-f-]{36})\/daysheet\/(\d+)$/, (id, perf) =>
    import('./views/daysheet.js').then((m) => m.daySheetView(id, Number(perf)))],
  [/^\/rodeo\/([0-9a-f-]{36})\/entries$/, (id) =>
    import('./views/entries.js').then((m) => m.entriesView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/draw$/, (id) =>
    import('./views/draw.js').then((m) => m.drawView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/payouts$/, (id) =>
    import('./views/payouts.js').then((m) => m.payoutsView(id))],
  [/^\/contestant\/([0-9a-f-]{36})$/, (id) =>
    import('./views/contestant.js').then((m) => m.contestantView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/scoring$/, (id) =>
    import('./views/scoring.js').then((m) => m.scoringView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/judge-cards$/, (id) =>
    import('./views/judgesheet.js').then((m) => m.judgeSheetView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/results$/, (id) =>
    import('./views/results.js').then((m) => m.resultsView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/corrections$/, (id) =>
    import('./views/corrections.js').then((m) => m.correctionsView(id, null))],
  [/^\/rodeo\/([0-9a-f-]{36})\/corrections\/([0-9a-f-]{36})$/, (id, evId) =>
    import('./views/corrections.js').then((m) => m.correctionsView(id, evId))],
  [/^\/rodeo\/([0-9a-f-]{36})\/arena$/, (id) =>
    import('./views/arena.js').then((m) => m.arenaView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/books$/, (id) =>
    import('./views/books.js').then((m) => m.booksView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/compliance$/, (id) =>
    import('./views/compliance.js').then((m) => m.complianceView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/grounds$/, (id) =>
    import('./views/grounds.js').then((m) => m.groundsView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/waivers$/, (id) =>
    import('./views/waivers.js').then((m) => m.waiversView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/turnouts$/, (id) =>
    import('./views/turnouts.js').then((m) => m.turnoutsView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/trades$/, (id) =>
    import('./views/trades.js').then((m) => m.tradesView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/infractions$/, (id) =>
    import('./views/infractions.js').then((m) => m.infractionsView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/timers$/, (id) =>
    import('./views/timers.js').then((m) => m.timersView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/performance$/, (id) =>
    import('./views/performance_mode.js').then((m) => m.performanceModeView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/remittance$/, (id) =>
    import('./views/remittance.js').then((m) => m.remittanceView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/checkin$/, (id) =>
    import('./views/checkin.js').then((m) => m.checkInView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/arena-check$/, (id) =>
    import('./views/arena_check.js').then((m) => m.arenaCheckView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/ground-rules$/, (id) =>
    import('./views/groundrules.js').then((m) => m.groundRulesView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/personnel$/, (id) =>
    import('./views/personnel.js').then((m) => m.personnelView(id))],
  [/^\/year-end$/, () =>
    import('./views/yearend.js').then((m) => m.yearEndView())],
  [/^\/settings$/, () => settingsView()],
];

/**
 * Where the session comes from.
 *
 * Supabase Auth is not wired into this app yet, so the token and the
 * organisation are pasted in once and kept in localStorage. That is stated
 * plainly on the screen rather than hidden behind a fake login: pretending to
 * have authentication that does not exist is how a demo gets deployed.
 */
function settingsView() {
  crumbs({ label: 'Settings' });
  showPrint(null);
  const { token, orgId } = session();

  const tokenInput = h('input', {
    name: 'token', value: token, placeholder: 'eyJhbGciOi…', autocomplete: 'off',
  });
  const orgInput = h('input', {
    name: 'org', value: orgId, placeholder: '00000000-0000-0000-0000-000000000000',
  });

  render(
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        setSession(tokenInput.value.trim(), orgInput.value.trim());
        toast('Saved.');
        location.hash = '#/';
      },
    },
      h('h1', {}, 'Connection'),
      h('div', { class: 'card' },
        h('p', { class: 'muted' },
          'Supabase Auth is not wired into this interface yet. Until it is, paste ' +
          'an access token and the organisation id. The token is sent as a bearer ' +
          'header and is never stored anywhere but this browser.'),
        h('label', {}, 'Access token', tokenInput),
        h('label', {}, 'Organisation id', orgInput),
        h('div', { class: 'actions' },
          h('button', { type: 'submit' }, 'Save'),
          h('button', {
            type: 'button', class: 'ghost',
            onclick: () => { clearSession(); toast('Cleared.'); location.hash = '#/settings'; },
          }, 'Clear'),
        ),
      ),
    ),
  );
}

function notFound() {
  crumbs({ label: 'Not found' });
  render(h('div', { class: 'card' },
    h('h1', {}, 'No such page'),
    h('p', {}, h('a', { href: '#/' }, 'Back to rodeos')),
  ));
}

function showError(err) {
  crumbs({ label: 'Error' });
  showPrint(null);
  render(h('div', { class: 'card' },
    h('h1', {}, 'That did not work'),
    h('p', {}, err.message ?? String(err)),
    err.code ? h('p', { class: 'muted small' }, err.code) : null,
    h('div', { class: 'actions' },
      h('a', { class: 'row-link', href: '#/', style: 'padding:10px 18px' }, 'Back'),
      h('a', { class: 'row-link', href: '#/settings', style: 'padding:10px 18px' }, 'Connection'),
    ),
  ));
}

async function route() {
  const path = location.hash.replace(/^#/, '') || '/';

  // Any live refresh from the view we are leaving stops before the next one
  // starts, so exactly one poll is ever in flight.
  stopPoll();

  if (!session().configured && path !== '/settings') {
    location.hash = '#/settings';
    return;
  }

  for (const [pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    try {
      document.getElementById('view').replaceChildren(
        h('div', { class: 'loading' }, 'Loading…'),
      );
      await handler(...match.slice(1));
    } catch (err) {
      showError(err);
    }
    return;
  }
  notFound();
}

window.addEventListener('hashchange', route);

/**
 * Global keyboard shortcuts.
 *
 * The rapid rhythm — type a score, press Enter, drop to the next contestant —
 * lives inside each entry view. These are the shortcuts that make sense
 * anywhere, and every one of them stands down the moment a field has focus, so
 * a secretary typing a horse's name never trips a shortcut. The one exception
 * is Escape, whose whole job is to let go of a field and stop the rapid entry.
 */
const TYPING = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
window.addEventListener('keydown', (e) => {
  const typing = TYPING.has(document.activeElement?.tagName);

  if (e.key === 'Escape' && typing) {
    document.activeElement.blur();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

  // p — print the sheet, when the current view offers one.
  if (e.key === 'p') {
    const btn = document.getElementById('printBtn');
    if (btn && !btn.hidden) { e.preventDefault(); btn.click(); }
    return;
  }
  // ? — a reminder of what the keys do.
  if (e.key === '?') {
    e.preventDefault();
    toast('Enter saves and moves down · Esc leaves a field · p prints');
  }
});

/**
 * Offline status and sync.
 *
 * The top bar carries one small pill that tells the truth about the connection:
 * how many writes are waiting on this device, or that the app is offline and
 * running on cached data. When the connection returns — the browser's `online`
 * event, or simply coming back to the tab — the queue drains automatically and
 * the current view is refreshed so the secretary sees the synced result.
 */
function paintSync(queued) {
  const el = document.getElementById('syncLabel');
  if (!el) return;
  if (!navigator.onLine) {
    el.hidden = false;
    el.className = 'pill warn';
    el.textContent = queued > 0 ? `Offline · ${queued} to sync` : 'Offline';
    return;
  }
  if (queued > 0) {
    el.hidden = false;
    el.className = 'pill warn';
    el.textContent = `Syncing ${queued}…`;
    return;
  }
  el.hidden = true;
}

onQueueChange(paintSync);
window.addEventListener('offline', () => paintSync(queueSize()));

async function drainAndRefresh() {
  if (!navigator.onLine) return;
  await syncOffline();
  // Show the synced state on whatever screen the secretary is looking at.
  await route();
}
window.addEventListener('online', drainAndRefresh);

// Register the service worker so the shell and the reads it has seen survive
// going offline. It is a progressive enhancement: if it fails to register the
// app still runs, just without the offline cache.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

await init();
const org = session().orgId;
if (org) {
  document.getElementById('orgLabel').textContent = `org ${org.slice(0, 8)}`;
}
await route();
// Drain anything left queued from a previous offline session.
drainAndRefresh();
