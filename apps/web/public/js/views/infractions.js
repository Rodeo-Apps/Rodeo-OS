/**
 * Infractions — barrier, field, conduct, stock.
 *
 * An infraction is recorded, then verified (a barrier call needs the barrier
 * judge), then posted. Posting locks the row: once it is on the record it is
 * corrected by a new offsetting entry, never edited, so the fine a contestant
 * paid always matches the sheet.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const TYPE_LABEL = {
  barrier: 'Barrier',
  field: 'Field',
  conduct: 'Conduct',
  stock: 'Stock',
  other: 'Other',
};

function dollarsToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export async function infractionsView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Infractions' },
  );

  let rows = [];

  async function load() {
    rows = await api.infractions(rodeoId);
    draw();
  }

  async function add(form) {
    const data = new FormData(form);
    const body = {
      infraction_type: data.get('infraction_type'),
      rule_code: (data.get('rule_code') || '').trim() || undefined,
      member_number: (data.get('member_number') || '').trim() || undefined,
      fine_cents: data.get('fine') ? dollarsToCents(data.get('fine')) : undefined,
      verified_by_barrier_judge: data.get('verified_by_barrier_judge') === 'on',
      notes: (data.get('notes') || '').trim() || undefined,
    };
    try {
      await api.logInfraction(rodeoId, body);
      toast('Recorded.');
      form.reset();
      load();
    } catch (err) {
      const detail = err.details?.issues?.map((i) => i.message).join(' ');
      toast(detail ? `Rejected: ${detail}` : err.message, true);
    }
  }

  async function verify(r) {
    try {
      await api.verifyInfraction(rodeoId, r.id);
      toast('Verified.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function post(r) {
    if (!confirm('Post this infraction? Once posted it cannot be edited, only offset.')) return;
    try {
      await api.postInfraction(rodeoId, r.id);
      toast('Posted. It is on the record now.');
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
          h('select', { name: 'infraction_type' },
            Object.entries(TYPE_LABEL).map(([v, l]) => h('option', { value: v }, l)))),
        h('label', {}, 'Rule code',
          h('input', { name: 'rule_code', placeholder: 'e.g. R3.2', style: 'width:120px' })),
        h('label', {}, 'Member #',
          h('input', { name: 'member_number', placeholder: 'e.g. 12345', style: 'width:120px' })),
        h('label', {}, 'Fine ($)',
          h('input', { name: 'fine', type: 'number', min: '0', step: '0.01', style: 'width:110px' })),
        h('label', { style: 'display:flex;gap:6px;align-items:center' },
          h('input', { name: 'verified_by_barrier_judge', type: 'checkbox' }),
          'Barrier judge verified'),
      ),
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end;margin-top:10px' },
        h('label', {}, 'Notes',
          h('input', { name: 'notes', placeholder: 'optional', style: 'width:260px' })),
        h('button', { type: 'submit' }, 'Record infraction'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Record an infraction'),
      h('p', { class: 'muted small' },
        'A barrier infraction needs the barrier judge before it can post.'),
      form,
    );
  }

  function tablePanel() {
    const posted = rows.filter((r) => r.posted_at);
    const total = rows.reduce((s, r) => s + (r.fine_cents || 0), 0);
    return h('section', { class: 'card' },
      h('h2', {}, 'Infractions'),
      h('p', { class: 'muted small' },
        `${rows.length} recorded · ${posted.length} posted · ${money(total)} in fines`),
      rows.length === 0
        ? h('p', { class: 'muted small' }, 'Nothing recorded yet.')
        : h('table', { class: 'sheet' },
            h('thead', {}, h('tr', {},
              h('th', {}, 'Member'),
              h('th', {}, 'Type'),
              h('th', {}, 'Rule'),
              h('th', { class: 'num' }, 'Fine'),
              h('th', {}, 'State'),
              h('th', {}, ''),
            )),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', {}, r.member_number || '—'),
              h('td', {}, TYPE_LABEL[r.infraction_type] ?? r.infraction_type),
              h('td', {}, r.rule_code || '—'),
              h('td', { class: 'num' }, money(r.fine_cents)),
              h('td', {}, r.posted_at
                ? h('span', { class: 'pill ok' }, 'Posted')
                : r.verified_by_barrier_judge
                  ? h('span', { class: 'pill warn' }, 'Verified')
                  : h('span', { class: 'pill' }, 'Recorded')),
              h('td', {}, r.posted_at
                ? h('span', { class: 'muted small' }, 'Locked')
                : h('div', { class: 'actions', style: 'gap:6px' },
                    r.verified_by_barrier_judge
                      ? null
                      : h('button', { class: 'small ghost', onclick: () => verify(r) }, 'Verify'),
                    h('button', { class: 'small', onclick: () => post(r) }, 'Post'))),
            ))),
          ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Infractions'),
      h('p', { class: 'muted' }, 'Recorded, verified, then posted to the record.'),
      formPanel(),
      tablePanel(),
    ));
  }

  await load();
}
