import { WORKGROUP } from '../config.js';
import { commonWGSL } from './common.wgsl.js';

// ══════════════════════════════════════════════════════
//  SIMULATION — Margolus 2x2 block cellular automaton
//  Note: ALL arithmetic uses u32 exclusively.
//  Margolus block origin computed with unsigned math only.
//  No signed shifts, no reserved keywords as identifiers.
//
//  Block layout:  0 1   (top)
//                 2 3   (bottom)
// ══════════════════════════════════════════════════════
export const simWGSL = `
${commonWGSL}

@group(0) @binding(0) var<storage,read> gi: array<u32>;
@group(0) @binding(1) var<storage,read_write> go: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;

alias Cells = array<u32, 4>;

// Per-block context shared by every rule
struct Block { bx:u32, by:u32, rng:u32, rng2:u32 }

fn idx(x:u32, y:u32) -> u32 { return y * p.w + x; }

// Independent random stream per (block, slot, purpose). Use a distinct salt per roll.
fn roll(b: Block, i:u32, salt:u32) -> u32 {
  return hh(b.rng2 + i * 0x9E3779B9u + salt * 0x85EBCA6Bu);
}

// ─── NOISE ───
fn sstep(a:f32, b:f32, t:f32) -> f32 {
  let x = clamp((t - a) / (b - a), 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}
fn hash_f(ix:u32, iy:u32, seed:u32) -> f32 {
  return f32(hh(ix * 374761393u + iy * 668265263u + seed) & 0xFFFFu) / 65535.0;
}
fn value_noise(fx:f32, fy:f32, period:f32, seed:u32) -> f32 {
  let px = fx / period;
  let py = fy / period;
  let ix0 = u32(floor(px)) & 0xFFu;
  let iy0 = u32(floor(py)) & 0xFFu;
  let ix1 = (ix0 + 1u) & 0xFFu;
  let iy1 = (iy0 + 1u) & 0xFFu;
  let tx = sstep(0.0, 1.0, fract(px));
  let ty = sstep(0.0, 1.0, fract(py));
  return mix(mix(hash_f(ix0,iy0,seed), hash_f(ix1,iy0,seed), tx),
             mix(hash_f(ix0,iy1,seed), hash_f(ix1,iy1,seed), tx), ty);
}
fn growth_noise(cx:u32, cy:u32) -> f32 {
  let fx = f32(cx); let fy = f32(cy);
  return 0.67 * value_noise(fx, fy, 24.0, 12345u)
       + 0.33 * value_noise(fx, fy, 10.0, 67890u);
}
fn noise_variant(cx:u32, cy:u32) -> u32 {
  let n = growth_noise(cx, cy);
  if (n > 0.66) { return 1u; }
  if (n > 0.33) { return 0u; }
  return 2u;
}

// ─── HELPERS ───
fn heavy(c:u32) -> bool { let t = gt(c); return t == SAND || t == SEED || t == EMBER; }
fn fl(c:u32) -> bool { return heavy(c) || gt(c) == WATER; }
fn em(c:u32) -> bool { return gt(c) == EMPTY; }
fn lq(c:u32) -> bool { return gt(c) == WATER; }
fn is_fire(c:u32) -> bool { return gt(c) == FIRE; }
// Can mover fall into dest? Heavy particles sink through water only when
// this block's sink bit is set (~half the steps), so they sink at half speed.
fn disp(mover:u32, dest:u32, sink:bool) -> bool {
  if (em(dest)) { return true; }
  return sink && heavy(mover) && lq(dest);
}
fn gas(c:u32) -> bool { let t = gt(c); return t == SMOKE || t == STEAM; }
// Gases rise into empty space; steam also bubbles up through water
fn rises_into(g:u32, above:u32) -> bool { return em(above) || (gt(g) == STEAM && lq(above)); }
fn burns(c:u32) -> bool { let t = gt(c); return t == PLANT || t == SEED; }
fn sw(cells: ptr<function, Cells>, a:u32, b:u32) {
  let tmp = (*cells)[a]; (*cells)[a] = (*cells)[b]; (*cells)[b] = tmp;
}
fn cell_x(bx:u32, li:u32) -> u32 { return bx + (li & 1u); }
fn cell_y(by:u32, li:u32) -> u32 { return by + (li >> 1u); }

// A neighbor of slot i holding type t, scanning from a random start (no
// direction bias); 4u if none
fn find_neighbor(c: Cells, i:u32, t:u32, r:u32) -> u32 {
  for (var k = 0u; k < 4u; k = k + 1u) {
    let j = (r + k) & 3u;
    if (j != i && gt(c[j]) == t) { return j; }
  }
  return 4u;
}

fn steam_cell(r:u32) -> u32 {
  return mc(STEAM, STEAM_LIFE_MIN + r % STEAM_LIFE_VAR, (r >> 8u) & 3u);
}

// Fire variant brightens as it burns down
fn fire_variant(life:u32) -> u32 {
  if (life < 20u) { return 3u; }
  if (life < 40u) { return 2u; }
  if (life < 60u) { return 1u; }
  return 0u;
}

// Fire at src rises into dst, paying FIRE_RISE_COST and leaving a smoke trail
fn rise_fire(cells: ptr<function, Cells>, src:u32, dst:u32) {
  let life = gd((*cells)[src]);
  if (life <= FIRE_RISE_COST + 2u) { return; }
  let nl = life - FIRE_RISE_COST;
  (*cells)[dst] = mc(FIRE, nl, fire_variant(nl));
  (*cells)[src] = mc(SMOKE, SMOKE_TRAIL_LIFE, gv((*cells)[src]));
}

// ═══════════════════════════════════════════
//  PHASE 1: MOVEMENT (swaps only — conserves every particle)
// ═══════════════════════════════════════════
fn movement(cin: Cells, rng:u32) -> Cells {
  var c = cin;
  let sink = ((rng >> 9u) & 1u) == 0u;

  // Gravity straight
  if (fl(c[0]) && disp(c[0], c[2], sink)) { sw(&c, 0u, 2u); }
  if (fl(c[1]) && disp(c[1], c[3], sink)) { sw(&c, 1u, 3u); }

  // Gravity diagonal
  if ((rng & 1u) == 0u) {
    if (fl(c[0]) && !disp(c[0], c[2], sink) && disp(c[0], c[3], sink) && !fl(c[1])) { sw(&c, 0u, 3u); }
    if (fl(c[1]) && !disp(c[1], c[3], sink) && disp(c[1], c[2], sink) && !fl(c[0])) { sw(&c, 1u, 2u); }
  } else {
    if (fl(c[1]) && !disp(c[1], c[3], sink) && disp(c[1], c[2], sink) && !fl(c[0])) { sw(&c, 1u, 2u); }
    if (fl(c[0]) && !disp(c[0], c[2], sink) && disp(c[0], c[3], sink) && !fl(c[1])) { sw(&c, 0u, 3u); }
  }

  // Gases rise
  if (gas(c[2]) && rises_into(c[2], c[0])) { sw(&c, 2u, 0u); }
  if (gas(c[3]) && rises_into(c[3], c[1])) { sw(&c, 3u, 1u); }
  if (gas(c[2]) && !rises_into(c[2], c[0]) && rises_into(c[2], c[1]) && ((rng >> 2u) & 1u) == 0u) { sw(&c, 2u, 1u); }
  if (gas(c[3]) && !rises_into(c[3], c[1]) && rises_into(c[3], c[0]) && ((rng >> 3u) & 1u) == 0u) { sw(&c, 3u, 0u); }

  // Gases drift sideways (1/4 of steps, random direction)
  if (((rng >> 10u) & 3u) == 0u) {
    if (((rng >> 12u) & 1u) == 0u) {
      if (gas(c[0]) && em(c[1])) { sw(&c, 0u, 1u); }
      if (gas(c[2]) && em(c[3])) { sw(&c, 2u, 3u); }
    } else {
      if (gas(c[1]) && em(c[0])) { sw(&c, 1u, 0u); }
      if (gas(c[3]) && em(c[2])) { sw(&c, 3u, 2u); }
    }
  }

  // Water lateral spread
  let sd = (rng >> 4u) & 1u;
  if (lq(c[2]) && em(c[3]) && sd == 0u)      { sw(&c, 2u, 3u); }
  else if (lq(c[3]) && em(c[2]) && sd == 1u)  { sw(&c, 3u, 2u); }
  if (lq(c[0]) && em(c[1]) && sd == 1u)       { sw(&c, 0u, 1u); }
  else if (lq(c[1]) && em(c[0]) && sd == 0u)  { sw(&c, 1u, 0u); }

  // Water leveling: surface water with water below spreads to empty beside it
  // This simulates hydrostatic pressure pushing the pool surface outward
  if (lq(c[0]) && lq(c[2]) && em(c[1]) && !lq(c[3]) && sd == 0u) {
    sw(&c, 0u, 1u); // TL water spreads right when sitting on water
  } else if (lq(c[1]) && lq(c[3]) && em(c[0]) && !lq(c[2]) && sd == 1u) {
    sw(&c, 1u, 0u); // TR water spreads left when sitting on water
  }

  // Water rising: water in bottom row rises to empty top cell (finding its level)
  // Only when the water can't spread laterally (both bottom cells occupied)
  let rise_bit = (rng >> 6u) & 1u;
  if (lq(c[2]) && lq(c[3]) && em(c[0]) && !em(c[1]) && rise_bit == 0u) {
    sw(&c, 2u, 0u); // BL rises to TL
  } else if (lq(c[2]) && lq(c[3]) && em(c[1]) && !em(c[0]) && rise_bit == 1u) {
    sw(&c, 3u, 1u); // BR rises to TR
  }

  return c;
}

// ═══════════════════════════════════════════
//  PHASE 2: INTERACTIONS
//  One tick_* per type; each updates cell i and may touch neighbors.
// ═══════════════════════════════════════════

// FIRE: quenched by water, ignites neighbors, decays into smoke
fn tick_fire(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  let life = gd(c[i]);

  // Quench: a touching water cell flashes to steam and the fire goes out
  if ((roll(b, i, 11u) % QUENCH_ODDS) == 0u) {
    let j = find_neighbor(c, i, WATER, roll(b, i, 12u));
    if (j < 4u) {
      c[j] = steam_cell(roll(b, i, 13u));
      c[i] = 0u;
      return c;
    }
  }

  // Ignite flammable neighbors
  if ((roll(b, i, 10u) % IGNITE_ODDS) == 0u) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      if (j != i && burns(c[j])) {
        var fl_life = 0u;
        if (gt(c[j]) == PLANT) {
          fl_life = gd(c[j]) / 3u + 20u; // plant energy → fire life
        } else {
          fl_life = 50u + (roll(b, j, 14u) % 40u);
        }
        c[j] = mc(FIRE, fl_life, roll(b, j, 15u) & 3u);
      }
    }
  }

  // Decay
  if (life <= 1u) {
    c[i] = mc(SMOKE, 30u + (roll(b, i, 16u) % 30u), gv(c[i]));
  } else {
    c[i] = mc(FIRE, life - 1u, fire_variant(life));
  }
  return c;
}

// SMOKE: decay
fn tick_smoke(cin: Cells, i:u32) -> Cells {
  var c = cin;
  let life = gd(c[i]);
  if (life <= 1u) { c[i] = 0u; }
  else { c[i] = mc(SMOKE, life - 1u, gv(c[i])); }
  return c;
}

// STEAM: slow decay, then condenses back into water (falls as rain)
fn tick_steam(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  if ((roll(b, i, 17u) & 3u) == 0u) {
    let life = gd(c[i]);
    if (life <= 1u) { c[i] = mc(WATER, 0u, roll(b, i, 18u) & 3u); }
    else { c[i] = mc(STEAM, life - 1u, gv(c[i])); }
  }
  return c;
}

// SEED: germinate by consuming adjacent water, turning into a plant cell with much energy
fn tick_seed(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  if ((roll(b, i, 20u) % GERM_ODDS) == 0u) {
    let j = find_neighbor(c, i, WATER, roll(b, i, 21u));
    if (j < 4u) {
      c[i] = mc(PLANT, GERM_E, noise_variant(cell_x(b.bx, i), cell_y(b.by, i)));
      c[j] = 0u;
    }
  }
  return c;
}

// Plant age lives in variant bits 2-7; bits 0-1 are color. Age is a generation
// count: a seed starts at 0 and each sprout is one more than the cell that grew it.
// It wraps at 64, and "younger" means 1-31 generations ahead, so a gradient runs
// through a plant of any length and energy only needs it locally.
fn plant_age(c:u32) -> u32 { return gv(c) >> 2u; }
fn is_younger(other:u32, me:u32) -> bool { let d = (other - me) & 63u; return d >= 1u && d <= 31u; }
// Stillness lives in bits 24-31: how long since energy last moved in or out of
// the cell, counted every other step (one Margolus cycle) so it spans ~2.8s.
// Rebuilding a cell with mc() zeroes it, so receiving energy resets it.
fn plant_still(c:u32) -> u32 { return c >> 24u; }

// PLANT ("ageism"): energy only flows from older cells to younger ones.
//   Drink adjacent water, turning it into energy.
//   If a neighbor is younger and not full, transfer energy to it;
//   else, once full, attempt to sprout new growth;
//   else the energy accumulates.
fn tick_plant(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  var energy = gd(c[i]);
  let age = plant_age(c[i]);
  var still = plant_still(c[i]);
  var moved = false;

  // Drink: occasionally absorb one adjacent water, unless full
  if (energy < PLANT_CAP && (roll(b, i, 30u) % ABSORB_ODDS) == 0u) {
    let j = find_neighbor(c, i, WATER, roll(b, i, 31u));
    if (j < 4u) {
      energy = min(energy + WATER_GAIN, 255u);
      c[j] = 0u;
    }
  }

  // A younger neighbor that isn't full
  var younger = 4u;
  let r = roll(b, i, 33u);
  for (var k = 0u; k < 4u; k = k + 1u) {
    let j = (r + k) & 3u;
    if (j != i && gt(c[j]) == PLANT && is_younger(plant_age(c[j]), age) && gd(c[j]) < PLANT_CAP) { younger = j; break; }
  }

  if (younger < 4u) {
    // Transfer energy to it
    let pe = gd(c[younger]);
    if (energy > STEM_RESERVE) {
      let flow = min(min(FLOW_RATE, energy - STEM_RESERVE), PLANT_CAP - pe);
      energy = energy - flow;
      c[younger] = mc(PLANT, pe + flow, gv(c[younger]));
      moved = true;
    }
  } else if (energy >= PLANT_CAP && still * 2u >= SPROUT_DELAY && (roll(b, i, 32u) % GROW_ODDS) == 0u) {
    // Sprout, only once full and still (stems have energy moving through them,
    // so only the ends of stems bloom):
    // claim an empty neighbor for a noise-dependent energy cost.
    // The new cell is one generation younger and starts with BIRTH_E.
    let j = find_neighbor(c, i, EMPTY, roll(b, i, 47u));
    if (j < 4u) {
      let jx = cell_x(b.bx, j);
      let jy = cell_y(b.by, j);
      let cost = GROW_COST_MIN + u32(f32(GROW_COST_MAX - GROW_COST_MIN) * (1.0 - growth_noise(jx, jy)));
      if (energy >= cost + GROW_KEEP) {
        energy = energy - cost;
        c[j] = mc(PLANT, BIRTH_E, noise_variant(jx, jy) | (((age + 1u) & 63u) << 2u));
      }
    }
  }
  // (otherwise the energy accumulates)

  // Energy moving out resets stillness; otherwise it counts up, once per cycle
  if (moved) { still = 0u; }
  else if ((p.frame & 1u) == 0u) { still = min(still + 1u, 255u); }

  // Metabolism: every cell slowly burns energy, now and then breathing out
  // steam into open air, so a forest returns part of its water as rain
  let mr = roll(b, i, 34u);
  if ((mr % METAB_ODDS) == 0u && energy > 0u) {
    energy = energy - 1u;
    if (((mr >> 12u) % TRANSPIRE_ODDS) == 0u) {
      let j = find_neighbor(c, i, EMPTY, roll(b, i, 37u));
      if (j < 4u) { c[j] = steam_cell(roll(b, i, 38u)); }
    }
  }

  // Starved cells die, occasionally leaving a seed
  if (energy == 0u) {
    if ((roll(b, i, 35u) % SEED_DROP_ODDS) == 0u) { c[i] = mc(SEED, 0u, roll(b, i, 36u) & 3u); }
    else { c[i] = 0u; }
  } else {
    c[i] = mc(PLANT, energy, gv(c[i])) | (still << 24u);
  }
  return c;
}

// EMBER: falls like sand, sparks now and then, boils water it touches
fn tick_ember(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  let elife = gd(c[i]);

  // Quench: touching water flashes to steam and costs the ember heat
  if ((roll(b, i, 40u) % QUENCH_ODDS) == 0u) {
    let j = find_neighbor(c, i, WATER, roll(b, i, 41u));
    if (j < 4u) {
      c[j] = steam_cell(roll(b, i, 42u));
      if (elife <= EMBER_QUENCH) { c[i] = 0u; }
      else { c[i] = mc(EMBER, elife - EMBER_QUENCH, gv(c[i])); }
      return c;
    }
  }

  // Flare: spawn a short-lived spark in a random empty neighbor (~1/128 per step)
  if ((roll(b, i, 43u) & 127u) == 0u) {
    let j = find_neighbor(c, i, EMPTY, roll(b, i, 44u));
    if (j < 4u) {
      let r = roll(b, j, 45u);
      c[j] = mc(FIRE, 15u + r % 11u, (r >> 8u) & 3u);
    }
  }

  // Slow decay: 1/128 per step. Lifetime 200 lasts ~25,600 steps (~142s at 3x)
  if ((roll(b, i, 46u) & 127u) == 0u && elife > 0u) {
    if (elife <= 1u) {
      c[i] = 0u; // ember burns out
    } else {
      // Variant pulses slowly based on remaining lifetime
      c[i] = mc(EMBER, elife - 1u, (elife / 50u) & 3u);
    }
  }
  return c;
}

// ═══════════════════════════════════════════
//  PHASE 3: FIRE CONVECTION (post-interaction)
//  Fire rises into empty space, leaves smoke trail.
//  Processed after interactions so fire gets to ignite
//  neighbors before rising away from fuel.
// ═══════════════════════════════════════════
fn convection(cin: Cells, b: Block) -> Cells {
  var c = cin;
  let fire_rng = hh(b.bx * 997u + b.by * 127u + p.frame * 53u);

  // Flicker: occasionally rise diagonally even when straight up is open
  let wob = (fire_rng >> 9u) & 7u;
  if (is_fire(c[2]) && em(c[1]) && wob == 0u) { rise_fire(&c, 2u, 1u); }
  if (is_fire(c[3]) && em(c[0]) && wob == 1u) { rise_fire(&c, 3u, 0u); }

  // Fire rises: BL→TL, BR→TR (50% probability each)
  if (is_fire(c[2]) && em(c[0]) && (fire_rng & 1u) == 0u)         { rise_fire(&c, 2u, 0u); }
  if (is_fire(c[3]) && em(c[1]) && ((fire_rng >> 1u) & 1u) == 0u) { rise_fire(&c, 3u, 1u); }

  // Fire diagonal rise (when straight up blocked, 25% chance)
  if (is_fire(c[2]) && !em(c[0]) && em(c[1]) && ((fire_rng >> 2u) & 3u) == 0u) { rise_fire(&c, 2u, 1u); }
  if (is_fire(c[3]) && !em(c[1]) && em(c[0]) && ((fire_rng >> 4u) & 3u) == 0u) { rise_fire(&c, 3u, 0u); }

  // Fire lateral drift (top row only — fire that's already airborne, 25% chance)
  let drift_dir = (fire_rng >> 6u) & 1u;
  if (is_fire(c[0]) && em(c[1]) && drift_dir == 0u && ((fire_rng >> 7u) & 3u) == 0u) {
    sw(&c, 0u, 1u); // pure swap, no lifetime cost for lateral
  } else if (is_fire(c[1]) && em(c[0]) && drift_dir == 1u && ((fire_rng >> 7u) & 3u) == 0u) {
    sw(&c, 1u, 0u);
  }
  return c;
}

// ═══════════════════════════════════════════
//  ENTRY
// ═══════════════════════════════════════════
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let x = gid.x;
  let y = gid.y;
  if (x >= p.w || y >= p.h) { return; }

  let ph = p.phase & 1u;
  if (ph == 1u && (x == 0u || y == 0u)) {
    go[idx(x, y)] = gi[idx(x, y)];
    return;
  }

  let bx = ((x - ph) / 2u) * 2u + ph;
  let by = ((y - ph) / 2u) * 2u + ph;
  if (bx + 1u >= p.w || by + 1u >= p.h) {
    go[idx(x, y)] = gi[idx(x, y)];
    return;
  }

  let pos = (y - by) * 2u + (x - bx);

  var c: Cells;
  c[0] = gi[idx(bx,      by     )];
  c[1] = gi[idx(bx + 1u, by     )];
  c[2] = gi[idx(bx,      by + 1u)];
  c[3] = gi[idx(bx + 1u, by + 1u)];

  let b = Block(
    bx, by,
    hh(bx * 65537u + by * 251u + p.frame * 31u),
    // Secondary rng, seeds roll() for per-cell probability gates
    hh(bx * 31u + by * 65537u + p.frame * 7919u),
  );

  c = movement(c, b.rng);

  // Visit cells starting from a random slot so no position always acts first
  let start = hh(b.rng ^ 0x5bd1e995u) & 3u;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let i = (start + k) & 3u;
    let t = gt(c[i]);
    if (t == FIRE)       { c = tick_fire(c, i, b); }
    else if (t == SMOKE) { c = tick_smoke(c, i); }
    else if (t == STEAM) { c = tick_steam(c, i, b); }
    else if (t == SEED)  { c = tick_seed(c, i, b); }
    else if (t == PLANT) { c = tick_plant(c, i, b); }
    else if (t == EMBER) { c = tick_ember(c, i, b); }
  }

  c = convection(c, b);

  go[idx(x, y)] = c[pos];
}
`;
