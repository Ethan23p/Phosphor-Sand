// Run scenarios headlessly and save their strips.
//
//   node dev/strip.mjs <scenario[/variant]>... [TUNING=value ...] [--tag name] [--jobs 4]
//   node dev/strip.mjs plants                  # the plant suite (see SUITES)
//   node dev/strip.mjs waterfall/heavy BLOOM_E=4
//   node dev/strip.mjs pipe --tag before        # every variant of pipe
//   node dev/strip.mjs garden.html              # a standalone dev/*.html page (no checks)
//
// Writes dev/out/<tag>_<scenario>_<variant>[_overrides].png (the strip, with a
// header saying what it's for) and .txt (per-snapshot stats and the checks), and
// prints each snapshot as it lands plus a PASS/FAIL table at the end. Serves the
// repo itself and drives the installed Chrome through playwright-core (installed
// once into %LOCALAPPDATA%/phosphor-sand-tools on first use). Hard timeout per
// scenario; at most --jobs scenarios at once.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dev', 'out');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SUITES = { plants: ['waterfall', 'pipe', 'tunnel', 'reservoir', 'meadow'], elements: ['gravity', 'oil'] };
const PER_RUN_TIMEOUT = 240e3;

// ── args ──
const argv = process.argv.slice(2);
let tag = 'run', jobs = 4;
const names = [], overrides = [];
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a === '--tag') tag = argv[++k];
  else if (a === '--jobs') jobs = +argv[++k];
  else if (/^[A-Z_]+=\d+$/.test(a)) overrides.push(a);
  else names.push(...(SUITES[a] || [a]));
}
if (!names.length) {
  console.log('usage: node dev/strip.mjs <scenario[/variant]|suite>... [TUNING=value ...] [--tag name] [--jobs n]');
  console.log('scenarios: ' + fs.readdirSync(path.join(ROOT, 'dev', 'scenarios')).map(f => f.replace(/\.js$/, '')).join(' '));
  console.log('suites: ' + Object.entries(SUITES).map(([k, v]) => `${k} (${v.join(' ')})`).join(', '));
  process.exit(1);
}
// expand a bare scenario name into all its variants
const runs = [];
for (const n of names) {
  if (n.endsWith('.html')) { runs.push({ s: n, v: '', page: true }); continue; }  // a standalone dev page
  const [s, v] = n.split('/');
  const file = path.join(ROOT, 'dev', 'scenarios', s + '.js');
  if (!fs.existsSync(file)) { console.log(`no scenario ${s} (dev/scenarios/${s}.js)`); process.exit(1); }
  // scenario modules import nothing (the page hands them lib), so node can load them too
  const vars = v ? [v] : Object.keys((await import(pathToFileURL(file))).default.variants || {});
  for (const x of (vars.length ? vars : [''])) runs.push({ s, v: x });
}

// ── playwright-core, installed once outside the repo ──
function loadPlaywright() {
  const dir = path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME, '.cache'), 'phosphor-sand-tools');
  const req = createRequire(path.join(dir, 'x.js'));
  try { return req('playwright-core'); } catch {}
  console.log(`installing playwright-core into ${dir} (once)...`);
  fs.mkdirSync(dir, { recursive: true });
  execSync('npm install --no-save --silent playwright-core', { cwd: dir, stdio: 'inherit' });
  return req('playwright-core');
}

// ── static server for the repo ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((rq, rs) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(rq.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rs.writeHead(404); rs.end(); return; }
  rs.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(rs);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const { chromium } = loadPlaywright();
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now(), el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`.padStart(4);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu'] });
const results = [];

async function runOne({ s, v, page }) {
  const id = [s, v].filter(Boolean).join('/');
  const file = [tag, s.replace('.html', ''), v, ...overrides.map(o => o.replace('=', ''))].filter(Boolean).join('_');
  const pg = await browser.newPage({ viewport: { width: 1800, height: 900 } });
  pg.on('console', m => {
    const t = m.text();
    if (/^step|^CHECK|^VERDICT|^ERROR/.test(t) || (m.type() === 'error' && !/404/.test(t))) console.log(`[${el()}] ${id}: ${t.replace(/^CHECK /, '  ').slice(0, 400)}`);
  });
  pg.on('pageerror', e => console.log(`[${el()}] ${id}: PAGEERROR ${e.message}`));
  const url = page ? `http://127.0.0.1:${port}/dev/${s}${overrides.length ? '?' + overrides.join('&') : ''}`
    : `http://127.0.0.1:${port}/dev/scenario.html?s=${s}${v ? '&v=' + v : ''}${overrides.map(o => '&' + o).join('')}`;
  try {
    await pg.goto(url);
    await pg.waitForFunction(page => page ? document.getElementById('out').textContent !== 'running...' && document.getElementById('cv')
      : window.__result || /^ERROR/.test(document.getElementById('out').textContent), page, { timeout: PER_RUN_TIMEOUT, polling: 500 });
    const res = page ? { pass: true, checks: [{ ok: true, text: '(no checks: standalone page)' }] } : await pg.evaluate(() => window.__result);
    await (await pg.$(page ? '#cv' : '#report')).screenshot({ path: path.join(OUT, file.replace('.html', '') + '.png') });
    fs.writeFileSync(path.join(OUT, file + '.txt'), await pg.$eval('#out', e => e.textContent));
    results.push({ id, pass: res?.pass, checks: res?.checks || [], file });
    console.log(`[${el()}] ${id}: done -> dev/out/${file}.png`);
  } catch (e) {
    results.push({ id, pass: false, checks: [{ ok: false, text: 'did not finish: ' + e.message.split('\n')[0] }], file });
    console.log(`[${el()}] ${id}: FAILED ${e.message.split('\n')[0]}`);
  }
  await pg.close();
}

console.log(`[${el()}] ${runs.length} run(s), ${Math.min(jobs, runs.length)} at a time${overrides.length ? ', with ' + overrides.join(' ') : ''}`);
const queue = [...runs];
await Promise.all(Array.from({ length: Math.min(jobs, runs.length) }, async () => { while (queue.length) await runOne(queue.shift()); }));
await browser.close(); server.close();

console.log('\n── summary ──');
for (const r of runs.map(({ s, v }) => results.find(x => x.id === [s, v].filter(Boolean).join('/')))) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(22)} dev/out/${r.file}.png`);
  for (const c of r.checks) if (!c.ok) console.log(`        - ${c.text}`);
}
process.exit(0);
