// Shared by pipe and tunnel: a stone cup on the left holds water resting on the
// wet end of a thick stem; the stem climbs out of the cup, runs right through a
// conduit cut in solid stone, and ends at the mouth of a big open chamber on the
// right. gap: air between the stem and the conduit walls (0: the stem fills it,
// fully enclosed; a pipe). curved: the conduit dips down and back up.
export const CHAMBER = 190, R = 4;   // chamber starts at this x; stem half-width
const WATER_TOP = 96, CUP = [10, 70, 60, 150];   // x0, x1, y0 (rim), y1 (floor)

export function conduit(gap) {
  return {
    variants: { straight: { curved: false }, curved: { curved: true } },
    times: [5, 15, 30, 60, 90, 120],
    build(g, v, { fill, path, makePlant, STONE, WATER }) {
      g.fill(STONE);
      const [cx0, cx1, cy0, cy1] = CUP;
      fill(g, cx0, cx1 - 2 * R - 6, cy0 - 30, cy1, 0);            // the cup's inside (and air above it); its right wall
                                                                  //   encloses the stem where it climbs out
      fill(g, CHAMBER, 250, 12, 244, 0);                          // the open chamber
      const y = 40;                                               // conduit height, above the cup's rim
      const pts = [[cx0 + 4, cy1 - R - 1], [cx1 - R - 2, cy1 - R - 1], [cx1 - R - 2, y]];
      const run = v.curved
        ? [[90, y], [110, 120], [140, 200], [165, 120], [CHAMBER - 6, y], [CHAMBER + 8, y]]
        : [[CHAMBER + 8, y]];
      pts.push(...run);
      const wide = pts.slice(2);
      if (gap) path(g, wide, R + gap, 0);                         // the air gap around the stem
      fill(g, cx0, cx1 - 2 * R - 6, WATER_TOP, cy1 - 2 * R - 2, WATER);   // water resting on the wet end
      path(g, pts, R, makePlant(3));
      fill(g, CHAMBER, 250, 12, 244, 0);                          // keep the chamber clear (the stem's tip ends at its mouth)
      path(g, [[CHAMBER - 6, y], [CHAMBER + 2, y]], R, makePlant(3));
    },
    input(h, s, v, { T }) {
      // keep the water topped up to its line
      if (s % 30 === 0) h.brush({ x0: CUP[0] + 4, y0: WATER_TOP + 2, x1: CUP[1] - 2 * R - 10, y1: WATER_TOP + 2, r: 2, type: T.WATER });
    },
    regions: () => ({
      wet: x => x < CUP[1],
      conduit: x => x >= CUP[1] && x < CHAMBER,
      chamber: x => x >= CHAMBER,
    }),
  };
}
