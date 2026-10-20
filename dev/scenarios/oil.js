// Oil: a thick liquid that floats on water and burns. One variant per question.
const FLOOR = 236;

function stats(a, { W, N, T }) {
  const out = { oil: 0, water: 0, fire: 0, oy: 0, wy: 0 };
  for (let i = 0; i < N; i++) {
    const t = a[i] & 255, y = (i / W) | 0;
    if (t === T.OIL) { out.oil++; out.oy += y; }
    if (t === T.WATER) { out.water++; out.wy += y; }
    if (t === T.FIRE) out.fire++;
  }
  out.oy = out.oil ? +(out.oy / out.oil).toFixed(1) : -1;
  out.wy = out.water ? +(out.wy / out.water).toFixed(1) : -1;
  return out;
}

export default {
  intent: 'Oil, a thick liquid that floats on water and burns. float: a tank with oil at the bottom and water on top (do they swap). '
    + 'pour: oil and water poured side by side onto a floor (does the oil spread slower and end up on top). '
    + 'slick: a lit match dropped on an oil slick floating on a pool (does the fire spread across it and leave the water). '
    + 'ember: embers dropped into an oil pool (do they sink and set it alight).',
  expect: ['oil rises through water and floats as a layer', 'oil spreads, but slower than water', 'fire runs across a slick and burns it off', 'embers sink through oil and ignite it'],
  legend: 'Cells only. Stats: oil and water cell counts, their mean y (lower is higher up), fire cells.',
  plantRows: false,
  variants: { float: { k: 'float' }, pour: { k: 'pour' }, slick: { k: 'slick' }, ember: { k: 'ember' } },
  times: [0.5, 1, 2, 5, 10, 20],
  build(g, v, { fill, makeCell, T, STONE, WATER }) {
    const OIL = makeCell(T.OIL, 0, 0);
    fill(g, 1, 255, FLOOR, 255, STONE);
    if (v.k === 'float') { fill(g, 60, 64, 120, FLOOR, STONE); fill(g, 192, 196, 120, FLOOR, STONE); fill(g, 64, 192, 196, FLOOR, OIL); fill(g, 64, 192, 150, 196, WATER); }
    if (v.k === 'slick') { fill(g, 2, 254, 200, FLOOR, WATER); fill(g, 2, 254, 194, 200, OIL); fill(g, 20, 24, 190, 194, makeCell(T.FIRE, 80, 0)); }
    if (v.k === 'ember') { fill(g, 2, 254, 170, FLOOR, OIL); fill(g, 120, 136, 140, 146, makeCell(T.EMBER, 200, 0)); }
  },
  input(h, s, v, { T }) {
    if (v.k === 'pour' && s < 900 && s % 3 === 0) {
      h.brush({ x0: 70, y0: 40, x1: 70.5, y1: 40, r: 3, type: T.OIL, density: 160 });
      h.brush({ x0: 186, y0: 40, x1: 186.5, y1: 40, r: 3, type: T.WATER, density: 160 });
    }
  },
  measure(a, lib) { return stats(a, lib); },
  checks(s, v) {
    const e = s[s.length - 1], first = s[0];
    if (v.k === 'float') return [{ ok: e.oy < e.wy - 20, text: `oil on top: oil mean y ${e.oy}, water ${e.wy} (want oil 20+ higher)` }];
    if (v.k === 'pour') return [{ ok: e.oil > 0 && e.water > 0, text: `both poured: oil ${e.oil}, water ${e.water}` }];
    if (v.k === 'slick') return [
      { ok: e.oil < first.oil * 0.2, text: `burns off: ${e.oil} oil left of ${first.oil} (want < 20%)` },
      { ok: e.water > first.water * 0.8, text: `water stays: ${e.water} of ${first.water} (want > 80%)` },
    ];
    if (v.k === 'ember') return [{ ok: Math.max(...s.map(r => r.fire)) > 50 && e.oil < first.oil * 0.9, text: `ignites: peak fire ${Math.max(...s.map(r => r.fire))} cells, oil ${e.oil} of ${first.oil}` }];
    return [];
  },
};
