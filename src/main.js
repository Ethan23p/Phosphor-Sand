import { GRID_W, GRID_H, WORKGROUP, T, P, TOOLS, makeCell } from './config.js';
import { dbg, showSimError, setHealth, validateWGSL, checkShader } from './debug.js';
import { attachPointer, attachToolbar } from './input.js';
import { simWGSL } from './shaders/sim.wgsl.js';
import { renWGSL } from './shaders/render.wgsl.js';
import { brushWGSL } from './shaders/brush.wgsl.js';

const N = GRID_W * GRID_H;

// ── GPU init: adapter, device, canvas context ──
async function initGPU() {
  if (!navigator.gpu) throw new Error('No WebGPU');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No adapter');
  dbg(`Adapter: ${adapter.info?.vendor || 'unknown'} ${adapter.info?.device || ''}`);

  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', e => dbg(`GPU ERR: ${e.error.message}`, true));
  device.lost.then(i => dbg(`DEVICE LOST: ${i.message}`, true));

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('webgpu');
  if (!ctx) throw new Error('No WebGPU context');
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: fmt, alphaMode: 'opaque' });
  dbg(`Canvas: ${fmt}`);
  return { device, canvas, ctx, fmt };
}

// ── Pipelines + bind groups. Ping-pong: index `cur` reads grids[cur], writes grids[1-cur] ──
async function buildPipelines(device, fmt, grids, moms, paramBuf, brushBuf) {
  validateWGSL(simWGSL, 'sim');
  validateWGSL(renWGSL, 'render');
  validateWGSL(brushWGSL, 'brush');

  dbg('Compiling shaders...');
  const simMod = device.createShaderModule({ code: simWGSL });
  const simErrors = await checkShader(simMod, 'sim');
  const renMod = device.createShaderModule({ code: renWGSL });
  const renErrors = await checkShader(renMod, 'render');
  const brushMod = device.createShaderModule({ code: brushWGSL });
  const brushErrors = await checkShader(brushMod, 'brush');

  const sBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ]});

  let simPipe = null;
  if (simErrors.length === 0) {
    try {
      simPipe = await device.createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [sBGL] }),
        compute: { module: simMod, entryPoint: 'main' },
      });
      dbg('Sim pipeline OK');
    } catch (e) {
      dbg(`Sim pipeline FAIL: ${e.message}`, true);
    }
  } else {
    dbg('Skipping sim pipeline creation — shader has errors', true);
  }
  setHealth('h-sim', !!simPipe);
  if (!simPipe) showSimError(simErrors.length > 0 ? simErrors : ['Pipeline creation failed']);

  const rBGL = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
  ]});

  let renPipe = null;
  if (renErrors.length === 0) {
    try {
      renPipe = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [rBGL] }),
        vertex: { module: renMod, entryPoint: 'vs' },
        fragment: { module: renMod, entryPoint: 'fs', targets: [{ format: fmt }] },
        primitive: { topology: 'triangle-list' },
      });
      dbg('Render pipeline OK');
    } catch (e) {
      dbg(`Render pipeline FAIL: ${e.message}`, true);
    }
  }
  setHealth('h-ren', !!renPipe);

  const sBGs = [0, 1].map(k => device.createBindGroup({ layout: sBGL, entries: [
    { binding: 0, resource: { buffer: grids[k] } },
    { binding: 1, resource: { buffer: grids[1 - k] } },
    { binding: 2, resource: { buffer: paramBuf } },
    { binding: 3, resource: { buffer: moms[k] } },
    { binding: 4, resource: { buffer: moms[1 - k] } },
  ]}));
  const rBGs = grids.map(g => device.createBindGroup({ layout: rBGL, entries: [
    { binding: 0, resource: { buffer: g } },
    { binding: 1, resource: { buffer: paramBuf } },
  ]}));

  // Brush: edits a grid in place, so one bind group per grid
  let brushPipe = null, bBGs = [];
  if (brushErrors.length === 0) {
    brushPipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: brushMod, entryPoint: 'main' } });
    bBGs = grids.map(g => device.createBindGroup({ layout: brushPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: g } },
      { binding: 1, resource: { buffer: brushBuf } },
      { binding: 2, resource: { buffer: paramBuf } },
    ]}));
    dbg('Brush pipeline OK');
  }

  return { simPipe, renPipe, brushPipe, sBGs, rBGs, bBGs };
}

function testPattern() {
  const tg = new Uint32Array(N);
  for (let x = 80; x < 176; x++) tg[30 * GRID_W + x] = makeCell(T.SAND, 0, x & 3);
  for (let x = 100; x < 156; x++) for (let y = 35; y < 40; y++) tg[y * GRID_W + x] = makeCell(T.WATER, 0, x & 3);
  for (let x = 60; x < 196; x++) tg[200 * GRID_W + x] = makeCell(T.STONE, 0, x & 1);
  for (let x = 110; x < 120; x++) tg[32 * GRID_W + x] = makeCell(T.SEED, 0, x & 3);
  return tg;
}

// ══════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════
async function main() {
  dbg('Init...');
  const { device, canvas, ctx, fmt } = await initGPU();
  document.getElementById('app').style.display = 'flex';

  const gridUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const grids = [
    device.createBuffer({ size: N * 4, usage: gridUsage }),
    device.createBuffer({ size: N * 4, usage: gridUsage }),
  ];
  // Plant state beside the grids, ping-ponged with them: per cell momentum and root distance
  const moms = [0, 1].map(() => device.createBuffer({ size: N * 8, usage: gridUsage }));
  const params = new Uint32Array([GRID_W, GRID_H, 0, 0, 0, 0, 0, 0]); // w,h,phase,frame,pad...
  const paramBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  // Brush uniform: a.xy, b.xy, r (f32) | cell_type, density, seed (u32)
  const brushData = new ArrayBuffer(32), brushF = new Float32Array(brushData), brushU = new Uint32Array(brushData);
  const brushBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const { simPipe, renPipe, brushPipe, sBGs, rBGs, bBGs } = await buildPipelines(device, fmt, grids, moms, paramBuf, brushBuf);
  if (!renPipe) {
    dbg('FATAL: render pipeline failed — nothing to display', true);
    return;
  }

  const fillGrids = data => {
    grids.forEach(g => device.queue.writeBuffer(g, 0, data));
    moms.forEach(m => device.queue.writeBuffer(m, 0, new Uint32Array(2 * N)));
  };
  fillGrids(testPattern());
  dbg('Test pattern ready — you should see sand, water, stone, seeds');

  // ── State (mutated by input handlers) ──
  const state = {
    cur: 0, step: 0, paused: false,
    tool: TOOLS[0], bRad: 3, spf: 3,
    pDown: false, pGrid: null, segs: [], pEvts: 0,
  };
  attachPointer(canvas, state);
  attachToolbar(state, { onClear: () => {
    fillGrids(new Uint32Array(N));
    state.cur = 0; state.step = 0;
    dbg('Cleared');
  }});

  function writeParams() {
    params[2] = state.step & 3;
    params[3] = state.step;
    device.queue.writeBuffer(paramBuf, 0, params);
  }

  // ── Frame loop ──
  const dX = Math.ceil(GRID_W / WORKGROUP), dY = Math.ceil(GRID_H / WORKGROUP);
  const stEl = document.getElementById('status');
  let fc = 0, lt = performance.now(), brushSeed = 1;

  function frame() {
    fc++;
    const now = performance.now();
    if (now - lt >= 1000) {
      const sim = simPipe ? '●' : '○';
      const pi = state.pDown ? ` ptr(${state.pGrid[0] | 0},${state.pGrid[1] | 0})` : '';
      stEl.textContent = `${fc}fps ${sim}step:${state.step} ${state.spf}x${pi} evts:${state.pEvts}`;
      fc = 0; lt = now;
    }

    // Brush: draw every queued pointer segment as a capsule; holding still keeps pouring
    if (brushPipe) {
      if (state.segs.length === 0 && state.pDown) state.segs.push([state.pGrid, state.pGrid]);
      for (const [a, b] of state.segs) {
        brushF.set([a[0], a[1], b[0], b[1], state.bRad + 0.5]);
        brushU[5] = state.tool.type; brushU[6] = state.tool.density; brushU[7] = brushSeed++;
        device.queue.writeBuffer(brushBuf, 0, brushData);
        writeParams();
        const enc = device.createCommandEncoder();
        const bp = enc.beginComputePass();
        bp.setPipeline(brushPipe);
        bp.setBindGroup(0, bBGs[state.cur]);
        bp.dispatchWorkgroups(dX, dY);
        bp.end();
        device.queue.submit([enc.finish()]);
      }
      state.segs.length = 0;
    }

    // Sim
    if (!state.paused && simPipe) {
      for (let s = 0; s < state.spf; s++) {
        writeParams();
        const enc = device.createCommandEncoder();
        const cp = enc.beginComputePass();
        cp.setPipeline(simPipe);
        cp.setBindGroup(0, sBGs[state.cur]);
        cp.dispatchWorkgroups(dX, dY);
        cp.end();
        device.queue.submit([enc.finish()]);
        state.cur = 1 - state.cur;
        state.step++;
      }
    }

    // Render
    writeParams();
    const enc = device.createCommandEncoder();
    const [r, g, b] = P.nearBlack;
    const rp = enc.beginRenderPass({ colorAttachments: [{
      view: ctx.getCurrentTexture().createView(),
      loadOp: 'clear', storeOp: 'store',
      clearValue: { r, g, b, a: 1.0 },
    }]});
    rp.setPipeline(renPipe);
    rp.setBindGroup(0, rBGs[state.cur]);
    rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);
    requestAnimationFrame(frame);
  }

  dbg('Starting loop...');
  requestAnimationFrame(frame);
}

main().catch(err => {
  dbg(`FATAL: ${err.message}\n${err.stack}`, true);
  const errEl = document.getElementById('error');
  errEl.style.display = 'block';
  const p = document.createElement('p');
  p.className = 'err-detail';
  p.textContent = err.message;
  errEl.appendChild(p);
});
