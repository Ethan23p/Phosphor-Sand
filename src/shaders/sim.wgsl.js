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
// Plant momentum, ping-ponged like the grid (see unpack_mom); zero for other cells
@group(0) @binding(3) var<storage,read> mi: array<vec2u>;
@group(0) @binding(4) var<storage,read_write> mo: array<vec2u>;

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
          fl_life = pe(c[j]) / ENERGY_RES / 3u + 20u; // plant energy → fire life
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
      c[i] = mp(GERM_E * ENERGY_RES, noise_variant(cell_x(b.bx, i), cell_y(b.by, i)));
      c[j] = 0u;
    }
  }
  return c;
}

// PLANT: energy and momentum.
//   Energy: a scalar (14 bits, see pe/mp).
//   Momentum: a vector in the parallel momentum buffer, in the same fine units,
//   with |p| <= E. |p| is the moving part of the energy; the rest is at rest.
//   |p| is measured on the 8 directions: the axis part plus sqrt2 times the
//   diagonal part (see speed8), so a packet moving diagonally carries its energy
//   split evenly over x and y.
//   Root distance: how far each cell is from where the plant last drank,
//   measured through the plant (see plant_dist). Bloom favors far cells.
//   Tick order: consume (plant_consume) -> transfer (plant_flow) -> root
//   distance (plant_dist) -> bloom -> decay -> damp (tick_plant).
alias Moms = array<vec2i, 4>;
alias Dists = array<u32, 4>;

const RT2: f32 = 1.41421356;

fn unpack_mom(m:u32) -> vec2i { return vec2i(bitcast<i32>(m << 16u) >> 16u, bitcast<i32>(m) >> 16u); }
fn pack_mom(v:vec2i) -> u32 { return (bitcast<u32>(v.x) & 0xFFFFu) | (bitcast<u32>(v.y) << 16u); }

// |p|: the axis part plus sqrt2 times the diagonal part
fn speed8(v:vec2i) -> u32 {
  let ax = abs(v.x); let ay = abs(v.y);
  return u32(max(ax, ay)) + u32(round(f32(min(ax, ay)) * (RT2 - 1.0)));
}

// Moving energy can't exceed the energy the cell holds
fn clamp_mom(v:vec2i, e:u32) -> vec2i {
  let n = speed8(v);
  if (n <= e) { return v; }
  if (e == 0u) { return vec2i(0, 0); }
  var r = vec2i(vec2f(v) * (f32(e) / f32(n)));
  if (speed8(r) > e) { r = r - vec2i(sign(r.x), sign(r.y)); }
  return r;
}

// Direction from slot i toward its in-block neighbors: x toward i^1, y toward i^2
// (and both toward the diagonal i^3)
fn slot_dir(i:u32) -> vec2i { return vec2i(select(-1, 1, (i & 1u) == 0u), select(-1, 1, (i & 2u) == 0u)); }

// How far energy turns, in radians: the noise map turns it up to turn degrees
// (the same way every time at a given spot), plus a random spread of up to
// spread degrees either way
fn plant_turn(b: Block, i:u32, salt:u32, turn:u32, spread:u32) -> f32 {
  let n = growth_noise(cell_x(b.bx, i), cell_y(b.by, i));
  let r = f32(roll(b, i, salt) & 0xFFFFu) / 65535.0;
  return ((n - 0.5) * 2.0 * f32(turn) + (r - 0.5) * 2.0 * f32(spread)) * 0.0174533;
}

// Rotate a momentum, keeping its moving energy (speed8)
fn turn_mom(v:vec2i, a:f32) -> vec2i {
  let n = speed8(v);
  if (n == 0u) { return v; }
  let f = vec2f(v);
  let r = vec2f(f.x * cos(a) - f.y * sin(a), f.x * sin(a) + f.y * cos(a));
  let ar = abs(r);
  return vec2i(round(r * (f32(n) / (max(ar.x, ar.y) + (RT2 - 1.0) * min(ar.x, ar.y)))));
}

// Consumption: a plant cell that isn't full drinks a neighboring water. The new
// energy is all moving, away from the water, turned (see plant_turn).
fn plant_consume(c: ptr<function, Cells>, m: ptr<function, Moms>, d: ptr<function, Dists>, b: Block) {
  let start = roll(b, 0u, 30u) & 3u;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let i = (start + k) & 3u;
    if (gt((*c)[i]) != PLANT) { continue; }
    let energy = pe((*c)[i]);
    if (energy + WATER_GAIN * ENERGY_RES > PLANT_CAP * ENERGY_RES) { continue; }
    let j = find_neighbor(*c, i, WATER, roll(b, i, 31u));
    if (j == 4u) { continue; }
    let away = vec2f(f32(i & 1u) - f32(j & 1u), f32(i >> 1u) - f32(j >> 1u));
    let a = atan2(away.y, away.x) + plant_turn(b, i, 32u, DRINK_TURN, DRINK_SPREAD);
    let u = vec2f(cos(a), sin(a));
    let ad = abs(u);
    let g = f32(WATER_GAIN * ENERGY_RES) / (max(ad.x, ad.y) + (RT2 - 1.0) * min(ad.x, ad.y));
    let ne = energy + WATER_GAIN * ENERGY_RES;
    (*m)[i] = clamp_mom((*m)[i] + vec2i(round(u * g)), ne);
    (*c)[i] = mp(ne, gv((*c)[i]));
    (*c)[j] = 0u;
    (*d)[i] = 0u;
  }
}

// Root distance, in half cells (an orthogonal step is 2, a diagonal 3), capped
// at DIST_CAP. Drinking sets a cell's distance to 0; every cell otherwise takes
// the shortest route offered by its plant neighbors in this block. A distance
// also creeps up now and then unless a neighbor keeps confirming it, so a
// branch cut off from its roots drifts up to the cap.
const DIST_CAP: u32 = 255u;
fn plant_dist(c: Cells, d: ptr<function, Dists>, b: Block) {
  var nd: Dists;
  for (var i = 0u; i < 4u; i = i + 1u) {
    nd[i] = DIST_CAP;
    if (gt(c[i]) != PLANT) { continue; }
    var v = (*d)[i];
    if ((roll(b, i, 51u) % DIST_CREEP_ODDS) == 0u) { v = min(v + 1u, DIST_CAP); }
    for (var j = 0u; j < 4u; j = j + 1u) {
      if (j == i || gt(c[j]) != PLANT) { continue; }
      v = min(v, (*d)[j] + select(2u, 3u, (i ^ j) == 3u));
    }
    nd[i] = v;
  }
  *d = nd;
}

// Bounce off something that isn't plant: the momentum into it flips, with loss
// (then turns, see plant_turn)
fn plant_reflect(q:vec2i, fx:bool, fy:bool, loss:u32) -> vec2i {
  let r = vec2i(select(q.x, -q.x, fx), select(q.y, -q.y, fy));
  return vec2i(vec2f(r) * (f32(100u - loss) / 100.0));
}

// Glance off stone (or anything solid) or a full plant cell: turn about 90
// degrees, the side picked with odds set by the noise map, up to DEFLECT_SPREAD
// degrees off square, losing SOLID_LOSS %
fn plant_deflect(q:vec2i, b: Block, i:u32, salt:u32) -> vec2i {
  let n = growth_noise(cell_x(b.bx, i), cell_y(b.by, i));
  let r = roll(b, i, salt);
  let side = select(-1.0, 1.0, f32(r & 0xFFFFu) / 65535.0 < n);
  let jit = (f32((r >> 16u) & 0xFFFFu) / 65535.0 - 0.5) * 2.0 * f32(DEFLECT_SPREAD);
  let t = turn_mom(q, (side * 90.0 + jit) * 0.0174533);
  return vec2i(vec2f(t) * (f32(100u - SOLID_LOSS) / 100.0));
}

// Transfer, for the whole block at once. A cell's moving energy splits between
// the two nearest of the 8 directions: an axis part and a diagonal part. Each
// part moves when its target is in this block (every other step), carrying its
// share of p; the energy left behind is at rest. In-block targets are i^1, i^2
// and i^3.
fn plant_flow(c: ptr<function, Cells>, m: ptr<function, Moms>, d: Dists, b: Block) {
  var e0: array<u32, 4>;
  var oe: array<array<u32, 4>, 4>;   // energy sent from i to j
  var oq: array<array<vec2i, 4>, 4>; // momentum sent from i to j
  for (var i = 0u; i < 4u; i = i + 1u) {
    e0[i] = select(0u, pe((*c)[i]), gt((*c)[i]) == PLANT);
    for (var j = 0u; j < 4u; j = j + 1u) { oe[i][j] = 0u; oq[i][j] = vec2i(0, 0); }
  }

  for (var i = 0u; i < 4u; i = i + 1u) {
    if (gt((*c)[i]) != PLANT) { continue; }
    let v = (*m)[i];
    if (v.x == 0 && v.y == 0) { continue; }
    let s = vec2i(sign(v.x), sign(v.y));
    let ax = abs(v.x); let ay = abs(v.y);
    let mn = min(ax, ay);
    let dir = slot_dir(i);
    var ea = u32(max(ax, ay) - mn);
    var ed = u32(round(f32(mn) * RT2));
    let tot = ea + ed;
    if (tot > e0[i]) { ea = ea * e0[i] / tot; ed = e0[i] - ea; }
    // axis part, slowed to the diagonals' pace: an axis neighbor shares a block
    // on 2 phases of 4, a diagonal on 1 but sqrt2 farther away
    let go_axis = (roll(b, i, 50u) & 1023u) < 724u;
    if (go_axis && ax > ay && s.x == dir.x) {
      oe[i][i ^ 1u] += ea; oq[i][i ^ 1u] += vec2i(v.x - s.x * mn, 0);
    } else if (go_axis && ay > ax && s.y == dir.y) {
      oe[i][i ^ 2u] += ea; oq[i][i ^ 2u] += vec2i(0, v.y - s.y * mn);
    }
    // diagonal part
    if (mn > 0) {
      let q = s * mn;
      if (s.x == dir.x && s.y == dir.y) { oe[i][i ^ 3u] += ed; oq[i][i ^ 3u] += q; }
    }
  }

  var inc: array<u32, 4>;
  for (var j = 0u; j < 4u; j = j + 1u) {
    inc[j] = 0u;
    for (var i = 0u; i < 4u; i = i + 1u) { inc[j] += oe[i][j]; }
  }

  var e1: array<i32, 4>;
  var m1: Moms;
  var full: array<bool, 4>;
  for (var i = 0u; i < 4u; i = i + 1u) {
    e1[i] = i32(e0[i]); m1[i] = (*m)[i];
    full[i] = gt((*c)[i]) == PLANT && e0[i] + inc[i] > PLANT_CAP * ENERGY_RES;
  }
  for (var i = 0u; i < 4u; i = i + 1u) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      let q = oq[i][j];
      let en = oe[i][j];
      if (i == j || (q.x == 0 && q.y == 0 && en == 0u)) { continue; }
      let tj = gt((*c)[j]);
      if (tj == EMPTY || tj == WATER) {
        // Water reflects with small loss. Open air reflects with hardly any
        // loss near the roots, rising to AIR_LOSS at BLOOM_DIST cells out, so
        // energy races through the young part of the plant and slows at its
        // far edges, where it can bloom
        let reach = f32(min(d[i], 2u * BLOOM_DIST)) / f32(2u * BLOOM_DIST);
        let loss = select(u32(round(f32(AIR_LOSS) * reach)), WATER_LOSS, tj == WATER);
        let r = plant_reflect(q, ((i ^ j) & 1u) != 0u, ((i ^ j) & 2u) != 0u, loss);
        m1[i] += turn_mom(r, plant_turn(b, i, 53u + j, NOISE_TURN, SPREAD)) - q;
      } else if (tj != PLANT || full[j]) {
        // Stone and the like, or a full plant cell: the energy stays and the
        // momentum glances off sideways
        m1[i] += plant_deflect(q, b, i, 57u + j) - q;
      } else {
        e1[i] -= i32(en); e1[j] += i32(en);
        m1[i] -= q; m1[j] += q;
      }
    }
  }
  for (var i = 0u; i < 4u; i = i + 1u) {
    if (gt((*c)[i]) != PLANT) { continue; }
    (*m)[i] = m1[i];
    (*c)[i] = mp(u32(e1[i]), gv((*c)[i]));
  }
}

fn tick_plant(cin: Cells, m: ptr<function, Moms>, d: ptr<function, Dists>, i:u32, b: Block) -> Cells {
  var c = cin;
  var energy = pe(c[i]);
  let color = gv(c[i]) & 3u;
  let mom = (*m)[i];

  // Bloom: high energy, low momentum, and more likely the farther from the
  // roots (certain at BLOOM_DIST cells, 1 in BLOOM_NEAR_ODDS at the roots).
  // Grows into an orthogonal neighbor of open air, or, less often and only
  // fuller, of water (replacing it)
  var far = max((*d)[i] * BLOOM_NEAR_ODDS, 2u * BLOOM_DIST) > roll(b, i, 52u) % (2u * BLOOM_DIST * BLOOM_NEAR_ODDS);
  // With BLOOM_TIP, only a tip blooms: no plant neighbor in the block is farther out
  for (var j = 0u; j < 4u; j = j + 1u) {
    if (BLOOM_TIP == 1u && j != i && gt(c[j]) == PLANT && (*d)[j] > (*d)[i]) { far = false; }
  }
  if (far && energy >= BLOOM_E * ENERGY_RES && speed8(mom) * 100u <= energy * BLOOM_MOVING) {
    let r = roll(b, i, 47u) & 1u;
    for (var k = 0u; k < 2u; k = k + 1u) {
      let j = i ^ (1u + ((r + k) & 1u));
      let tj = gt(c[j]);
      let into_water = tj == WATER && energy >= BLOOM_WATER_E * ENERGY_RES
                       && (roll(b, i, 48u + k) % BLOOM_WATER_ODDS) == 0u;
      if (tj == EMPTY || into_water) {
        let half = energy / 2u;
        energy = energy - half;
        c[j] = mp(half, noise_variant(cell_x(b.bx, j), cell_y(b.by, j)));
        (*m)[j] = vec2i(0, 0);
        (*d)[j] = min((*d)[i] + 2u, DIST_CAP);
        break;
      }
    }
  }

  // Decay: burn one fine unit every ~METAB_ODDS / ENERGY_RES steps (one whole
  // unit per ~METAB_ODDS), sometimes breathing out steam into open air
  let mr = roll(b, i, 34u);
  if ((mr % max(METAB_ODDS / ENERGY_RES, 1u)) == 0u && energy > 0u) {
    energy = energy - 1u;
    if (((mr >> 8u) % (TRANSPIRE_ODDS * ENERGY_RES)) == 0u) {
      let j = find_neighbor(c, i, EMPTY, roll(b, i, 37u));
      if (j < 4u) { c[j] = steam_cell(roll(b, i, 38u)); }
    }
  }

  // An empty cell dies, sometimes leaving a seed
  if (energy == 0u) {
    if ((roll(b, i, 35u) % SEED_DROP_ODDS) == 0u) { c[i] = mc(SEED, 0u, roll(b, i, 36u) & 3u); }
    else { c[i] = 0u; }
    (*m)[i] = vec2i(0, 0);
    return c;
  }

  // Damp: moving energy settles into resting energy, hardly at all near the
  // roots and up to DAMP per mille from BLOOM_DIST cells out
  let reach = f32(min((*d)[i], 2u * BLOOM_DIST)) / f32(2u * BLOOM_DIST);
  let damped = vec2i(vec2f(mom) * (1.0 - f32(DAMP) / 1000.0 * reach));
  (*m)[i] = clamp_mom(damped, energy);
  c[i] = mp(energy, color);
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

  // Four phases, block offsets (0,0) (1,1) (0,1) (1,0), so every pair of
  // neighbors, diagonals included, shares a block on some phase
  let ph = p.phase & 3u;
  let ox = ph & 1u;
  let oy = (ph ^ (ph >> 1u)) & 1u;
  if ((ox == 1u && x == 0u) || (oy == 1u && y == 0u)) {
    go[idx(x, y)] = gi[idx(x, y)];
    mo[idx(x, y)] = mi[idx(x, y)];
    return;
  }

  let bx = ((x - ox) / 2u) * 2u + ox;
  let by = ((y - oy) / 2u) * 2u + oy;
  if (bx + 1u >= p.w || by + 1u >= p.h) {
    go[idx(x, y)] = gi[idx(x, y)];
    mo[idx(x, y)] = mi[idx(x, y)];
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

  // Plants never move, so a plant's momentum stays in its slot
  var m: Moms;
  var dist: Dists;
  for (var k = 0u; k < 4u; k = k + 1u) {
    m[k] = vec2i(0, 0); dist[k] = DIST_CAP;
    if (gt(c[k]) == PLANT) {
      let ps = mi[idx(bx + (k & 1u), by + (k >> 1u))];
      m[k] = unpack_mom(ps.x); dist[k] = ps.y;
    }
  }

  c = movement(c, b.rng);
  plant_consume(&c, &m, &dist, b);
  plant_flow(&c, &m, dist, b);
  plant_dist(c, &dist, b);

  // Visit cells starting from a random slot so no position always acts first
  let start = hh(b.rng ^ 0x5bd1e995u) & 3u;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let i = (start + k) & 3u;
    let t = gt(c[i]);
    if (t == FIRE)       { c = tick_fire(c, i, b); }
    else if (t == SMOKE) { c = tick_smoke(c, i); }
    else if (t == STEAM) { c = tick_steam(c, i, b); }
    else if (t == SEED)  { c = tick_seed(c, i, b); dist[i] = 0u; } // a sprout is a root
    else if (t == PLANT) { c = tick_plant(c, &m, &dist, i, b); }
    else if (t == EMBER) { c = tick_ember(c, i, b); }
  }

  c = convection(c, b);

  go[idx(x, y)] = c[pos];
  mo[idx(x, y)] = select(vec2u(0u), vec2u(pack_mom(m[pos]), dist[pos]), gt(c[pos]) == PLANT);
}
`;
