// Headless-style scenario harness: runs the real sim + brush shaders on the GPU,
// takes snapshots, and renders them as a time-lapse strip with per-snapshot stats.
import { GRID_W, GRID_H, WORKGROUP, T, CMAP, TUNING, makeCell } from '../src/config.js';
import { simWGSL } from '../src/shaders/sim.wgsl.js';
import { brushWGSL } from '../src/shaders/brush.wgsl.js';

export { T, makeCell };
export const W = GRID_W, H = GRID_H, N = W * H;
const NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

// opts.wgsl swaps in a modified sim shader and opts.extra adds bind group
// entries to it (for temporary instrumentation)
export async function createHarness({ wgsl = simWGSL, extra = [] } = {}) {
  const device = await (await navigator.gpu.requestAdapter()).requestDevice();
  const module = async code => {
    const m = device.createShaderModule({ code });
    for (const msg of (await m.getCompilationInfo()).messages) console.log(`${msg.type} L${msg.lineNum}: ${msg.message}`);
    return m;
  };
  const sim = device.createComputePipeline({ layout: 'auto', compute: { module: await module(wgsl), entryPoint: 'main' } });
  const brush = device.createComputePipeline({ layout: 'auto', compute: { module: await module(brushWGSL), entryPoint: 'main' } });

  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const grids = [0, 1].map(() => device.createBuffer({ size: N * 4, usage }));
  const moms = [0, 1].map(() => device.createBuffer({ size: N * 8, usage })); // per cell: momentum, root distance
  const pBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const rb = device.createBuffer({ size: N * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const simBGs = [[0, 1], [1, 0]].map(([a, b]) => device.createBindGroup({ layout: sim.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: grids[a] } }, { binding: 1, resource: { buffer: grids[b] } }, { binding: 2, resource: { buffer: pBuf } },
    { binding: 3, resource: { buffer: moms[a] } }, { binding: 4, resource: { buffer: moms[b] } }, ...extra] }));
  const brushBGs = grids.map(g => device.createBindGroup({ layout: brush.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: g } }, { binding: 1, resource: { buffer: bBuf } }, { binding: 2, resource: { buffer: pBuf } }] }));

  const params = new Uint32Array([W, H, 0, 0, 0, 0, 0, 0]);
  const bData = new ArrayBuffer(32), bF = new Float32Array(bData), bU = new Uint32Array(bData);
  let cur = 0, step = 0, seed = 1;
  const frames = [];

  const dispatch = (pipe, bg) => {
    const e = device.createCommandEncoder(), cp = e.beginComputePass();
    cp.setPipeline(pipe); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(W / WORKGROUP, H / WORKGROUP); cp.end();
    device.queue.submit([e.finish()]);
  };

  return {
    get step() { return step; },
    load(g) {
      grids.forEach(b => device.queue.writeBuffer(b, 0, g));
      moms.forEach(b => device.queue.writeBuffer(b, 0, new Uint32Array(2 * N)));
      cur = 0; step = 0;
    },
    // Same capsule brush the app uses: only fills empty cells (eraser clears all)
    brush({ x0, y0, x1 = x0, y1 = y0, r = 3, type, density = 256 }) {
      bF.set([x0, y0, x1, y1, r + 0.5]); bU[5] = type; bU[6] = density; bU[7] = seed++;
      device.queue.writeBuffer(bBuf, 0, bData);
      device.queue.writeBuffer(pBuf, 0, params);
      dispatch(brush, brushBGs[cur]);
    },
    // Advance n steps; onStep(step) runs before each step (for brush input etc.)
    run(n, onStep) {
      for (let k = 0; k < n; k++) {
        if (onStep) onStep(step);
        params[2] = step & 3; params[3] = step;
        device.queue.writeBuffer(pBuf, 0, params);
        dispatch(sim, simBGs[cur]);
        cur = 1 - cur; step++;
      }
    },
    // The grid, or with mom = true the plant buffer: per cell [momentum (see momOf), root distance]
    async read(mom = false) {
      const n = mom ? N * 8 : N * 4;
      const e = device.createCommandEncoder(); e.copyBufferToBuffer((mom ? moms : grids)[cur], 0, rb, 0, n); device.queue.submit([e.finish()]);
      await rb.mapAsync(GPUMapMode.READ, 0, n); const a = new Uint32Array(rb.getMappedRange(0, n)).slice(); rb.unmap(); return a;
    },
    async snapshot(statsFn = stats) {
      const a = await this.read();
      const line = `step ${String(step).padStart(5)} (${(step / 180).toFixed(1).padStart(5)}s @3x): ${statsFn(a)}`;
      frames.push({ a, line });
      console.log(line);
      return a;
    },
    // Render all snapshots side by side (scale 2) and print stats under them
    finish(title) {
      const S = 2, cv = document.createElement('canvas');
      cv.id = 'cv'; cv.width = W * frames.length * S + (frames.length - 1) * 4; cv.height = H * S;
      const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
      frames.forEach((f, k) => {
        const img = ctx.createImageData(W, H);
        for (let i = 0; i < N; i++) {
          const c = colorOf(f.a[i]), o = i * 4;
          img.data[o] = c[0] * 255; img.data[o + 1] = c[1] * 255; img.data[o + 2] = c[2] * 255; img.data[o + 3] = 255;
        }
        const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, k * (W * S + 4), 0, W * S, H * S);
        ctx.fillStyle = '#fff'; ctx.font = '20px monospace'; ctx.fillText(f.line.match(/\(\s*([\d.]+)s/)[1] + 's', k * (W * S + 4) + 8, 24);
      });
      document.body.prepend(cv);
      const out = document.getElementById('out');
      out.textContent = `${title}\n` + frames.map(f => f.line).join('\n');
      console.log('DONE');
    },
  };
}

// Plant energy, in units of tuning (stored as 14 bits of fine units: data + variant bits 2-7)
export function plantE(cell) { return (((cell >> 8) & 255) | (((cell >> 18) & 63) << 8)) / TUNING.ENERGY_RES; }
// Plant momentum [x, y] in units of tuning, from the momentum buffer
export function momOf(m) { return [(m << 16 >> 16) / TUNING.ENERGY_RES, (m >> 16) / TUNING.ENERGY_RES]; }
export function makePlant(e, color = 0) {
  const f = Math.round(e * TUNING.ENERGY_RES);
  return makeCell(T.PLANT, f & 255, (color & 3) | ((f >> 8) << 2));
}

// Mirrors render.wgsl.js closely enough to judge behavior (no CRT effects)
export function colorOf(cell) {
  const t = cell & 255, d = (cell >> 8) & 255; let v = (cell >> 16) & 255;
  const cols = CMAP[t] || [[1, 0, 1]];
  let c = cols[(v & 3) % cols.length];
  if (t === T.FIRE) c = c.map(x => Math.min(1, x * (1 + d / 200)));
  if (t === T.PLANT) {
    const k = 0.25 + 1.0 * Math.min(plantE(cell) / TUNING.PLANT_CAP, 1);
    c = c.map(x => Math.min(1, x * k));
  }
  return c;
}

// Default stats: count per type, plus average plant energy
export function stats(a) {
  const n = {}; let pe = 0;
  for (const cell of a) {
    const t = cell & 255; n[t] = (n[t] || 0) + 1;
    if (t === T.PLANT) pe += plantE(cell);
  }
  const parts = Object.entries(n).filter(([t]) => +t !== T.EMPTY).map(([t, k]) => `${NAMES[t].toLowerCase()} ${k}`);
  if (n[T.PLANT]) parts.push(`avgE ${(pe / n[T.PLANT]).toFixed(0)}`);
  return parts.join(' | ');
}

export function blankGrid() { return new Uint32Array(N); }
export function fill(g, x0, x1, y0, y1, cell) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * W + x] = cell;
}
