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
| `src/shaders/brush.wgsl.js` | GPU brush: stamps a capsule per pointer segment, fills only empty cells |
| `src/input.js` | Pointer handling (queues stroke segments), toolbar wiring |
| `src/debug.js` | On-page log, health dots, WGSL lint, compile-error reporting |

## Plant model

Each plant cell has two scalars, fullness (its energy; `PLANT_CAP` is "full") and stillness (zero while energy moves into or out of the cell, otherwise counting up), and these rules:

- **Consumption:** a plant cell touching water removes it and gains `WATER_GAIN` energy (cells can go overfull, up to what 14 bits hold).
- **Transfer:** a cell gives to its emptiest less-full neighbor until that neighbor is full, even if that empties the giver. All cells in a block decide from the block as it was at the start of the step, so energy can't be handed straight back.
- **Bloom:** a full cell that has been still for `SPROUT_DELAY` steps grows into an empty neighbor and gives it half its energy.
- **Metabolism:** every cell burns one energy per ~`METAB_ODDS` steps; 1 in `TRANSPIRE_ODDS` of it is breathed out as steam (forests make their own rain).
- **Starving:** a cell left empty and still for ~1.4s dies; 1 in `SEED_DROP_ODDS` leaves a seed.

Seeds touching water germinate into a plant cell with `GERM_E`. Energy runs from the roots to wherever it can sit still, so plants grow at their ends, and a plant whose roots run dry drains toward its growing ends: it walks. A source that drinks faster than its stems can carry blooms at the source. All tuning lives in `TUNING` in `src/config.js`, with timings at 3x (~180 steps/s).

Rendering: plant brightness tracks fullness: full cells are bright, starved ones dim.

## Other rules

- Sand, seeds and embers sink through water at half speed.
- Smoke and steam rise and drift sideways; steam bubbles up through water.
- Fire or ember touching water boils it to steam; steam condenses back to water (falls as rain), so water is conserved through the cycle.
- The brush (GPU) only fills empty cells; the eraser clears everything. Strokes are queued per pointer event, so fast swipes and quick taps are drawn whole.

## Dev scenarios

`dev/` pages run the real shaders on the GPU with scripted input and render a time-lapse strip plus stats:
`tunnel` (water at one end, growth at the other), `pool` (seeds in a pool), `garden` (repeated watering, then drought), `elements` (fire/water/steam/embers/sinking).
Open through the server, e.g. http://localhost:8000/dev/garden.html. `dev/harness.js` is the shared harness.

## Cell encoding

One `u32` per cell: `type | data << 8 | variant << 16`. `data` is per-type (fire/smoke/ember lifetime, plant energy). `variant` bits 0-1 pick a color; plants keep their energy as 14 bits (`data` plus variant bits 2-7, in `ENERGY_RES` fine units), and bits 24-29 hold stillness.

## Adding a particle type

1. Add an ID to `T` and its colors to `CMAP` in `config.js` (and to `TOOLS` if it should be drawable).
2. Add a `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s interaction loop.
3. If it needs starting data when drawn, set it in `src/shaders/brush.wgsl.js`.
