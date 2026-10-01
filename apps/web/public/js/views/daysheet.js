/**
 * The day sheet.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE IS FOR PRINTING.
 * ---------------------------------------------------------------------------
 * The announcer reads it, the chute boss works from it, the gate man calls off
 * it. A rodeo can lose its network, its tablets and its power and still run a
 * performance if somebody printed the sheet — so the print stylesheet is not a
 * finishing touch, it is the point, and everything that is not the sheet is
 * marked `noprint`.
 *
 * The layout is monospaced and deliberately plain. It has to be read at arm's
 * length, under a floodlight, by somebody who is also watching a chute.
 */

import { api } from '../api.js';
import * as offline from '../offline.js';
import { engine, localSheet, nightState } from '../night.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';
import { deskPanel } from './desk.js';

const FLAG_LABEL = {
  turned_out: 'TURNED OUT',
  scratched: 'SCRATCHED',
  no_show: 'NO SHOW',
  reride_pending: 'RE-RIDE',
  medical_release: 'MEDICAL',
  vet_release: 'VET RELEASE',
  slack: 'SLACK',
};

/**
 * The sheet from the stored packet. If she has turned somebody out or traded
 * a run since it was downloaded, the engine re-renders it with that applied,
 * in the same text format; otherwise it is the packet's own text, unchanged.
 */
async function sheetFromPacket(rodeoId, perf) {
  const pk = await offline.packet(rodeoId);
  if (!pk) return null;
  const entry = pk.day_sheets.find((s) => s.performance_number === perf)
    ?? pk.day_sheets.find((s) => s.performance_number === null);
  const state = nightState(pk, await offline.queued(rodeoId));
  const local = localSheet(state, entry.performance_number);
  return {
    rodeo: pk.rodeo,
    sheet: local ?? entry.sheet,
    text: local ? engine.renderDaySheetText(local) : entry.text,
  };
}

export async function daySheetView(rodeoId, performance) {
  let rodeo;
  let fromPacket = null;
  try {
    rodeo = await api.rodeo(rodeoId);
  } catch (err) {
    if (!offline.isUnreachable(err)) throw err;
    fromPacket = await sheetFromPacket(rodeoId, performance ?? null);
    if (!fromPacket) throw new Error('No signal, and this rodeo was never downloaded onto this browser.');
    rodeo = fromPacket.rodeo;
  }
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Day sheet' },
  );
  showPrint(() => window.print());

  const perf = performance ?? (rodeo.performances[0]?.performance_number ?? null);
  if (!fromPacket) {
    try {
      fromPacket = { sheet: await api.daySheet(rodeoId, perf), text: null, live: true };
    } catch (err) {
      if (!offline.isUnreachable(err)) throw err;
      fromPacket = await sheetFromPacket(rodeoId, perf);
      if (!fromPacket) throw err;
    }
  } else if (perf !== (performance ?? null)) {
    fromPacket = await sheetFromPacket(rodeoId, perf);
  }
  const sheet = fromPacket.sheet;

  const picker = h('div', { class: 'actions noprint' },
    rodeo.performances.map((p) =>
      h('a', {
        class: 'row-link',
        href: `#/rodeo/${rodeoId}/daysheet/${p.performance_number}`,
        style: `padding:10px 16px${p.performance_number === perf ? ';border-color:var(--accent)' : ''}`,
      }, p.name ?? `Perf ${p.performance_number}`),
    ),
    h('a', { class: 'row-link', href: `#/rodeo/${rodeoId}/daysheet/all`, style: 'padding:10px 16px' },
      'Whole rodeo'),
    h('button', {
      class: 'ghost',
      onclick: async () => {
        try {
          // No signal: the packet's text — the same format the server prints.
          let text = fromPacket.text;
          if (fromPacket.live) {
            try {
              text = await api.daySheetText(rodeoId, perf);
            } catch (err) {
              // The wifi went after the page loaded: print the packet's copy.
              if (!offline.isUnreachable(err)) throw err;
              text = (await sheetFromPacket(rodeoId, perf))?.text;
              if (!text) throw err;
            }
          }
          const w = window.open('', '_blank');
          if (!w) return toast('Allow pop-ups to open the plain-text sheet.', true);
          // Plain text in a <pre> — what a cheap arena printer handles best.
          const pre = w.document.createElement('pre');
          pre.style.font = '12px/1.35 ui-monospace, Menlo, Consolas, monospace';
          pre.textContent = text;
          w.document.body.append(pre);
        } catch (e) {
          toast(e.message, true);
        }
      },
    }, 'Plain text'),
  );

  const sections = sheet.sections.map((section) => {
    const dragAfter = new Map(section.drags.map((d) => [d.after_position, d]));
    const rows = [];

    for (const run of section.runs) {
      rows.push(
        h('tr', { class: run.is_scratched ? 'scratched' : '' },
          h('td', { class: 'pos' }, run.is_scratched ? '—' : run.position),
          h('td', {}, run.back_number ?? ''),
          h('td', {}, run.contestant_name),
          h('td', {}, run.partner_name ?? ''),
          h('td', {},
            section.is_roughstock
              ? [run.stock_name, run.stock_brand ? `#${run.stock_brand}` : null]
                  .filter(Boolean).join(' ')
              : run.horse_name ?? ''),
          h('td', { class: 'flagcell' },
            // A release with no flag of its own (stock issue, weather) shows
            // its stored reason, as the printed sheet does.
            [...run.flags.map((f) => FLAG_LABEL[f] ?? f), engine.releaseNote({ release_type: null, ...run })]
              .filter(Boolean).join(' · ')),
        ),
      );
      const drag = dragAfter.get(run.position);
      if (drag && !run.is_scratched) {
        rows.push(
          h('tr', { class: 'drag' },
            h('td', { colspan: '6' }, drag.condensed ? 'drag (condensed)' : 'drag')),
        );
      }
    }

    return h('section', { class: 'card sheet' },
      h('h2', {},
        section.event_label,
        section.go_round > 1 ? ` — Round ${section.go_round}` : '',
        h('span', { class: 'muted small' }, `   ${section.live_count} up`),
      ),
      h('table', {},
        h('thead', {},
          h('tr', {},
            h('th', {}, '#'),
            h('th', {}, 'Back'),
            h('th', {}, 'Contestant'),
            h('th', {}, 'Partner'),
            h('th', {}, section.is_roughstock ? 'Stock' : 'Horse'),
            h('th', {}, 'Notes'),
          ),
        ),
        h('tbody', {}, rows),
      ),
    );
  });

  render(
    h('div', {},
      h('h1', {}, sheet.rodeo_name),
      h('p', { class: 'muted' },
        [sheet.performance_name, sheet.date, sheet.scheduled_start, sheet.venue,
         sheet.sanctioned_by.length ? `Approved: ${sheet.sanctioned_by.join(', ')}` : null,
        ].filter(Boolean).join('  ·  ')),

      sheet.personnel.length
        ? h('p', { class: 'small' },
            sheet.personnel.map((p) =>
              `${p.role}: ${p.name}${p.card_number ? ` (#${p.card_number})` : ''}${
                p.carded ? '' : ' — not carded'}`).join('   '))
        : null,

      deskPanel(rodeoId, { source: fromPacket.live ? 'server' : 'copy' }),
      picker,

      sections.length
        ? sections
        : h('div', { class: 'card' },
            h('p', { class: 'muted' },
              'Nothing drawn into this performance yet. Take entries and run the draw.')),

      h('p', { class: 'small muted' },
        `${sheet.footer}    Total runs: ${sheet.total_runs}`),
    ),
  );
}
