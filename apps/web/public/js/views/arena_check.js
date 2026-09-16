/**
 * Form K — Arena measurement / judges' check.
 *
 * The morning setup sheet. Box lengths, score line, barrier height, the barrel
 * pattern, cattle counts, and the humane note — measured and posted before the
 * first competition animal runs, so nothing about the setup is argued from
 * memory after a run.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

export async function arenaCheckView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Arena check' },
  );

  let sheet = null;

  async function load() {
    sheet = await api.arenaMeasurement(rodeoId).catch(() => null);
    draw();
  }

  function val(key) {
    return sheet && sheet[key] != null ? sheet[key] : '';
  }
  function checked(key) {
    return sheet && sheet[key] === true;
  }

  async function save(post) {
    const g = (name) => {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return undefined;
      if (el.type === 'checkbox') return el.checked;
      if (el.type === 'number') return el.value === '' ? null : Number(el.value);
      return el.value.trim() || null;
    };
    const body = {
      box_length_l: g('box_length_l'),
      box_length_r: g('box_length_r'),
      scoreline_length: g('scoreline_length'),
      barrier_height: g('barrier_height'),
      electric_eye: g('electric_eye'),
      even_cattle_marked: g('even_cattle_marked'),
      cloverleaf_measured: g('cloverleaf_measured'),
      pattern: g('pattern'),
      flagger_position: g('flagger_position'),
      backup_watches: g('backup_watches'),
      num_bareback: g('num_bareback'),
      num_saddle_bronc: g('num_saddle_bronc'),
      num_bull: g('num_bull'),
      timed_cattle_count: g('timed_cattle_count'),
      fresh_used_note: g('fresh_used_note'),
      humane_issues: g('humane_issues'),
      notes: g('notes'),
      posted_with_draw: post ? true : (sheet?.posted_with_draw ?? false),
    };
    try {
      await api.saveArenaMeasurement(rodeoId, body);
      toast(post ? 'Posted with the draw.' : 'Saved.');
      await load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function textField(label, name, hint) {
    return h('label', {}, label,
      hint ? h('span', { class: 'hint' }, hint) : null,
      h('input', { name, value: val(name), style: 'width:120px' }));
  }
  function numField(label, name) {
    return h('label', {}, label,
      h('input', { name, type: 'number', min: '0', value: val(name), style: 'width:90px' }));
  }
  function checkField(label, name) {
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', name, checked: checked(name) ? true : null }), ' ', label);
  }

  function draw() {
    const posted = sheet?.posted_with_draw;
    render(h('div', {},
      h('h1', {}, 'Arena check'),
      h('p', { class: 'muted' },
        posted
          ? 'Posted with the draw. Re-save to correct, then post again.'
          : 'Measure and post before the first competition animal.'),

      h('section', { class: 'card' },
        h('h2', {}, 'Timed-event setup'),
        h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
          textField('Box length L', 'box_length_l'),
          textField('Box length R', 'box_length_r'),
          textField('Score line', 'scoreline_length'),
          textField('Barrier height', 'barrier_height'),
          numField('Timed cattle', 'timed_cattle_count'),
        ),
        h('div', { class: 'actions', style: 'gap:16px;flex-wrap:wrap;margin-top:10px' },
          checkField('Electric eye', 'electric_eye'),
          checkField('Even cattle marked', 'even_cattle_marked'),
          checkField('Backup watches ready', 'backup_watches'),
        ),
      ),

      h('section', { class: 'card' },
        h('h2', {}, 'Barrels'),
        h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
          checkField('Cloverleaf measured', 'cloverleaf_measured'),
          textField('Pattern', 'pattern'),
          textField('Flagger position', 'flagger_position'),
        ),
      ),

      h('section', { class: 'card' },
        h('h2', {}, 'Rough-stock counts'),
        h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap;align-items:end' },
          numField('Bareback', 'num_bareback'),
          numField('Saddle bronc', 'num_saddle_bronc'),
          numField('Bull', 'num_bull'),
        ),
        h('label', { style: 'display:block;margin-top:8px' }, 'Fresh / used note',
          h('input', { name: 'fresh_used_note', value: val('fresh_used_note'), style: 'width:100%' })),
      ),

      h('section', { class: 'card' },
        h('h2', {}, 'Humane & notes'),
        h('label', { style: 'display:block' }, 'Humane issues',
          h('input', { name: 'humane_issues', value: val('humane_issues'), style: 'width:100%' })),
        h('label', { style: 'display:block;margin-top:8px' }, 'Notes',
          h('input', { name: 'notes', value: val('notes'), style: 'width:100%' })),
      ),

      h('div', { class: 'actions', style: 'gap:10px' },
        h('button', { class: 'ghost', onclick: () => save(false) }, 'Save'),
        h('button', { onclick: () => save(true) }, 'Post with draw'),
        posted ? h('span', { class: 'pill ok' }, 'Posted') : null,
      ),
    ));
  }

  await load();
}
