/**
 * Form H — Check-in / fee receipt desk.
 *
 * The arrival desk. Confirm a contestant is entered, take what they owe, hand
 * back a receipt, and watch the running total climb — that total is what the
 * close-out reconciles against, so it is on screen the whole time.
 *
 * Keyboard: Enter in the last field of the check-in form records it and returns
 * the cursor to the name field for the next contestant in the queue.
 */

import { api } from '../api.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';

function dollarsToCents(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'card', label: 'Card' },
  { value: 'account', label: 'On account' },
  { value: 'comp', label: 'Comp' },
];

export async function checkInView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Check-in & receipts' },
  );

  let data = { items: [], total_collected_cents: 0, total_due_cents: 0 };

  async function load() {
    data = await api.checkIns(rodeoId);
    draw();
  }

  async function record(form) {
    const f = new FormData(form);
    const name = (f.get('contestant_name') || '').trim();
    if (!name) return toast('A name is required.', true);
    const body = {
      contestant_name: name,
      member_number: (f.get('member_number') || '').trim() || null,
      fees_due_cents: dollarsToCents(f.get('fees_due')),
      fees_paid_cents: dollarsToCents(f.get('fees_paid')),
      payment_method: f.get('payment_method') || 'cash',
      receipt_number: (f.get('receipt_number') || '').trim() || null,
      check_number: (f.get('check_number') || '').trim() || null,
      notes: (f.get('notes') || '').trim() || null,
    };
    try {
      await api.createCheckIn(rodeoId, body);
      toast(`Checked in ${name}.`);
      await load();
      const first = document.querySelector('input[name="contestant_name"]');
      if (first) first.focus();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function checkinForm() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); record(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Contestant',
          h('input', { name: 'contestant_name', placeholder: 'Name', style: 'width:200px', autofocus: true })),
        h('label', {}, 'Member #',
          h('input', { name: 'member_number', placeholder: 'card / member', style: 'width:120px' })),
        h('label', {}, 'Fees due ($)',
          h('input', { name: 'fees_due', type: 'number', min: '0', step: '0.01', style: 'width:110px' })),
        h('label', {}, 'Paid ($)',
          h('input', { name: 'fees_paid', type: 'number', min: '0', step: '0.01', style: 'width:110px' })),
        h('label', {}, 'Method',
          h('select', { name: 'payment_method' },
            METHODS.map((m) => h('option', { value: m.value }, m.label)))),
        h('label', {}, 'Receipt #',
          h('input', { name: 'receipt_number', style: 'width:100px' })),
        h('label', {}, 'Check #',
          h('input', { name: 'check_number', style: 'width:100px' })),
        h('button', { type: 'submit' }, 'Check in'),
      ),
      h('label', { style: 'display:block;margin-top:8px' }, 'Note',
        h('input', { name: 'notes', placeholder: 'optional', style: 'width:100%' })),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'New check-in'),
      h('p', { class: 'muted small' },
        'Enter records the receipt and jumps back to the name for the next in line.'),
      form,
    );
  }

  function totals() {
    const balance = data.total_due_cents - data.total_collected_cents;
    return h('section', { class: 'card' },
      h('table', { class: 'ledger' }, h('tbody', {},
        h('tr', {}, h('td', {}, 'Fees due'), h('td', { class: 'num' }, money(data.total_due_cents))),
        h('tr', {}, h('td', {}, h('strong', {}, 'Collected')),
          h('td', { class: 'num' }, h('strong', {}, money(data.total_collected_cents)))),
        h('tr', {}, h('td', {}, 'Outstanding'),
          h('td', { class: 'num' },
            balance === 0
              ? h('span', { class: 'pill ok' }, 'All in')
              : h('span', { class: 'pill stop' }, money(balance)))),
      )),
    );
  }

  function log() {
    if (!data.items.length) {
      return h('section', { class: 'card' }, h('p', { class: 'muted' }, 'No check-ins yet.'));
    }
    return h('section', { class: 'card' },
      h('h2', {}, 'Desk log'),
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Time'), h('th', {}, 'Contestant'), h('th', {}, 'Member'),
          h('th', { class: 'num' }, 'Due'), h('th', { class: 'num' }, 'Paid'),
          h('th', {}, 'Method'), h('th', {}, 'Receipt'), h('th', {}, 'Note'))),
        h('tbody', {}, data.items.map((r) => h('tr', {},
          h('td', {}, new Date(r.checked_in_at).toLocaleTimeString()),
          h('td', {}, r.contestant_name),
          h('td', {}, r.member_number ?? ''),
          h('td', { class: 'num' }, money(r.fees_due_cents)),
          h('td', { class: 'num' }, money(r.fees_paid_cents)),
          h('td', {}, r.payment_method),
          h('td', {}, r.receipt_number ?? (r.check_number ? `chk ${r.check_number}` : '')),
          h('td', {}, r.notes ?? ''),
        ))),
      ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Check-in & receipts'),
      h('p', { class: 'muted' }, 'Confirm entries, take fees, and keep the running total.'),
      checkinForm(),
      totals(),
      log(),
    ));
  }

  await load();
}
