/**
 * Copies pinned third-party assets out of node_modules into
 * public/assets/vendor/ so they can be served from our own origin.
 *
 * Why not a CDN: the Content-Security-Policy is `script-src 'self'` and
 * `style-src 'self'` with no exceptions. Serving Bootstrap from jsdelivr would
 * mean widening the CSP to a third-party origin, and would make the app depend
 * on that origin being up. Vendoring costs one build step and removes both.
 *
 * Why not commit the files: the version then lives in two places (package.json
 * and the committed blob) and the blob goes stale. This script is the Vercel
 * build command, so the deployed copy always matches package.json.
 *
 * Usage: npm run vendor:refresh
 */

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODULES = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'public', 'assets', 'vendor');

/** [source relative to node_modules, destination relative to vendor dir] */
const ASSETS = [
  ['bootstrap/dist/css/bootstrap.min.css', 'bootstrap/bootstrap.min.css'],
  ['bootstrap/dist/js/bootstrap.bundle.min.js', 'bootstrap/bootstrap.bundle.min.js'],
  ['bootstrap-icons/font/bootstrap-icons.min.css', 'bootstrap-icons/bootstrap-icons.min.css'],
  [
    'bootstrap-icons/font/fonts/bootstrap-icons.woff2',
    'bootstrap-icons/fonts/bootstrap-icons.woff2',
  ],
  ['bootstrap-icons/font/fonts/bootstrap-icons.woff', 'bootstrap-icons/fonts/bootstrap-icons.woff'],
];

async function main() {
  await rm(VENDOR, { recursive: true, force: true });

  for (const [from, to] of ASSETS) {
    const source = join(MODULES, from);
    const destination = join(VENDOR, to);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    process.stdout.write(`  vendored  ${to}\n`);
  }

  process.stdout.write(`\n  ${ASSETS.length} files -> public/assets/vendor/\n`);
}

main().catch((error) => {
  process.stderr.write(
    `\nvendor:refresh failed — ${error.message}\n` +
      'Run `npm install` first; these files come from devDependencies.\n',
  );
  process.exitCode = 1;
});
