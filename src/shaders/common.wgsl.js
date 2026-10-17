import { T, TUNING } from '../config.js';

const u32Consts = obj =>
  Object.entries(obj).map(([k, v]) => `const ${k}:u32 = ${v}u;`).join('\n');

// Prepended to every shader: params layout, type IDs, tuning, cell accessors, hash.
export const commonWGSL = `
struct Params { w:u32, h:u32, phase:u32, frame:u32, _p0:u32, _p1:u32, _p2:u32, _p3:u32 }

${u32Consts(T)}
${u32Consts(TUNING)}


fn gt(c:u32) -> u32 { return c & 255u; }
fn gd(c:u32) -> u32 { return (c >> 8u) & 255u; }
fn gv(c:u32) -> u32 { return (c >> 16u) & 255u; }
fn mc(t:u32, d:u32, v:u32) -> u32 { return t | (d << 8u) | (v << 16u); }
// Plant energy is 14 bits, in fine units (ENERGY_RES per unit of tuning):
// the low 8 in data, the high 6 in variant bits 2-7. Variant bits 0-1 are color.
const PE_MAX:u32 = 16383u;
fn pe(c:u32) -> u32 { return ((c >> 8u) & 255u) | (((c >> 18u) & 63u) << 8u); }
fn mp(e:u32, color:u32) -> u32 { return mc(PLANT, e & 255u, (color & 3u) | ((e >> 8u) << 2u)); }

fn hh(xi:u32) -> u32 {
  var h = xi;
  h = h ^ (h >> 16u);
  h = h * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  h = h * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  return h;
}
`;
