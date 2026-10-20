// Scenario modules import nothing browser-side (dev/scenario.js hands them lib),
// so dev/strip.mjs can read their variants in node. See dev/README.md.
const FLOOR = 236, X = 128, STRAW_END = 150;
export default {
  intent: 'A basin, kept topped up, drains through a hole and a straw into a free fall onto seeds on a plateau. '
    + 'Runoff spills off the plateau into sumps that keep being erased, so the plant is watered, never flooded. '
    + 'The question: does the plant flourish where the water lands, or climb the stream and eat the waterfall?',
  expect: ['a big, thick plant on the plateau', 'nothing growing up the fall', 'water still reaching the plateau'],
  legend: 'Rows: cells · moving energy · root distance · age. Regions: fall = the column above the landing zone; bottom = the rest.',
  variants: { light: { hole: 1 }, heavy: { hole: 5 } },
  times: [5, 15, 30, 60, 90, 120],
  build(g, v, { fill, STONE, WATER }) {
    const h0 = X - (v.hole >> 1), h1 = h0 + v.hole;
    fill(g, 20, 236, 20, 60, WATER);                     // basin
    fill(g, 16, 240, 60, 70, STONE);                     // its floor
    fill(g, 16, 20, 10, 60, STONE); fill(g, 236, 240, 10, 60, STONE);
    fill(g, h0 - 1, h1 + 1, 70, STRAW_END, STONE);       // straw, so the stream lands narrow
    fill(g, h0, h1, 60, STRAW_END, 0);                   // hole and straw bore
    fill(g, 48, 208, FLOOR, 250, STONE);                 // plateau
  },
  init(h, v, { T }) { h.brush({ x0: X - 20, y0: FLOOR - 2, x1: X + 20, y1: FLOOR - 2, r: 1, type: T.SEED, density: 90 }); },
  input(h, s, v, { T, W, H }) {
    if (s % 20 === 0) h.brush({ x0: 30, y0: 24, x1: 226, y1: 24, r: 4, type: T.WATER });   // keep the basin topped up
    if (s % 30 === 0) h.brush({ x0: 1, y0: H - 3, x1: W - 2, y1: H - 3, r: 2, type: T.EMPTY }); // sumps
  },
  regions: () => ({
    fall: (x, y) => y < FLOOR - 30 && Math.abs(x - X) < 16,
    bottom: (x, y) => y >= FLOOR - 30,
  }),
  checks(s) {
    const end = s[s.length - 1], mid = s[3];
    return [
      { ok: end.bottom.plant >= 2500, text: `plant flourishes at the bottom: ${end.bottom.plant} cells (want >= 2500)` },
      { ok: end.bottom.width >= 7, text: `bottom growth is thick: median branch width ${end.bottom.width} (want >= 7)` },
      { ok: Math.max(mid.fall.plant, end.fall.plant) <= 20, text: `doesn't eat the waterfall: ${Math.max(mid.fall.plant, end.fall.plant)} cells up the fall (want <= 20)` },
    ];
  },
};
