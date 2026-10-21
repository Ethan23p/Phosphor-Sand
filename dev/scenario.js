// Runs a scenario module from dev/scenarios/ on the GPU (through harness.js):
// builds its grid, plays its scripted input, snapshots at its times, measures its
// regions, renders the strip with a header saying what it's for, and grades the
// result against its checks. See dev/README.md for the module format.
import { createHarness, blankGrid, fill, T, makeCell, makePlant, plantE, momOf, W, H, N, OVERRIDES } from './harness.js';
import { TUNING } from '../src/config.js';

export const STONE = makeCell(T.STONE, 0, 0), WATER = makeCell(T.WATER, 0, 0), SAND = makeCell(T.SAND, 0, 0);
export const lib = { blankGrid, fill, T, makeCell, makePlant, plantE, W, H, N, STONE, WATER, SAND, TUNING,
  // a filled disc of cell (or of cell(x, y) if it's a function)
  disc(g, cx, cy, r, cell) {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, cy + r); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, cx + r); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) g[y * W + x] = typeof cell === 'function' ? cell(x, y) : cell;
  },
  // a thick polyline (capsules between points) of cell, as a set of cells; returns the cell indices it covered
  path(g, pts, r, cell) {
    const hit = new Set();
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      for (let y = Math.floor(Math.min(ay, by) - r); y <= Math.ceil(Math.max(ay, by) + r); y++)
        for (let x = Math.floor(Math.min(ax, bx) - r); x <= Math.ceil(Math.max(ax, bx) + r); x++) {
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((x + .5 - ax) * dx + (y + .5 - ay) * dy) / l2)) : 0;
          if (Math.hypot(x + .5 - ax - dx * t, y + .5 - ay - dy * t) <= r) { g[y * W + x] = cell; hit.add(y * W + x); }
        }
    }
    return hit;
  },
};

// Chebyshev distance from each plant cell to the nearest non-plant cell (1 at the edge)
function plantDT(a) {
  const d = new Uint16Array(N), BIG = 9999;
  for (let i = 0; i < N; i++) d[i] = (a[i] & 255) === T.PLANT ? BIG : 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], d[i - 1] + 1, d[i - W - 1] + 1, d[i - W] + 1, d[i - W + 1] + 1);
  }
  for (let y = H - 2; y >= 1; y--) for (let x = W - 2; x >= 1; x--) {
    const i = y * W + x; if (!d[i]) continue;
    d[i] = Math.min(d[i], d[i + 1] + 1, d[i + W + 1] + 1, d[i + W] + 1, d[i + W - 1] + 1);
  }
  return d;
}

// Per-region measures of one snapshot. For each region (a predicate on x, y):
//   plant: cells; e: total energy; mov: total moving energy;
//   width: typical branch width, the median over ridge cells (local maxima of
//     the distance to the plant's edge) of 2 * that distance - 1: about 1 for
//     a one-cell ray, 10 for a 10px tendril;
//   thick: share of the region's plant cells in a body at least 5 cells wide.
// Plus water: water cells in the whole grid.
export function measure(a, m, regions) {
  const dt = plantDT(a), out = { water: 0 };
  const rs = Object.entries(regions);
  for (const [k] of rs) out[k] = { plant: 0, e: 0, mov: 0, ridges: [], thick: 0 };
  for (let i = 0; i < N; i++) {
    const t = a[i] & 255;
    if (t === T.WATER) out.water++;
    if (t !== T.PLANT) continue;
    const x = i % W, y = (i / W) | 0;
    let ridge = x > 0 && y > 0 && x < W - 1 && y < H - 1;
    if (ridge) for (const o of [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1]) if (dt[i + o] > dt[i]) { ridge = false; break; }
    const [mx, my] = m ? momOf(m[2 * i]) : [0, 0];
    for (const [k, f] of rs) {
      if (!f(x, y)) continue;
      const r = out[k]; r.plant++; r.e += plantE(a[i]); r.mov += Math.max(Math.abs(mx), Math.abs(my)) + 0.4142 * Math.min(Math.abs(mx), Math.abs(my));
      if (dt[i] >= 3) r.thick++;
      if (ridge) r.ridges.push(2 * dt[i] - 1);
    }
  }
  for (const [k] of rs) {
    const r = out[k], s = r.ridges.sort((p, q) => p - q);
    r.width = s.length ? s[s.length >> 1] : 0;
    r.thick = r.plant ? r.thick / r.plant : 0;
    delete r.ridges;
  }
  return out;
}

const fmtRegion = r => `plant ${String(r.plant).padStart(5)} E ${String(Math.round(r.e)).padStart(5)} mov ${String(Math.round(r.mov)).padStart(4)} width ${String(r.width).padStart(2)} thick ${String(Math.round(100 * r.thick)).padStart(3)}%`;

export async function runScenario() {
  const q = new URLSearchParams(location.search);
  const name = q.get('s'), mod = (await import(`./scenarios/${name}.js`)).default;
  const vname = q.get('v') || Object.keys(mod.variants || { '': 0 })[0];
  const v = { ...(mod.variants?.[vname] || {}), name: vname };
  document.title = `${name}${vname ? '/' + vname : ''}`;
  const head = document.getElementById('head');
  const ov = Object.entries(OVERRIDES).map(([k, x]) => `${k}=${x}`).join(' ');
  head.innerHTML = `<div style="font-size:20px;color:#fff">${document.title}${ov ? ` <span style="color:#fc6">[${ov}]</span>` : ''}</div>`
    + `<div style="font-size:15px;max-width:1700px;margin:4px 0">${mod.intent}</div>`
    + `<div style="font-size:15px;color:#9d9">Good: ${mod.expect.join(' · ')}</div>`
    + (mod.legend ? `<div style="font-size:13px;color:#999">${mod.legend}</div>` : '');

  const h = await createHarness();
  const g = blankGrid();
  const built = mod.build(g, v, lib) || {};
  h.load(g, built.mom);
  if (mod.init) mod.init(h, v, lib);
  const regions = (mod.regions && mod.regions(v)) || { all: () => true };
  const series = [];
  const line = (a, mm) => {
    const r = measure(a, mm, regions); r.t = h.step / 180;
    // a scenario's own measures (mod.measure(a, lib, v) -> { name: number })
    const own = mod.measure ? mod.measure(a, lib, v) : null;
    if (own) Object.assign(r, own);
    series.push(r);
    if (own) return Object.entries(own).map(([k, x]) => `${k} ${typeof x === 'number' ? +x.toFixed(2) : x}`).join(' | ');
    return `water ${String(r.water).padStart(5)} | ` + Object.keys(regions).map(k => `${k}: ${fmtRegion(r[k])}`).join(' | ');
  };
  const times = mod.times || [5, 15, 30, 60, 100, 180];
  const input = mod.input ? s => mod.input(h, s, v, lib) : null;
  await h.snapshot(line, { mom: mod.plantRows !== false });
  for (const t of times) {
    // run in chunks of a sim-second so progress shows and the page stays responsive
    while (h.step < t * 180) { h.run(Math.min(180, t * 180 - h.step), input); await h.read(); }
    await h.snapshot(line, { mom: mod.plantRows !== false });
  }
  h.finish(`${document.title}`, { zoom: mod.zoom && mod.zoom(v) });
  document.getElementById('strip').append(document.getElementById('cv'));

  const checks = mod.checks ? mod.checks(series, v) : [];
  const pass = checks.every(c => c.ok);
  const verdict = checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.text}`).join('\n');
  const out = document.getElementById('out');
  out.textContent += `\n\n${verdict}\nVERDICT ${pass ? 'PASS' : 'FAIL'} (${checks.filter(c => c.ok).length}/${checks.length})`;
  for (const l of verdict.split('\n')) console.log('CHECK ' + l);
  console.log(`VERDICT ${pass ? 'PASS' : 'FAIL'}`);
  window.__result = { name, variant: vname, series, checks, pass };
  console.log('DONE');
}
