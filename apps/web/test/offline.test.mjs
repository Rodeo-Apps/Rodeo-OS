/**
 * The offline desk, in the browser half.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES
 * ---------------------------------------------------------------------------
 * The API half (apps/api/test/sync.test.ts) proves what the server does with
 * a queue. This proves what the laptop does before the queue gets there: that
 * a score typed with the API down is kept, survives a refresh, and is shown as
 * NOT on the server; that a half download is never usable; that the queue
 * empties only on the server's word; and that the envelope figured offline is
 * the engine's, to the cent.
 *
 * Same harness as views.test.mjs — no browser, no jsdom, no dependency. Two
 * stand-ins, both written here:
 *
 *   * IndexedDB: the smallest object-store database the desk's ~dozen
 *     requests need. It outlives `_forgetConnection()`, which is what a page
 *     refresh does to the desk: the connection goes, the data stays.
 *   * /engine/: a resolve hook pointing the browser's `/engine/...` imports at
 *     packages/engine/src, which Node runs with its own type stripping — the
 *     same files apps/web/server.ts strips and serves.
 *
 *     node test/offline.test.mjs
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const ENGINE = new URL('../../../packages/engine/src/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/engine/')) {
      return { url: new URL(specifier.slice('/engine/'.length), ENGINE).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// ---------------------------------------------------------------------------
// The stub DOM, as in views.test.mjs
// ---------------------------------------------------------------------------

function makeEl(tag) {
  return {
    tagName: tag.toUpperCase(), children: [], attrs: {}, dataset: {},
    className: '', value: '', style: {}, textContent: '', checked: false,
    append(...cs) { for (const c of cs) this.children.push(c); },
    replaceChildren(...cs) { this.children = cs; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    querySelector() { return null; },
    focus() {},
    remove() {},
  };
}
const byId = new Map();
globalThis.document = {
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, text: String(t) }),
  createDocumentFragment: () => makeEl('fragment'),
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, makeEl('div'));
    return byId.get(id);
  },
  querySelector: () => makeEl('div'),
  body: makeEl('body'),
};
globalThis.Node = class {};
Object.defineProperty(globalThis.Node, Symbol.hasInstance, {
  value: (x) => !!x && typeof x === 'object' && ('tagName' in x || 'nodeType' in x),
});
globalThis.window = { print() {}, addEventListener() {}, scrollTo() {}, location: { hash: '' }, open: () => null };
globalThis.location = globalThis.window.location;
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.confirm = () => true;
globalThis.prompt = () => null;

// ---------------------------------------------------------------------------
// A small IndexedDB
// ---------------------------------------------------------------------------

function fakeIndexedDB() {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);

  function connection(dbData) {
    return {
      objectStoreNames: { contains: (n) => dbData.stores.has(n) },
      createObjectStore(name, opts = {}) {
        dbData.stores.set(name, { keyPath: opts.keyPath, auto: !!opts.autoIncrement, seq: 0, rows: new Map() });
      },
      transaction(names, mode = 'readonly') {
        const tx = { mode, pending: 0, done: false, oncomplete: null, onerror: null, onabort: null };
        const settle = () => later(() => {
          if (tx.pending === 0 && !tx.done) { tx.done = true; tx.oncomplete?.(); }
        });
        const request = (work) => {
          const r = { onsuccess: null, onerror: null };
          tx.pending++;
          later(() => {
            try { r.result = work(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); tx.onerror?.(); }
            tx.pending--;
            settle();
          });
          return r;
        };
        tx.objectStore = (name) => {
          const s = dbData.stores.get(name);
          const keyOf = (v) => v[s.keyPath];
          return {
            get: (k) => request(() => structuredClone(s.rows.get(k))),
            getAll: () => request(() => [...s.rows.values()].map((v) => structuredClone(v))),
            put: (v) => request(() => {
              const val = structuredClone(v);
              if (s.auto && val[s.keyPath] === undefined) val[s.keyPath] = ++s.seq;
              s.rows.set(keyOf(val), val);
              return keyOf(val);
            }),
            add: (v) => request(() => {
              const val = structuredClone(v);
              if (s.auto && val[s.keyPath] === undefined) val[s.keyPath] = ++s.seq;
              if (s.rows.has(keyOf(val))) throw new Error('ConstraintError');
              s.rows.set(keyOf(val), val);
              return keyOf(val);
            }),
            delete: (k) => request(() => { s.rows.delete(k); }),
          };
        };
        settle();
        return tx;
      },
    };
  }

  return {
    open(name) {
      const r = { onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        let d = databases.get(name);
        const fresh = !d;
        if (fresh) { d = { stores: new Map() }; databases.set(name, d); }
        r.result = connection(d);
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
}
globalThis.indexedDB = fakeIndexedDB();

// ---------------------------------------------------------------------------
// The modules under test
// ---------------------------------------------------------------------------

const W = new URL('../public/js', import.meta.url).href;
const apiMod = await import(`${W}/api.js`);
const offline = await import(`${W}/offline.js`);
const night = await import(`${W}/night.js`);
const scoring = await import(`${W}/views/scoring.js`);
const { engine } = night;

// Every request the app makes goes through fetch; the tests decide what it does.
let fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
const calls = [];
globalThis.fetch = (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); };
await apiMod.init(); // config.json fails → same origin
apiMod.setSession('test-token', 'org-1');
const apiDown = () => { fetchImpl = async () => { throw new TypeError('Failed to fetch'); }; };
const respond = (fn) => {
  fetchImpl = async (url, opts) => {
    const out = await fn(url, opts);
    return { ok: true, status: 200, json: async () => ({ data: out }), text: async () => '' };
  };
};

// ---------------------------------------------------------------------------
// A packet
// ---------------------------------------------------------------------------

const TIMED = {
  mode: 'timed', time_precision: 2,
  timed_penalties: [{ type: 'barrier_break', seconds: 10 }], dq_triggers: ['no_catch'],
};
const LADDER = {
  fee_structure: { admin_pct: 0.06, office_fee_flat: 500 },
  payout_rules: [{ min_entries: 1, max_entries: 99, places_paid: 2, splits: [0.6, 0.4] }],
  ground_money_rule: 'combine_and_split',
};
const people = [['c1', 'Casey Roper'], ['c2', 'Dale Heeler'], ['c3', 'Rae Runner']];
const entries = people.map(([id, name], i) => ({
  entry_id: `e${i + 1}`, rodeo_event_id: 'ev1', contestant_id: id, contestant_name: name,
  partner_id: null, partner_name: null, back_number: String(100 + i), go_round: 1,
  performance_number: 1, draw_position: i + 1, status: 'drawn',
  entry_fee_amount: '100.00', fees_paid: i !== 2, release_type: null, turnout_notified_at: null,
}));
const runs = entries.map((e, i) => ({
  position: i + 1, entry_id: e.entry_id, back_number: e.back_number, contestant_id: e.contestant_id,
  contestant_name: e.contestant_name, partner_name: null, horse_name: null, stock_name: null,
  stock_brand: null, go_round: 1, flags: [], is_scratched: false, notes: null,
}));
const section = {
  rodeo_event_id: 'ev1', event_type: 'breakaway_roping', event_label: 'Breakaway',
  scoring_mode: 'timed', is_roughstock: false, go_round: 1, runs, drags: [],
  live_count: 3, entered_count: 3,
};
const sheet = {
  rodeo_id: 'r1', rodeo_name: 'Desk Jackpot', performance_id: null, performance_name: 'All performances',
  performance_type: 'performance', date: '2026-10-03', scheduled_start: null, venue: null,
  sanctioned_by: [], personnel: [], sections: [section], total_runs: 3, footer: 'Desk Jackpot',
};
const PACKET = {
  packet_version: 1, rodeo_id: 'r1', org_id: 'org-1', built_at: '2026-10-01T18:00:00.000Z',
  rodeo: {
    id: 'r1', name: 'Desk Jackpot', sanctioned_by: [], start_date: '2026-10-03', end_date: '2026-10-03',
    entry_count: 3,
    events: [{ id: 'ev1', event_type: 'breakaway_roping', label: 'Breakaway', scoring_mode: 'timed',
      entries: 3, scored: 0, scoring_config_id: 'sc1' }],
    performances: [{ performance_number: 1, name: 'Friday', performance_type: 'performance',
      performance_at: '2026-10-03T01:00:00.000Z' }],
  },
  day_sheets: [
    { performance_number: null, sheet, text: 'DESK JACKPOT — whole rodeo' },
    { performance_number: 1, sheet: { ...sheet, performance_id: '1' }, text: 'DESK JACKPOT — Friday' },
  ],
  events: [{
    id: 'ev1', event_type: 'breakaway_roping', label: 'Breakaway', scoring_mode: 'timed',
    is_roughstock: false, num_go_rounds: 1, is_d_format: false, d_format_config: null,
    scoring_config_id: 'sc1', scoring_config: TIMED, payout_config_id: 'pc1', payout_config: LADDER,
    payout: { added_money_cents: 50000, entry_fee_cents: 10000, entries: [] },
    results_official: false, disbursed: false,
  }],
  entries, scores: [], judges: [],
  release_reasons: [{ code: 'medical', label: 'Medical Release', counts_as_turnout: false }],
};

// ---------------------------------------------------------------------------
// Runner, in the views.test.mjs manner
// ---------------------------------------------------------------------------

let bad = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (e) {
    bad++;
    console.log(`FAIL  ${label}\n      ${e.message}`);
  }
}
function textOf(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.nodeType === 3) acc.push(node.text);
  for (const c of node.children ?? []) textOf(c, acc);
  return acc;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const body = (entry, raw, card) => ({
  entry_id: entry.entry_id, contestant_id: entry.contestant_id, go_round: 1,
  scoring_config_id: 'sc1', source: 'secretary', raw_time: raw, penalties: [],
  ...(card !== undefined ? { cross_check: { kind: 'timed', judge_card: { raw_time: card, penalties: [] } } } : {}),
});

// ---------------------------------------------------------------------------

await test('a half download cannot be used as the packet', async () => {
  // The response arrives without the entries.
  respond(() => ({ ...PACKET, entries: undefined }));
  await assert.rejects(() => offline.downloadPacket('r1'), /incomplete/);
  assert.equal(await offline.packet('r1'), null, 'nothing usable was stored');
  assert.equal((await offline.downloadStatus('r1')).state, 'failed');

  // The link dies mid-download.
  apiDown();
  await assert.rejects(() => offline.downloadPacket('r1'));
  assert.equal(await offline.packet('r1'), null);
});

await test('a complete download is the copy, with its time, and survives a later failed one', async () => {
  respond(() => PACKET);
  const stored = await offline.downloadPacket('r1');
  assert.ok(stored.downloaded_at);
  assert.equal((await offline.downloadStatus('r1')).state, 'complete');

  respond(() => ({ ...PACKET, day_sheets: [] }));
  await assert.rejects(() => offline.downloadPacket('r1'));
  const copy = await offline.packet('r1');
  assert.ok(copy, 'the earlier complete packet is still the copy');
  assert.equal(copy.downloaded_at, stored.downloaded_at);
  assert.equal((await offline.downloadStatus('r1')).state, 'failed', 'and the failure is shown');
});

await test('the live score path is the real route and sends scoring_config_id', async () => {
  calls.length = 0;
  respond(() => ({ id: 'live-score', status: 'official', raw_time: 8.4, final_time: 8.4 }));
  const out = await scoring.saveRun('r1', {
    existing: null, body: body(entries[0], 8.4, 8.4), rodeo_event_id: 'ev1', label: 'Casey',
  });
  assert.equal(out.where, 'server');
  const post = calls.find((c) => c.opts?.method === 'POST');
  assert.equal(post.url, '/v1/orgs/org-1/rodeos/r1/events/ev1/scores');
  const sent = JSON.parse(post.opts.body);
  assert.equal(sent.scoring_config_id, 'sc1');
  assert.equal(sent.entry_id, 'e1');
  assert.equal(sent.source, 'secretary');
});

let queuedId;
await test('a score saved with the API down is kept, survives a refresh, and is marked not on the server', async () => {
  apiDown();
  const out = await scoring.saveRun('r1', {
    existing: null, body: body(entries[1], 9.25, 9.25), rodeo_event_id: 'ev1', label: 'Dale',
  });
  assert.equal(out.where, 'local', 'it went to the queue, not "saved"');
  queuedId = out.row.change.id;

  offline._forgetConnection(); // the page is refreshed
  const rows = await offline.queued('r1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].change.id, queuedId);
  assert.equal(rows[0].change.data.scoring_config_id, 'sc1');
  assert.equal(rows[0].change.source, 'secretary');
  assert.ok((await offline.clientId()).startsWith('desk-'), 'this browser keeps its own id');

  const state = night.nightState(await offline.packet('r1'), rows);
  const score = state.scores.get(night.keyOf('e2', 1));
  assert.equal(score.on_server, false);
  assert.equal(score.final_time, 9.25, 'the engine figured it on the laptop');

  // And the scoring screen says so.
  byId.set('view', makeEl('div'));
  await scoring.scoringView('r1');
  await tick();
  const text = textOf(byId.get('view')).join(' ');
  assert.ok(text.includes('not on the server'), text.slice(0, 400));
  assert.ok(text.includes('This browser is the copy.'));
  const desk = await offline.deskName();
  assert.match(desk, /^Desk [0-9A-F]{6}$/);
  assert.ok(text.includes(`This browser: ${desk}`), 'the panel names this browser');
  assert.ok(text.includes('1 change(s) on this laptop only'));
});

await test('the queue empties only when the server says accepted; a refusal stays for her', async () => {
  // The link is still down: nothing changes.
  apiDown();
  await assert.rejects(() => offline.drain());
  assert.equal((await offline.queued('r1')).length, 1);

  // Back, but the server refuses it (another secretary changed the run).
  let sent;
  respond((url, opts) => {
    sent = JSON.parse(opts.body);
    return {
      accepted: [], server_changes: [], sync_timestamp: '2026-10-01T20:00:00.000Z',
      rejected: [{ client_change_id: queuedId, reason: 'authority_override', resolution: 'manual_required',
        server_version: { version: 2 }, explanation: "Two 'secretary' sources changed this run independently." }],
    };
  });
  await offline.drain();
  assert.equal(sent.client_id, await offline.clientId());
  assert.equal(sent.last_sync_at, PACKET.built_at, 'asks for what changed since the packet');
  assert.deepEqual(sent.changes.map((c) => c.id), [queuedId]);
  let rows = await offline.queued('r1');
  assert.equal(rows.length, 1, 'refused is not removed');
  assert.equal(rows[0].state, 'rejected');
  assert.match(rows[0].conflict.explanation, /independently/);

  // She keeps hers: it goes back against the version the server holds.
  await offline.resolveRejected(rows[0].seq, 'resend');
  rows = await offline.queued('r1');
  assert.equal(rows[0].state, 'queued');
  assert.equal(rows[0].change.base_version, 2);

  respond(() => ({ accepted: [queuedId], rejected: [], server_changes: [], sync_timestamp: '2026-10-01T20:05:00.000Z' }));
  const s = await offline.drain();
  assert.equal(s.accepted, 1);
  assert.equal((await offline.queued('r1')).length, 0, 'empty once — and only once — accepted');
});

await test('changes are sent in the order she made them', async () => {
  apiDown();
  for (const [i, e] of entries.entries()) {
    await offline.enqueue('r1', { entity_type: 'score', data: { ...body(e, 10 + i, 10 + i), rodeo_event_id: 'ev1' } });
  }
  await offline.enqueue('r1', { entity_type: 'finalize', data: { rodeo_event_id: 'ev1', official: true, confirm: true } });
  let sent;
  respond((url, opts) => {
    sent = JSON.parse(opts.body).changes;
    return { accepted: sent.map((c) => c.id), rejected: [], server_changes: [], sync_timestamp: new Date().toISOString() };
  });
  await offline.drain();
  assert.deepEqual(sent.map((c) => c.entity_type), ['score', 'score', 'score', 'finalize']);
  const times = sent.map((c) => Date.parse(c.timestamp));
  assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), 'strictly increasing timestamps');
});

await test('official is held back on the laptop while a card and a sheet disagree', async () => {
  const pk = await offline.packet('r1');
  apiDown();
  await offline.enqueue('r1', { entity_type: 'score', data: { ...body(entries[0], 8.4, 8.5), rodeo_event_id: 'ev1' } });
  const state = night.nightState(pk, await offline.queued('r1'));
  const blockers = night.eventBlockers(state, 'ev1');
  assert.ok(blockers.some((b) => b.code === 'TIME_DIFFERS' && b.contestant_name === 'Casey Roper'));
  for (const r of await offline.queued('r1')) await offline.resolveRejected(r.seq, 'drop');
});

await test('a cash payout figured offline matches the engine to the cent, and its lines add to the net purse', async () => {
  const pk = await offline.packet('r1');
  apiDown();
  const times = [8.4, 9.25, 10.1];
  for (const [i, e] of entries.entries()) {
    await offline.enqueue('r1', { entity_type: 'score', data: { ...body(e, times[i], times[i]), rodeo_event_id: 'ev1' } });
  }
  const state = night.nightState(pk, await offline.queued('r1'));
  const figured = night.eventPayout(state, 'ev1');
  assert.ok(figured.ok, figured.reason);

  const direct = engine.calculatePayout({
    payout_config: LADDER, scoring_mode: 'timed',
    entries: entries.map((e) => ({ contestant_id: e.contestant_id, status: 'drawn', entry_fee_cents: 10000 })),
    results: entries.map((e, i) => ({ contestant_id: e.contestant_id, status: 'official', final_time: times[i] })),
    added_money_cents: 50000, entry_fee_cents: 10000,
  });
  assert.deepEqual(
    figured.result.payouts.map((p) => [p.contestant_id, p.amount_cents]),
    direct.payouts.map((p) => [p.contestant_id, p.amount_cents]),
    'the same engine call, the same cents',
  );

  const env = night.envelopes(state, figured.result);
  assert.equal(
    env.total_cents + figured.result.unpaid_cents + figured.result.escrow_cents,
    figured.result.net_purse_cents,
    'every cent of the net purse is in an envelope, unpaid, or in escrow',
  );
  assert.equal(env.lines[0].name, 'Casey Roper');

  const text = night.renderEnvelopeText('Desk Jackpot', 'Breakaway', env);
  assert.match(text, /Casey Roper\s+1\s+\$\d+\.\d\d\s+CASH/);
  assert.match(text, /TOTAL IN ENVELOPES/);
  for (const r of await offline.queued('r1')) await offline.resolveRejected(r.seq, 'drop');
});

await test('a turnout recorded offline is classified by the engine from the time she was told', async () => {
  const pk = await offline.packet('r1');
  await offline.enqueue('r1', {
    entity_type: 'turnout',
    data: { entry_id: 'e3', release_type: 'personal',
      performance_at: '2026-10-03T01:00:00.000Z', notified_at: '2026-10-02T23:00:00.000Z' },
  });
  const state = night.nightState(pk, await offline.queued('r1'));
  const e = state.entries.get('e3');
  assert.equal(e.status, 'turned_out');
  assert.equal(e.turnout.fineable, true, 'two hours\' notice is short: the fine is owed');
  assert.equal(e.on_server, false);

  // The printed sheet from the packet shows it, in the day sheet's own format.
  const local = night.localSheet(state, null);
  const run = local.sections[0].runs.find((r) => r.entry_id === 'e3');
  assert.equal(run.is_scratched, true);
  assert.match(engine.renderDaySheetText(local), /TURNED OUT/);
  for (const r of await offline.queued('r1')) await offline.resolveRejected(r.seq, 'drop');
});

await test('one slip per contestant: a two-place event prints two, and they add to the envelope total', async () => {
  const pk = await offline.packet('r1');
  apiDown();
  // Two runs, two places paid.
  await offline.enqueue('r1', { entity_type: 'score', data: { ...body(entries[0], 8.4, 8.4), rodeo_event_id: 'ev1' } });
  await offline.enqueue('r1', { entity_type: 'score', data: { ...body(entries[1], 9.25, 9.25), rodeo_event_id: 'ev1' } });
  const state = night.nightState(pk, await offline.queued('r1'));
  const figured = night.eventPayout(state, 'ev1');
  assert.ok(figured.ok, figured.reason);
  const env = night.envelopes(state, figured.result);

  const people = night.slips(env);
  assert.equal(people.length, 2, 'two places, two slips');
  assert.equal(people.reduce((s, p) => s + p.total_cents, 0), env.total_cents,
    'the slips add up to the envelope total');

  // Recorded on this laptop only: no method, and it says so.
  const offlineText = night.renderSlipsText('Desk Jackpot', 'Breakaway', people);
  assert.equal(offlineText.match(/cut here/g).length, 2);
  assert.match(offlineText, /Casey Roper[\s\S]*1st prize[\s\S]*IN THIS ENVELOPE/);
  assert.match(offlineText, /NOT ON THE SERVER until sync\naccepts the cash\./);
  assert.doesNotMatch(offlineText, /held/i, 'nothing held, so no held line');
  assert.doesNotMatch(offlineText, /CASH|check/, 'no method before the server has the cash');

  // Paid in cash from this screen: the slip says cash, and nothing else changes.
  const paidText = night.renderSlipsText('Desk Jackpot', 'Breakaway', people, { paidCash: true, onServer: true });
  assert.equal(paidText.match(/Paid in CASH\./g).length, 2);
  assert.doesNotMatch(paidText, /NOT ON THE SERVER|held|check/i);

  // Paid on the server some other way: no method named, no offline warning.
  const otherText = night.renderSlipsText('Desk Jackpot', 'Breakaway', people, { onServer: true });
  assert.doesNotMatch(otherText, /CASH|NOT ON THE SERVER/);
  for (const r of await offline.queued('r1')) await offline.resolveRejected(r.seq, 'drop');
});

await test('a go-round and an average are both on his one slip, with his total', async () => {
  const env = {
    lines: [
      { contestant_id: 'c1', name: 'Casey Roper', place: 1, type: 'go_round', go_round: 1, amount_cents: 30000 },
      { contestant_id: 'c2', name: 'Dale Heeler', place: 2, type: 'go_round', go_round: 1, amount_cents: 20000 },
      { contestant_id: 'c1', name: 'Casey Roper', place: 1, type: 'average', go_round: null, amount_cents: 12345 },
    ],
    total_cents: 62345,
  };
  const people = night.slips(env);
  assert.equal(people.length, 2);
  const casey = people.find((p) => p.contestant_id === 'c1');
  assert.equal(casey.lines.length, 2);
  assert.equal(casey.total_cents, 42345);
  const text = night.renderSlipsText('Desk Jackpot', 'Tie-Down', people);
  const caseySlip = text.split('cut here')[0];
  assert.match(caseySlip, /1st go round R1\s+\$300\.00/);
  assert.match(caseySlip, /1st average\s+\$123\.45/);
  assert.match(caseySlip, /IN THIS ENVELOPE\s+\$423\.45/);
});

console.log(bad === 0 ? '\n✓ the offline desk holds' : `\n✗ ${bad} offline check(s) wrong`);
process.exit(bad ? 1 : 0);
