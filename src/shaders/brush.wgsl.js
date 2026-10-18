import { WORKGROUP } from '../config.js';
import { commonWGSL } from './common.wgsl.js';

// ══════════════════════════════════════════════════════
//  BRUSH — stamps a capsule (segment a→b, radius r) into the grid in place.
//  Paints only into empty cells; the eraser clears everything.
//  Using the segment from last frame's pointer to this frame's means fast
//  strokes leave no gaps.
// ══════════════════════════════════════════════════════
export const brushWGSL = `
${commonWGSL}

struct Brush { a: vec2f, b: vec2f, r: f32, cell_type: u32, density: u32, seed: u32 }

@group(0) @binding(0) var<storage,read_write> grid: array<u32>;
@group(0) @binding(1) var<uniform> br: Brush;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= p.w || gid.y >= p.h) { return; }
  // the 1px stone border stays (see sim main)
  if (gid.x == 0u || gid.y == 0u || gid.x + 1u == p.w || gid.y + 1u == p.h) { return; }

  let pt = vec2f(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let ab = br.b - br.a;
  let len2 = dot(ab, ab);
  var t = 0.0;
  if (len2 > 0.0) { t = clamp(dot(pt - br.a, ab) / len2, 0.0, 1.0); }
  if (distance(pt, br.a + ab * t) > br.r) { return; }

  let i = gid.y * p.w + gid.x;
  if (br.cell_type == EMPTY) { grid[i] = 0u; return; }
  if (gt(grid[i]) != EMPTY) { return; }

  // density/256 chance per frame gives pours some texture
  let h = hh(i * 747796405u + br.seed);
  if ((h & 255u) >= br.density) { return; }

  var d = 0u;
  if (br.cell_type == FIRE)  { d = 60u + (h >> 8u) % 40u; }
  if (br.cell_type == EMBER) { d = EMBER_LIFE; }
  if (br.cell_type == PLANT) { grid[i] = mp(GERM_E * ENERGY_RES, (h >> 16u) & 3u); return; }
  grid[i] = mc(br.cell_type, d, (h >> 16u) & 3u);
}
`;
