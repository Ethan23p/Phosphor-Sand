// Soap: a liquid between oil and water. It sorts between them, mixes them where
// it touches both, and lathers into foam under falling liquid.
const FLOOR = 236, TOP = 120, IFACE = 190;   // tank top, the oil/water boundary in layer

function stats(a, { W, N, T }) {
  const out = { oil: 0, soap: 0, water: 0, foam: 0, oy: 0, sy: 0, wy: 0, sunk: 0 };
  for (let i = 0; i < N; i++) {
    const t = a[i] & 255, y = (i / W) | 0;
    if (t === T.OIL) { out.oil++; out.oy += y; if (y > IFACE + 2) out.sunk++; }
    if (t === T.SOAP) { out.soap++; out.sy += y; }
    if (t === T.WATER) { out.water++; out.wy += y; }
    if (t === T.FOAM) out.foam++;
  }
  for (const [k, n] of [['oy', 'oil'], ['sy', 'soap'], ['wy', 'water']]) out[k] = out[n] ? +(out[k] / out[n]).toFixed(1) : -1;
  return out;
}

export default {
  intent: 'Soap, a liquid lighter than water and heavier than oil that mixes the two where it touches both, and lathers. '
    + 'sort: a tank of oil, soap and water stirred together (do they settle into three layers, oil on top, soap in the middle). '
    + 'layer: soap poured onto oil floating on water (does it sink to the boundary and churn oil down into the water). '
    + 'lather: water poured onto a soap film on a pool (does it froth up into foam that heaps and slowly pops).',
  expect: ['three clean layers: oil, soap, water', 'soap gathers at the oil-water boundary and stirs oil droplets into the water', 'falling water lathers soap into a heap of foam', 'foam pops back to soap within seconds'],
  legend: 'Cells only. Stats: cell counts and mean y (lower is higher up) of oil, soap and water; foam cells; oil below the boundary (layer).',
  plantRows: false,
  variants: { sort: { k: 'sort' }, layer: { k: 'layer' }, lather: { k: 'lather' } },
  times: [0.5, 1, 2, 5, 10, 20],
  build(g, v, { fill, makeCell, T, STONE, WATER, W }) {
    const OIL = makeCell(T.OIL, 0, 0), SOAP = makeCell(T.SOAP, 0, 0);
    fill(g, 1, 255, FLOOR, 255, STONE);
    fill(g, 60, 64, TOP, FLOOR, STONE); fill(g, 192, 196, TOP, FLOOR, STONE);
    if (v.k === 'sort') {
      const kinds = [OIL, SOAP, WATER];
      let r = 12345;
      for (let y = 150; y < FLOOR; y++) for (let x = 64; x < 192; x++) { r = (r * 1103515245 + 12345) >>> 0; g[y * W + x] = kinds[(r >>> 16) % 3]; }
    }
    if (v.k === 'layer') { fill(g, 64, 192, IFACE, FLOOR, WATER); fill(g, 64, 192, IFACE - 16, IFACE, OIL); }
    if (v.k === 'lather') { fill(g, 64, 192, 196, FLOOR, WATER); fill(g, 64, 192, 188, 196, SOAP); }
  },
  input(h, s, v, { T }) {
    if (v.k === 'layer' && s < 180 && s % 3 === 0) h.brush({ x0: 128, y0: 60, x1: 128.5, y1: 60, r: 4, type: T.SOAP, density: 160 });
    if (v.k === 'lather' && s < 900 && s % 3 === 0) h.brush({ x0: 128, y0: 40, x1: 128.5, y1: 40, r: 3, type: T.WATER, density: 160 });
  },
  measure(a, lib) { return stats(a, lib); },
  checks(s, v) {
    const e = s[s.length - 1];
    if (v.k === 'sort') return [{ ok: e.oy < e.sy - 5 && e.sy < e.wy - 5, text: `layers: mean y oil ${e.oy}, soap ${e.sy}, water ${e.wy} (want each 5+ above the next)` }];
    if (v.k === 'layer') {
      const sunk = Math.max(...s.map(r => r.sunk));
      return [{ ok: sunk > 20, text: `emulsifies: up to ${sunk} oil droplets below the boundary (want > 20)` }];
    }
    if (v.k === 'lather') {
      const peak = Math.max(...s.map(r => r.foam));
      return [
        { ok: peak > 150, text: `lathers: peak foam ${peak} cells (want > 150)` },
        { ok: e.foam < peak / 3, text: `pops: ${e.foam} foam cells at the end (want < a third of the peak)` },
      ];
    }
    return [];
  },
};
