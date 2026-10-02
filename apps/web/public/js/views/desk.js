/**
 * The offline desk panel, shown at the top of every screen she runs a
 * performance from.
 *
 * It answers three questions without her having to ask:
 *
 *   Is this browser the copy?   When the packet was downloaded, or that it was
 *                               not — and if the last download did not finish,
 *                               that she must not start offline on it.
 *   What is not on the server?  How many changes exist only on this laptop.
 *   What did the server refuse? Every rejected change, with the server's own
 *                               explanation, until she chooses what to do.
 */

import * as offline from '../offline.js';
import { api } from '../api.js';
import { h, toast } from '../ui.js';

/**
 * The night's data: a fresh packet from the server when there is a signal,
 * the stored copy when there is not. `source` says which.
 */
export async function loadNight(rodeoId) {
  try {
    const fresh = await api.offlinePacket(rodeoId);
    if (offline.isCompletePacket(fresh, rodeoId)) {
      return { packet: fresh, source: 'server', queue: await offline.queued(rodeoId) };
    }
  } catch (err) {
    if (!offline.isUnreachable(err)) throw err;
  }
  const copy = await offline.packet(rodeoId);
  if (!copy) {
    const status = await offline.downloadStatus(rodeoId);
    throw new Error(
      status?.state === 'failed'
        ? 'No signal, and the last packet download did not finish. This browser has no usable copy of this rodeo.'
        : 'No signal, and this rodeo was never downloaded onto this browser.',
    );
  }
  return { packet: copy, source: 'copy', queue: await offline.queued(rodeoId) };
}

const time = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

/** A marker for a value that exists only on this laptop. */
export function notOnServer(row) {
  if (!row || row.on_server !== false) return null;
  return h('span', { class: 'pill', style: 'border-color:var(--warn);color:var(--warn)' },
    row.queue_state === 'rejected' ? 'refused by server' : 'not on the server');
}

/**
 * The panel. `onChange` re-renders the screen after a sync or a choice.
 */
export function deskPanel(rodeoId, { source, onChange } = {}) {
  const box = h('div', { class: 'card noprint' }, h('p', { class: 'muted small' }, 'Checking this browser…'));

  async function draw() {
    const [pk, status, rows, desk] = await Promise.all([
      offline.packet(rodeoId),
      offline.downloadStatus(rodeoId),
      offline.queued(rodeoId),
      offline.deskName(),
    ]);
    const waiting = rows.filter((r) => r.state === 'queued');
    const refused = rows.filter((r) => r.state === 'rejected');

    const packetLine = pk
      ? h('div', {},
          h('strong', {}, 'This browser is the copy. '),
          `Packet downloaded ${time(pk.downloaded_at)}.`,
          source === 'copy' ? h('span', { class: 'muted' }, '  No signal — working from the copy.') : null)
      : h('div', {}, h('strong', {}, 'No packet on this browser. '),
          'Download one while there is a signal, or this screen stops when the wifi does.');

    const failedLine = status?.state === 'failed'
      ? h('div', { class: 'issue blocker' },
          h('div', { class: 'where' }, 'Download did not finish'),
          h('div', {}, `${time(status.at)}: ${status.error}`),
          h('div', { class: 'fix' }, pk
            ? `The copy from ${time(pk.downloaded_at)} is still the one in use. Do not start offline on the failed download.`
            : 'There is no usable copy. Do not start the performance offline on this browser.'))
      : null;

    box.replaceChildren(
      h('div', { class: 'small' }, h('strong', {}, `This browser: ${desk}`),
        h('span', { class: 'muted' }, '  — its own packet and its own queue.')),
      // Tabs share one IndexedDB, so they share one desk. Said here so a
      // second tab is not mistaken for the other secretary.
      h('div', { class: 'muted small' },
        'Two tabs of this browser are one desk, not two. The other secretary is a different browser or laptop.'),
      packetLine,
      failedLine,
      waiting.length
        ? h('div', { class: 'warnline' },
            `${waiting.length} change(s) on this laptop only — not on the server yet.`)
        : h('div', { class: 'muted small' }, 'Nothing waiting: the server has everything recorded here.'),
      refused.length
        ? h('div', {},
            h('h3', {}, `${refused.length} refused by the server — choose for each`),
            refused.map((r) => refusedRow(r)))
        : null,
      h('div', { class: 'actions' },
        h('button', {
          class: 'ghost',
          onclick: async () => {
            try {
              await offline.downloadPacket(rodeoId);
              toast('Packet downloaded. This browser is the copy.');
            } catch (err) {
              toast(`Download did not finish: ${err.message}`, true);
            }
            await draw();
          },
        }, pk ? 'Download the packet again' : 'Download the packet'),
        waiting.length
          ? h('button', {
              onclick: async () => {
                try {
                  const s = await offline.drain();
                  toast(`Sync: ${s.accepted} accepted, ${s.rejected} refused.`, s.rejected > 0);
                } catch (err) {
                  toast(offline.isUnreachable(err) ? 'Still no signal. Nothing was sent.' : err.message, true);
                }
                await draw();
                onChange?.();
              },
            }, 'Sync now')
          : null,
      ),
    );
  }

  function refusedRow(r) {
    const c = r.conflict ?? {};
    const manual = c.resolution === 'manual_required';
    return h('div', { class: `issue ${manual ? 'warning' : 'blocker'}` },
      h('div', { class: 'where' }, r.label ?? r.change.entity_type),
      h('div', {}, c.explanation ?? 'The server refused this change.'),
      h('div', { class: 'actions' },
        manual
          ? h('button', {
              onclick: async () => {
                await offline.resolveRejected(r.seq, 'resend');
                toast('Sent to the back of the queue.');
                await draw();
                onChange?.();
              },
            }, 'Keep mine — send it again')
          : null,
        h('button', {
          class: 'ghost',
          onclick: async () => {
            await offline.resolveRejected(r.seq, 'drop');
            toast('Dropped. The server\'s version stands.');
            await draw();
            onChange?.();
          },
        }, manual ? 'Use the server\'s' : 'Understood — drop mine'),
      ),
    );
  }

  const off = offline.onChange(() => {
    // A screen she has navigated away from stops listening.
    if (box.isConnected === false) { off(); return; }
    draw().catch(() => {});
  });
  draw().catch((err) => box.replaceChildren(h('p', { class: 'muted small' }, err.message)));
  return box;
}
