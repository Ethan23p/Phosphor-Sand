// ══════════════════════════════════════════════════════
//  CONFIGURATION — single source of truth shared by JS and WGSL
// ══════════════════════════════════════════════════════
export const GRID_W = 256, GRID_H = 256;
export const WORKGROUP = 16;

// Particle type IDs. Emitted into WGSL as `const SAND:u32 = 1u;` etc.
export const T = {
  EMPTY: 0, SAND: 1, WATER: 2, STONE: 3, FIRE: 4,
  SMOKE: 5, PLANT: 6, SEED: 7, EMBER: 8, STEAM: 9, OIL: 10, SOAP: 11, FOAM: 12,
};

// Simulation tuning. Emitted into WGSL as u32 consts.
// "_ODDS: n" means a 1-in-n chance per step. Times assume 3x speed ≈ 180 steps/s.
export const TUNING = {
  // ── Plant life cycle ──
  GERM_E: 8,             // a germinated seed starts this full (with room to drink)
  GERM_ODDS: 32,         // seed touching water sprouts after ~0.2s
  WATER_GAIN: 2,         // energy per water consumed (6 waters fill a cell)
  DRINK_MAX: 3,          // waters a cell can drink in one step (of the up to 3 it shares a block with)
  DRINK_TURN: 5,         // degrees the noise map turns energy as it's drunk (away from the water)
  DRINK_SPREAD: 5,       // plus up to this many degrees of random turn either way
  NOISE_TURN: 20,        // degrees the noise map turns energy bouncing off air or water
  SPREAD: 15,            // plus up to this many degrees of random turn either way
  PRESS: 20,             // % of the energy difference between neighbors that pushes momentum each step (wave stiffness)
  VISC: 60,              // % each cell's momentum relaxes toward its block's average each step (viscosity: streams, not sloshing)
  AIR_LOSS: 10,          // % of momentum lost bouncing off open air (the energy stays, at rest)
  WATER_LOSS: 10,        // % of momentum lost bouncing off water (likewise)
  DAMP: 5,               // per mille of moving energy that comes to rest each step (friction; pressure moves it again)
  PLANT_GLOW: 12,        // a plant cell with this much energy renders at full brightness (cells store up to 255)
  BLOOM_E: 3,            // energy pushing into open air from a cell this full blooms a new cell there...
  BLOOM_TIP: 50,         // ...per mille as often where the new cell would touch only its parent (keeps fronts thick)...
  //                        (building it takes WATER_GAIN: one water's worth, returned as steam when it retires)
  BLOOM_DIST: 20,        // ...certainly this many cells from the roots...
  BLOOM_NEAR: 1,         // ...and this per mille as often at the roots, rising smoothly between (1000: no gate)
  GROWN_AGE: 4,          //    (the distance gate only applies to plants this old in age steps, ~3s; see AGE_ODDS)
  DIST_CREEP_ODDS: 8,    // root distance creeps up 1/N per step unless confirmed
  BLOOM_WATER_ODDS: 64,  // energy pushing into water blooms 1 in N as often
  ENERGY_RES: 64,        // plant energy is stored in fine units, this many per unit
  AGE_ODDS: 128,         // a cell ages 1/N per step and retires at 255: lives ~3 min
  SEED_DROP_ODDS: 16,    // a retiring cell leaves a seed 1 in N times (else steam); its energy goes to a neighbor

  // ── Gravity ──
  FALL_START: 2,         // a cell at rest falls with chance FALL_START/(FALL_START+7); at top speed (7) always
  FALL_ACCEL_ODDS: 6,    // a falling cell gains a speed step 1 in N steps (top speed after ~0.25s)
  ROLL_V: 4,             // a grain rolling off a slope leaves at least this fast (of 7)
  FLOW_TURN_ODDS: 4,     // water flowing into other water turns around 1 in N times (at a wall, always)
  SPILL: 3,              // cells (of 3) of sideways momentum flowing water carries off a ledge as it falls
  OIL_FLOW_ODDS: 3,      // oil flows sideways 1 in N steps (it's thick); it floats on water
  SOAP_MIX_ODDS: 8,      // soap mixes with oil or water beside it 1 in N steps; touching both, it pulls a coated oil droplet into the water
  EMULSION_ODDS: 1800,   // a soap-coated oil droplet drifts in water until it loses its coating, 1 in N steps (~10s), then floats up
  FOAM_ODDS: 2,          // water falling fast onto soap whips it into foam 1 in N times
  FOAM_POP_ODDS: 450,    // foam pops (bubbles to air, films back to soap) 1 in N steps: ~2.5s
  ERODE_ODDS: 8,         // water running over sand (or falling hard onto it) kicks up a grain 1 in N times

  // ── Fire, water, steam ──
  IGNITE_ODDS: 8,        // fire's chance per step to ignite plants/seeds in its block
  QUENCH_ODDS: 12,       // fire/ember touching water: water flashes to steam (~70ms sizzle)
  STEAM_LIFE_MIN: 120,   // steam decays 1/4 steps: lives ~2.7–4.4s, then condenses back to water
  STEAM_LIFE_VAR: 80,
  EMBER_LIFE: 200,       // starting lifetime of a drawn ember (~140s)
  EMBER_QUENCH: 50,      // lifetime an ember loses each time it boils a water cell
  FIRE_RISE_COST: 4,     // extra lifetime lost when fire rises
  SMOKE_TRAIL_LIFE: 18,  // lifetime of smoke left by rising fire
  OIL_FIRE_LIFE: 90,     // burning oil: fire life this plus up to 40 (fire or embers touching oil set it alight)
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
  white:[1,1,1], mist:[.722,.784,.863], amber:[.706,.475,.255], darkAmber:[.522,.333,.212],
  lavender:[.776,.682,.925], paleLavender:[.875,.827,.973], foam:[.937,.933,.976],
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
  [T.OIL]:   [P.amber, P.darkAmber],
  [T.SOAP]:  [P.lavender, P.paleLavender],
  [T.FOAM]:  [P.foam, P.white, P.paleLavender],
};

// Toolbar brushes, in display order. Swatch = first color of the type.
// density: chance /256 that the brush fills each empty cell per frame (texture for pours).
export const TOOLS = [
  { type: T.SAND,  title: 'Sand',   density: 160 },
  { type: T.WATER, title: 'Water',  density: 160 },
  { type: T.STONE, title: 'Stone',  density: 256 },
  { type: T.OIL,   title: 'Oil',    density: 160 },
  { type: T.SOAP,  title: 'Soap',   density: 160 },
  { type: T.FIRE,  title: 'Fire',   density: 200 },
  { type: T.SEED,  title: 'Seed',   density: 40 },
  { type: T.EMBER, title: 'Ember',  density: 90 },
  { type: T.EMPTY, title: 'Eraser', density: 256 },
];

// ── Cell encoding: type | data << 8 | variant << 16 ──
export function makeCell(t, d, v) { return (t & 0xFF) | ((d & 0xFF) << 8) | ((v & 0xFF) << 16); }
export const rgbCss = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
