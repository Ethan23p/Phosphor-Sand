// ══════════════════════════════════════════════════════
//  CONFIGURATION — single source of truth shared by JS and WGSL
// ══════════════════════════════════════════════════════
export const GRID_W = 256, GRID_H = 256;
export const WORKGROUP = 16;

// Particle type IDs. Emitted into WGSL as `const SAND:u32 = 1u;` etc.
export const T = {
  EMPTY: 0, SAND: 1, WATER: 2, STONE: 3, FIRE: 4,
  SMOKE: 5, PLANT: 6, SEED: 7, EMBER: 8, STEAM: 9,
};

// Simulation tuning. Emitted into WGSL as u32 consts.
// "_ODDS: n" means a 1-in-n chance per step. Times assume 3x speed ≈ 180 steps/s.
export const TUNING = {
  // ── Plant life cycle ──
  GERM_E: 40,            // a germinated seed starts full
  GERM_ODDS: 32,         // seed touching water sprouts after ~0.2s
  WATER_GAIN: 10,        // energy per water consumed (4 waters fill a cell)
  DRINK_TURN: 5,         // degrees the noise map turns energy as it's drunk (away from the water)
  DRINK_SPREAD: 5,       // plus up to this many degrees of random turn either way
  NOISE_TURN: 45,        // degrees the noise map turns energy bouncing off air or water
  SPREAD: 30,            // plus up to this many degrees of random turn either way
  AIR_LOSS: 60,          // % of momentum lost bouncing off open air at BLOOM_DIST cells out (none at the roots)
  WATER_LOSS: 10,        // % of momentum lost bouncing off water
  CRADLE: 0,             // % of a packet's momentum a full plant cell takes without its energy (Newton's cradle); the rest deflects like stone
  SOLID_LOSS: 0,         // % lost glancing off stone etc. or a full plant cell...
  DEFLECT_SPREAD: 15,    // ...which turns it 90 degrees (side biased by the noise map), give or take this many
  DAMP: 20,              // per mille of momentum settling into rest each step, scaled up from 0 at the roots to full at BLOOM_DIST
  DAMP_AIR: 0,           // 1: damp only cells next to open air (that could bloom), instead of by root distance
  PLANT_CAP: 40,         // "full": no more drinking, and arriving energy stays put
  FULL_BLOOMLESS: 1,     // 1: a cell with no open air to bloom into is already full at BLOOM_E
  BLOOM_E: 20,           // a cell this full can bloom into open air...
  BLOOM_MOVING: 30,      // ...if at most this % of its energy is moving
  BLOOM_DIST: 20,        // ...and certainly this many cells from the roots
  BLOOM_NEAR_ODDS: 256,  //    (1 in N at the roots, rising with distance)
  BLOOM_RAMP: 2,         //    (chance per step rises as the distance to this power; 1 is linear, which lets cells a few steps from water bloom almost at once)
  BLOOM_TIP: 1,          // 1: only tips bloom (no plant neighbor farther from the roots)
  DIST_CREEP_ODDS: 8,    // root distance creeps up 1/N per step unless confirmed
  BLOOM_WATER_E: 38,     // blooming into water needs more energy...
  BLOOM_WATER_ODDS: 8,   // ...and is tried 1 in N as often
  ENERGY_RES: 64,        // plant energy is stored in fine units, this many per unit
  METAB_ODDS: 1280,      // every cell burns 1 energy per ~7s; a full cell lasts ~4.7 min alone
  METAB_FILL: 0,         // ...plus this many times that again in proportion to how full it is
  SEED_DROP_ODDS: 16,    // a cell that runs empty leaves a seed instead of empty space
  TRANSPIRE_ODDS: 64,    // 1 in N energy burned is breathed out as steam

  // ── Fire, water, steam ──
  IGNITE_ODDS: 8,        // fire's chance per step to ignite plants/seeds in its block
  QUENCH_ODDS: 12,       // fire/ember touching water: water flashes to steam (~70ms sizzle)
  STEAM_LIFE_MIN: 120,   // steam decays 1/4 steps: lives ~2.7–4.4s, then condenses back to water
  STEAM_LIFE_VAR: 80,
  EMBER_LIFE: 200,       // starting lifetime of a drawn ember (~140s)
  EMBER_QUENCH: 50,      // lifetime an ember loses each time it boils a water cell
  FIRE_RISE_COST: 4,     // extra lifetime lost when fire rises
  SMOKE_TRAIL_LIFE: 18,  // lifetime of smoke left by rising fire
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
  white:[1,1,1], mist:[.722,.784,.863],
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
  [T.STEAM]: [P.mist, P.lightBlue],
};

// Toolbar brushes, in display order. Swatch = first color of the type.
// density: chance /256 that the brush fills each empty cell per frame (texture for pours).
export const TOOLS = [
  { type: T.SAND,  title: 'Sand',   density: 160 },
  { type: T.WATER, title: 'Water',  density: 160 },
  { type: T.STONE, title: 'Stone',  density: 256 },
  { type: T.FIRE,  title: 'Fire',   density: 200 },
  { type: T.SEED,  title: 'Seed',   density: 40 },
  { type: T.EMBER, title: 'Ember',  density: 90 },
  { type: T.EMPTY, title: 'Eraser', density: 256 },
];

// ── Cell encoding: type | data << 8 | variant << 16 ──
export function makeCell(t, d, v) { return (t & 0xFF) | ((d & 0xFF) << 8) | ((v & 0xFF) << 16); }
export const rgbCss = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
