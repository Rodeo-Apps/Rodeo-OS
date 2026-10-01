/**
 * Payouts — review, then disburse.
 *
 * ---------------------------------------------------------------------------
 * TWO STEPS, ALWAYS, AND NEVER ONE
 * ---------------------------------------------------------------------------
 * Calculating a payout and paying it out are separate actions with a human
 * looking at the numbers in between. A secretary reads the placings against
 * the judge's sheet before anybody's money moves, because a wrong time gets
 * caught here or it does not get caught at all.
 *
 * The API refuses to return a calculation that does not reconcile, so anything
 * shown on this screen adds up to the cent by the time it arrives. What the
 * screen adds is the human check on whether the right people are in it.
 */

import { api } from '../api.js';
import * as offline from '../offline.js';
import {
  envelopes, eventBlockers, eventPayout, nightState, renderEnvelopeText, renderSlipsText, slips,
} from '../night.js';
import { crumbs, h, money, render, showPrint, toast } from '../ui.js';
import { deskPanel, loadNight, notOnServer } from './desk.js';

/** Events whose envelopes were paid in cash on the server from this screen. */
const paidCashHere = new Set();

/** Open fixed-width text in a window of its own — what a cheap arena printer handles best. */
function printText(text) {
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to open the payoff list.', true);
  const pre = w.document.createElement('pre');
  pre.style.font = '12px/1.35 ui-monospace, Menlo, Consolas, monospace';
  pre.textContent = text;
  w.document.body.append(pre);
  w.print?.();
}

export async function payoutsView(rodeoId) {
  showPrint(() => window.print());
  const night = await loadNight(rodeoId);
  const state = nightState(night.packet, night.queue);
  const rodeo = night.packet.rodeo;

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Payouts' },
  );

  const [sidepots] = night.source === 'server'
    ? await Promise.all([api.sidepots(rodeoId).catch(() => [])])
    : [[]];

  /**
   * The envelopes for one event, figured on this laptop by the engine from
   * the runs it holds. Paying them records the cash; the server recalculates
   * when it receives it and refuses an envelope total that is not its own.
   */
  function envelopeBox(ev) {
    const box = h('div', { class: 'card', style: 'margin-top:12px' });
    const label = ev.label ?? ev.event_type;
    const payout = eventPayout(state, ev.id);
    const blockers = eventBlockers(state, ev.id);
    const official = state.finalized.get(ev.id);
    const paid = state.paid.get(ev.id);

    if (!payout.ok) {
      box.replaceChildren(h('h3', {}, 'Envelopes'), h('p', { class: 'muted' }, payout.reason));
      return box;
    }
    const env = envelopes(state, payout.result);
    const why = blockers.length
      ? `${blockers.length} run(s) where the judge card and the timer sheet do not agree.`
      : !official
        ? 'This event is not official yet. Make it official on the scoring screen first.'
        : null;

    box.replaceChildren(
      h('h3', {}, 'Envelopes',
        h('span', { class: 'muted small' }, `   net purse ${money(payout.result.net_purse_cents)}`),
        paid ? [' ', h('span', { class: 'pill ok' }, 'paid in cash'), ' ', notOnServer(paid) ?? ''] : ''),
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Name'), h('th', {}, 'Place'),
          h('th', { style: 'text-align:right' }, 'Amount'), h('th', {}, ''))),
        h('tbody', {}, env.lines.map((l) =>
          h('tr', {},
            h('td', {}, l.name),
            h('td', {}, l.place ? `${l.place}${l.go_round ? ` · R${l.go_round}` : ''}` : l.type.replace(/_/g, ' ')),
            h('td', { style: 'text-align:right' }, money(l.amount_cents)),
            h('td', {}, 'cash')))),
      ),
      h('p', { class: 'small' }, h('strong', {}, `${money(env.total_cents)} in envelopes`),
        payout.result.unpaid_cents ? `  ·  ${money(payout.result.unpaid_cents)} unpaid` : '',
        payout.result.escrow_cents ? `  ·  ${money(payout.result.escrow_cents)} in escrow` : ''),
      why ? h('div', { class: 'issue warning' }, h('div', {}, why)) : null,
      h('div', { class: 'actions noprint' },
        h('button', {
          class: 'ghost',
          onclick: () => printText(renderEnvelopeText(rodeo.name, label, env,
            night.source === 'copy' ? 'Figured on the offline desk; the server recalculates when the link is back.' : null)),
        }, 'Print payoff list'),
        h('button', {
          class: 'ghost',
          onclick: () => printText(renderSlipsText(rodeo.name, label, slips(env), {
            paidCash: paidCashHere.has(ev.id),
            onServer: paid?.on_server === true,
          })),
        }, 'Print slips'),
        paid
          ? null
          : h('button', {
              onclick: async () => {
                if (why) return toast(why, true);
                if (!confirm(`Put ${money(env.total_cents)} in ${env.lines.length} envelope(s) for ${label}? `
                  + 'You have compared the judge cards and the timer sheets.')) return;
                const claim = {
                  envelope_total_cents: env.total_cents,
                  lines: env.lines.map((l) => ({ contestant_id: l.contestant_id, amount_cents: l.amount_cents })),
                };
                try {
                  const out = await offline.record(rodeoId, {
                    live: () => api.payCash(rodeoId, ev.id, claim),
                    change: {
                      entity_type: 'cash',
                      data: { rodeo_id: rodeoId, rodeo_event_id: ev.id, confirm: true, payment_method: 'cash', ...claim },
                      label: `Cash envelopes — ${label}, ${money(env.total_cents)}`,
                    },
                  });
                  if (out.where === 'server') paidCashHere.add(ev.id);
                  toast(out.where === 'server'
                    ? `Paid. ${money(out.result.total_cents)} settled as cash on the ledger.`
                    : `Envelopes recorded ON THIS LAPTOP ONLY — the server recalculates and settles when the link is back.`,
                  out.where !== 'server');
                } catch (err) {
                  toast(err.code === 'ENVELOPE_MISMATCH' ? `Not paid: ${err.message}` : err.message, true);
                }
                payoutsView(rodeoId).catch((e) => toast(e.message, true));
              },
            }, `Paid in cash — ${money(env.total_cents)}`),
      ),
    );
    return box;
  }

  const container = h('div');

  function lineRows(payouts) {
    return payouts.map((p) =>
      h('tr', {},
        h('td', { class: 'pos' }, p.place ?? ''),
        h('td', {}, p.contestant_name ?? h('span', { class: 'muted' }, p.description ?? p.type)),
        h('td', {}, p.type.replace(/_/g, ' ')),
        h('td', { style: 'text-align:right' }, money(p.amount_cents)),
      ),
    );
  }

  function summary(result) {
    return h('table', { class: 'ledger' },
      h('tbody', {},
        h('tr', {}, h('td', {}, 'Gross purse'), h('td', {}, money(result.gross_purse_cents))),
        h('tr', { class: 'sub' }, h('td', {}, 'Fees'), h('td', {}, `−${money(result.fees.total_cents)}`)),
        h('tr', { class: 'total' }, h('td', {}, 'Net purse'), h('td', {}, money(result.net_purse_cents))),
      ),
    );
  }

  async function calcEvent(ev, target) {
    target.replaceChildren(h('div', { class: 'muted' }, 'Calculating…'));
    try {
      const result = await api.calculatePayouts(rodeoId, ev.id);
      target.replaceChildren(
        summary(result),
        h('table', { class: 'sheet', style: 'margin-top:12px' },
          h('thead', {}, h('tr', {},
            h('th', {}, '#'), h('th', {}, 'Who'), h('th', {}, 'Line'),
            h('th', { style: 'text-align:right' }, 'Amount'))),
          h('tbody', {}, lineRows(result.payouts)),
        ),
        result.unpaid_cents
          ? h('p', { class: 'muted small' },
              `${money(result.unpaid_cents)} unpaid — not enough qualified runs to fill the ladder.`)
          : null,
        result.escrow_cents
          ? h('p', { class: 'muted small' }, `${money(result.escrow_cents)} held in escrow.`)
          : null,
        result.issues?.length
          ? h('div', {}, result.issues.map((i) =>
              h('div', { class: `issue ${i.severity === 'error' ? 'blocker' : 'warning'}` },
                h('div', { class: 'where' }, i.code),
                h('div', {}, i.message))))
          : null,
        h('div', { class: 'actions noprint' },
          h('button', {
            onclick: async () => {
              if (!confirm(`Disburse ${money(result.net_purse_cents)} for ${ev.label ?? ev.event_type}? This writes to the ledger.`)) return;
              try {
                await api.disburse(rodeoId, ev.id);
                toast('Disbursed. The ledger has it.');
              } catch (err) { toast(err.message, true); }
            },
          }, `Disburse ${money(result.net_purse_cents)}`),
        ),
      );
    } catch (err) {
      target.replaceChildren(
        h('div', { class: 'issue blocker' },
          h('div', { class: 'where' }, err.code ?? 'Error'),
          h('div', {}, err.message),
          err.details?.issues
            ? h('div', { class: 'fix' },
                err.details.issues.map((i) => i.message).join(' · '))
            : null),
      );
    }
  }

  const eventCards = rodeo.events.map((ev) => {
    const target = h('div', {},
      h('p', { class: 'muted' }, 'Not calculated yet.'));
    return h('section', { class: 'card' },
      h('h2', {}, ev.label ?? ev.event_type,
        h('span', { class: 'muted small' }, `   ${ev.entries} entered · ${ev.scored} scored`)),
      night.source === 'server'
        ? h('div', { class: 'actions noprint' },
            h('button', { class: 'ghost', onclick: () => calcEvent(ev, target) }, 'Calculate'))
        : null,
      night.source === 'server' ? target : null,
      envelopeBox(night.packet.events.find((e) => e.id === ev.id) ?? ev),
    );
  });

  const sidepotCards = sidepots.map((sp) => {
    const target = h('div', {}, h('p', { class: 'muted' }, 'Not calculated yet.'));
    return h('section', { class: 'card' },
      h('h3', {}, sp.name,
        h('span', { class: 'muted small' },
          `   ${sp.event_label} · ${sp.buyers} in · ${money(Number(sp.collected_cents))} collected`)),
      h('div', { class: 'actions noprint' },
        h('button', {
          class: 'ghost',
          onclick: async () => {
            target.replaceChildren(h('div', { class: 'muted' }, 'Calculating…'));
            try {
              const r = await api.calculateSidepot(rodeoId, sp.id);
              target.replaceChildren(
                h('p', { class: 'muted small' },
                  `${r.buyers} paid buy-ins`
                  + (r.unpaid_buyers ? ` · ${r.unpaid_buyers} said in but never paid, and are not in the pot` : '')),
                h('table', { class: 'sheet' },
                  h('thead', {}, h('tr', {},
                    h('th', {}, '#'), h('th', {}, 'Who'), h('th', {}, 'Line'),
                    h('th', { style: 'text-align:right' }, 'Amount'))),
                  h('tbody', {}, lineRows(r.payouts)),
                ),
              );
            } catch (err) {
              target.replaceChildren(
                h('div', { class: 'issue blocker' },
                  h('div', { class: 'where' }, err.code ?? 'Error'),
                  h('div', {}, err.message)),
              );
            }
          },
        }, 'Calculate'),
      ),
      target,
    );
  });

  container.replaceChildren(
    h('h1', {}, 'Payouts'),
    h('p', { class: 'muted' }, rodeo.name),
    deskPanel(rodeoId, { source: night.source, onChange: () => payoutsView(rodeoId) }),
    h('div', { class: 'card small noprint' },
      'Calculate, read it against the judge\'s sheet, then disburse. '
      + 'Nothing that fails to reconcile to the cent will appear on this page — '
      + 'the API refuses to serve it.'),
    ...eventCards,
    sidepotCards.length
      ? h('div', {}, h('h2', {}, 'Sidepots'), ...sidepotCards)
      : null,
    h('div', { class: 'actions noprint' },
      h('a', { class: 'row-link', style: 'padding:10px 16px', href: `#/rodeo/${rodeoId}/books` },
        'Close the books →'),
    ),
  );

  render(container);
}
