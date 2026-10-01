/**
 * Static server for the secretary interface.
 *
 * Node's own http module and nothing else. No bundler, no dev server, no
 * install step — the same reason the engine has no dependencies. A rodeo
 * secretary's laptop in an arena office is not a place to be resolving a
 * package tree, and a build step is a thing that can be broken on the one
 * night of the year it matters.
 *
 * In production this directory is served by any static host and this file is
 * not used. It exists so `node server.ts` works from a clean checkout.
 */

import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, 'public');

/**
 * The engine, served to the browser.
 *
 * The scoring and payout engine is TypeScript with no dependencies, and the
 * secretary's laptop has to run the same functions the server runs when the
 * wifi is gone. So this server strips the types with Node's own
 * `module.stripTypeScriptTypes` and serves the result as JavaScript at
 * /engine/. Nothing is bundled, nothing is copied, and there is no build step:
 * the file the browser runs is the file the server imports, minus its types.
 *
 * Type stripping only erases annotations, so the engine must stay erasable
 * syntax — no enums, no namespaces, no parameter properties. Its relative
 * imports already name `.ts` files, which resolve here unchanged.
 */
const ENGINE = resolve(import.meta.dirname, '../../packages/engine/src');
const stripped = new Map<string, string>();

async function engineFile(rel: string): Promise<string | null> {
  const file = join(ENGINE, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ENGINE) || !file.endsWith('.ts')) return null;
  const cached = stripped.get(file);
  if (cached !== undefined) return cached;
  try {
    const js = stripTypeScriptTypes(await readFile(file, 'utf8'));
    stripped.set(file, js);
    return js;
  } catch {
    return null;
  }
}

/** Every engine file, so the service worker can keep them for a night offline. */
async function engineManifest(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.name.endsWith('.ts')) out.push(`/engine/${relative(ENGINE, p)}`);
    }
  }
  await walk(ENGINE);
  return out.sort();
}
const PORT = Number(process.env.PORT ?? 5173);
const API = process.env.API_ORIGIN ?? 'http://localhost:3000';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // The client needs to know where the API is without a build step baking it
  // in. One endpoint, read once at start-up.
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'content-type': TYPES['.json'] });
    res.end(JSON.stringify({ api_origin: API }));
    return;
  }

  if (url.pathname === '/engine/manifest.json') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-cache' });
    res.end(JSON.stringify(await engineManifest()));
    return;
  }

  if (url.pathname.startsWith('/engine/')) {
    const js = await engineFile(url.pathname.slice('/engine/'.length));
    if (js === null) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' });
    res.end(js);
    return;
  }

  // Everything that is not a file is the app: this is a single page and the
  // routes are hash-based, but a hard refresh on a deep link must still work.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, safe);

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    const body = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    res.end(body);
  }
});

server.listen(PORT, () => {
  console.log(`Secretary interface on http://localhost:${PORT}  (API: ${API})`);
});
