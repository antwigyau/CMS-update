/**
 * Invariants that span files, where a mismatch would only show up in production.
 *
 * Two copies of the security headers exist by necessity: static assets are
 * served by Vercel's CDN from vercel.json, while API responses are built in
 * JavaScript. These tests make the duplication safe.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  API_HEADERS,
  ASSET_CACHE_CONTROL,
  CONTENT_SECURITY_POLICY,
  DOCUMENT_SECURITY_HEADERS,
} from '../../src/lib/security-headers.js';
import { APP_NAME, APP_VERSION } from '../../src/lib/version.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));

const vercelConfig = readJson('vercel.json');
const packageJson = readJson('package.json');

const headerBlock = (source) => {
  const entry = vercelConfig.headers.find((item) => item.source === source);
  assert.ok(entry, `vercel.json has no headers entry for ${source}`);
  return Object.fromEntries(entry.headers.map(({ key, value }) => [key, value]));
};

describe('package.json', () => {
  it('matches the version reported by /api/health', () => {
    assert.equal(packageJson.version, APP_VERSION);
    assert.equal(packageJson.name, APP_NAME);
  });

  it('pins a Node version Vercel actually offers', () => {
    // Verified 2026-08-26: Vercel offers 24.x (default), 22.x and 20.x.
    assert.match(packageJson.engines.node, /^(20|22|24)\.x$/);
  });

  it('is an ES module project, matching the import syntax used throughout', () => {
    assert.equal(packageJson.type, 'module');
  });

  it('keeps runtime dependencies to the two that were approved', () => {
    assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
      '@supabase/supabase-js',
      'zod',
    ]);
  });
});

describe('vercel.json rewrites', () => {
  it('funnels every /api path into the single function', () => {
    assert.deepEqual(vercelConfig.rewrites, [
      { source: '/api/(.*)', destination: '/api/index?path=$1' },
    ]);
  });

  it('carries the path as a query capture, which app.js uses as a fallback', () => {
    assert.match(vercelConfig.rewrites[0].destination, /\?path=\$1$/);
  });
});

describe('security headers: vercel.json matches src/lib/security-headers.js', () => {
  const documentHeaders = headerBlock('/(.*)');

  for (const [key, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
    it(`sets ${key} identically in both places`, () => {
      assert.equal(documentHeaders[key], value);
    });
  }

  it('does not set any header in vercel.json that the module does not know about', () => {
    assert.deepEqual(
      Object.keys(documentHeaders).sort(),
      Object.keys(DOCUMENT_SECURITY_HEADERS).sort(),
    );
  });

  it('caches assets with the documented policy', () => {
    assert.equal(headerBlock('/assets/(.*)')['Cache-Control'], ASSET_CACHE_CONTROL);
  });

  it('never caches API responses', () => {
    assert.equal(headerBlock('/api/(.*)')['Cache-Control'], API_HEADERS['Cache-Control']);
    assert.match(API_HEADERS['Cache-Control'], /no-store/);
  });
});

describe('content security policy', () => {
  it('allows no inline or eval-based script', () => {
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-inline/);
    assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe-eval/);
  });

  it('locks down the dangerous directives explicitly', () => {
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
    ]) {
      assert.ok(CONTENT_SECURITY_POLICY.includes(directive), `CSP is missing: ${directive}`);
    }
  });
});

/* ---- the CSP is only true if the markup honours it ----------------------- */

function walk(directory, extension) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'vendor') continue; // third-party, not ours to police
      found.push(...walk(full, extension));
    } else if (extname(entry) === extension) {
      found.push(full);
    }
  }
  return found;
}

describe('markup honours the CSP', () => {
  const htmlFiles = walk(join(ROOT, 'public'), '.html');

  it('finds the pages to check', () => {
    assert.ok(htmlFiles.length >= 2, 'expected at least the login and design-system pages');
  });

  for (const file of htmlFiles) {
    const relative = file.slice(ROOT.length).replaceAll('\\', '/');
    const html = readFileSync(file, 'utf8');

    it(`${relative} has no inline script`, () => {
      // <script> with no src= would be blocked by script-src 'self'.
      const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
      for (const tag of scriptTags) {
        assert.match(tag, /\ssrc=/, `inline <script> found in ${relative}: ${tag}`);
      }
    });

    it(`${relative} has no inline style attribute`, () => {
      // style="" would be blocked by style-src 'self' (via style-src-attr).
      assert.doesNotMatch(html, /\sstyle="/, `inline style attribute found in ${relative}`);
    });

    it(`${relative} declares a language and a viewport`, () => {
      assert.match(html, /<html[^>]+lang="/);
      assert.match(html, /name="viewport"/);
    });
  }
});
