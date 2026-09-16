/**
 * Offline write queue.
 *
 * ---------------------------------------------------------------------------
 * A SCORE TYPED WITH NO SIGNAL IS NOT A SCORE THAT IS LOST.
 * ---------------------------------------------------------------------------
 * Reads survive going offline because the service worker serves the last copy
 * it saw. Writes are harder: a POST that never reached the server did not
 * happen, and the secretary has already looked away at the next run. So a write
 * that fails purely because the network is gone is not thrown away — it is
 * appended here, in order, and replayed the moment the connection returns.
 *
 * The store is localStorage, not IndexedDB. The queue is a short list of small
 * JSON bodies — a night's worth of scores is kilobytes — and localStorage is
 * synchronous, which means a write cannot be half-queued if the tab is closed
 * mid-operation. Order is preserved and the queue is drained from the front, so
 * a correction keyed after a score replays after that score.
 *
 * Only the network decides what lands here. An HTTP error — a validation
 * failure, a permission denial — is a real answer from the server and must
 * surface to the secretary now, not be silently queued and replayed into the
 * same rejection later.
 */

const KEY = 'rodeo.offline.queue';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function write(queue) {
  localStorage.setItem(KEY, JSON.stringify(queue));
  notify();
}

const listeners = new Set();

/** Subscribe to queue-size changes — the top bar shows how many writes wait. */
export function onQueueChange(fn) {
  listeners.add(fn);
  fn(queueSize());
  return () => listeners.delete(fn);
}

function notify() {
  const n = queueSize();
  for (const fn of listeners) fn(n);
}

export function queueSize() {
  return read().length;
}

/** Append a write. Returns the new queue length. */
export function enqueue(entry) {
  const queue = read();
  queue.push({
    ...entry,
    id: (crypto.randomUUID?.() ?? String(Date.now() + Math.random())),
    queued_at: new Date().toISOString(),
  });
  write(queue);
  return queue.length;
}

let flushing = false;

/**
 * Replay the queue front to back. `send(entry)` performs the real request and
 * must resolve on success and reject on failure. On the first failure — still
 * offline, or a request the server now rejects — replay stops and everything
 * from that entry on stays queued, so nothing is dropped and order holds.
 */
export async function flush(send) {
  if (flushing) return;
  flushing = true;
  try {
    while (true) {
      const queue = read();
      if (queue.length === 0) break;
      const entry = queue[0];
      try {
        await send(entry);
      } catch {
        break;
      }
      // Re-read before shifting: the tab may have queued more while we waited.
      const after = read();
      after.shift();
      write(after);
    }
  } finally {
    flushing = false;
  }
}
