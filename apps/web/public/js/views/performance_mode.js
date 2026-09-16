/**
 * Performance mode.
 *
 * The one screen the office and the arena both watch during a performance. It
 * says which event and which position is up, and it holds the crew sign-in for
 * the day. One row per performance: moving it forward updates that row, so the
 * office screen and the arena screen never disagree about what is up.
 */

import { api } from '../api.js';
import { crumbs, h, poll, render, showPrint, toast } from '../ui.js';

const STATE_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  section_complete: 'Section complete',
  reconciled: 'Reconciled',
  closed: 'Closed',
};

function statePill(s) {
  if (s === 'closed') return h('span', { class: 'pill ok' }, STATE_LABEL[s]);
  if (s === 'in_progress') return h('span', { class: 'pill warn' }, STATE_LABEL[s]);
  if (s === 'reconciled') return h('span', { class: 'pill ok' }, STATE_LABEL[s]);
  return h('span', { class: 'pill' }, STATE_LABEL[s] ?? s);
}

export async function performanceModeView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Performance mode' },
  );

  const events = rodeo.events ?? [];
  let states = [];
  let crew = [];

  async function load() {
    [states, crew] = await Promise.all([
      api.performanceState(rodeoId),
      api.personnelSignins(rodeoId),
    ]);
    draw();
  }

  async function setState(form) {
    const data = new FormData(form);
    const performanceNumber = Number(data.get('performance_number'));
    const body = {
      state: data.get('state'),
      current_event_id: (data.get('current_event_id') || '') || null,
      current_run_position: data.get('current_run_position')
        ? Number(data.get('current_run_position'))
        : null,
    };
    try {
      await api.setPerformanceState(rodeoId, performanceNumber, body);
      toast('Updated.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function addCrew(form) {
    const data = new FormData(form);
    const body = {
      role: (data.get('role') || '').trim(),
      printed_name: (data.get('printed_name') || '').trim(),
      card_or_phone: (data.get('card_or_phone') || '').trim() || undefined,
      signature_method: data.get('signature_method') || undefined,
    };
    if (!body.role || !body.printed_name) return toast('Role and name are required.', true);
    try {
      await api.addPersonnelSignin(rodeoId, body);
      toast('Signed in.');
      form.reset();
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function removeCrew(r) {
    if (!confirm(`Remove ${r.printed_name}?`)) return;
    try {
      await api.removePersonnelSignin(rodeoId, r.id);
      toast('Removed.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function eventName(id) {
    const ev = events.find((e) => e.id === id);
    return ev ? (ev.label ?? ev.event_type) : (id ? id.slice(0, 8) : '—');
  }

  function statePanel() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); setState(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Perf #',
          h('input', { name: 'performance_number', type: 'number', min: '0', value: '1', style: 'width:80px' })),
        h('label', {}, 'State',
          h('select', { name: 'state' },
            Object.entries(STATE_LABEL).map(([v, l]) => h('option', { value: v }, l)))),
        h('label', {}, 'Event up',
          h('select', { name: 'current_event_id' },
            h('option', { value: '' }, '—'),
            events.map((ev) => h('option', { value: ev.id }, ev.label ?? ev.event_type)))),
        h('label', {}, 'Position up',
          h('input', { name: 'current_run_position', type: 'number', min: '0', style: 'width:100px' })),
        h('button', { type: 'submit' }, 'Set'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'What is up'),
      form,
      states.length === 0
        ? h('p', { class: 'muted small', style: 'margin-top:10px' }, 'No performance is running yet.')
        : h('table', { class: 'sheet', style: 'margin-top:10px' },
            h('thead', {}, h('tr', {},
              h('th', { class: 'num' }, 'Perf'),
              h('th', {}, 'State'),
              h('th', {}, 'Event up'),
              h('th', { class: 'num' }, 'Position'),
            )),
            h('tbody', {}, states.map((s) => h('tr', {},
              h('td', { class: 'num' }, s.performance_number),
              h('td', {}, statePill(s.state)),
              h('td', {}, eventName(s.current_event_id)),
              h('td', { class: 'num' }, s.current_run_position ?? '—'),
            ))),
          ),
    );
  }

  function crewPanel() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); addCrew(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Role',
          h('input', { name: 'role', placeholder: 'judge, timer, pickup', style: 'width:160px' })),
        h('label', {}, 'Name',
          h('input', { name: 'printed_name', placeholder: 'printed name', style: 'width:180px' })),
        h('label', {}, 'Card / phone',
          h('input', { name: 'card_or_phone', placeholder: 'optional', style: 'width:160px' })),
        h('label', {}, 'Method',
          h('select', { name: 'signature_method' },
            h('option', { value: 'typed' }, 'Typed'),
            h('option', { value: 'paper' }, 'Paper'),
            h('option', { value: 'imported' }, 'Imported'))),
        h('button', { type: 'submit' }, 'Sign in'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Crew signed in'),
      h('p', { class: 'muted small' }, `${crew.length} on the sheet`),
      form,
      crew.length === 0
        ? h('p', { class: 'muted small', style: 'margin-top:10px' }, 'Nobody signed in yet.')
        : h('table', { class: 'sheet', style: 'margin-top:10px' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'Role'),
              h('th', {}, 'Name'),
              h('th', {}, 'Card / phone'),
              h('th', {}, 'Method'),
              h('th', {}, ''),
            )),
            h('tbody', {}, crew.map((r) => h('tr', {},
              h('td', {}, r.role),
              h('td', {}, r.printed_name),
              h('td', {}, r.card_or_phone || '—'),
              h('td', {}, r.signature_method),
              h('td', {}, h('button', { class: 'small ghost', onclick: () => removeCrew(r) }, 'Remove')),
            ))),
          ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Performance mode'),
      h('p', { class: 'muted' }, 'What is up right now, and who is on the crew today.'),
      statePanel(),
      crewPanel(),
    ));
  }

  await load();
  // Keep the office and arena screens agreeing on what is up. A refresh that
  // fired while someone was mid-entry would wipe the form under their hands, so
  // it holds off whenever a field on this screen has focus.
  poll(() => {
    const active = document.activeElement;
    if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
    return load();
  }, 15000);
}
