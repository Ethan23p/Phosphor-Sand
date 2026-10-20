const FLOOR = 232, CX = 128, RAD = 44;
export default {
  intent: 'A mound of plant (or of seeds) sits on a floor. Water pours onto its left side between it and a wall, so the left flank '
    + 'gets drowned as the pool rises, while the right flank faces open air. Drinking at the wet side should drive energy across '
    + 'the mound and out the dry side, which should flourish fast.',
  expect: ['rapid growth out of the dry (right) side', 'thick, bushy growth there', 'not much growth into the pool'],
  legend: 'Rows: cells · moving energy · root distance · age. Regions: wet = left of the mound centre, dry = right of it.',
  variants: { plant: { seed: false }, seed: { seed: true } },
  times: [5, 10, 20, 40, 60, 90],
  build(g, v, { fill, disc, makePlant, STONE, SEED, T, makeCell }) {
    fill(g, 8, 250, FLOOR, 240, STONE);                      // floor
    fill(g, 8, 14, 120, FLOOR, STONE);                       // wall on the left
    const cell = v.seed ? makeCell(T.SEED, 0, 0) : makePlant(3);
    disc(g, CX, FLOOR, RAD, (x, y) => y < FLOOR ? cell : g[y * 256 + x]);
  },
  input(h, s, v, { T, W, H }) {
    if (s < 60 * 180 && s % 8 === 0) h.brush({ x0: 40, y0: 60, x1: 60, y1: 60, r: 2, type: T.WATER });   // pour on the left
    if (s % 30 === 0) h.brush({ x0: 1, y0: H - 3, x1: W - 2, y1: H - 3, r: 2, type: T.EMPTY });           // sumps past the floor's ends
  },
  regions: () => ({ wet: x => x < CX, dry: x => x >= CX }),
  checks(s) {
    const t0 = s[0].dry.plant || 1, at = k => s.find(r => r.t >= k) || s[s.length - 1];
    const fast = at(20).dry.plant, end = s[s.length - 1];
    return [
      { ok: fast >= 2 * t0 + 400, text: `dry side flourishes fast: ${fast} cells at 20s, started ${s[0].dry.plant} (want >= 2x + 400)` },
      { ok: end.dry.plant >= 3000, text: `dry side keeps going: ${end.dry.plant} cells at the end (want >= 3000)` },
      { ok: end.dry.width >= 7, text: `dry side is thick: median branch width ${end.dry.width} (want >= 7)` },
    ];
  },
};
