// Captures the screenshots used in README.md from a running local app.
//
//   npm run dev                      (in another terminal)
//   TMS_EMAIL=... TMS_PASSWORD=... node scripts/docs-screenshots.mjs [--demo-review]
//
// Drives a headless Chrome/Edge through the DevTools protocol (no extra packages). Use a local
// development database only: --demo-review sends one Arabic translation back for review so the
// Review screens have content, and approves it again at the end.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.TMS_URL || 'http://localhost:5173';
const EMAIL = process.env.TMS_EMAIL;
const PASSWORD = process.env.TMS_PASSWORD;
const OUT = resolve('docs/images');
const PORT = 9333;
const DEMO_REVIEW = process.argv.includes('--demo-review');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');

if (!EMAIL || !PASSWORD) {
  console.error('Set TMS_EMAIL and TMS_PASSWORD (a local Super Admin account).');
  process.exit(1);
}
const browserPath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!browserPath) throw new Error('No Chrome/Edge found; set CHROME_PATH');

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'tms-shots-'));
const browser = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--hide-scrollbars',
  'about:blank',
]);

// ---------------------------------------------------------------- DevTools protocol plumbing
let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = pages.find((p) => p.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {
    await sleep(200);
  }
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
/** Runs an expression in the page and returns its (awaited) value. */
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const api = (path, init) => evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init ?? {})}).then(r => r.json())`);
const post = (path, body) =>
  evaluate(`fetch('/api/auth/me').then(r=>r.json()).then(me => fetch(${JSON.stringify(path)}, {
    method:'POST', headers:{'content-type':'application/json','X-CSRF-Token':me.csrfToken}, body:${JSON.stringify(JSON.stringify(body))}
  })).then(r => r.json())`);

const goto = async (path, settle = 1500) => {
  await send('Page.navigate', { url: BASE + path });
  for (let i = 0; i < 50; i++) {
    if ((await evaluate('document.readyState')) === 'complete') break;
    await sleep(100);
  }
  await waitIdle();
  await sleep(settle);
};
/** Waits until skeleton placeholders are gone (data loaded). */
const waitIdle = async () => {
  for (let i = 0; i < 60; i++) {
    if (!(await evaluate(`!!document.querySelector('.skeleton, [class*="animate-pulse"]')`))) return;
    await sleep(150);
  }
};
/** Clicks the first visible button/link/radio whose text (or aria-label) matches. */
const click = async (text, settle = 900) => {
  const ok = await evaluate(`(() => {
    const t = ${JSON.stringify(text)};
    const els = [...document.querySelectorAll('button, a, [role="radio"], [role="tab"]')]
      .filter(e => e.offsetParent && ((e.textContent || '').trim() === t || e.getAttribute('aria-label') === t || (e.textContent || '').trim().startsWith(t)));
    els[0]?.click();
    return !!els[0];
  })()`);
  if (!ok) throw new Error(`Nothing to click: ${text}`);
  await sleep(settle);
  await waitIdle();
};
const type = async (text) => {
  await send('Input.insertText', { text });
  await sleep(300);
};
const key = async (k) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k });
  await sleep(500);
};
// Real people's names/emails must not end up in the repository: rows that mention any account
// outside the demo domain (@tms.test) are hidden before each screenshot.
let realPeople = [];
const hideRealPeople = () =>
  realPeople.length &&
  evaluate(`(() => {
    const needles = ${JSON.stringify(realPeople)};
    for (const row of document.querySelectorAll('tr, li')) {
      const t = row.textContent || '';
      if (needles.some((n) => t.includes(n))) row.style.display = 'none';
    }
  })()`);
const shoot = async (name) => {
  await hideRealPeople();
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  ✓ ${name}.png`);
};

// ---------------------------------------------------------------- shots
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

const shots = [];
const shot = (name, fn) => shots.push({ name, fn });

shot('01-sign-in', async () => {
  await goto('/');
  await shoot('01-sign-in');
});

let demo = null; // { translationId, keyId }
let arabic, persian;
const login = async () => {
  await goto('/', 300);
  const r = await evaluate(`fetch('/api/auth/login', {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} })}).then(r => r.status)`);
  if (r !== 200) throw new Error(`Login failed (${r})`);
  const langs = await api('/api/languages');
  arabic = langs.find((l) => l.code === 'ar')?.id;
  persian = langs.find((l) => l.code === 'fa')?.id;
  const users = await api('/api/users');
  realPeople = (users.users ?? users)
    .filter((u) => !u.email.endsWith('@tms.test'))
    .flatMap((u) => [u.email, u.name]);
};

shot('02-overview', async () => {
  await goto('/');
  await shoot('02-overview');
});
shot('03-workspace', async () => {
  await goto(`/workspace?lang=${arabic}`);
  await shoot('03-workspace');
});
shot('04-workspace-filters', async () => {
  await goto(`/workspace?lang=${arabic}&statuses=missing`);
  await click('Filters');
  await shoot('04-workspace-filters');
  await key('Escape');
});
shot('06-editor', async () => {
  const k = (await api(`/api/keys?search=about_us_privacy_policy&languageIds=${arabic}&pageSize=1`)).rows[0];
  await goto(`/workspace?lang=${arabic}&key=${k.id}`, 2000);
  await shoot('06-editor');
});
shot('07-new-key', async () => {
  await goto(`/workspace?lang=${arabic}`);
  await click('New key');
  await shoot('07-new-key');
  await key('Escape');
});
shot('08-request-changes', async () => {
  const k = (await api(`/api/keys?search=about_us_privacy_policy&languageIds=${arabic}&pageSize=1`)).rows[0];
  await goto(`/workspace?lang=${arabic}&key=${k.id}`, 2000);
  await click('Request changes');
  await type('Please use the formal tone here');
  await shoot('08-request-changes');
  await key('Escape'); // cancel: nothing is sent
});
shot('09-review', async () => {
  if (DEMO_REVIEW) {
    const k = (await api(`/api/keys?search=about_us_privacy_policy&languageIds=${arabic}&pageSize=1`)).rows[0];
    const t = k.translations[arabic];
    if (t.status !== 'in_progress') {
      await post(`/api/translations/${t.id}/review`, { action: 'request_changes', comment: 'Please use the formal tone here', expectedVersion: t.version });
      demo = { translationId: t.id, keyId: k.id };
    }
  }
  await goto('/review');
  await click('Returned', 1500);
  await shoot('09-review');
});
shot('10-editor-feedback', async () => {
  if (!demo) return;
  await goto(`/workspace?lang=${arabic}&key=${demo.keyId}`, 2000);
  await shoot('10-editor-feedback');
});
shot('11-import', async () => {
  await goto('/import-export/import');
  await shoot('11-import');
});
shot('12-export-excel', async () => {
  await goto('/import-export/excel');
  await shoot('12-export-excel');
});
shot('13-export-resources', async () => {
  await goto('/import-export/resources');
  await shoot('13-export-resources');
});
shot('14-conflicts', async () => {
  await goto('/import-export/conflicts');
  await shoot('14-conflicts');
});
shot('15-users', async () => {
  await goto('/users');
  await shoot('15-users');
});
shot('16-invite-user', async () => {
  await goto('/users');
  await click('Invite user');
  await shoot('16-invite-user');
  await key('Escape');
});
shot('17-platforms', async () => {
  await goto('/platforms');
  await shoot('17-platforms');
});
shot('18-languages', async () => {
  await goto('/languages');
  await shoot('18-languages');
});
shot('19-segments', async () => {
  await goto('/segments');
  await shoot('19-segments');
});
shot('20-activity', async () => {
  await goto('/activity');
  await shoot('20-activity');
});
shot('21-settings', async () => {
  await goto('/settings');
  await shoot('21-settings');
});

// API Access: creates a demo key through the UI (revoked again at the end, so the key in the image is dead).
const DEMO_KEY_NAME = 'iOS Driver app (docs demo)';
shot('22-api-key-new', async () => {
  await goto('/api-access/keys');
  await click('New API key');
  await type(DEMO_KEY_NAME);
  await shoot('22-api-key-new');
  await click('Create key', 1500);
  await shoot('23-api-key-created');
  await click('Done');
  await shoot('24-api-keys');
});
shot('27-ai-missing-keys', async () => {
  await goto('/ai-translation/missing');
  await shoot('27-ai-missing-keys');
});
shot('28-ai-auto-translate', async () => {
  await goto('/ai-translation/missing');
  await click('Auto translate all', 2500);
  await shoot('28-ai-auto-translate');
  await key('Escape');
});
shot('25-api-docs', async () => {
  await goto('/api-access/docs');
  await shoot('25-api-docs');
  await evaluate(`document.getElementById('keywords').scrollIntoView()`);
  await sleep(400);
  await shoot('26-api-docs-keywords');
});

try {
  for (const s of shots) {
    if (s.name === '02-overview') await login();
    if (ONLY && !ONLY.includes(s.name)) continue;
    try {
      await s.fn();
    } catch (err) {
      console.error(`  ✗ ${s.name}: ${err.message}`);
    }
  }
} finally {
  if (demo) {
    const k = (await api(`/api/keys/${demo.keyId}?languageIds=${arabic}`)).translations[arabic];
    await post(`/api/translations/${demo.translationId}/review`, { action: 'approve', comment: '', expectedVersion: k.version });
    console.log('  demo translation approved again');
  }
  const demoKeys = (await api('/api/api-keys').catch(() => [])).filter?.((k) => k.name === DEMO_KEY_NAME && k.status === 'active') ?? [];
  for (const k of demoKeys) await post(`/api/api-keys/${k.id}/revoke`, {});
  if (demoKeys.length) console.log(`  revoked ${demoKeys.length} demo API key(s)`);
  ws.close();
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
