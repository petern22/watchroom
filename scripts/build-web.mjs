// Builds the installable web app (PWA) into dist-web/.
// Same app code as the desktop app. The browser adapter fills in the desktop-only features.
// Run with: npm run build:web

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-web');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const buildId = `${pkg.version}-${Date.now().toString(36)}`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'renderer/app.js')],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  outfile: path.join(out, 'bundle.js'),
  define: { __WEB_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'error',
});

await cp(path.join(root, 'renderer/styles.css'), path.join(out, 'styles.css'));
await cp(path.join(root, 'pwa/manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
await cp(path.join(root, 'pwa/_headers'), path.join(out, '_headers'));
await cp(path.join(root, 'pwa/icons'), path.join(out, 'icons'), { recursive: true });

const sw = await readFile(path.join(root, 'pwa/sw.js'), 'utf8');
await writeFile(path.join(out, 'sw.js'), sw.replace('__BUILD__', buildId));

// The desktop page stays clean. The installable-app tags are added only to the web copy.
const pwaTags = `
    <link rel="manifest" href="manifest.webmanifest" />
    <link rel="icon" href="icons/icon-192.png" />
    <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
    <meta name="theme-color" content="#0b0c0d" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="Watchroom" />
  </head>`;
let html = await readFile(path.join(root, 'renderer/index.html'), 'utf8');
html = html.replace('</head>', pwaTags).replace('initial-scale=1', 'initial-scale=1, viewport-fit=cover');
await writeFile(path.join(out, 'index.html'), html);

console.log(`web build ${buildId} written to ${out}`);
