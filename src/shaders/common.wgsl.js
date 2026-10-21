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

// Soap and lipid: the head direction, data bits 0-2, counted clockwise from
// east (y points down): E SE S SW W NW N NE
fn head(c:u32) -> u32 { return gd(c) & 7u; }
fn dir_off(k:u32) -> vec2i {
  var o = array<vec2i, 8>(vec2i(1, 0), vec2i(1, 1), vec2i(0, 1), vec2i(-1, 1), vec2i(-1, 0), vec2i(-1, -1), vec2i(0, -1), vec2i(1, -1));
  return o[k & 7u];
}
fn amph(c:u32) -> bool { let t = gt(c); return t == SOAP || t == LIPID; }
// Two-cell lipid: a lipid head (data bit 3) bonded to an oil tail (data bit 1,
// bits 2-4 the direction to its head). The head points away from its tail, so
// the head's direction is also its pointer to its partner.
fn bonded(c:u32) -> bool { let t = gt(c); return (t == LIPID && (gd(c) & 8u) != 0u) || (t == OIL && (gd(c) & 2u) != 0u); }
fn partner_dir(c:u32) -> u32 { return select((gd(c) >> 2u) & 7u, (head(c) + 4u) & 7u, gt(c) == LIPID); }

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
