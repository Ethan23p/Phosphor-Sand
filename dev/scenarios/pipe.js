import { conduit } from './_conduit.js';
const base = conduit(0);
export default {
  ...base,
  intent: 'A thick stem (8px) fully enclosed in stone: its left end lies in a cup under water (kept topped up), '
    + 'it climbs out and runs through a long conduit it completely fills, and its tip pokes into a big open chamber on the right. '
    + 'The only air it can grow into is the cup above the water and the chamber. Energy drunk at the wet end should be piped along the stem to the dry end.',
  expect: ['energy flowing along the pipe (moving-energy row lit up through it)', 'the plant flourishing in the chamber, thick', 'no growth back into the cup'],
  legend: 'Rows: cells · moving energy · root distance · age. Regions: wet = the cup, conduit = the pipe, chamber = the open chamber.',
  checks(s) {
    const end = s[s.length - 1], mid = s[3];
    return [
      { ok: mid.conduit.mov > 20, text: `energy moving through the pipe at ${mid.t}s: ${Math.round(mid.conduit.mov)} (want > 20)` },
      { ok: end.chamber.plant >= 2000, text: `flourishes in the chamber: ${end.chamber.plant} cells (want >= 2000)` },
      { ok: end.chamber.width >= 7, text: `chamber growth is thick: median branch width ${end.chamber.width} (want >= 7)` },
      { ok: end.wet.plant <= s[0].wet.plant * 1.5, text: `stays out of the cup: ${end.wet.plant} cells there, started ${s[0].wet.plant} (want <= 1.5x)` },
    ];
  },
};
