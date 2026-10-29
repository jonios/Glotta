#!/usr/bin/env node
// Renders the PNG brand assets from their sources with a headless Chrome/Edge:
//   docs/assets/banner.html  -> docs/assets/banner.png (1280x640, README banner / GitHub social preview)
//   web/public/glotta-mark.svg -> web/public/apple-touch-icon.png (180x180) and docs/assets/logo.png (512x512)
// Usage: node scripts/render-branding.mjs   (set CHROME_PATH if Chrome/Edge is installed elsewhere)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!chrome) throw new Error('No Chrome/Edge found; set CHROME_PATH');

const tmp = mkdtempSync(join(tmpdir(), 'glotta-brand-'));
function shot(url, out, w, h) {
  execFileSync(chrome, ['--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${join(tmp, 'profile')}`, `--window-size=${w},${h}`, '--virtual-time-budget=4000', `--screenshot=${resolve(out)}`, url], { stdio: 'ignore' });
  console.log(`wrote ${out}`);
}
/** Square icon page: the SVG mark centred on a transparent-looking dark tile. */
function iconPage(size, pad) {
  const svg = readFileSync('web/public/glotta-mark.svg', 'utf8');
  const file = join(tmp, `icon-${size}.html`);
  writeFileSync(file, `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:#0b0e16;display:grid;place-items:center"><div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`);
  return pathToFileURL(file).href;
}
try {
  shot(pathToFileURL(resolve('docs/assets/banner.html')).href, 'docs/assets/banner.png', 1280, 640);
  shot(iconPage(180, 22), 'web/public/apple-touch-icon.png', 180, 180);
  shot(iconPage(512, 64), 'docs/assets/logo.png', 512, 512);
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
