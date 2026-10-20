import { conduit } from './_conduit.js';
const base = conduit(6);
export default {
  ...base,
  intent: 'Like pipe, but the conduit is wider than the stem: an air gap of 6px surrounds it the whole way, so energy can leak out into air '
    + '(bounce, or grow into the gap) on its way. The left end lies in a cup under water (kept topped up); the tip pokes into a big open chamber.',
  expect: ['some energy reaching the far end', 'growth in the chamber (any)', 'the gap may fill in along the way'],
  legend: 'Rows: cells · moving energy · root distance · age. Regions: wet = the cup, conduit = the tunnel, chamber = the open chamber.',
  checks(s) {
    const end = s[s.length - 1], start = s[0];
    const grew = Math.max(...s.map(r => r.chamber.plant)) - start.chamber.plant;
    return [
      { ok: grew >= 100, text: `energy reaches the chamber and grows there: +${grew} cells at most (want >= 100)` },
      { ok: end.chamber.plant > start.chamber.plant, text: `still alive in the chamber at the end: ${end.chamber.plant} (started ${start.chamber.plant})` },
    ];
  },
};
