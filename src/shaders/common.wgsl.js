import { T, TUNING } from '../config.js';

const u32Consts = obj =>
  Object.entries(obj).map(([k, v]) => `const ${k}:u32 = ${v}u;`).join('\n');

// Prepended to every shader: params layout, type IDs, tuning, cell accessors.
export const commonWGSL = `
struct Params { w:u32, h:u32, phase:u32, frame:u32, react:u32, _p1:u32, _p2:u32, _p3:u32 }

${u32Consts(T)}
${u32Consts(TUNING)}

// Plant variant bit: set on growing tips (color uses only the low 2 bits)
const PLANT_TIP:u32 = 4u;

fn gt(c:u32) -> u32 { return c & 255u; }
fn gd(c:u32) -> u32 { return (c >> 8u) & 255u; }
fn gv(c:u32) -> u32 { return (c >> 16u) & 255u; }
fn mc(t:u32, d:u32, v:u32) -> u32 { return t | (d << 8u) | (v << 16u); }
`;
