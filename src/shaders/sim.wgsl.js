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
fn em(c:u32) -> bool { return gt(c) == EMPTY; }
fn lq(c:u32) -> bool { return gt(c) == WATER; }
// Liquids (water, oil, soap, lipid) move alike (see fall, flow); lq is water alone
// (a bonded lipid or its tail isn't: a pair only moves as a pair, see tick_amph)
fn liq(c:u32) -> bool { let t = gt(c); return (t == WATER || t == OIL || amph(c)) && !bonded(c); }
fn fl(c:u32) -> bool { return heavy(c) || liq(c); }
// Liquid weight: oil 0 floats on water 2; soap and lipid weigh as much as water
// (they float on it as a film and mix into it by their own moves, see tick_amph)
fn weight(c:u32) -> u32 { return select(2u, 0u, gt(c) == OIL); }
fn is_fire(c:u32) -> bool { return gt(c) == FIRE; }
// Can mover fall into dest? Heavy particles sink through liquid, and water,
// soap and lipid sink through oil, only when this block's sink bit is set (~half
// the steps), so they sink at half speed. Seeds float on water, soap and lipid
// but sink in oil. (Falling water also passes through soap and lipid, and they
// plunge into water: see fall.)
fn disp(mover:u32, dest:u32, sink:bool) -> bool {
  if (em(dest)) { return true; }
  if (bonded(dest)) { return false; }
  if (!sink) { return false; }
  let td = gt(dest);
  if (td == OIL) { return heavy(mover) || lq(mover) || amph(mover); }
  return heavy(mover) && gt(mover) != SEED && (lq(dest) || amph(dest));
}

// Motion state of a loose cell (sand, water, seed, ember), in the variant bits
// above the color (bits 0-1): bits 2-4 fall speed (0: at rest), bit 5 the
// sideways direction (1: right), bits 6-7 sideways momentum left from a landing.
fn fall_v(c:u32) -> u32 { return (gv(c) >> 2u) & 7u; }
fn side_r(c:u32) -> bool { return ((gv(c) >> 5u) & 1u) == 1u; }
fn skid_v(c:u32) -> u32 { return (gv(c) >> 6u) & 3u; }
fn motion(c:u32, v:u32, right:bool, skid:u32) -> u32 {
  return mc(gt(c), gd(c), (gv(c) & 3u) | (v << 2u) | (select(0u, 1u, right) << 5u) | (skid << 6u));
}

// Gravity for top slot i (0 or 1) falling into the slot below it. A falling
// grain speeds up: it falls with chance (FALL_START + v) / (FALL_START + 7), and
// each step it's unsupported v rises 1 in FALL_ACCEL_ODDS (at least to 1, so a
// cell that has left the ground counts as falling). Sinking through water
// caps v at 1 (drag). On landing on something at rest, a heavy cell turns its
// speed into a sideways skid (see skid) and comes to rest. Water always falls at
// full rate (a body of water mustn't hang in the air, full of holes); its speed
// only marks it as falling (see flow).
fn fall(c: ptr<function, Cells>, i:u32, b: Block, sink:bool) {
  let a = (*c)[i];
  if (!fl(a)) { return; }
  let j = i + 2u;
  let v = fall_v(a);
  // a soap-coated oil droplet (see tick_amph) stays put in water: liquids
  // don't sink past it
  let held = liq(a) && gt((*c)[j]) == OIL && gd((*c)[j]) == 1u;
  if (disp(a, (*c)[j], sink) && !held) {
    var nv = max(v, 1u);
    if (nv < 7u && (roll(b, i, 70u) % FALL_ACCEL_ODDS) == 0u) { nv += 1u; }
    if (liq((*c)[j])) { nv = 1u; }
    let moved = motion(a, nv, side_r(a), select(0u, skid_v(a), liq(a)));   // liquid keeps its sideways momentum (see flow)
    if (liq(a) || (roll(b, i, 71u) % (FALL_START + 7u)) < FALL_START + v) { (*c)[i] = (*c)[j]; (*c)[j] = moved; }
    else { (*c)[i] = moved; }
  } else if (lq(a) && v >= 4u && gt((*c)[j]) == SOAP && (roll(b, i, 100u) % FOAM_ODDS) == 0u) {
    // Lather: water falling fast onto soap whips it up into foam (the soap, as a
    // film, plus bubbles of the air around it); the water takes its place
    (*c)[i] = mc(FOAM, 1u, roll(b, i, 101u) & 3u);
    (*c)[j] = motion(a, 0u, side_r(a), 0u);
    for (var k = 0u; k < 4u; k = k + 1u) { if (em((*c)[k])) { (*c)[k] = mc(FOAM, 0u, (roll(b, i, 102u) >> (2u * k)) & 3u); } }
  } else if (lq(a) && v >= 3u && gt((*c)[j]) == SAND && fall_v((*c)[j]) == 0u && (roll(b, i, 75u) % ERODE_ODDS) == 0u) {
    // Fast water hitting sand splashes a grain up and aside (the water digs in):
    // a waterfall carves a plunge pool and heaps the sand around it
    (*c)[i] = motion((*c)[j], 0u, (roll(b, i, 76u) & 1u) == 1u, 3u);
    (*c)[j] = motion(a, 0u, side_r(a), 0u);
  } else if (v > 0u && ((lq(a) && amph((*c)[j]) && !bonded((*c)[j])) || (amph(a) && lq((*c)[j])))) {
    // Falling water passes through soap and lipid (rain falls through a film),
    // and falling soap or lipid plunges into water, slowing to a stop 1 in
    // AMPH_PLUNGE_ODDS steps (resting, they weigh the same: see weight)
    var nv = 1u;
    if (amph(a) && (roll(b, i, 126u) % AMPH_PLUNGE_ODDS) == 0u) { nv = 0u; }
    (*c)[i] = (*c)[j];
    (*c)[j] = motion(a, nv, side_r(a), 0u);
  } else if (v > 0u) {
    // a grain resting on one still falling keeps pace with it (water lands at
    // once, so a body of water is never all marked as falling and can flow)
    let below = (*c)[j];
    if (!liq(a) && fl(below) && fall_v(below) > 0u) { (*c)[i] = motion(a, min(v, fall_v(below)), side_r(a), 0u); return; }
    var skid = skid_v(a);
    if (heavy(a)) { skid = min((v + 1u) / 2u, 3u); }
    (*c)[i] = motion(a, 0u, side_r(a), skid);   // keeps its direction: water poured down a slope keeps going
  }
}

// A cell that can't fall straight rolls down diagonally (top slot i to the
// opposite bottom slot) if the side it rolls past is clear, and keeps rolling:
// it leaves at ROLL_V speed at least, so it doesn't hang on the slope (a hanging
// grain would prop up the ones above it and make piles too steep)
fn roll_off(c: ptr<function, Cells>, i:u32, sink:bool) {
  let a = (*c)[i];
  let j = 3u - i;
  if (fl(a) && !disp(a, (*c)[i + 2u], sink) && disp(a, (*c)[j], sink) && !fl((*c)[i ^ 1u])) {
    (*c)[i] = (*c)[j];
    (*c)[j] = motion(a, max(fall_v(a), ROLL_V), side_r(a), skid_v(a));
  }
}

// A heavy cell that landed with speed skids sideways (its skid momentum, one
// cell a move) into open space beside it, or through water while it has 2 or
// more, so impacts spread out and piles settle lower than 45 degrees, and sand
// kicked up by water (see flow) is carried downstream. Blocked, it stops.
fn skid(c: ptr<function, Cells>, i:u32) {
  let a = (*c)[i];
  if (!heavy(a)) { return; }
  let k = skid_v(a);
  if (k == 0u) { return; }
  let left = (i & 1u) == 0u;
  if (side_r(a) != left) { return; }        // its direction leaves the block: wait
  let j = i ^ 1u;
  if (em((*c)[j]) || (k >= 2u && lq((*c)[j]))) { (*c)[i] = (*c)[j]; (*c)[j] = motion(a, fall_v(a), side_r(a), k - 1u); }
  else { (*c)[i] = motion(a, fall_v(a), side_r(a), 0u); }
}

// Water flows sideways the way it remembers, so it travels instead of
// wandering (a hump levels in linear time, not diffusively). Blocked, it turns
// around: always at a wall, 1 in FLOW_TURN_ODDS times against other water (so
// water inside a body keeps shuffling its directions and its edges pour out).
// Flowing gives it sideways momentum (the skid bits, SPILL cells' worth), which
// it keeps as it falls, one cell a move: water running off a ledge arcs out
// instead of hugging the wall. Water falling with none (rain, drips, pours)
// falls straight, so streams don't spray.
//
// Oil flows the same way at 1 in OIL_FLOW_ODDS steps (it's thick).
fn flow(c: ptr<function, Cells>, i:u32, b: Block) {
  let a = (*c)[i];
  if (!liq(a)) { return; }
  if (gt(a) == OIL && (roll(b, i, 80u) % OIL_FLOW_ODDS) != 0u) { return; }
  let falling = fall_v(a) > 0u;
  if (falling && skid_v(a) == 0u) { return; }
  let left = (i & 1u) == 0u;
  if (side_r(a) != left) { return; }
  let j = i ^ 1u;
  if (em((*c)[j])) {
    (*c)[i] = (*c)[j];
    (*c)[j] = motion(a, fall_v(a), side_r(a), select(SPILL, skid_v(a) - 1u, falling));
    // Erosion: water spilling over a sand edge (open air or water below where
    // it's going) now and then kicks the edge grain up into the stream (the
    // water drops into its place), with the stream's momentum; the grain is
    // carried over the edge (see skid) and settles downhill. So streams cut
    // back into sand and wear channels, and the sand builds up where they slow.
    if (i < 2u && lq(a) && gt((*c)[i + 2u]) == SAND && (em((*c)[j + 2u]) || lq((*c)[j + 2u]))
        && (roll(b, i, 74u) % ERODE_ODDS) == 0u) {
      (*c)[i] = motion((*c)[i + 2u], 0u, side_r(a), 3u);
      (*c)[i + 2u] = (*c)[j];
      (*c)[j] = 0u;
    }
  } else if (i >= 2u && liq((*c)[j]) && weight((*c)[j]) < weight(a) && (roll(b, i, 108u) & 1u) == 0u) {
    // a heavier liquid flows under a lighter one beside it, so liquids spread
    // into layers instead of standing in columns
    (*c)[i] = (*c)[j];
    (*c)[j] = a;
  } else if (!liq((*c)[j]) || (roll(b, i, 73u) % FLOW_TURN_ODDS) == 0u) {
    (*c)[i] = motion(a, fall_v(a), !side_r(a), select(0u, skid_v(a), !falling));
  }
}

fn gas(c:u32) -> bool { let t = gt(c); return t == SMOKE || t == STEAM; }
// Gases rise into empty space; steam also bubbles up through water
fn rises_into(g:u32, above:u32) -> bool { return em(above) || (gt(g) == STEAM && liq(above)); }
fn burns(c:u32) -> bool { let t = gt(c); return t == PLANT || t == SEED || t == OIL; }
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
fn movement(cin: Cells, b: Block) -> Cells {
  var c = cin;
  let rng = b.rng;
  let sink = ((rng >> 9u) & 1u) == 0u;

  // Gravity straight (see fall)
  fall(&c, 0u, b, sink);
  fall(&c, 1u, b, sink);

  // Gravity diagonal: a cell that can't fall straight rolls off (see roll)
  if ((rng & 1u) == 0u) { roll_off(&c, 0u, sink); roll_off(&c, 1u, sink); }
  else { roll_off(&c, 1u, sink); roll_off(&c, 0u, sink); }

  // Skids from landings
  let sk = (rng >> 13u) & 3u;
  for (var k = 0u; k < 4u; k = k + 1u) { skid(&c, (sk + k) & 3u); }

  // Seeds float: a seed under water bobs up through it
  if (gt(c[2]) == SEED && lq(c[0]) && ((rng >> 15u) & 1u) == 0u) { sw(&c, 2u, 0u); }
  if (gt(c[3]) == SEED && lq(c[1]) && ((rng >> 16u) & 1u) == 0u) { sw(&c, 3u, 1u); }

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

  // Foam is light and stiff: it rises through liquid, settles slowly through
  // air and heaps rather than flowing
  if (gt(c[2]) == FOAM && liq(c[0])) { sw(&c, 2u, 0u); }
  if (gt(c[3]) == FOAM && liq(c[1])) { sw(&c, 3u, 1u); }
  if (gt(c[0]) == FOAM && em(c[2]) && ((rng >> 19u) & 3u) == 0u) { sw(&c, 0u, 2u); }
  if (gt(c[1]) == FOAM && em(c[3]) && ((rng >> 21u) & 3u) == 0u) { sw(&c, 1u, 3u); }

  // Water flows sideways (see flow)
  for (var k = 0u; k < 4u; k = k + 1u) { flow(&c, (sk + k) & 3u, b); }

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
        } else if (gt(c[j]) == OIL) {
          fl_life = OIL_FIRE_LIFE + (roll(b, j, 14u) % 40u);
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
    if (life <= 1u) { c[i] = mc(WATER, 0u, roll(b, i, 18u) & 0x23u); } // random color and flow direction
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
//   Tick order: consume (plant_consume) -> transfer and bloom (plant_flow) ->
//   root distance (plant_dist) -> decay -> damp (tick_plant).
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
    // up to DRINK_MAX of the water cells it touches in this block, one at a time
    for (var n = 0u; n < DRINK_MAX; n = n + 1u) {
      let j = find_neighbor(*c, i, WATER, roll(b, i, 31u + 50u * n));
      if (j == 4u) { break; }
      (*d)[i] = 0u; // touching water is a source, full or not
      let energy = pe((*c)[i]);
      if (energy + WATER_GAIN * ENERGY_RES > E_MAX) { break; } // storage is full
      let away = vec2f(f32(i & 1u) - f32(j & 1u), f32(i >> 1u) - f32(j >> 1u));
      let a = atan2(away.y, away.x) + plant_turn(b, i, 32u + 50u * n, DRINK_TURN, DRINK_SPREAD);
      let u = vec2f(cos(a), sin(a));
      let ad = abs(u);
      let g = f32(WATER_GAIN * ENERGY_RES) / (max(ad.x, ad.y) + (RT2 - 1.0) * min(ad.x, ad.y));
      let ne = energy + WATER_GAIN * ENERGY_RES;
      (*m)[i] = clamp_mom((*m)[i] + vec2i(round(u * g)), ne);
      (*c)[i] = mp(ne, gv((*c)[i]));
      (*c)[j] = 0u;
    }
  }
}

// Root distance, in half cells (an orthogonal step is 2, a diagonal 3), capped
// at DIST_CAP. Touching water (drinking or full) sets a cell's distance to 0;
// every cell otherwise takes the shortest route offered by its plant neighbors
// in this block. A distance
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

// Age. Bits 0-7: the cell's own age, rising 1 in AGE_ODDS steps (it retires at
// 255, see tick_plant). Bits 8-15: the plant's age, the oldest any of its cells
// has been, passed through the plant and never lowered. A new cell starts at 0
// but takes its parent's plant age, so a plant younger than GROWN_AGE is a
// seedling, and every new tendril of an older plant counts as grown.
fn plant_age(c: Cells, k: ptr<function, Dists>, b: Block) {
  var nk: Dists;
  for (var i = 0u; i < 4u; i = i + 1u) {
    nk[i] = 0u;
    if (gt(c[i]) != PLANT) { continue; }
    var age = (*k)[i] & 255u;
    if ((roll(b, i, 71u) % AGE_ODDS) == 0u) { age = min(age + 1u, 255u); }
    var old = max((*k)[i] >> 8u, age);
    for (var j = 0u; j < 4u; j = j + 1u) {
      if (j != i && gt(c[j]) == PLANT) { old = max(old, (*k)[j] >> 8u); }
    }
    nk[i] = age | (old << 8u);
  }
  *k = nk;
}

// Bounce off something that isn't plant, like a mirror: a move along an axis
// flips that axis; a diagonal move flips the axis the wall faces (judged from
// the two axis neighbors), or both at a corner. So a stem guides its packets
// like a waveguide: whatever runs along it keeps running along it.
fn plant_mirror(q:vec2i, c: Cells, i:u32, j:u32) -> vec2i {
  let cx = ((i ^ j) & 1u) != 0u;
  let cy = ((i ^ j) & 2u) != 0u;
  if (cx && cy) {
    let bx = gt(c[i ^ 1u]) != PLANT;
    let by = gt(c[i ^ 2u]) != PLANT;
    if (bx && !by) { return vec2i(-q.x, q.y); }
    if (by && !bx) { return vec2i(q.x, -q.y); }
    return -q;
  }
  if (cx) { return vec2i(-q.x, q.y); }
  return vec2i(q.x, -q.y);
}

// Pressure: stored energy pushes momentum toward neighbors holding less (the
// restoring force that makes energy travel as waves rather than sit). Stone,
// water and the like push back as hard as the cell itself does (no pull); open
// air pulls (pressure 0) only as far as the plant may bloom into it (see
// bloom_odds), so energy is drawn toward the growth front, not into air by
// its roots. PRESS: percent of the difference added each step.
fn plant_press(c: Cells, m: ptr<function, Moms>, d: Dists, k: Dists) {
  for (var i = 0u; i < 4u; i = i + 1u) {
    if (gt(c[i]) != PLANT) { continue; }
    let ei = f32(pe(c[i]));
    let dir = vec2f(slot_dir(i));
    var g = vec2f(0.0, 0.0);
    for (var s = 1u; s < 4u; s = s + 1u) {
      let j = i ^ s;
      var pj = ei;
      if (gt(c[j]) == PLANT) { pj = f32(pe(c[j])); }
      else if (gt(c[j]) == EMPTY) { pj = ei * (1.0 - bloom_odds(d[i], k[i])); }
      let w = select(1.0, 0.5, s == 3u);
      g += dir * vec2f(f32(s & 1u), f32(s >> 1u)) * (ei - pj) * w;
    }
    (*m)[i] = clamp_mom((*m)[i] + vec2i(round(g * (f32(PRESS) / 100.0))), pe(c[i]));
  }
  // Viscosity: each plant cell's momentum relaxes VISC % toward the block's
  // average (total momentum kept), so neighbors move together as streams
  // rather than sloshing against each other
  var sum = vec2f(0.0, 0.0);
  var n = 0.0;
  for (var i = 0u; i < 4u; i = i + 1u) { if (gt(c[i]) == PLANT) { sum += vec2f((*m)[i]); n += 1.0; } }
  if (n < 2.0) { return; }
  let avg = sum / n;
  for (var i = 0u; i < 4u; i = i + 1u) {
    if (gt(c[i]) != PLANT) { continue; }
    let v = vec2f((*m)[i]);
    (*m)[i] = clamp_mom(vec2i(round(v + (avg - v) * (f32(VISC) / 100.0))), pe(c[i]));
  }
}

// How many plant cells, other than j itself, share the block: a new cell at j
// supported by 2 or more grows as usual; one touching only its parent (the tip
// of a one-cell ray) grows BLOOM_TIP per mille as often, so growth advances as
// thick fronts rather than rays
fn bloom_support(c: Cells, j:u32) -> f32 {
  var n = 0u;
  for (var s = 1u; s < 4u; s = s + 1u) { if (gt(c[j ^ s]) == PLANT) { n += 1u; } }
  return select(1.0, f32(BLOOM_TIP) / 1000.0, n < 2u);
}

// Transfer, for the whole block at once. First pressure (plant_press) pushes
// momentum; then a cell's moving energy splits between the two nearest of the 8
// directions: an axis part and a diagonal part. Each part moves when its target
// is in this block, carrying its share of p; the energy left behind is at rest
// (and pressure sets it moving again). In-block targets are i^1, i^2 and i^3.
fn plant_flow(c: ptr<function, Cells>, m: ptr<function, Moms>, d: ptr<function, Dists>, k: ptr<function, Dists>, b: Block) {
  plant_press(*c, m, *d, *k);
  let c0 = *c;
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
    full[i] = gt((*c)[i]) == PLANT && e0[i] + inc[i] > E_MAX; // would overflow storage
  }
  for (var i = 0u; i < 4u; i = i + 1u) {
    for (var j = 0u; j < 4u; j = j + 1u) {
      let q = oq[i][j];
      let en = oe[i][j];
      if (i == j || (q.x == 0 && q.y == 0 && en == 0u)) { continue; }
      let tj = gt((*c)[j]);
      // Bloom: a packet from a cell with at least BLOOM_E pushing into open
      // air (or, 1 in BLOOM_WATER_ODDS times, into water, replacing it) grows
      // a new cell there, if the source is far enough from the roots (see
      // bloom_odds) and the new cell would be supported (see bloom_support).
      // Building the cell turns WATER_GAIN of the packet's energy (one water's
      // worth) into its structure, which it gives back as steam when it retires
      // (see tick_plant); the new cell takes the rest of the packet's energy and
      // its momentum.
      let kept = i32(en) - i32(WATER_GAIN * ENERGY_RES);
      let into = tj == EMPTY || (tj == WATER && (roll(b, i, 64u + j) % BLOOM_WATER_ODDS) == 0u);
      if (into && kept >= i32(ENERGY_RES) && e1[i] >= i32(BLOOM_E * ENERGY_RES)
          && f32(roll(b, i, 60u + j) & 0xFFFFFFu) / 16777216.0 < bloom_odds((*d)[i], (*k)[i]) * bloom_support(c0, j)) {
        (*c)[j] = mp(0u, noise_variant(cell_x(b.bx, j), cell_y(b.by, j)));
        (*d)[j] = min((*d)[i] + select(2u, 3u, (i ^ j) == 3u), DIST_CAP);
        (*k)[j] = (*k)[i] & 0xFF00u; // newborn, in the parent's plant
        e1[i] -= i32(en); e1[j] += kept;
        m1[i] -= q; m1[j] += vec2i(vec2f(q) * (f32(kept) / f32(en)));
      } else if (tj == PLANT && !full[j]) {
        e1[i] -= i32(en); e1[j] += i32(en);
        m1[i] -= q; m1[j] += q;
      } else {
        // Reflect (see plant_mirror). Air and water also scatter it a little
        // (the noise map plus random spread) and take AIR_LOSS / WATER_LOSS %
        // of its momentum; that energy stays, at rest, for pressure to move.
        var r = plant_mirror(q, c0, i, j);
        if (tj == EMPTY || tj == WATER) {
          let loss = select(WATER_LOSS, AIR_LOSS, tj == EMPTY);
          r = turn_mom(vec2i(vec2f(r) * (f32(100u - loss) / 100.0)), plant_turn(b, i, 53u + j, NOISE_TURN, SPREAD));
        }
        m1[i] += r - q;
      }
    }
  }
  for (var i = 0u; i < 4u; i = i + 1u) {
    if (gt((*c)[i]) != PLANT) { continue; }
    let e = u32(max(e1[i], 0));
    (*m)[i] = clamp_mom(m1[i], e);
    (*c)[i] = mp(e, gv((*c)[i]));
  }
}

// Chance that a push into air from a cell this far from the roots (in half
// cells) blooms: BLOOM_NEAR per mille at the roots (the allowance: 0 never,
// 1000 no gate), rising smoothly to certain at BLOOM_DIST cells. Always for a
// plant younger than GROWN_AGE (k: age, see plant_age).
// The most energy a plant cell can store (14 bits of fine units). Plants have
// no other capacity: they drink while there is water, and energy passes
// through them freely.
const E_MAX: u32 = 16383u;

fn bloom_odds(d: u32, k: u32) -> f32 {
  if ((k >> 8u) < GROWN_AGE) { return 1.0; }
  let x = smoothstep(0.0, f32(2u * BLOOM_DIST), f32(d));
  return mix(f32(BLOOM_NEAR) / 1000.0, 1.0, x);
}

fn tick_plant(cin: Cells, m: ptr<function, Moms>, d: ptr<function, Dists>, k: ptr<function, Dists>, i:u32, b: Block) -> Cells {
  var c = cin;
  let energy = pe(c[i]);
  let color = gv(c[i]) & 3u;

  // Retirement: a cell retires once its age (see plant_age) runs out, about
  // 255 * AGE_ODDS steps after it grew. Its structure (the one water's worth
  // of energy that built it) goes back to the world: as a seed now and then
  // (1 in SEED_DROP_ODDS), otherwise as steam if it's at the plant's surface
  // (open air in the block, so the steam can rise away); deep inside it just
  // leaves a gap. The energy it still holds goes to a plant neighbor in the
  // block, or with none there it's lost. Decay is the one place the plant
  // loses anything.
  if (((*k)[i] & 255u) >= 255u) {
    if ((roll(b, i, 35u) % SEED_DROP_ODDS) == 0u) { c[i] = mc(SEED, 0u, roll(b, i, 36u) & 3u); }
    else if (find_neighbor(c, i, EMPTY, 0u) < 4u) { c[i] = steam_cell(roll(b, i, 38u)); }
    else { c[i] = 0u; }
    (*m)[i] = vec2i(0, 0);
    let j = find_neighbor(c, i, PLANT, roll(b, i, 37u));
    if (j < 4u) {
      let ej = min(pe(c[j]) + energy, E_MAX);
      c[j] = mp(ej, gv(c[j]));
    }
    return c;
  }

  // Friction: moving energy slows by DAMP per mille a step and comes to rest
  // (none of it is lost; pressure sets it moving again)
  (*m)[i] = vec2i(vec2f((*m)[i]) * (1.0 - f32(DAMP) / 1000.0));
  (*m)[i] = clamp_mom((*m)[i], energy);
  c[i] = mp(energy, color);
  return c;
}

// ─── AMPHIPHILES: SOAP AND LIPID ───
// Each molecule has a head (likes water) pointing one of 8 ways (see head) and
// a tail opposite it (likes oil, air and other tails). amph_pair scores a
// molecule against a neighbor; amph_site sums every pair around a cell. A
// molecule turns, or swaps places with a block neighbor, when that lowers the
// energy, and uphill with chance exp(-dE / AMPH_TEMP) (Metropolis), so it
// settles into structures without freezing. Energies are in tenths.

// The cell at (x, y): this block's (as it stands now) or, outside it, the
// read-only grid (a halo read; those cells may be moving this step too)
fn at(c: Cells, b: Block, x:u32, y:u32) -> u32 {
  if (x >= b.bx && x < b.bx + 2u && y >= b.by && y < b.by + 2u) { return c[(y - b.by) * 2u + (x - b.bx)]; }
  return gi[idx(x, y)];
}
// Cells the energy treats as (part of) a molecule, and the way each faces: a
// bonded tail faces its head, so a pair scores like two molecules in a row
fn amph_e(c:u32) -> bool { return amph(c) || bonded(c); }
fn head_e(c:u32) -> u32 { return select(head(c), partner_dir(c), gt(c) == OIL); }
fn dir_v(k:u32) -> vec2f { let o = vec2f(dir_off(k)); return o / length(o); }
fn amph_crowd(a:u32) -> f32 { return f32(select(LIPID_CROWD, SOAP_CROWD, gt(a) == SOAP)) * 0.1; }
fn amph_edge(a:u32) -> f32 { return f32(select(LIPID_EDGE, SOAP_EDGE, gt(a) == SOAP)) * 0.1; }
fn amph_align(a:u32) -> f32 { return f32(select(LIPID_ALIGN, SOAP_ALIGN, gt(a) == SOAP)) * 0.1; }
fn amph_junction(a:u32) -> f32 { return f32(select(LIPID_JUNCTION, SOAP_JUNCTION, gt(a) == SOAP)) * 0.1; }

// Molecule a against a plain neighbor n in direction e (unit vector from a)
fn amph_side(a:u32, n:u32, e:vec2f) -> f32 {
  let s = dot(dir_v(head_e(a)), e);
  let hs = max(s, 0.0);
  let ts = max(-s, 0.0);
  let t = gt(n);
  // water at its side touches the oily core of a layer: the open edge of a
  // membrane, which lipid would rather close up
  if (t == WATER) { return (f32(AMPH_TAIL_WATER) * ts - f32(AMPH_HEAD_WATER) * hs) * 0.1 + amph_edge(a) * max(1.0 - 2.0 * s * s, 0.0); }
  if (t == OIL)   { return (f32(AMPH_HEAD_OIL) * hs - f32(AMPH_TAIL_OIL) * ts) * 0.1; }
  if (t == EMPTY) { return f32(AMPH_HEAD_AIR) * hs * 0.1; }
  return 0.0;
}

// The energy of cells a and n, n in direction e from a (zero unless one is a
// molecule). Two molecules: tails facing each other attract, a head with a
// molecule beside or in front of it is crowded (by its own CROWD), side
// neighbors pointing the same way align (stiffness), and a head pointing into a
// molecule's side is a junction (the end of one layer butting into the face of
// another, which costs about what an open edge does)
fn amph_pair(a:u32, n:u32, e:vec2f) -> f32 {
  let aa = amph_e(a);
  let an = amph_e(n);
  if (aa && an) {
    let ha = dir_v(head_e(a));
    let hn = dir_v(head_e(n));
    let sa = dot(ha, e);
    let sn = -dot(hn, e);
    let tails = f32(AMPH_TAILS) * 0.1 * max(-sa, 0.0) * max(-sn, 0.0);
    let crowded = amph_crowd(a) * clamp(sa + 0.5, 0.0, 1.0) + amph_crowd(n) * clamp(sn + 0.5, 0.0, 1.0);
    let aligned = 0.5 * (amph_align(a) + amph_align(n)) * dot(ha, hn) * max(1.0 - 2.0 * sa * sa, 0.0); // side by side only
    // a head pointing into a side: a T-junction (at a corner they meet tail to side)
    let junction = amph_junction(a) * max(1.0 - 2.0 * sa * sa, 0.0) * max(sn, 0.0) + amph_junction(n) * max(1.0 - 2.0 * sn * sn, 0.0) * max(sa, 0.0);
    return crowded + junction - tails - aligned;
  }
  if (aa) { return amph_side(a, n, e); }
  if (an) { return amph_side(n, a, -e); }
  return 0.0;
}

// Diagonal neighbors count 1/sqrt2 as much
fn dir_w(k:u32) -> f32 { return select(1.0, 0.7071, (k & 1u) == 1u); }

// Every pair energy around (x, y)
fn amph_site(c: Cells, b: Block, x:u32, y:u32) -> f32 {
  let a = at(c, b, x, y);
  var e = 0.0;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let o = dir_off(k);
    let n = at(c, b, u32(i32(x) + o.x), u32(i32(y) + o.y));
    e += amph_pair(a, n, dir_v(k)) * dir_w(k);
  }
  return e;
}

fn amph_accept(de:f32, r:u32) -> bool {
  if (de <= 0.0) { return true; }
  return f32(r & 0xFFFFu) / 65536.0 < exp(-de / (f32(AMPH_TEMP) * 0.1));
}
fn with_head(c:u32, d:u32) -> u32 { return (c & ~(7u << 8u)) | ((d & 7u) << 8u); }
// The direction (0-7) from block slot i to slot j
fn slot_k(i:u32, j:u32) -> u32 {
  let dx = i32(j & 1u) - i32(i & 1u);
  let dy = i32(j >> 1u) - i32(i >> 1u);
  for (var k = 0u; k < 8u; k = k + 1u) { if (all(dir_off(k) == vec2i(dx, dy))) { return k; } }
  return 0u;
}

// The energy of the whole block: every pair touching it, each counted once
fn amph_block_e(c: Cells, b: Block) -> f32 {
  var e = 0.0;
  for (var i = 0u; i < 4u; i = i + 1u) {
    e += amph_site(c, b, cell_x(b.bx, i), cell_y(b.by, i));
    for (var j = i + 1u; j < 4u; j = j + 1u) { let k = slot_k(i, j); e -= amph_pair(c[i], c[j], dir_v(k)) * dir_w(k); }
  }
  return e;
}
// The block slot of slot i's bonded partner, or 4u if it's outside the block
fn partner_slot(c: Cells, i:u32) -> u32 {
  let o = dir_off(partner_dir(c[i]));
  let px = i32(i & 1u) + o.x;
  let py = i32(i >> 1u) + o.y;
  if (px < 0 || px > 1 || py < 0 || py > 1) { return 4u; }
  return u32(py) * 2u + u32(px);
}
// Bond cell c to a partner in direction d (from c)
fn bond_to(c:u32, d:u32) -> u32 {
  if (gt(c) == LIPID) { return with_head(c, (d + 4u) & 7u) | (8u << 8u); }
  return mc(OIL, 2u | ((d & 7u) << 2u), gv(c));
}
fn unbond(c:u32) -> u32 {
  if (gt(c) == LIPID) { return c & ~(8u << 8u); }
  return mc(OIL, 0u, gv(c));
}
// A bonded cell keeps its bond while its partner points back at it and it's
// in liquid (with air under it the pair falls apart, and each half falls alone)
fn bond_holds(c: Cells, b: Block, i:u32) -> bool {
  let x = cell_x(b.bx, i);
  let y = cell_y(b.by, i);
  if (em(at(c, b, x, y + 1u))) { return false; }
  let o = dir_off(partner_dir(c[i]));
  let px = u32(i32(x) + o.x);
  let py = u32(i32(y) + o.y);
  let n = at(c, b, px, py);
  if (!bonded(n) || gt(n) == gt(c[i])) { return false; }
  let q = dir_off(partner_dir(n));
  return u32(i32(px) + q.x) == x && u32(i32(py) + q.y) == y;
}
fn amph_movable(c: Cells, i:u32) -> bool {
  let n = c[i];
  if (bonded(n)) { return partner_slot(c, i) < 4u; }
  return amph(n) || lq(n) || gt(n) == OIL;
}

// Drift: the block's two columns (or rows) trade places, molecules keeping
// their headings, so a pair of molecules (a piece of bilayer) slides a cell as
// one; single molecules alone can't move a structure, which would freeze into
// small pieces. Only in blocks of molecules, water and oil.
fn amph_drift(cin: Cells, b: Block) -> Cells {
  let c = cin;
  if (!(amph(c[0]) || amph(c[1]) || amph(c[2]) || amph(c[3]))) { return c; }
  if (!(amph_movable(c, 0u) && amph_movable(c, 1u) && amph_movable(c, 2u) && amph_movable(c, 3u))) { return c; }
  let r = roll(b, 0u, 127u);
  if ((r % AMPH_DRIFT_ODDS) != 0u) { return c; }
  // slot s takes the cell from slot f ^ s (f = 1: columns, 2: rows); a bonded
  // pair moves together, its pointers turned to where its partner went
  let f = select(2u, 1u, ((r >> 8u) & 1u) == 0u);
  var t: Cells;
  for (var s = 0u; s < 4u; s = s + 1u) { t[s] = c[s ^ f]; }
  for (var s = 0u; s < 4u; s = s + 1u) {
    if (bonded(t[s])) { t[s] = bond_to(t[s], slot_k(s, partner_slot(c, s ^ f) ^ f)); }
  }
  if (amph_accept(amph_block_e(t, b) - amph_block_e(c, b), roll(b, 1u, 127u))) { return t; }
  return c;
}

// A two-cell lipid: it comes apart 1 in LIPID_UNBOND_ODDS steps, or when its
// partner has gone or it's out of the water; with its partner in this block it
// moves one of its halves into a third slot (every slot of a block touches
// every other, so the bond holds), the pair turning to match
fn tick_pair(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  if (!bond_holds(c, b, i) || (roll(b, i, 128u) % LIPID_UNBOND_ODDS) == 0u) { c[i] = unbond(c[i]); return c; }
  let p = partner_slot(c, i);
  if (p == 4u || (roll(b, i, 129u) % AMPH_SWAP_ODDS) != 0u) { return c; }
  let r = roll(b, i, 130u);
  // the two slots that are neither half, then which half moves there
  var js = array<u32, 2>(0u, 0u);
  var k = 0u;
  for (var s = 0u; s < 4u; s = s + 1u) { if (s != i && s != p) { js[k] = s; k = k + 1u; } }
  let j = js[r & 1u];
  let n = c[j];
  if (!(lq(n) || ((gt(n) == OIL || amph(n)) && !bonded(n)))) { return c; }
  let m = select(p, i, ((r >> 1u) & 1u) == 0u);
  let stay = select(i, p, m == i);
  var t = c;
  t[m] = c[j]; t[j] = c[m];
  t[j] = bond_to(t[j], slot_k(j, stay));
  t[stay] = bond_to(t[stay], slot_k(stay, j));
  if (amph_accept(amph_block_e(t, b) - amph_block_e(c, b), roll(b, i, 131u))) { return t; }
  return c;
}

fn tick_amph(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  if (bonded(c[i])) { return tick_pair(c, i, b); }
  let x = cell_x(b.bx, i);
  let y = cell_y(b.by, i);

  // Lipid bonds to a loose oil cell at its tail, 1 in LIPID_BOND_ODDS steps:
  // a two-cell molecule, the oil its tail
  if (gt(c[i]) == LIPID) {
    let o = dir_off((head(c[i]) + 4u) & 7u);
    let qx = i32(i & 1u) + o.x;
    let qy = i32(i >> 1u) + o.y;
    if (qx >= 0 && qx <= 1 && qy >= 0 && qy <= 1) {
      let q = u32(qy) * 2u + u32(qx);
      if (gt(c[q]) == OIL && gd(c[q]) == 0u && (roll(b, i, 132u) % LIPID_BOND_ODDS) == 0u) {
        c[i] = bond_to(c[i], slot_k(i, q));
        c[q] = bond_to(c[q], slot_k(q, i));
        return c;
      }
    }
  }

  // Detergent: soap whose tail touches oil, with water in its block, pulls the
  // oil into the water as a coated droplet (see tick_oil): an emulsion
  if (gt(c[i]) == SOAP && (roll(b, i, 103u) % SOAP_MIX_ODDS) == 0u) {
    let j = find_neighbor(c, i, OIL, roll(b, i, 104u));
    let k = find_neighbor(c, i, WATER, roll(b, i, 105u));
    if (j < 4u && k < 4u && !bonded(c[j]) && dot(dir_v(head(c[i])), dir_v(slot_k(i, j))) < 0.0) {
      let o = c[j]; c[j] = c[k]; c[k] = mc(OIL, 1u, gv(o)); return c;
    }
  }

  // Turn: one step either way, or 1 in 4 times any direction
  if ((roll(b, i, 120u) % AMPH_ROT_ODDS) == 0u) {
    let r = roll(b, i, 121u);
    var nd = (head(c[i]) + select(1u, 7u, (r & 1u) == 1u)) & 7u;
    if ((r & 6u) == 0u) { nd = (r >> 3u) & 7u; }
    var t = c;
    t[i] = with_head(c[i], nd);
    if (amph_accept(amph_site(t, b, x, y) - amph_site(c, b, x, y), roll(b, i, 122u))) { c = t; }
  }

  // Swap with a block neighbor: water, oil or another molecule
  if ((roll(b, i, 123u) % AMPH_SWAP_ODDS) == 0u) {
    let j = (i + 1u + roll(b, i, 124u) % 3u) & 3u;
    let n = c[j];
    if (lq(n) || ((gt(n) == OIL || (amph(n) && n != c[i])) && !bonded(n))) {
      let xj = cell_x(b.bx, j);
      let yj = cell_y(b.by, j);
      let k = slot_k(i, j);
      var t = c;
      t[i] = c[j]; t[j] = c[i];
      let before = amph_site(c, b, x, y) + amph_site(c, b, xj, yj) - amph_pair(c[i], c[j], dir_v(k)) * dir_w(k);
      let after = amph_site(t, b, x, y) + amph_site(t, b, xj, yj) - amph_pair(t[i], t[j], dir_v(k)) * dir_w(k);
      if (amph_accept(after - before, roll(b, i, 125u))) { c = t; }
    }
  }
  return c;
}

// OIL: a soap-coated droplet (data 1) drifts through the water around it,
// trading places with a water cell in its block now and then, and loses its
// coating 1 in EMULSION_ODDS steps, after which it floats back up
fn tick_oil(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  if (bonded(c[i])) { if (!bond_holds(c, b, i)) { c[i] = unbond(c[i]); } return c; }
  if (gd(c[i]) != 1u) { return c; }
  if ((roll(b, i, 109u) % EMULSION_ODDS) == 0u) { c[i] = mc(OIL, 0u, gv(c[i])); return c; }
  if ((roll(b, i, 110u) & 3u) == 0u) {
    let k = find_neighbor(c, i, WATER, roll(b, i, 111u));
    if (k < 4u) { sw(&c, i, k); }
  }
  return c;
}

// FOAM: a film (data 1, holding the soap) turns back into soap, and a bubble
// (data 0, just air) pops, each 1 in FOAM_POP_ODDS steps
fn tick_foam(cin: Cells, i:u32, b: Block) -> Cells {
  var c = cin;
  if ((roll(b, i, 106u) % FOAM_POP_ODDS) != 0u) { return c; }
  if (gd(c[i]) == 1u) { let r = roll(b, i, 107u); c[i] = mc(SOAP, (r >> 8u) & 7u, r & 0x23u); }
  else { c[i] = 0u; }
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

  // Ignite: touching oil sets it alight
  if ((roll(b, i, 90u) % IGNITE_ODDS) == 0u) {
    let j = find_neighbor(c, i, OIL, roll(b, i, 91u));
    if (j < 4u) { c[j] = mc(FIRE, OIL_FIRE_LIFE + (roll(b, j, 92u) % 40u), roll(b, j, 93u) & 3u); }
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
  // The grid's edge is a 1px wall of stone (this also covers every cell of a
  // block that would hang off the grid)
  if (x == 0u || y == 0u || x + 1u == p.w || y + 1u == p.h) {
    go[idx(x, y)] = mc(STONE, 0u, (x * 7u + y * 13u) & 3u);
    mo[idx(x, y)] = vec2u(0u, 0u);
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
  var age: Dists;
  for (var k = 0u; k < 4u; k = k + 1u) {
    m[k] = vec2i(0, 0); dist[k] = DIST_CAP; age[k] = 0u;
    if (gt(c[k]) == PLANT) {
      let ps = mi[idx(bx + (k & 1u), by + (k >> 1u))];
      m[k] = unpack_mom(ps.x); dist[k] = ps.y & 255u; age[k] = ps.y >> 8u;
    }
  }

  c = movement(c, b);
  plant_consume(&c, &m, &dist, b);
  plant_flow(&c, &m, &dist, &age, b);
  plant_dist(c, &dist, b);
  plant_age(c, &age, b);

  // Visit cells starting from a random slot so no position always acts first
  let start = hh(b.rng ^ 0x5bd1e995u) & 3u;
  for (var k = 0u; k < 4u; k = k + 1u) {
    let i = (start + k) & 3u;
    let t = gt(c[i]);
    if (t == FIRE)       { c = tick_fire(c, i, b); }
    else if (t == SMOKE) { c = tick_smoke(c, i); }
    else if (t == STEAM) { c = tick_steam(c, i, b); }
    else if (t == SEED)  { c = tick_seed(c, i, b); dist[i] = 0u; age[i] = 0u; } // a sprout is a root, and a newborn plant
    else if (t == PLANT) { c = tick_plant(c, &m, &dist, &age, i, b); }
    else if (t == EMBER) { c = tick_ember(c, i, b); }
    else if (amph(c[i])) { c = tick_amph(c, i, b); }
    else if (t == OIL)   { c = tick_oil(c, i, b); }
    else if (t == FOAM)  { c = tick_foam(c, i, b); }
  }

  c = amph_drift(c, b);
  c = convection(c, b);

  go[idx(x, y)] = c[pos];
  mo[idx(x, y)] = select(vec2u(0u), vec2u(pack_mom(m[pos]), dist[pos] | (age[pos] << 8u)), gt(c[pos]) == PLANT);
}
`;
