// Amphiphiles: soap and lipid molecules with a head (likes water) and a tail
// (likes oil, air and other tails) that self-assemble. Soap crowds, so it
// should curl into micelles; lipid lines up, so it should make bilayer
// membranes that close into vesicles.
const FLOOR = 236, TOP = 120, L = 64, R = 192;
const OFF = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function stats(a, { W, N, T }) {
  let n = 0, wet = 0, hid = 0, film = 0, pairs = 0;
  for (let i = 0; i < N; i++) {
    const t = a[i] & 255;
    if (t !== T.SOAP && t !== T.LIPID) continue;
    n++;
    if (t === T.LIPID && (a[i] >> 8) & 8) pairs++;
    const [dx, dy] = OFF[(a[i] >> 8) & 7], ht = a[i + dy * W + dx] & 255, tt = a[i - dy * W - dx] & 255;
    if (ht === T.WATER) wet++;
    if (tt === T.SOAP || tt === T.LIPID || tt === T.OIL || tt === T.EMPTY) hid++;
    if (((i / W) | 0) < 150) film++;
  }
  // heads: share of molecules with water in front of their head; tails:
  // share with their tail against another tail, oil or air (not water)
  return { n, heads: n ? wet / n : 0, tails: n ? hid / n : 0, above: film, pairs };
}

export default {
  intent: 'Soap (blue) and lipid (pink): molecules with a head (white edge) that likes water and a tail that likes oil, air and other tails. '
    + 'micelle: soap stirred through a tank of water (does it curl into small clusters, heads out). '
    + 'vesicle: lipid stirred through a tank of water (does it line up into bilayers, tails in, that close into rings). '
    + 'film: lipid poured onto a pool (does it spread as a film, tails up, and work down into the water). '
    + 'oil: soap stirred through water with oil (do micelles form around the oil). '
    + 'pair: lipid and oil stirred through water (does lipid bond to oil tails as two-cell molecules, and do those make thicker membranes).',
  expect: ['soap: small round clusters, white heads facing out', 'lipid: double lines, white edges on both outer faces, closing into rings', 'a poured film lies tails up on the water', 'the zoom row shows the molecules up close'],
  legend: 'Row 2 zooms into the middle of the tank. Stats: molecules, share with their head in water, share with their tail hidden (against a tail, oil or air), molecules above the water line.',
  plantRows: false,
  variants: { micelle: { k: 'micelle' }, vesicle: { k: 'vesicle' }, dense: { k: 'vesicle', pct: 25 }, pair: { k: 'pair', pct: 12 }, film: { k: 'film' }, oil: { k: 'oil' } },
  times: [0.5, 5, 20, 60, 120, 240],
  zoom: () => ({ x: 96, y: 168, w: 64, h: 64 }),
  build(g, v, { fill, makeCell, T, STONE, WATER, W }) {
    fill(g, 1, 255, FLOOR, 255, STONE);
    fill(g, L - 4, L, TOP, FLOOR, STONE); fill(g, R, R + 4, TOP, FLOOR, STONE);
    if (v.k === 'film') { fill(g, L, R, 170, FLOOR, WATER); return; }
    fill(g, L, R, 150, FLOOR, WATER);
    let r = 12345;
    const rnd = () => (r = (r * 1103515245 + 12345) >>> 0) >>> 16;
    const t = v.k === 'vesicle' || v.k === 'pair' ? T.LIPID : T.SOAP;
    for (let y = 150; y < FLOOR; y++) for (let x = L; x < R; x++) {
      const q = rnd() % 100;
      if (q < (v.pct || 12)) g[y * W + x] = makeCell(t, rnd() & 7, rnd() & 3);
      else if ((v.k === 'oil' && q < 18) || (v.k === 'pair' && q < 2 * v.pct)) g[y * W + x] = makeCell(T.OIL, 0, 0);
    }
  },
  input(h, s, v, { T }) {
    if (v.k === 'film' && s < 360 && s % 3 === 0) h.brush({ x0: 128, y0: 100, x1: 128.5, y1: 100, r: 4, type: T.LIPID, density: 160 });
  },
  measure(a, lib) { return stats(a, lib); },
  checks(s, v) {
    const e = s[s.length - 1], first = s[0];
    const out = [{ ok: e.tails > first.tails + 0.25, text: `assembles: tails hidden ${first.tails.toFixed(2)} -> ${e.tails.toFixed(2)} (want +0.25)` }];
    if (v.k === 'pair') out.push({ ok: e.pairs > e.n * 0.3, text: `bonds: ${e.pairs} of ${e.n} lipids in two-cell molecules (want 30%+)` });
    if (v.k !== 'film') out.push({ ok: e.n === first.n, text: `conserved: ${first.n} -> ${e.n} molecules` });
    return out;
  },
};
