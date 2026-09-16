/**
 * Close-out cover sheet and the association packet.
 *
 * Two halves of the same job at the end of a rodeo. The money half adds up what
 * came in and what went out and tells the secretary what should be in the
 * deposit — and whether it ties out to the cent before the bag leaves. The
 * packet half is the checklist the association wants filed, with the deadline
 * the engine works out from the last performance.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

const MONEY_IN = [
  ['fees_collected', 'Entry fees collected'],
  ['fines_collected', 'Fines collected'],
  ['stalls_camp_gate', 'Stalls / camp / gate'],
];
const MONEY_OUT = [
  ['prize_paid', 'Prize money paid'],
  ['assn_cut_sent', 'Association cut sent'],
  ['unclaimed_sent', 'Unclaimed sent'],
];

function dollarsToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export async function remittanceView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Close-out & packet' },
  );

  let items = [];
  let reconciliation = null;
  let packet = null; // { upload, required_items, check } or null

  async function load() {
    const [remit, pkt] = await Promise.all([
      api.remittance(rodeoId),
      api.associationUpload(rodeoId).catch(() => null),
    ]);
    items = remit.items ?? [];
    reconciliation = remit.reconciliation ?? null;
    packet = pkt;
    draw();
  }

  function amountFor(category) {
    const row = items.find((i) => i.category === category);
    return row ? row.amount_cents : 0;
  }

  async function saveLine(category, dollars) {
    try {
      await api.setRemittance(rodeoId, category, { amount_cents: dollarsToCents(dollars) });
      toast('Saved.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function saveDeposit(dollars, slip) {
    try {
      await api.setRemittance(rodeoId, 'deposit', {
        amount_cents: dollarsToCents(dollars),
        deposit_slip: slip || null,
      });
      toast('Deposit recorded.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function lineRow([category, label]) {
    const input = h('input', {
      type: 'number', min: '0', step: '0.01',
      value: (amountFor(category) / 100).toFixed(2),
      style: 'width:130px',
    });
    return h('tr', {},
      h('td', {}, label),
      h('td', { class: 'num' }, input),
      h('td', {}, h('button', { class: 'small', onclick: () => saveLine(category, input.value) }, 'Save')),
    );
  }

  function moneyPanel() {
    const depositRow = items.find((i) => i.category === 'deposit');
    const depInput = h('input', {
      type: 'number', min: '0', step: '0.01',
      value: depositRow ? (depositRow.amount_cents / 100).toFixed(2) : '',
      placeholder: '0.00', style: 'width:130px',
    });
    const slipInput = h('input', {
      value: depositRow?.deposit_slip ?? '', placeholder: 'slip #', style: 'width:130px',
    });

    return h('section', { class: 'card' },
      h('h2', {}, 'Money'),
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Line'), h('th', { class: 'num' }, 'Amount ($)'), h('th', {}, ''))),
        h('tbody', {},
          h('tr', {}, h('td', { colspan: '3', class: 'muted small' }, 'Money in')),
          MONEY_IN.map(lineRow),
          h('tr', {}, h('td', { colspan: '3', class: 'muted small' }, 'Money out')),
          MONEY_OUT.map(lineRow),
        ),
      ),
      reconciliation ? reconcilePanel() : null,
      h('div', { style: 'margin-top:12px' },
        h('h3', {}, 'Deposit'),
        h('div', { class: 'actions', style: 'gap:12px;align-items:end;flex-wrap:wrap' },
          h('label', {}, 'Counted ($)', depInput),
          h('label', {}, 'Slip', slipInput),
          h('button', { class: 'small', onclick: () => saveDeposit(depInput.value, slipInput.value) },
            'Record deposit'),
        ),
      ),
    );
  }

  function reconcilePanel() {
    const r = reconciliation;
    return h('table', { class: 'ledger', style: 'margin-top:12px' }, h('tbody', {},
      h('tr', {}, h('td', {}, 'Money in'), h('td', { class: 'num' }, money(r.money_in_cents))),
      h('tr', {}, h('td', {}, 'Money out'), h('td', { class: 'num' }, money(r.money_out_cents))),
      h('tr', {}, h('td', {}, h('strong', {}, 'Expected deposit')),
        h('td', { class: 'num' }, h('strong', {}, money(r.expected_deposit_cents)))),
      h('tr', {}, h('td', {}, 'Over / short'),
        h('td', { class: 'num' },
          r.over_short_cents == null
            ? h('span', { class: 'muted' }, 'no deposit yet')
            : r.over_short_cents === 0
              ? h('span', { class: 'pill ok' }, 'Balanced')
              : h('span', { class: 'pill stop' }, money(r.over_short_cents)))),
    ));
  }

  async function startPacket(form) {
    const data = new FormData(form);
    const body = {
      association_code: (data.get('association_code') || '').trim(),
      last_performance_date: data.get('last_performance_date') || undefined,
      timezone: (data.get('timezone') || '').trim() || undefined,
    };
    if (!body.association_code) return toast('An association code is required.', true);
    try {
      await api.startAssociationUpload(rodeoId, body);
      toast('Packet started.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function toggleItem(code, present) {
    const current = { ...(packet.upload.packet_items ?? {}) };
    current[code] = present;
    try {
      await api.updateAssociationUpload(rodeoId, packet.upload.id, { packet_items: current });
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function markSubmitted() {
    const ref = prompt('Submission reference (confirmation number, tracking):') ?? '';
    try {
      await api.updateAssociationUpload(rodeoId, packet.upload.id, {
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        submission_reference: ref.trim() || null,
      });
      toast('Marked submitted.');
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function packetStartPanel() {
    const firstAssoc = (rodeo.sanctioned_by ?? [])[0] ?? '';
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); startPacket(e.target); } },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Association',
          h('input', { name: 'association_code', value: firstAssoc, placeholder: 'PRCA, WPRA, IPRA…', style: 'width:150px' })),
        h('label', {}, 'Last perf date',
          h('input', { name: 'last_performance_date', type: 'date', value: rodeo.end_date ?? '' })),
        h('label', {}, 'Timezone',
          h('input', { name: 'timezone', placeholder: 'America/Denver', style: 'width:170px' })),
        h('button', { type: 'submit' }, 'Start packet'),
      ),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Association packet'),
      h('p', { class: 'muted small' },
        'Pick the association to load its checklist and work out the filing deadline.'),
      form,
    );
  }

  function packetChecklistPanel() {
    const u = packet.upload;
    const c = packet.check;
    const have = u.packet_items ?? {};
    return h('section', { class: 'card' },
      h('h2', {}, `Association packet — ${u.association_code}`),
      h('p', { class: 'muted small' },
        [c.ready ? 'Ready to file' : `${c.missing.length} item(s) missing`,
         u.deadline_at ? `due ${new Date(u.deadline_at).toLocaleString()}` : null,
         u.status ? `status: ${u.status}` : null,
        ].filter(Boolean).join('  ·  ')),
      c.note ? h('p', { class: 'hint' }, c.note) : null,
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Have'), h('th', {}, 'Item'))),
        h('tbody', {}, c.items.map((it) => h('tr', {},
          h('td', {}, h('input', {
            type: 'checkbox',
            checked: have[it.code] === true ? true : null,
            onchange: (e) => toggleItem(it.code, e.target.checked),
          })),
          h('td', {}, it.label),
        ))),
      ),
      h('div', { class: 'actions', style: 'gap:8px;margin-top:10px' },
        u.status === 'submitted'
          ? h('span', { class: 'pill ok' }, 'Submitted')
          : h('button', { class: 'small', disabled: !c.ready ? true : null, onclick: markSubmitted },
              'Mark submitted'),
      ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Close-out & packet'),
      h('p', { class: 'muted' }, 'The money that ties out, and the packet that gets filed.'),
      moneyPanel(),
      packet ? packetChecklistPanel() : packetStartPanel(),
    ));
  }

  await load();
}
