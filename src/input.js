import { GRID_W, GRID_H, T, CMAP, TOOLS, rgbCss } from './config.js';
import { dbg } from './debug.js';

// ── Pointer → state.segs (queued [from, to] segments in fractional grid coords) ──
// Every pointer event queues a segment so nothing between frames is lost,
// including taps shorter than a frame. Holding still keeps pouring at state.pGrid.
export function attachPointer(canvas, state) {
  function c2g(e) {
    const r = canvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) / r.width, sy = (e.clientY - r.top) / r.height;
    return [
      Math.max(0, Math.min(GRID_W - 0.01, sx * GRID_W)),
      Math.max(0, Math.min(GRID_H - 0.01, sy * GRID_H)),
    ];
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    state.pDown = true; state.pGrid = c2g(e); state.segs.push([state.pGrid, state.pGrid]); state.pEvts++;
    dbg(`DOWN (${state.pGrid[0] | 0},${state.pGrid[1] | 0}) ${state.tool.title} r=${state.bRad}`);
  }, { passive: false });

  canvas.addEventListener('pointermove', e => {
    e.preventDefault();
    if (!state.pDown) return;
    const p = c2g(e);
    state.segs.push([state.pGrid, p]);
    state.pGrid = p; state.pEvts++;
  }, { passive: false });

  const end = () => { state.pDown = false; };
  canvas.addEventListener('pointerup', e => { e.preventDefault(); end(); dbg('UP'); }, { passive: false });
  canvas.addEventListener('pointercancel', () => { end(); dbg('CANCEL'); });
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}

// ── Toolbar: particle buttons generated from TOOLS, sliders, pause/clear ──
export function attachToolbar(state, { onClear }) {
  const group = document.getElementById('particle-tools');
  for (const tool of TOOLS) {
    const b = document.createElement('button');
    b.className = 'particle-btn' + (tool === state.tool ? ' active' : '');
    b.title = tool.title;
    const sw = document.createElement('span');
    sw.className = 'swatch' + (tool.type === T.EMPTY ? ' eraser' : '');
    sw.style.background = rgbCss(CMAP[tool.type][0]);
    b.appendChild(sw);
    b.addEventListener('click', () => {
      group.querySelectorAll('.particle-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.tool = tool;
      dbg(`Tool → ${tool.title}`);
    });
    group.appendChild(b);
  }

  const slider = (id, key) => {
    const el = document.getElementById(id);
    el.value = state[key];
    el.addEventListener('input', () => { state[key] = parseInt(el.value); });
  };
  slider('brush-size', 'bRad');
  slider('sim-speed', 'spf');

  const pauseBtn = document.getElementById('btn-pause');
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? '▶' : '⏸';
    dbg(state.paused ? 'PAUSED' : 'RESUMED');
  });
  document.getElementById('btn-clear').addEventListener('click', onClear);
}
