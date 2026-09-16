/**
 * Two-timer sheet.
 *
 * Every timed run is caught on two watches, and often an electric eye. The
 * office does not pick a favourite watch — the engine reconciles them by a
 * fixed rule (the eye if it read; otherwise the average of two watches that
 * agree; otherwise the single watch, flagged). This screen enters the watches
 * and shows the one official time that comes out, so a contestant cannot argue
 * the office rounded against them.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

function fmtSeconds(s) {
  if (s == null) return '—';
  return Number(s).toFixed(3);
}

export async function timersView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Two-timer sheet' },
  );

  const events = rodeo.events ?? [];
  let eventId = events[0]?.id ?? '';
  let readings = [];
  let result = null;

  async function loadReadings() {
    readings = eventId ? await api.timerReadings(rodeoId, eventId) : [];
    draw();
  }

  function num(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function reconcile(form) {
    const data = new FormData(form);
    const persist = data.get('persist') === 'on';
    const body = {
      rodeo_event_id: eventId,
      timer1_seconds: num(data.get('timer1')),
      timer2_seconds: num(data.get('timer2')),
      electric_eye_seconds: num(data.get('eye')),
      barrier_penalty_seconds: num(data.get('barrier')) ?? 0,
      other_penalty_seconds: num(data.get('other')) ?? 0,
      no_time: data.get('no_time') === 'on',
      persist,
      performance_number: data.get('performance_number')
        ? Number(data.get('performance_number'))
        : undefined,
      run_position: data.get('run_position') ? Number(data.get('run_position')) : undefined,
    };
    try {
      result = await api.reconcileTimer(rodeoId, body);
      toast(persist ? 'Reconciled and saved.' : 'Reconciled.');
      loadReadings();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function reconcilePanel() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); reconcile(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Event',
          h('select', {
            name: 'event',
            onchange: (e) => { eventId = e.target.value; loadReadings(); },
          }, events.map((ev) =>
            h('option', { value: ev.id, selected: ev.id === eventId ? true : null },
              ev.label ?? ev.event_type)))),
        h('label', {}, 'Watch 1',
          h('input', { name: 'timer1', type: 'number', step: '0.001', min: '0', style: 'width:100px' })),
        h('label', {}, 'Watch 2',
          h('input', { name: 'timer2', type: 'number', step: '0.001', min: '0', style: 'width:100px' })),
        h('label', {}, 'Electric eye',
          h('input', { name: 'eye', type: 'number', step: '0.001', min: '0', style: 'width:100px' })),
      ),
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px' },
        h('label', {}, 'Barrier penalty',
          h('input', { name: 'barrier', type: 'number', step: '0.001', min: '0', value: '0', style: 'width:110px' })),
        h('label', {}, 'Other penalty',
          h('input', { name: 'other', type: 'number', step: '0.001', min: '0', value: '0', style: 'width:110px' })),
        h('label', { style: 'display:flex;gap:6px;align-items:center' },
          h('input', { name: 'no_time', type: 'checkbox' }), 'No time'),
      ),
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px' },
        h('label', {}, 'Perf #',
          h('input', { name: 'performance_number', type: 'number', min: '0', style: 'width:80px' })),
        h('label', {}, 'Run position',
          h('input', { name: 'run_position', type: 'number', min: '0', style: 'width:100px' })),
        h('label', { style: 'display:flex;gap:6px;align-items:center' },
          h('input', { name: 'persist', type: 'checkbox' }), 'Save official time to the run'),
        h('button', { type: 'submit' }, 'Reconcile'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Reconcile a run'),
      h('p', { class: 'muted small' },
        'Enter the two watches and the eye. The engine picks the official time '
        + 'by the fixed rule and flags a disagreement.'),
      form,
    );
  }

  function resultPanel() {
    if (!result) return null;
    const agree = result.watches_agree;
    return h('section', { class: 'card' },
      h('h2', {}, 'Official time'),
      h('p', { style: 'font-size:28px;font-weight:700;margin:6px 0' },
        result.no_time ? 'No time' : `${fmtSeconds(result.official_seconds)} s`),
      h('table', { class: 'ledger' }, h('tbody', {},
        h('tr', {}, h('td', {}, 'Base time'),
          h('td', { class: 'num' }, `${fmtSeconds(result.base_seconds)} s`)),
        h('tr', {}, h('td', {}, 'Base source'),
          h('td', {}, result.base_source ?? '—')),
        h('tr', {}, h('td', {}, 'Penalty'),
          h('td', { class: 'num' }, `${fmtSeconds(result.penalty_seconds)} s`)),
        h('tr', {}, h('td', {}, 'Watch spread'),
          h('td', { class: 'num' }, `${fmtSeconds(result.watch_spread_seconds)} s`)),
        h('tr', {}, h('td', {}, 'Watches agree'),
          h('td', {}, agree
            ? h('span', { class: 'pill ok' }, 'Yes')
            : h('span', { class: 'pill stop' }, 'No — check watches'))),
      )),
      (result.issues ?? []).length
        ? h('ul', { class: 'muted small' },
            result.issues.map((i) => h('li', {}, i.message)))
        : null,
    );
  }

  function readingsPanel() {
    return h('section', { class: 'card' },
      h('h2', {}, 'Watches recorded'),
      readings.length === 0
        ? h('p', { class: 'muted small' }, 'No watches recorded for this event yet.')
        : h('table', { class: 'sheet' },
            h('thead', {}, h('tr', {},
              h('th', { class: 'num' }, 'Perf'),
              h('th', { class: 'num' }, 'Pos'),
              h('th', { class: 'num' }, 'Watch'),
              h('th', { class: 'num' }, 'Raw'),
              h('th', { class: 'num' }, 'Official'),
              h('th', {}, 'Eye'),
            )),
            h('tbody', {}, readings.map((r) => h('tr', {},
              h('td', { class: 'num' }, r.performance_number ?? '—'),
              h('td', { class: 'num' }, r.run_position ?? '—'),
              h('td', { class: 'num' }, r.timer_number),
              h('td', { class: 'num' }, fmtSeconds(r.raw_seconds)),
              h('td', { class: 'num' }, fmtSeconds(r.official_seconds)),
              h('td', {}, r.electric_eye ? 'yes' : '—'),
            ))),
          ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Two-timer sheet'),
      h('p', { class: 'muted' }, 'Two watches and the eye, reconciled to one official time.'),
      reconcilePanel(),
      resultPanel(),
      readingsPanel(),
    ));
  }

  await loadReadings();
}
