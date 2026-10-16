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
  GERM_E: 200,           // a seed's packed energy: enough for a seedling to grow ~3 cells unwatered
  GERM_ODDS: 32,         // seed touching water sprouts after ~0.2s
  WATER_GAIN: 40,        // energy per water drunk
  ABSORB_ODDS: 24,       // a cell touching water drinks ≤ ~7 water/s, and only while below its cap
  STEM_RESERVE: 24,      // energy a stem keeps for itself; the rest flows on toward the tips
  STEM_CAP: 64,          // stems stop pulling/drinking here, so energy passes through instead of pooling
  TIP_CAP: 140,          // tips bank enough for one expensive growth step
  FLOW_RATE: 24,         // max energy a cell pulls from its parent per step
  GROW_ODDS: 16,         // tips try to grow every ~16 steps (≤ ~5 cells/s per tip when well fed)
  GROW_COST_MIN: 30,     // energy spent per new cell, at noise=1.0 (fertile)
  GROW_COST_MAX: 80,     // energy spent per new cell, at noise=0.0 (barren)
  GROW_KEEP: 8,          // a tip must keep this much after paying for growth
  FORWARD_BIAS: 3,       // tips mildly prefer to keep growing the way they were going...
  UP_BIAS: 3,            // ...and upward; sideways weighs 2, down 1, back 0
  BRANCH_ODDS: 6,        // 1 in N growths leaves the old tip growing too (bushy, not wiry)
  RETIRE_ODDS: 12,       // a tip that tries a blocked cell sometimes gives up and becomes stem
  BUD_ODDS: 2048,        // a full stem (energy ≥ STEM_CAP) sometimes sprouts a new tip (~1 per 11s each)
  METAB_ODDS: 512,       // every cell burns 1 energy per ~2.8s; a stem at reserve starves in ~70s
  SEED_DROP_ODDS: 16,    // a starved cell leaves a seed instead of empty space
  TRANSPIRE_ODDS: 64,    // 1 in N energy burned is breathed out as steam: ~60% of a water's worth comes back as rain

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
