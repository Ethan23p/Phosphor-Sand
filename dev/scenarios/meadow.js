const FLOOR = 226;
export default {
  intent: 'Phone-style play: seeds drawn along a floor, then every 3s the player drags a water stroke for 1s across a wandering spot '
    + '(the app default brush: radius 3, one stamp per frame), for the whole run. What isn\'t drunk drains off the floor\'s ends into sumps. This is the "what does a thriving plant look like" strip: '
    + 'where the plant is thick it should fill out the space around it, and its growth front should be bushy, led by thick tendrils (10px+).',
  expect: ['plants filling out the space above the floor', 'thick tendrils (10px+) leading the growth front', 'bushy, not stringy', 'still alive and spreading under ongoing watering'],
  legend: 'Rows: cells · moving energy · root distance · age.',
  variants: { '': {} },
  times: [5, 15, 30, 60, 90, 120],
  build(g, v, { fill, STONE }) {
    fill(g, 12, 244, FLOOR, 232, STONE);
    fill(g, 124, 132, 196, FLOOR, STONE);   // a ridge splitting the floor
  },
  init(h, v, { T }) {
    h.brush({ x0: 30, y0: 160, x1: 100, y1: 160, r: 2, type: T.SEED, density: 25 });
    h.brush({ x0: 150, y0: 160, x1: 230, y1: 160, r: 2, type: T.SEED, density: 25 });
  },
  input(h, s, v, { T, W, H }) {
    if (s % 30 === 0) h.brush({ x0: 1, y0: H - 3, x1: W - 2, y1: H - 3, r: 2, type: T.EMPTY });
    // a 1s drag every 3s, one stamp per frame (3 steps), like the app at 3x
    const k = Math.floor(s / 540), t = s % 540;
    if (t < 180 && t % 3 === 0) {
      const x = 20 + (k * 67) % 200 + t / 6, y = 40 + 10 * Math.sin(t / 20);
      h.brush({ x0: x, y0: y, x1: x + 0.5, y1: y, r: 3, type: T.WATER, density: 160 });
    }
  },
  regions: () => ({ all: () => true }),
  checks(s) {
    const end = s[s.length - 1];
    return [
      { ok: end.all.plant >= 6000, text: `fills out: ${end.all.plant} plant cells at the end (want >= 6000)` },
      { ok: end.all.width >= 9, text: `thick tendrils: median branch width ${end.all.width} (want >= 9)` },
      { ok: end.all.thick >= 0.6, text: `bushy, not stringy: ${Math.round(100 * end.all.thick)}% of cells in bodies 5+ wide (want >= 60%)` },
    ];
  },
};
