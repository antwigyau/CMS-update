/**
 * Local development server. Zero dependencies, ~150 lines.
 *
 * Why this exists rather than relying on `vercel dev`:
 *   - it runs the *same* handleRequest() the Vercel Function runs, so local
 *     behaviour is not an approximation of production
 *   - it applies the same security headers, so a CSP violation shows up on
 *     localhost instead of after a deploy
 *   - it needs no CLI login, no Docker, and no network
 *
 * Usage: npm run dev   ->   http://localhost:3000
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../src/config/env.js';
import {
  ASSET_CACHE_CONTROL,
  BASE_SECURITY_HEADERS,
  DOCUMENT_SECURITY_HEADERS,
  HTML_CACHE_CONTROL,
} from '../src/lib/security-headers.js';
import { handleRequest } from '../src/server/app.js';

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Candidate files for a URL path, mirroring Vercel's cleanUrls behaviour. */
function candidatesFor(pathname) {
  const clean = pathname.replace(/\/+$/, '');
  if (clean === '') return ['index.html'];
  const relative = clean.replace(/^\/+/, '');
  return [relative, `${relative}.html`, `${relative}/index.html`];
}

async function resolveStaticFile(pathname) {
  for (const candidate of candidatesFor(pathname)) {
    const absolute = resolve(PUBLIC_DIR, candidate);

    // Path traversal guard: never serve outside public/.
    if (absolute !== PUBLIC_DIR && !absolute.startsWith(PUBLIC_DIR + sep)) continue;

    try {
      const stats = await stat(absolute);
      if (stats.isFile()) return absolute;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function serveStatic(pathname, res) {
  const file = await resolveStaticFile(pathname);

  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_SECURITY_HEADERS });
    res.end('404 Not Found');
    return;
  }

  const extension = extname(file).toLowerCase();
  const isHtml = extension === '.html';

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'Cache-Control': isHtml ? HTML_CACHE_CONTROL : ASSET_CACHE_CONTROL,
    ...(isHtml ? DOCUMENT_SECURITY_HEADERS : BASE_SECURITY_HEADERS),
  });
  res.end(await readFile(file));
}

function toWebHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

async function serveApi(req, res) {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const request = new Request(`http://${host}${req.url}`, {
    method,
    headers: toWebHeaders(req.headers),
    body: hasBody ? await readRequestBody(req) : undefined,
  });

  const response = await handleRequest(request);

  const outgoing = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') outgoing[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) outgoing['Set-Cookie'] = cookies;

  res.writeHead(response.status, outgoing);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer.length === 0 ? undefined : buffer);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const handler =
    pathname === '/api' || pathname.startsWith('/api/')
      ? serveApi
      : (a, b) => serveStatic(pathname, b);

  Promise.resolve(handler(req, res)).catch((error) => {
    // Dev-only: the API path never reaches here (handleRequest maps its own
    // errors), so this is a static-serving or adapter fault worth seeing raw.
    process.stderr.write(`[dev-server] ${error?.stack ?? error}\n`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error');
  });
});

server.listen(PORT, () => {
  process.stdout.write(
    [
      '',
      `  Church Management System — dev server`,
      `  http://localhost:${PORT}`,
      '',
      `  static    ${PUBLIC_DIR}`,
      `  api       /api/*  ->  src/server/app.js`,
      `  supabase  ${config.supabase.configured ? 'configured' : 'NOT configured (set SUPABASE_* in .env.local)'}`,
      '',
    ].join('\n'),
  );
});
