/**
 * Turnout log.
 *
 * A contestant who does not compete either turned out on notice, turned out
 * without notice, or was released by a doctor or a vet. Which one it is decides
 * whether the entry fee is forfeit and whether a fine is owed. The engine makes
 * that call from the notice given; this screen records it and shows the money
 * that follows so nobody argues it at the pay window.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const TYPE_LABEL = {
  TO: 'Turned out (on notice)',
  NTO: 'No notice',
  PTO: 'Partner turned out',
  DR: 'Doctor release',
  VI: 'Vet release',
  DO: 'Drew out',
};

function typePill(t) {
  if (t === 'NTO') return h('span', { class: 'pill stop' }, TYPE_LABEL[t] ?? t);
  if (t === 'DR' || t === 'VI' || t === 'DO') return h('span', { class: 'pill ok' }, TYPE_LABEL[t] ?? t);
  return h('span', { class: 'pill warn' }, TYPE_LABEL[t] ?? t);
}

function dollarsToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export async function turnoutsView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Turnout log' },
  );

  let rows = [];

  async function load() {
    rows = await api.turnouts(rodeoId);
    draw();
  }

  async function add(form) {
    const data = new FormData(form);
    const logType = data.get('log_type');
    const body = {
      log_type: logType,
      member_number: (data.get('member_number') || '').trim() || undefined,
      performance_number: data.get('performance_number')
        ? Number(data.get('performance_number'))
        : undefined,
      notified_how: (data.get('notified_how') || '').trim() || undefined,
      entry_fee_cents: data.get('entry_fee')
        ? dollarsToCents(data.get('entry_fee'))
        : undefined,
      fine_amount_cents: data.get('fine_amount')
        ? dollarsToCents(data.get('fine_amount'))
        : undefined,
      is_team_roping: data.get('is_team_roping') === 'on',
      partner_notified: data.get('partner_notified') === 'on',
      notes: (data.get('notes') || '').trim() || undefined,
    };
    try {
      const saved = await api.logTurnout(rodeoId, body);
      const d = saved.decision;
      toast(
        d.fineable
          ? `Logged. Fine ${money(d.fine_cents)}, fee owed ${money(d.fee_owed_cents)}.`
          : 'Logged. No fine.',
      );
      form.reset();
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function formPanel() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); add(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Type',
          h('select', { name: 'log_type' },
            Object.entries(TYPE_LABEL).map(([v, l]) =>
              h('option', { value: v }, l)))),
        h('label', {}, 'Member #',
          h('input', { name: 'member_number', placeholder: 'e.g. 12345' })),
        h('label', {}, 'Perf #',
          h('input', { name: 'performance_number', type: 'number', min: '0', style: 'width:80px' })),
        h('label', {}, 'Entry fee ($)',
          h('input', { name: 'entry_fee', type: 'number', min: '0', step: '0.01', style: 'width:110px' })),
        h('label', {}, 'Fine ($)',
          h('input', { name: 'fine_amount', type: 'number', min: '0', step: '0.01', style: 'width:110px' })),
      ),
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px' },
        h('label', {}, 'Notice given',
          h('input', { name: 'notified_how', placeholder: 'called office 6pm Fri', style: 'width:220px' })),
        h('label', { style: 'display:flex;gap:6px;align-items:center' },
          h('input', { name: 'is_team_roping', type: 'checkbox' }), 'Team roping'),
        h('label', { style: 'display:flex;gap:6px;align-items:center' },
          h('input', { name: 'partner_notified', type: 'checkbox' }), 'Partner notified'),
        h('label', {}, 'Notes',
          h('input', { name: 'notes', placeholder: 'optional', style: 'width:220px' })),
        h('button', { type: 'submit' }, 'Log turnout'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Record a turnout'),
      h('p', { class: 'muted small' },
        'The engine decides the fine from the notice given. Enter the entry fee '
        + 'to see the fee at risk.'),
      form,
    );
  }

  function tablePanel() {
    const fineable = rows.filter((r) => r.fineable);
    const owed = rows.reduce((s, r) => s + (r.fine_cents || 0) + (r.fee_owed_cents || 0), 0);
    return h('section', { class: 'card' },
      h('h2', {}, 'Logged'),
      h('p', { class: 'muted small' },
        `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · ${fineable.length} fineable`,
        owed > 0 ? ` · ${money(owed)} at risk` : ''),
      rows.length === 0
        ? h('p', { class: 'muted small' }, 'Nothing logged yet.')
        : h('table', { class: 'sheet' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'Member'),
              h('th', {}, 'Type'),
              h('th', { class: 'num' }, 'Perf'),
              h('th', { class: 'num' }, 'Fee owed'),
              h('th', { class: 'num' }, 'Fine'),
              h('th', {}, 'Notice'),
            )),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', {}, r.member_number || '—'),
              h('td', {}, typePill(r.log_type)),
              h('td', { class: 'num' }, r.performance_number ?? '—'),
              h('td', { class: 'num' }, money(r.fee_owed_cents)),
              h('td', { class: 'num' }, money(r.fine_cents)),
              h('td', {}, r.notified_how || '—'),
            ))),
          ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Turnout log'),
      h('p', { class: 'muted' }, 'Who did not compete, and what it costs them.'),
      formPanel(),
      tablePanel(),
    ));
  }

  await load();
}
