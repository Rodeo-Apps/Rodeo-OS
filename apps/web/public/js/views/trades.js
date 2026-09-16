/**
 * Trades and doctor releases.
 *
 * A contestant can move to another position or performance a limited number of
 * times per go-round — two, unless the association says otherwise. The engine
 * counts what has already been used and refuses the one that goes over the cap,
 * so the day sheet cannot quietly grow a third trade nobody signed off.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

function pos(perf, position, slack) {
  if (slack) return 'slack';
  const parts = [];
  if (perf != null) parts.push(`perf ${perf}`);
  if (position != null) parts.push(`#${position}`);
  return parts.join(' ') || '—';
}

function statusPill(s) {
  if (s === 'confirmed') return h('span', { class: 'pill ok' }, 'Confirmed');
  if (s === 'rejected') return h('span', { class: 'pill stop' }, 'Rejected');
  return h('span', { class: 'pill warn' }, s || 'Pending');
}

export async function tradesView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Trades' },
  );

  const events = rodeo.events ?? [];
  let rows = [];

  async function load() {
    rows = await api.trades(rodeoId);
    draw();
  }

  async function add(form) {
    const data = new FormData(form);
    const body = {
      rodeo_event_id: data.get('rodeo_event_id'),
      discipline: data.get('discipline'),
      go_round_number: Number(data.get('go_round_number') || 1),
      contestant_a_id: (data.get('contestant_a_id') || '').trim(),
      contestant_b_id: (data.get('contestant_b_id') || '').trim() || undefined,
      from_performance_number: data.get('from_performance_number')
        ? Number(data.get('from_performance_number'))
        : undefined,
      from_position: data.get('from_position') ? Number(data.get('from_position')) : undefined,
      to_performance_number: data.get('to_performance_number')
        ? Number(data.get('to_performance_number'))
        : undefined,
      to_position: data.get('to_position') ? Number(data.get('to_position')) : undefined,
      trades_allowed: data.get('trades_allowed') === 'on',
      notes: (data.get('notes') || '').trim() || undefined,
    };
    try {
      const saved = await api.logTrade(rodeoId, body);
      const v = saved.validation;
      toast(`Trade ${v.trade_number} recorded. ${v.trades_remaining} left this go.`);
      form.reset();
      load();
    } catch (err) {
      // 422 TRADE_REJECTED carries the reasons in details.
      const detail = err.details?.issues?.map((i) => i.message).join(' ');
      toast(detail ? `Rejected: ${detail}` : err.message, true);
    }
  }

  function formPanel() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); add(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Event',
          h('select', { name: 'rodeo_event_id' },
            events.map((ev) =>
              h('option', { value: ev.id }, ev.label ?? ev.event_type)))),
        h('label', {}, 'Discipline',
          h('select', { name: 'discipline' },
            h('option', { value: 'timed' }, 'Timed'),
            h('option', { value: 'riding' }, 'Riding'))),
        h('label', {}, 'Go',
          h('input', { name: 'go_round_number', type: 'number', min: '1', value: '1', style: 'width:70px' })),
        h('label', { style: 'display:flex;gap:6px;align-items:center' },
          h('input', { name: 'trades_allowed', type: 'checkbox', checked: true }),
          'Trades allowed'),
      ),
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px' },
        h('label', {}, 'Contestant A id',
          h('input', { name: 'contestant_a_id', placeholder: 'uuid', style: 'width:200px' })),
        h('label', {}, 'Contestant B id',
          h('input', { name: 'contestant_b_id', placeholder: 'optional uuid', style: 'width:200px' })),
      ),
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px' },
        h('label', {}, 'From perf',
          h('input', { name: 'from_performance_number', type: 'number', min: '0', style: 'width:90px' })),
        h('label', {}, 'From pos',
          h('input', { name: 'from_position', type: 'number', min: '0', style: 'width:90px' })),
        h('label', {}, 'To perf',
          h('input', { name: 'to_performance_number', type: 'number', min: '0', style: 'width:90px' })),
        h('label', {}, 'To pos',
          h('input', { name: 'to_position', type: 'number', min: '0', style: 'width:90px' })),
        h('label', {}, 'Notes',
          h('input', { name: 'notes', placeholder: 'optional', style: 'width:180px' })),
        h('button', { type: 'submit' }, 'Record trade'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Record a trade'),
      h('p', { class: 'muted small' },
        'The engine caps trades per go-round and refuses the one that goes over.'),
      form,
    );
  }

  function tablePanel() {
    return h('section', { class: 'card' },
      h('h2', {}, 'Trades'),
      h('p', { class: 'muted small' }, `${rows.length} recorded`),
      rows.length === 0
        ? h('p', { class: 'muted small' }, 'No trades yet.')
        : h('table', { class: 'sheet' },
            h('thead', {}, h('tr', {},
              h('th', { class: 'num' }, '#'),
              h('th', {}, 'Go'),
              h('th', {}, 'From'),
              h('th', {}, 'To'),
              h('th', {}, 'Status'),
            )),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', { class: 'num' }, r.trade_number),
              h('td', {}, r.go_round_number),
              h('td', {}, pos(r.from_performance_number, r.from_position)),
              h('td', {}, pos(r.to_performance_number, r.to_position)),
              h('td', {}, statusPill(r.status)),
            ))),
          ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Trades'),
      h('p', { class: 'muted' }, 'Position and performance moves, capped per go-round.'),
      formPanel(),
      tablePanel(),
    ));
  }

  await load();
}
