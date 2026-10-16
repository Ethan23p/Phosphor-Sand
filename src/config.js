// ══════════════════════════════════════════════════════
//  CONFIGURATION — single source of truth shared by JS and WGSL
// ══════════════════════════════════════════════════════
export const GRID_W = 256, GRID_H = 256;
export const WORKGROUP = 16;

// Particle type IDs. Emitted into WGSL as `const SAND:u32 = 1u;` etc.
export const T = {
  EMPTY: 0, SAND: 1, WATER: 2, STONE: 3, FIRE: 4,
  SMOKE: 5, PLANT: 6, SEED: 7, EMBER: 8,
};

// Simulation tuning. Emitted into WGSL as u32 consts.
export const TUNING = {
  GERM_E: 150,           // energy of a freshly germinated plant
  WATER_GAIN: 50,        // energy gained per water absorbed
  ABSORB_CAP: 220,       // raised: let roots get very pressurized
  FLOW_RATE: 32,         // max energy a plant cell pulls from its parent per step
  STEM_RESERVE: 20,      // energy a stem keeps for itself; the rest flows on to the tips
  GROW_COST_MIN: 35,     // energy a tip spends to grow, at noise=1.0
  GROW_COST_MAX: 100,    // energy a tip spends to grow, at noise=0.0
  BRANCH_ODDS: 12,       // 1 in N growths leaves the old tip as a tip too
  FIRE_RISE_COST: 4,     // extra lifetime lost when fire rises
  SMOKE_TRAIL_LIFE: 18,  // lifetime of smoke left by rising fire
  EMBER_LIFE: 200,       // starting lifetime of a drawn ember
};

// ── Palette ──
export const P = {
  lightBlue:[.522,.855,.922], medBlue:[.373,.788,.906], blue:[.373,.631,.906],
  indigo:[.373,.431,.906], darkBlue:[.298,.376,.667], darkIndigo:[.267,.278,.455],
  nearBlack:[.196,.192,.231], darkPurple:[.275,.235,.369], medPurple:[.365,.278,.463],
  purple:[.522,.325,.584], magenta:[.671,.345,.659], pink:[.792,.376,.682],
  peach:[.953,.655,.529], sand:[.961,.855,.655], lightGreen:[.553,.847,.580],
  medGreen:[.365,.757,.565], tealGreen:[.290,.725,.639], darkTeal:[.271,.576,.647],
  brightCyan:[.369,.992,.969], hotPink:[1,.365,.8], brightYellow:[.992,.996,.537],
  white:[1,1,1],
};

// Up to 4 color variants per type (cycled if fewer). Indexed by type ID.
export const CMAP = {
  [T.EMPTY]: [P.nearBlack],
  [T.SAND]:  [P.sand, P.peach],
  [T.WATER]: [P.medBlue, P.blue, P.lightBlue],
  [T.STONE]: [P.darkIndigo, P.darkBlue],
  [T.FIRE]:  [P.brightYellow, P.hotPink, P.pink, P.peach],
  [T.SMOKE]: [P.darkPurple, P.medPurple],
  [T.PLANT]: [P.medGreen, P.lightGreen, P.tealGreen],
  [T.SEED]:  [P.magenta, P.purple],
  [T.EMBER]: [P.peach, P.pink, P.sand, P.hotPink],
};

// Toolbar brushes, in display order. Swatch = first color of the type.
export const TOOLS = [
  { type: T.SAND,  title: 'Sand' },
  { type: T.WATER, title: 'Water' },
  { type: T.STONE, title: 'Stone' },
  { type: T.FIRE,  title: 'Fire' },
  { type: T.SEED,  title: 'Seed' },
  { type: T.EMBER, title: 'Ember' },
  { type: T.EMPTY, title: 'Eraser' },
];

// ── Cell encoding: type | data << 8 | variant << 16 ──
export function makeCell(t, d, v) { return (t & 0xFF) | ((d & 0xFF) << 8) | ((v & 0xFF) << 16); }
export function jsHash(x) { x = ((x >> 16) ^ x) * 0x45d9f3b; x = ((x >> 16) ^ x) * 0x45d9f3b; x = (x >> 16) ^ x; return x >>> 0; }
export const rgbCss = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
