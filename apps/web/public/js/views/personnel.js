/**
 * Form I — Personnel sign-in sheet.
 *
 * The crew roster for the day: who is in the arena and what they are running.
 * A rodeo cannot be sanctioned until the required chairs are filled, so this
 * sheet drives a readiness indicator the association upload leans on.
 *
 * Keyboard: Enter in the sign-in form records the person and returns the cursor
 * to the printed-name field for the next crew member.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

// Chairs that must be filled before the rodeo is considered crewed. These gate
// the readiness pill; extra roles beyond this list are welcome but not required.
const ROLES = [
  { value: 'announcer', label: 'Announcer', required: true },
  { value: 'timer_1', label: 'Timer 1', required: true },
  { value: 'timer_2', label: 'Timer 2', required: true },
  { value: 'barrier_judge', label: 'Barrier judge', required: true },
  { value: 'field_judge_1', label: 'Field judge 1', required: true },
  { value: 'field_judge_2', label: 'Field judge 2', required: true },
  { value: 'pickup_man_1', label: 'Pickup man 1', required: true },
  { value: 'pickup_man_2', label: 'Pickup man 2', required: true },
  { value: 'bullfighter', label: 'Bullfighter', required: true },
  { value: 'barrelman', label: 'Barrelman', required: false },
  { value: 'flankman', label: 'Flankman', required: false },
  { value: 'stock_contractor', label: 'Stock contractor', required: true },
  { value: 'arena_director', label: 'Arena director', required: true },
];

const SIGN_METHODS = [
  { value: 'paper', label: 'Paper' },
  { value: 'typed', label: 'Typed' },
  { value: 'imported', label: 'Imported' },
];

function roleLabel(value) {
  const r = ROLES.find((x) => x.value === value);
  return r ? r.label : value;
}

export async function personnelView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Personnel sign-in' },
  );

  let items = [];

  async function load() {
    const res = await api.personnelSignins(rodeoId);
    items = Array.isArray(res) ? res : (res.items ?? res.data ?? []);
    draw();
  }

  async function record(form) {
    const f = new FormData(form);
    const printed = (f.get('printed_name') || '').trim();
    if (!printed) return toast('A printed name is required.', true);
    const body = {
      role: f.get('role') || 'announcer',
      printed_name: printed,
      card_or_phone: (f.get('card_or_phone') || '').trim() || null,
      signature_method: f.get('signature_method') || 'paper',
      notes: (f.get('notes') || '').trim() || null,
    };
    try {
      await api.addPersonnelSignin(rodeoId, body);
      toast(`Signed in ${printed}.`);
      form.reset();
      await load();
      const first = document.querySelector('input[name="printed_name"]');
      if (first) first.focus();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function remove(id, name) {
    if (!window.confirm(`Remove ${name} from the sheet?`)) return;
    try {
      await api.removePersonnelSignin(rodeoId, id);
      toast('Removed.');
      await load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function signinForm() {
    const form = h('form', {
      onsubmit: (e) => { e.preventDefault(); record(e.target); },
    },
      h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
        h('label', {}, 'Role',
          h('select', { name: 'role', style: 'width:170px' },
            ROLES.map((r) => h('option', { value: r.value },
              r.required ? `${r.label} *` : r.label)))),
        h('label', {}, 'Printed name',
          h('input', { name: 'printed_name', placeholder: 'Full name', style: 'width:200px', autofocus: true })),
        h('label', {}, 'Card / phone',
          h('input', { name: 'card_or_phone', placeholder: 'optional', style: 'width:150px' })),
        h('label', {}, 'Signature',
          h('select', { name: 'signature_method' },
            SIGN_METHODS.map((m) => h('option', { value: m.value }, m.label)))),
        h('button', { type: 'submit' }, 'Sign in'),
      ),
      h('label', { style: 'display:block;margin-top:8px' }, 'Note',
        h('input', { name: 'notes', placeholder: 'optional', style: 'width:100%' })),
    );
    return h('section', { class: 'card' },
      h('h2', {}, 'Sign in crew'),
      h('p', { class: 'muted small' },
        'Enter records the person and jumps back to the name for the next in line. * marks a required chair.'),
      form,
    );
  }

  function readiness() {
    const filled = new Set(items.map((r) => r.role));
    const required = ROLES.filter((r) => r.required);
    const missing = required.filter((r) => !filled.has(r.value));
    const complete = missing.length === 0;
    return h('section', { class: 'card' },
      h('h2', {}, 'Required chairs'),
      h('p', {},
        complete
          ? h('span', { class: 'pill ok' }, 'All required chairs filled')
          : h('span', { class: 'pill stop' }, `${missing.length} chair(s) open`)),
      complete
        ? null
        : h('ul', { class: 'muted small' },
          missing.map((r) => h('li', {}, r.label))),
    );
  }

  function sheet() {
    if (!items.length) {
      return h('section', { class: 'card' }, h('p', { class: 'muted' }, 'No one signed in yet.'));
    }
    return h('section', { class: 'card' },
      h('h2', {}, 'On the sheet'),
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Role'), h('th', {}, 'Name'), h('th', {}, 'Card / phone'),
          h('th', {}, 'Signed'), h('th', {}, 'Method'), h('th', {}, 'Note'), h('th', {}, ''))),
        h('tbody', {}, items.map((r) => h('tr', {},
          h('td', {}, roleLabel(r.role)),
          h('td', {}, r.printed_name),
          h('td', {}, r.card_or_phone ?? ''),
          h('td', {}, r.signed_at ? new Date(r.signed_at).toLocaleTimeString() : ''),
          h('td', {}, r.signature_method ?? 'paper'),
          h('td', {}, r.notes ?? ''),
          h('td', {}, h('button', {
            class: 'ghost', type: 'button',
            onclick: () => remove(r.id, r.printed_name),
          }, 'Remove')),
        ))),
      ),
    );
  }

  function draw() {
    render(h('div', {},
      h('h1', {}, 'Personnel sign-in'),
      h('p', { class: 'muted' }, 'The crew present today and whether every required chair is filled.'),
      readiness(),
      signinForm(),
      sheet(),
    ));
  }

  await load();
}
