// How the loose materials fall, pile, flow and settle. One variant per
// question; each measures its own numbers (see measure) instead of the plant stats.
const FLOOR = 236;
const COLS = { sand: 40, water: 100, seed: 160, ember: 220 };   // fall: one blob per material

// For each column x, the top of the material of type t (H if none), scanning down from y0
function tops(a, t, x0, x1, y0, { W, H }) {
  const out = [];
  for (let x = x0; x < x1; x++) {
    let y = y0; while (y < H && (a[y * W + x] & 255) !== t) y++;
    out.push(y);
  }
  return out;
}
function meanY(a, t, f, { W, N }) {
  let s = 0, n = 0;
  for (let i = 0; i < N; i++) if ((a[i] & 255) === t && f(i % W, (i / W) | 0)) { s += (i / W) | 0; n++; }
  return n ? s / n : -1;
}

export default {
  intent: 'Gravity for the loose materials. fall: equal blobs of sand, water, seed and ember dropped from the top (how fast, do they accelerate, do they keep their shape). '
    + 'pile: sand poured from a point onto a floor (angle of repose, avalanches). dam: a tall water column released into an empty tank (how fast it levels). '
    + 'sink: sand, seeds and embers dropped onto a pool (do the heavy things sink, do the light things float, does the water get displaced).',
  expect: ['falling things speed up', 'sand piles with a natural, slightly irregular slope', 'water levels within a few seconds', 'heavy sinks, light floats'],
  legend: 'Cells only. Stats: fall: mean y of each blob; pile: height, half-width, slope (degrees); dam: surface top-bottom spread; sink: mean y of each solid vs the pool surface.',
  plantRows: false,
  variants: { fall: { k: 'fall' }, pile: { k: 'pile' }, dam: { k: 'dam' }, sink: { k: 'sink' } },
  times: [0.25, 0.5, 1, 2, 5, 15],
  build(g, v, { fill, disc, makeCell, T, STONE, WATER, SAND }) {
    fill(g, 1, 255, FLOOR, 255, STONE);
    if (v.k === 'fall') {
      const cell = { sand: SAND, water: WATER, seed: makeCell(T.SEED, 0, 0), ember: makeCell(T.EMBER, 200, 0) };
      for (const [k, x] of Object.entries(COLS)) disc(g, x, 20, 10, cell[k]);
    }
    if (v.k === 'dam') fill(g, 2, 40, 40, FLOOR, WATER);
    if (v.k === 'sink') {
      fill(g, 2, 254, 176, FLOOR, WATER);
      fill(g, 20, 70, 140, 150, SAND);
      fill(g, 100, 150, 140, 150, makeCell(T.SEED, 0, 0));
      fill(g, 180, 230, 140, 150, makeCell(T.EMBER, 200, 0));
    }
  },
  input(h, s, v, { T }) {
    if (v.k === 'pile' && s % 3 === 0) h.brush({ x0: 128, y0: 30, x1: 128.5, y1: 30, r: 3, type: T.SAND, density: 160 });
  },
  measure(a, lib, v) {
    const { T } = lib;
    if (v.k === 'fall') {
      const out = {};
      for (const [k, x] of Object.entries(COLS)) out[k] = meanY(a, T[k.toUpperCase()], (px) => Math.abs(px - x) < 30, lib);
      return out;
    }
    if (v.k === 'pile') {
      // the settled pile: for each column, the sand stacked up from the floor without a gap (not the stream)
      const { W } = lib, col = [];
      for (let x = 2; x < 254; x++) { let y = FLOOR - 1; while (y > 0 && (a[y * W + x] & 255) === T.SAND) y--; col.push(FLOOR - 1 - y); }
      const height = Math.max(...col), xs = col.map((n, k) => n > 0 ? k : -1).filter(k => k >= 0);
      if (xs.length < 8) return { height, half: 0, slope: 0 };
      // the flanks' slope, between a quarter and three quarters of the way in from each edge
      // (the peak is left out: the falling stream stacks on it)
      const l = xs[0], r = xs[xs.length - 1], q = Math.max(1, Math.floor((r - l) / 8));
      const rise = (col[l + 3 * q] - col[l + q] + col[r - 3 * q] - col[r - q]) / 2;
      return { height, half: (r - l + 1) / 2, slope: Math.atan2(rise, 2 * q) * 180 / Math.PI };
    }
    if (v.k === 'dam') {
      const t = tops(a, T.WATER, 2, 254, 0, lib).map(y => Math.min(y, FLOOR));
      return { highest: FLOOR - Math.min(...t), lowest: FLOOR - Math.max(...t), spread: Math.max(...t) - Math.min(...t) };
    }
    if (v.k === 'sink') {
      const ts = tops(a, T.WATER, 2, 254, 100, lib).sort((p, q) => p - q), surf = ts[ts.length >> 1];   // median surface
      return { surface: surf, sand: meanY(a, T.SAND, () => true, lib), seed: meanY(a, T.SEED, () => true, lib), sprout: meanY(a, T.PLANT, () => true, lib), ember: meanY(a, T.EMBER, () => true, lib) };
    }
  },
  checks(s, v) {
    const e = s[s.length - 1];
    if (v.k === 'fall') {
      // distance in the first half second vs the second half second: > 1 means it accelerates
      const a = s[1], b = s[2], c = s[3];
      const acc = (b.sand - a.sand) > 0 ? ((c.sand - b.sand) / 2) / (b.sand - a.sand) : 0;
      return [{ ok: acc > 1.2, text: `sand speeds up: later/earlier speed ratio ${acc.toFixed(2)} (want > 1.2)` }];
    }
    if (v.k === 'pile') return [{ ok: e.slope > 25 && e.slope < 42, text: `slope ${e.slope.toFixed(1)} deg (want 25-42, a sand-like angle of repose)` }];
    if (v.k === 'dam') {
      const at5 = s.find(r => r.t >= 5);
      return [{ ok: at5.spread <= 4, text: `levels: surface spread ${at5.spread} cells at 5s (want <= 4)` }];
    }
    if (v.k === 'sink') return [
      { ok: e.sand > e.surface + 20, text: `sand sinks: mean y ${e.sand.toFixed(0)}, surface ${e.surface}` },
      { ok: Math.max(e.seed, e.sprout) < e.surface + 4, text: `seeds float: mean y ${e.seed.toFixed(0)} (sprouts ${e.sprout.toFixed(0)}), surface ${e.surface}` },
    ];
    return [];
  },
};
