import { T, CMAP, P } from '../config.js';
import { commonWGSL } from './common.wgsl.js';

// Flatten CMAP into a [type * 4 + variant] color table
function buildColorTable() {
  const ids = Object.values(T).sort((a, b) => a - b);
  const out = [];
  for (const id of ids) {
    const cols = CMAP[id];
    for (let v = 0; v < 4; v++) {
      const c = cols[v % cols.length];
      out.push(`vec3f(${c[0].toFixed(3)}, ${c[1].toFixed(3)}, ${c[2].toFixed(3)})`);
    }
  }
  return out;
}

const COLORS = buildColorTable();
const BG = `vec4f(${P.nearBlack.join(', ')}, 1.0)`;

export const renWGSL = `
${commonWGSL}

struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@group(0) @binding(0) var<storage,read> grid: array<u32>;
@group(0) @binding(1) var<uniform> p: Params;

// Fullscreen triangle
@vertex fn vs(@builtin(vertex_index) vi: u32) -> V {
  var o: V;
  let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
  let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
  o.pos = vec4f(x, y, 0.0, 1.0);
  o.uv = vec2f((x + 1.0) * 0.5, (1.0 - y) * 0.5);
  return o;
}

fn gc(cell: u32) -> vec3f {
  let ti = gt(cell) * 4u + (gv(cell) & 3u);
  var cl = array<vec3f, ${COLORS.length}>(
    ${COLORS.join(',\n    ')}
  );
  if (ti < ${COLORS.length}u) { return cl[ti]; }
  return vec3f(1.0, 0.0, 1.0);
}

@fragment fn fs(inp: V) -> @location(0) vec4f {
  // position in cells, and how many cells one screen pixel spans (for 1px edges)
  let cf = inp.uv * vec2f(f32(p.w), f32(p.h));
  let px = fwidth(cf);
  let gx = u32(inp.uv.x * f32(p.w));
  let gy = u32(inp.uv.y * f32(p.h));
  if (gx >= p.w || gy >= p.h) { return ${BG}; }

  let cell = grid[gy * p.w + gx];
  var col = gc(cell);

  // Fire glow
  if (gt(cell) == FIRE) {
    col = col * (1.0 + f32(gd(cell)) / 200.0);
  }
  // Plant: brightness tracks stored energy, from dim (nearly empty) to bright (full)
  if (gt(cell) == PLANT) {
    col = col * (0.25 + 1.0 * min(f32(pe(cell)) / f32(PLANT_GLOW * ENERGY_RES), 1.0));
  }
  // Ember glow: gentle pulse
  if (gt(cell) == EMBER) {
    col = col * (0.8 + 0.4 * f32(gd(cell)) / 200.0);
  }

  // Soap and lipid: a 1px white edge on the head side (two edges for a
  // diagonal head), so molecules show which way they face
  if (amph(cell)) {
    let o = dir_off(head(cell));
    let f = fract(cf);
    let edge = (o.x > 0 && 1.0 - f.x < px.x) || (o.x < 0 && f.x < px.x)
            || (o.y > 0 && 1.0 - f.y < px.y) || (o.y < 0 && f.y < px.y);
    if (edge) { col = mix(col, vec3f(1.0), 0.85); }
  }

  // CRT effects
  let sl = 0.88 + 0.12 * f32(u32(cf.y) & 1u);   // scanlines: alternate cell rows
  let uc = (inp.uv - 0.5) * 2.0;
  let vig = 1.0 - 0.25 * dot(uc, uc);
  col = col * vec3f(1.02, 1.0, 0.98) * sl * vig;

  return vec4f(col, 1.0);
}
`;
