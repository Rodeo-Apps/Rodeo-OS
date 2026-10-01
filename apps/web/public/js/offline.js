/**
 * The offline desk.
 *
 * ---------------------------------------------------------------------------
 * THE WIFI DIES AFTER THE DRAW IS POSTED. THE PERFORMANCE DOES NOT STOP.
 * ---------------------------------------------------------------------------
 * Before the performance, while there is still a signal, she downloads the
 * rodeo packet onto this browser: the day sheet, the entries and who has paid,
 * the ground rules and the payout table. From then on this browser is the
 * copy. Every score, turnout, trade, Make official and cash envelope she
 * records is tried against the API first; if the API cannot be reached it is
 * written to a queue in this browser and shown as NOT ON THE SERVER — never as
 * saved — until POST /sync says, in so many words, that it was accepted.
 *
 * Storage is the browser's own IndexedDB. No library: four object stores and
 * a dozen requests. What lives here:
 *
 *   meta       client_id (survives a refresh, identifies this desk to sync),
 *              last_sync_at, the last change timestamp handed out
 *   packets    one complete packet per rodeo, keyed by rodeo_id
 *   downloads  the state of the last download per rodeo: complete or failed
 *   queue      her changes, in the order she made them (autoincrement seq)
 *
 * A packet is written in one transaction, only after the whole response has
 * arrived and been checked. A download that fails part-way writes a 'failed'
 * marker and leaves any earlier complete packet alone; packet() never returns
 * anything that is not complete.
 * ---------------------------------------------------------------------------
 */

import { ApiError, api } from './api.js';

const DB_NAME = 'rodeo-os-desk';
const DB_VERSION = 1;

let dbPromise = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const d = open.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('packets')) d.createObjectStore('packets', { keyPath: 'rodeo_id' });
        if (!d.objectStoreNames.contains('downloads')) d.createObjectStore('downloads', { keyPath: 'rodeo_id' });
        if (!d.objectStoreNames.contains('queue')) {
          d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  return dbPromise;
}

/** For tests: forget the open connection, as a page refresh would. */
export function _forgetConnection() {
  dbPromise = null;
}

async function getMeta(key) {
  const d = await db();
  const row = await req(d.transaction('meta').objectStore('meta').get(key));
  return row?.value;
}

async function setMeta(key, value) {
  const d = await db();
  const tx = d.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await done(tx);
}

/** This browser's own id, made once and kept. Sync is told who is talking. */
export async function clientId() {
  let id = await getMeta('client_id');
  if (!id) {
    id = `desk-${crypto.randomUUID()}`;
    await setMeta('client_id', id);
  }
  return id;
}

/**
 * The name this desk goes by on screen: "Desk" and the last six characters
 * of its client id. With two people on the desk, it is how each can tell
 * which laptop holds which queue. Nothing is typed and nothing is shared —
 * each browser only ever shows its own.
 */
export async function deskName() {
  const id = await clientId();
  return `Desk ${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// The packet
// ---------------------------------------------------------------------------

const REQUIRED = ['rodeo', 'day_sheets', 'events', 'entries', 'scores', 'judges', 'release_reasons'];

/** True only for a packet with every part present. */
export function isCompletePacket(p, rodeoId) {
  if (!p || typeof p !== 'object') return false;
  if (p.packet_version !== 1 || p.rodeo_id !== rodeoId) return false;
  if (!REQUIRED.every((k) => p[k] !== undefined && p[k] !== null)) return false;
  if (!Array.isArray(p.day_sheets) || p.day_sheets.length === 0) return false;
  return p.day_sheets.every((s) => s && s.sheet && typeof s.text === 'string');
}

/**
 * Download the packet. Stored only if the whole of it arrived; otherwise a
 * 'failed' marker is stored and the error is thrown for the screen to show.
 */
export async function downloadPacket(rodeoId) {
  let packet;
  try {
    packet = await api.offlinePacket(rodeoId);
    if (!isCompletePacket(packet, rodeoId)) {
      throw new Error('The packet arrived incomplete.');
    }
  } catch (err) {
    const d = await db();
    const tx = d.transaction('downloads', 'readwrite');
    tx.objectStore('downloads').put({
      rodeo_id: rodeoId,
      state: 'failed',
      at: new Date().toISOString(),
      error: err.message ?? String(err),
    });
    await done(tx);
    throw err;
  }

  const downloaded_at = new Date().toISOString();
  const d = await db();
  const tx = d.transaction(['packets', 'downloads', 'meta'], 'readwrite');
  tx.objectStore('packets').put({ ...packet, downloaded_at, complete: true });
  tx.objectStore('downloads').put({ rodeo_id: rodeoId, state: 'complete', at: downloaded_at });
  // Sync asks the server for what changed since this packet was built.
  const meta = tx.objectStore('meta');
  const last = await req(meta.get('last_sync_at'));
  if (!last?.value || last.value < packet.built_at) {
    meta.put({ key: 'last_sync_at', value: packet.built_at });
  }
  await done(tx);
  return { ...packet, downloaded_at };
}

/** The complete packet for this rodeo, or null. Never a half one. */
export async function packet(rodeoId) {
  const d = await db();
  const p = await req(d.transaction('packets').objectStore('packets').get(rodeoId));
  return p && p.complete === true && isCompletePacket(p, rodeoId) ? p : null;
}

export async function downloadStatus(rodeoId) {
  const d = await db();
  return (await req(d.transaction('downloads').objectStore('downloads').get(rodeoId))) ?? null;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** A timestamp later than every one handed out before, so order survives a clock wobble. */
async function nextTimestamp() {
  const last = (await getMeta('last_ts')) ?? 0;
  const ts = Math.max(Date.now(), last + 1);
  await setMeta('last_ts', ts);
  return new Date(ts).toISOString();
}

/** Write one change to the queue. Returns the stored row. */
export async function enqueue(rodeoId, { entity_type, data, label, base_version, action = 'create' }) {
  const change = {
    id: crypto.randomUUID(),
    entity_type,
    action,
    data,
    timestamp: await nextTimestamp(),
    source: 'secretary',
    ...(base_version !== undefined && base_version !== null ? { base_version } : {}),
  };
  const d = await db();
  const tx = d.transaction('queue', 'readwrite');
  const row = { rodeo_id: rodeoId, change, label, state: 'queued', queued_at: change.timestamp };
  const seq = await req(tx.objectStore('queue').add(row));
  await done(tx);
  notify();
  return { ...row, seq };
}

/** Everything not yet accepted by the server, oldest first. */
export async function queued(rodeoId) {
  const d = await db();
  const rows = await req(d.transaction('queue').objectStore('queue').getAll());
  return rows
    .filter((r) => !rodeoId || r.rodeo_id === rodeoId)
    .sort((a, b) => a.seq - b.seq);
}

async function updateRow(row) {
  const d = await db();
  const tx = d.transaction('queue', 'readwrite');
  tx.objectStore('queue').put(row);
  await done(tx);
}

async function deleteSeqs(seqs) {
  if (seqs.length === 0) return;
  const d = await db();
  const tx = d.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  for (const s of seqs) store.delete(s);
  await done(tx);
}

/**
 * Her choice on a rejected change.
 *
 *   'drop'   she accepts the server's version; her change is discarded.
 *   'resend' she keeps hers: it goes to the back of the queue, and a score is
 *            sent against the version the server now holds, which is what lets
 *            an equal-authority edit through once she has looked at it.
 */
export async function resolveRejected(seq, choice) {
  const rows = await queued();
  const row = rows.find((r) => r.seq === seq);
  if (!row) return;
  if (choice === 'drop') {
    await deleteSeqs([seq]);
    notify();
    return;
  }
  const version = row.conflict?.server_version?.version;
  const change = {
    ...row.change,
    timestamp: await nextTimestamp(),
    ...(row.change.entity_type === 'score' && Number.isInteger(version)
      ? { base_version: version }
      : {}),
  };
  const d = await db();
  const tx = d.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  store.delete(seq);
  store.add({ rodeo_id: row.rodeo_id, change, label: row.label, state: 'queued', queued_at: change.timestamp });
  await done(tx);
  notify();
}

// ---------------------------------------------------------------------------
// Reaching the API
// ---------------------------------------------------------------------------

/**
 * The API could not be reached: no network, a timeout, or a gateway with
 * nothing behind it. A 4xx is the server answering, and is never queued.
 */
export function isUnreachable(err) {
  if (err instanceof ApiError) return [502, 503, 504].includes(err.status);
  return true;
}

/**
 * Try the live route; if the API cannot be reached, queue the change.
 *
 * Returns { where: 'server', result } or { where: 'local', row }. While
 * anything is still queued for this rodeo, new changes queue behind it, so the
 * server sees them in the order she made them.
 */
export async function record(rodeoId, { live, change }) {
  const pending = (await queued(rodeoId)).filter((r) => r.state === 'queued');
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (pending.length === 0 && !offline) {
    try {
      return { where: 'server', result: await live() };
    } catch (err) {
      if (!isUnreachable(err)) throw err;
    }
  }
  const row = await enqueue(rodeoId, change);
  return { where: 'local', row };
}

/**
 * Queue a change and try to send it straight away. Used for an edit of
 * something the server already holds, which goes through POST /sync so the
 * authority rule and base_version decide it.
 *
 * Returns { where: 'server' } once the server accepted it, { where:
 * 'refused', explanation, row } if it refused (the row stays on screen for her
 * to choose), or { where: 'local', row } if the server could not be reached.
 */
export async function sendNow(rodeoId, change) {
  const row = await enqueue(rodeoId, change);
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  if (offline) return { where: 'local', row };
  try {
    await drain();
  } catch (err) {
    if (!isUnreachable(err)) throw err;
    return { where: 'local', row };
  }
  const after = (await queued(rodeoId)).find((r) => r.change.id === row.change.id);
  if (!after) return { where: 'server' };
  if (after.state === 'rejected') {
    return { where: 'refused', explanation: after.conflict?.explanation, row: after };
  }
  return { where: 'local', row: after };
}

/** A queued change she corrected before it was sent: same change, new data. */
export async function replaceQueued(seq, data) {
  const row = (await queued()).find((r) => r.seq === seq);
  if (!row || row.state !== 'queued') throw new Error('That change is no longer waiting to be sent.');
  const next = { ...row, change: { ...row.change, data } };
  await updateRow(next);
  notify();
  return { where: 'local', row: next };
}

let draining = null;

/**
 * Send the queue to POST /sync, in the order she made the changes.
 *
 * A change leaves the queue only when the response lists it as accepted. A
 * rejected change stays, with the server's explanation, until she chooses.
 * If the request itself fails, nothing changes.
 */
export async function drain() {
  if (draining) return draining;
  draining = (async () => {
    const summary = { accepted: 0, rejected: 0, sent: 0 };
    for (;;) {
      const batch = (await queued()).filter((r) => r.state === 'queued').slice(0, 500);
      if (batch.length === 0) break;

      const response = await api.sync({
        client_id: await clientId(),
        last_sync_at: (await getMeta('last_sync_at')) ?? '1970-01-01T00:00:00.000Z',
        changes: batch.map((r) => r.change),
      });
      summary.sent += batch.length;

      const accepted = new Set(response.accepted ?? []);
      const rejected = new Map((response.rejected ?? []).map((c) => [c.client_change_id, c]));

      await deleteSeqs(batch.filter((r) => accepted.has(r.change.id)).map((r) => r.seq));
      for (const r of batch) {
        const conflict = rejected.get(r.change.id);
        if (conflict) await updateRow({ ...r, state: 'rejected', conflict });
      }
      summary.accepted += accepted.size;
      summary.rejected += rejected.size;

      await applyServerChanges(response.server_changes ?? []);
      if (response.sync_timestamp) await setMeta('last_sync_at', response.sync_timestamp);

      // Anything neither accepted nor rejected stays queued; stop rather than
      // resend it in a loop.
      if (accepted.size + rejected.size < batch.length) break;
    }
    notify();
    return summary;
  })().finally(() => {
    draining = null;
  });
  return draining;
}

/** Fold the server's scores back into the stored packets, so the copy stays current. */
async function applyServerChanges(changes) {
  const scores = changes.filter((c) => c.entity_type === 'score');
  if (scores.length === 0) return;
  const d = await db();
  const tx = d.transaction('packets', 'readwrite');
  const store = tx.objectStore('packets');
  const all = await req(store.getAll());
  for (const p of all) {
    let touched = false;
    for (const c of scores) {
      if (!p.entries.some((e) => e.entry_id === c.data.entry_id)) continue;
      const i = p.scores.findIndex((s) => s.id === c.entity_id);
      const merged = { ...(i >= 0 ? p.scores[i] : {}), id: c.entity_id, ...c.data };
      if (i >= 0) p.scores[i] = merged;
      else p.scores.push(merged);
      touched = true;
    }
    if (touched) store.put(p);
  }
  await done(tx);
}

// ---------------------------------------------------------------------------
// Telling the screens
// ---------------------------------------------------------------------------

const listeners = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) {
    try { fn(); } catch { /* a screen that has gone away */ }
  }
}

/** Drain whenever the link comes back, and every half minute while anything waits. */
export function startAutoSync() {
  if (typeof window === 'undefined' || window.__deskAutoSync) return;
  window.__deskAutoSync = true;
  const attempt = async () => {
    const waiting = (await queued()).some((r) => r.state === 'queued');
    if (!waiting) return;
    try { await drain(); } catch { /* still no link; try again later */ }
  };
  window.addEventListener('online', attempt);
  setInterval(attempt, 30_000);
}
