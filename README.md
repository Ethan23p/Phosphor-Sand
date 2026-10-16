# Phosphor Sand

WebGPU falling-sand toy: a Margolus 2×2 block cellular automaton on the GPU, rendered with a CRT look.

## Run

ES modules don't load over `file://`, so serve the folder:

```
python -m http.server 8000
```

Then open http://localhost:8000.

### On your phone

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

This starts the server plus a Cloudflare quick tunnel and prints an `https://….trycloudflare.com` URL. The tunnel is needed because WebGPU only runs in a secure context (HTTPS or localhost), so a plain LAN IP won't work. Requires `winget install Cloudflare.cloudflared`. The URL changes every run; Ctrl+C stops everything.

## Layout

| File | What lives there |
|---|---|
| `src/config.js` | The single source of truth: particle type IDs, sim tuning constants, palette, color map, toolbar order |
| `src/shaders/common.wgsl.js` | WGSL prelude shared by both shaders: `Params` struct, type/tuning consts generated from config, cell accessors |
| `src/shaders/sim.wgsl.js` | Simulation: `movement` → per-type `tick_*` rules → fire `convection` |
| `src/shaders/render.wgsl.js` | Fullscreen-triangle render, color lookup, glow and CRT effects |
| `src/main.js` | WebGPU setup, pipelines, ping-pong buffers, frame loop |
| `src/input.js` | Brush, pointer handling, toolbar wiring |
| `src/debug.js` | On-page log, health dots, WGSL lint, compile-error reporting |

## Plant model

Plants are trees. Each plant cell stores which orthogonal neighbor it grew from (variant bits 3-5), and tips carry a flag (variant bit 2).

- **Any** plant cell absorbs adjacent water as energy, leaving the cell empty.
- **Every** cell pulls its parent's energy above `STEM_RESERVE`, so energy flows root → tip like a pipe.
- **Only tips** grow: spending a noise-dependent cost to claim an orthogonal empty cell, which becomes the new tip (occasionally branching).

So water absorbed at one end of a tunnel drives growth at the other. Growth is orthogonal only because in Margolus some diagonal neighbor pairs never share a block, which would break the link.

Rendering: plant brightness tracks stored energy, tips show as bright cells.

## Dev scenarios

`dev/tunnel.html` (watered at one end, growing at the other) and `dev/pool.html` (seeds in a pool) run the sim headless-style on the GPU and show snapshots plus per-region counts. Open them through the server, e.g. http://localhost:8000/dev/tunnel.html.

## Cell encoding

One `u32` per cell: `type | data << 8 | variant << 16`. `data` is per-type (fire/smoke/ember lifetime, plant energy). `variant` bits 0-1 pick a color; plants also use bit 2 (tip) and bits 3-5 (parent link).

## Adding a particle type

1. Add an ID to `T` and its colors to `CMAP` in `config.js` (and to `TOOLS` if it should be drawable).
2. Add a `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s interaction loop.
3. If it needs starting data when drawn, add it in `brushData` in `input.js`.
