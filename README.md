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

Plants run on two quantities, energy and momentum; larger behavior (flow toward open space, bottlenecks filling up) is meant to emerge from them rather than from special rules. Each step runs consume → transfer → bloom → decay → damp.

| Mechanic | What it does | Parameters |
|---|---|---|
| Energy | A scalar: the cell's stored energy (14 bits). | `ENERGY_RES` (fine units per energy) |
| Momentum | A vector in a second buffer, \|p\| ≤ E. \|p\| is the moving part of the energy, the rest is at rest. \|p\| counts the axis part plus √2 × the diagonal part. | none |
| Consumption | A cell that isn't full drinks a neighboring water. The new energy is all moving, away from the water, turned by the noise map. | `WATER_GAIN`, `NOISE_TURN`, `PLANT_CAP` |
| Transfer | The moving energy splits between the two nearest of the 8 directions and moves one cell, carrying its momentum; arrivals add up, so head-on ones cancel into rest. Diagonals take 1 phase in 4 to come around, axes 2, so axis moves are taken with chance 1/√2 to keep pace. A full destination keeps the energy at the origin but takes the momentum; whatever exceeds its own energy reflects back. Air (or anything solid) reflects with moderate loss, water with small loss. | `PLANT_CAP`, `AIR_LOSS`, `WATER_LOSS` |
| Bloom | A cell with high energy and little moving grows into an orthogonal neighbor of open air, or, less often and only fuller, water (replacing it). The new cell gets half the energy, at rest. | `BLOOM_E`, `BLOOM_MOVING`, `BLOOM_WATER_E`, `BLOOM_WATER_ODDS` |
| Decay | Energy slowly burns, sometimes breathed out as steam; a cell that runs empty dies, sometimes leaving a seed. | `METAB_ODDS`, `TRANSPIRE_ODDS`, `SEED_DROP_ODDS` |
| Damp | Every step a little momentum settles into rest. | `DAMP` |
| Germination | A seed touching water becomes a plant cell. | `GERM_E`, `GERM_ODDS` |

All tuning lives in `TUNING` in `src/config.js`, with timings at 3x (~180 steps/s).

Rendering: plant brightness tracks fullness: full cells are bright, starved ones dim.

## Other rules

- Sand, seeds and embers sink through water at half speed.
- Smoke and steam rise and drift sideways; steam bubbles up through water.
- Fire or ember touching water boils it to steam; steam condenses back to water (falls as rain), so water is conserved through the cycle.
- The brush (GPU) only fills empty cells; the eraser clears everything. Strokes are queued per pointer event, so fast swipes and quick taps are drawn whole.

## Dev scenarios

`dev/` pages run the real shaders on the GPU with scripted input and render a time-lapse strip plus stats:
`tunnel` (water at one end, growth at the other), `reservoir` (a bowl drains through a hole onto seeds; left on open floor, right inside a stone cup whose roof gap and floor slit are the plant's only ways out), `sealed` (a sealed reservoir drains through a one-cell neck onto a root; the only air is the far chamber, where the plant should grow modestly), `pool` (seeds in a pool), `garden` (repeated watering, then drought), `elements` (fire/water/steam/embers/sinking).
Open through the server, e.g. http://localhost:8000/dev/garden.html. `dev/harness.js` is the shared harness.

## Cell encoding

One `u32` per cell: `type | data << 8 | variant << 16`. `data` is per-type (fire/smoke/ember lifetime, plant energy). `variant` bits 0-1 pick a color; plants keep their energy as 14 bits (`data` plus variant bits 2-7, in `ENERGY_RES` fine units). Plant momentum lives in a parallel buffer, one `u32` per cell holding signed 16-bit x and y.

## Adding a particle type

1. Add an ID to `T` and its colors to `CMAP` in `config.js` (and to `TOOLS` if it should be drawable).
2. Add a `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s interaction loop.
3. If it needs starting data when drawn, set it in `src/shaders/brush.wgsl.js`.
