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

fn hh(xi:u32) -> u32 {
  var h = xi;
  h = h ^ (h >> 16u);
  h = h * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  h = h * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  return h;
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
fn fl(c:u32) -> bool { let t = gt(c); return t == SAND || t == WATER || t == SEED; }
fn em(c:u32) -> bool { return gt(c) == EMPTY; }
fn lq(c:u32) -> bool { return gt(c) == WATER; }
fn is_fire(c:u32) -> bool { return gt(c) == FIRE; }
fn disp(mover:u32, dest:u32) -> bool {
  if (em(dest)) { return true; }
  return (gt(mover) == SAND || gt(mover) == SEED) && gt(dest) == WATER;
}
fn rises(c:u32) -> bool { return gt(c) == SMOKE; }
fn burns(c:u32) -> bool { let t = gt(c); return t == PLANT || t == SEED; }
fn sw(cells: ptr<function, Cells>, a:u32, b:u32) {
  let tmp = (*cells)[a]; (*cells)[a] = (*cells)[b]; (*cells)[b] = tmp;
}
fn cell_x(bx:u32, li:u32) -> u32 { return bx + (li & 1u); }
fn cell_y(by:u32, li:u32) -> u32 { return by + (li >> 1u); }

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
//  PHASE 1: MOVEMENT
// ═══════════════════════════════════════════
fn movement(cin: Cells, rng:u32) -> Cells {
  var c = cin;

  // Gravity straight
  if (fl(c[0]) && disp(c[0], c[2])) { sw(&c, 0u, 2u); }
  if (fl(c[1]) && disp(c[1], c[3])) { sw(&c, 1u, 3u); }

  // Gravity diagonal
  if ((rng & 1u) == 0u) {
    if (fl(c[0]) && !disp(c[0], c[2]) && disp(c[0], c[3]) && !fl(c[1])) { sw(&c, 0u, 3u); }
    if (fl(c[1]) && !disp(c[1], c[3]) && disp(c[1], c[2]) && !fl(c[0])) { sw(&c, 1u, 2u); }
  } else {
    if (fl(c[1]) && !disp(c[1], c[3]) && disp(c[1], c[2]) && !fl(c[0])) { sw(&c, 1u, 2u); }
    if (fl(c[0]) && !disp(c[0], c[2]) && disp(c[0], c[3]) && !fl(c[1])) { sw(&c, 0u, 3u); }
  }

  // Smoke rises
  if (rises(c[2]) && em(c[0])) { sw(&c, 2u, 0u); }
  if (rises(c[3]) && em(c[1])) { sw(&c, 3u, 1u); }
  if (rises(c[2]) && !em(c[0]) && em(c[1]) && ((rng >> 2u) & 1u) == 0u) { sw(&c, 2u, 1u); }
  if (rises(c[3]) && !em(c[1]) && em(c[0]) && ((rng >> 3u) & 1u) == 0u) { sw(&c, 3u, 0u); }

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
//  PHASE 2: INTERACTIONS (with probability gates)
//  One tick_* per type; each updates cell i and may touch neighbors.
// ═══════════════════════════════════════════

// FIRE: ignite neighbors, decay into smoke
fn tick_fire(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  let life = gd(c[i]);

  // Ignite flammable neighbors (probability gate: 1/react)
  let ignite_roll = (b.rng2 >> (i * 3u)) % p.react;
  if (ignite_roll == 0u) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      if (j != i && burns(c[j])) {
        var fl_life = 0u;
        if (gt(c[j]) == PLANT) {
          fl_life = gd(c[j]) / 3u + 20u; // plant energy → fire life
        } else {
          fl_life = 50u + (hh(b.bx * 3u + b.by * 7u + j + p.frame) % 40u);
        }
        c[j] = mc(FIRE, fl_life, hh(b.bx + j * 97u + p.frame * 13u) & 3u);
      }
    }
  }

  // Decay
  if (life <= 1u) {
    c[i] = mc(SMOKE, 30u + ((b.rng >> 8u) % 30u), gv(c[i]));
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

// SEED: germinate by consuming adjacent water (probability gate: 1/react)
// The seed becomes the plant's first tip.
fn tick_seed(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  let germ_roll = (b.rng2 >> (8u + i * 2u)) % p.react;
  if (germ_roll == 0u) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      if (j != i && gt(c[j]) == WATER) {
        c[i] = mc(PLANT, GERM_E, noise_variant(cell_x(b.bx, i), cell_y(b.by, i)) | PLANT_TIP);
        c[j] = 0u;
        break;
      }
    }
  }
  return c;
}

// ─── PLANT TREE LINKS ───
// Each plant cell stores which orthogonal neighbor it grew from (its parent)
// in variant bits 3-5: 0 none (root/seedling), 1 left, 2 right, 3 up, 4 down.
// Orthogonal only: in Margolus, some diagonal pairs never share a block.
fn parent_code(v:u32) -> u32 { return (v >> 3u) & 7u; }

// Block slot of i's parent, or 4u if the parent isn't in this block this phase
fn parent_slot(i:u32, code:u32) -> u32 {
  let ix = i & 1u; let iy = i >> 1u;
  if (code == 1u && ix == 1u) { return i ^ 1u; }
  if (code == 2u && ix == 0u) { return i ^ 1u; }
  if (code == 3u && iy == 1u) { return i ^ 2u; }
  if (code == 4u && iy == 0u) { return i ^ 2u; }
  return 4u;
}

// Link code stored in child, pointing at its orthogonal neighbor parent
fn link_code(child:u32, parent:u32) -> u32 {
  if ((child ^ parent) == 1u) {
    if ((parent & 1u) < (child & 1u)) { return 1u; }
    return 2u;
  }
  if ((parent >> 1u) < (child >> 1u)) { return 3u; }
  return 4u;
}

// PLANT: a tree of cells. Tips (PLANT_TIP bit) are the only cells that grow.
//   Any cell absorbs adjacent water. Every cell pulls its parent's energy
//   above STEM_RESERVE toward itself, so energy flows root → tip like a pipe,
//   however far the tips are from the water — non-local behavior from local rules.
fn tick_plant(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  var energy = gd(c[i]);
  var v = gv(c[i]);

  // Watering (probability gate: ~1/(react/2)): water → energy, cell left empty
  for (var j = 0u; j < 4u; j = j + 1u) {
    if (j != i && gt(c[j]) == WATER && energy < ABSORB_CAP) {
      let water_roll = (b.rng2 >> (16u + i)) % max(p.react / 2u, 2u);
      if (water_roll == 0u) {
        energy = min(energy + WATER_GAIN, 255u);
        c[j] = 0u;
      }
    }
  }

  // Transport: pull parent's surplus toward the tips
  let pj = parent_slot(i, parent_code(v));
  if (pj < 4u && gt(c[pj]) == PLANT) {
    let pe = gd(c[pj]);
    if (pe > STEM_RESERVE) {
      let flow = min(min(FLOW_RATE, pe - STEM_RESERVE), 255u - energy);
      energy = energy + flow;
      c[pj] = mc(PLANT, pe - flow, gv(c[pj]));
    }
  }

  // Growth (tips only): try one orthogonal neighbor per step. Spending the
  // noise-dependent cost claims it as the new tip; the old tip becomes stem
  // unless it branches (1/BRANCH_ODDS).
  if ((v & PLANT_TIP) != 0u) {
    let gr = hh(b.bx * 13u + b.by * 7919u + p.frame * 101u + i * 7u);
    var j = i ^ 1u;
    if ((gr & 1u) == 1u) { j = i ^ 2u; }
    let jt = gt(c[j]);
    if (jt == EMPTY || jt == SEED) {
      let jx = cell_x(b.bx, j);
      let jy = cell_y(b.by, j);
      let cost = GROW_COST_MIN + u32(f32(GROW_COST_MAX - GROW_COST_MIN) * (1.0 - growth_noise(jx, jy)));
      if (energy >= cost + 2u) {
        let rest = energy - cost;
        energy = rest / 2u;
        c[j] = mc(PLANT, rest - energy, noise_variant(jx, jy) | PLANT_TIP | (link_code(j, i) << 3u));
        if (((gr >> 2u) % BRANCH_ODDS) != 0u) { v = v & ~PLANT_TIP; }
      }
    }
  }

  // Metabolic cost — very slow drain (1/128 per step)
  // Plants cut off from water eventually starve
  let metab_roll = (b.rng2 >> (24u + i)) & 127u;
  if (metab_roll == 0u && energy > 0u) {
    energy = energy - 1u;
  }

  // Death: plants with no energy become empty
  if (energy == 0u) {
    c[i] = 0u;
  } else {
    c[i] = mc(PLANT, energy, v);
  }
  return c;
}

// EMBER: static, periodically flares up with fire
fn tick_ember(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  let elife = gd(c[i]);

  // Flare: spawn short-lived fire in an adjacent empty cell (~1/128 per step)
  let flare_roll = hh(b.bx * 53u + b.by * 127u + p.frame * 997u + i * 31u) & 127u;
  if (flare_roll == 0u) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      if (j != i && em(c[j])) {
        // Short fire: life 15-25, looks like a spark
        let spark_life = 15u + (hh(b.bx + j * 97u + p.frame) % 11u);
        c[j] = mc(FIRE, spark_life, hh(b.bx * 7u + j + p.frame) & 3u);
        break;
      }
    }
  }

  // Slow decay: 1/128 per step. Lifetime 200 lasts ~25,600 steps (~142s at 3x)
  let edecay = hh(b.bx * 31u + b.by * 53u + p.frame * 71u + i * 13u) & 127u;
  if (edecay == 0u && elife > 0u) {
    if (elife <= 1u) {
      c[i] = 0u; // ember burns out
    } else {
      // Variant pulses slowly based on remaining lifetime
      let ev = (elife / 50u) & 3u;
      c[i] = mc(EMBER, elife - 1u, ev);
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
    // Secondary rng for probability gates (uncorrelated bits)
    hh(bx * 31u + by * 65537u + p.frame * 7919u),
  );

  c = movement(c, b.rng);

  for (var i = 0u; i < 4u; i = i + 1u) {
    let t = gt(c[i]);
    if (t == FIRE)       { c = tick_fire(c, i, b); }
    else if (t == SMOKE) { c = tick_smoke(c, i); }
    else if (t == SEED)  { c = tick_seed(c, i, b); }
    else if (t == PLANT) { c = tick_plant(c, i, b); }
    else if (t == EMBER) { c = tick_ember(c, i, b); }
  }

  c = convection(c, b);

  go[idx(x, y)] = c[pos];
}
`;
