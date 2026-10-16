import { GRID_W, GRID_H, T, TUNING, CMAP, TOOLS, makeCell, jsHash, rgbCss } from './config.js';
import { dbg } from './debug.js';

// Initial data byte for a freshly drawn cell
function brushData(type, px, py, step) {
  if (type === T.FIRE) return 60 + (jsHash(px + py * 97 + step) % 40); // user-drawn fixed lifetime
  if (type === T.PLANT) return TUNING.GERM_E;
  if (type === T.EMBER) return TUNING.EMBER_LIFE;
  return 0;
}

// Stamp a filled circle directly into a grid buffer, one row write per scanline
export function cpuBrush(device, buf, gx, gy, r, type, step) {
  for (let dy = -r; dy <= r; dy++) {
    const py = gy + dy;
    if (py < 0 || py >= GRID_H) continue;
    const hw = Math.floor(Math.sqrt(r * r - dy * dy));
    const x0 = Math.max(0, gx - hw), x1 = Math.min(GRID_W - 1, gx + hw);
    if (x0 > x1) continue;
    const row = new Uint32Array(x1 - x0 + 1);
    if (type !== T.EMPTY) {
      for (let i = 0; i < row.length; i++) {
        const px = x0 + i;
        const v = jsHash(px * 65537 + py * 251 + step) & 3;
        row[i] = makeCell(type, brushData(type, px, py, step), v);
      }
    }
    device.queue.writeBuffer(buf, (py * GRID_W + x0) * 4, row);
  }
}

// ── Pointer → state.pDown / state.pGrid ──
export function attachPointer(canvas, state) {
  function c2g(e) {
    const r = canvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) / r.width, sy = (e.clientY - r.top) / r.height;
    return [
      Math.max(0, Math.min(GRID_W - 1, Math.floor(sx * GRID_W))),
      Math.max(0, Math.min(GRID_H - 1, Math.floor(sy * GRID_H))),
    ];
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    state.pDown = true; state.pGrid = c2g(e); state.pEvts++;
    dbg(`DOWN (${state.pGrid[0]},${state.pGrid[1]}) t=${state.selType} r=${state.bRad}`);
  }, { passive: false });

  canvas.addEventListener('pointermove', e => {
    e.preventDefault();
    if (!state.pDown) return;
    state.pGrid = c2g(e); state.pEvts++;
  }, { passive: false });

  canvas.addEventListener('pointerup', e => { e.preventDefault(); state.pDown = false; dbg('UP'); }, { passive: false });
  canvas.addEventListener('pointercancel', () => { state.pDown = false; dbg('CANCEL'); });
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  canvas.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}

// ── Toolbar: particle buttons generated from TOOLS, sliders, pause/clear ──
export function attachToolbar(state, { onClear }) {
  const group = document.getElementById('particle-tools');
  for (const tool of TOOLS) {
    const b = document.createElement('button');
    b.className = 'particle-btn' + (tool.type === state.selType ? ' active' : '');
    b.title = tool.title;
    const sw = document.createElement('span');
    sw.className = 'swatch' + (tool.type === T.EMPTY ? ' eraser' : '');
    sw.style.background = rgbCss(CMAP[tool.type][0]);
    b.appendChild(sw);
    b.addEventListener('click', () => {
      group.querySelectorAll('.particle-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.selType = tool.type;
      dbg(`Type → ${tool.title}`);
    });
    group.appendChild(b);
  }

  const slider = (id, key, log) => {
    const el = document.getElementById(id);
    el.value = state[key];
    el.addEventListener('input', () => {
      state[key] = parseInt(el.value);
      if (log) dbg(`${log} → ${state[key]}`);
    });
  };
  slider('brush-size', 'bRad');
  slider('sim-speed', 'spf');
  slider('react-rate', 'reactRate', 'React');

  const pauseBtn = document.getElementById('btn-pause');
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? '▶' : '⏸';
    dbg(state.paused ? 'PAUSED' : 'RESUMED');
  });
  document.getElementById('btn-clear').addEventListener('click', onClear);
}
