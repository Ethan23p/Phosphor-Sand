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

Plant energy behaves like a wave medium: each cell holds energy (a scalar) and momentum (a vector). Stored energy is pressure, pressure pushes momentum, and momentum carries energy from cell to cell as directed packets. So energy drunk at the water travels through the plant as waves, guided by the plant's shape: down an enclosed stem it travels like light down a fiber. It pours out wherever the plant may grow, and that is where the plant grows. Separately, each cell tracks its root distance, which decides where the plant may grow. Each step runs consume → pressure and viscosity → transfer and bloom → root distance → age → retire → friction.

Conservation: water becomes energy when drunk, and energy becomes structure when a cell is built (one water's worth per cell). Structure goes back to the world as steam (or a seed) when the cell retires. In between nothing is created or lost: friction, viscosity and bounces only slow energy down, and pressure sets it moving again. The only leaks are at decay: a cell retiring deep inside a plant leaves no steam, and one with no plant neighbor loses the energy it held.

| Mechanic | What it does | Parameters |
|---|---|---|
| Energy | A scalar: the cell's stored energy (14 bits). | `ENERGY_RES` (fine units per energy) |
| Momentum | A vector in a second buffer, \|p\| ≤ E: the moving part of the energy. \|p\| counts the axis part plus √2 × the diagonal part. | none |
| Consumption | A cell drinks the water it touches, up to `DRINK_MAX` cells of it per step, while it has room (about 255 energy a cell). The new energy moves straight away from the water, turned slightly by the noise map and a little random spread. | `WATER_GAIN`, `DRINK_MAX`, `DRINK_TURN`, `DRINK_SPREAD` |
| Pressure | Stored energy pushes momentum toward neighbors holding less: the restoring force that makes energy travel as waves rather than sit. Stone and water push back as hard as the cell does, so they don't draw energy. Open air draws it (pressure 0) only as far as the plant may bloom there, so energy is pulled toward the growth front, not to bare edges by the roots. | `PRESS` |
| Viscosity | Each cell's momentum relaxes toward its block's average (total momentum kept), so neighbors move together as streams instead of sloshing against each other. Streams make jets, and jets make thick tendrils. | `VISC` |
| Transfer | Moving energy splits between the two nearest of the 8 directions and moves one cell, carrying its momentum. Diagonals take 1 phase in 4 to come around and axes 2, so axis moves are taken with chance 1/√2 to keep pace. Energy passes freely between plant cells. | none |
| Bounce | A packet that can't go on (stone, water, open air it doesn't bloom into, a full cell) reflects like a mirror: the axis facing the wall flips and the rest carries on. That is what guides packets down a stem. Bounces off air and water also scatter it a little (noise map plus random spread) and slow it by `AIR_LOSS` / `WATER_LOSS` %; the energy stays, at rest. | `AIR_LOSS`, `WATER_LOSS`, `NOISE_TURN`, `SPREAD` |
| Friction | Moving energy comes to rest at `DAMP` per mille a step (none is lost). | `DAMP` |
| Root distance | How far a cell is from where the plant last drank, measured through the plant. Touching water or sprouting sets it to 0; otherwise a cell takes the shortest route its plant neighbors offer, +1 per step (+1.5 diagonally). Unconfirmed distances creep up, so a cut-off branch drifts to the cap. | `DIST_CREEP_ODDS` |
| Age | Each cell's own age (see Retirement), and the plant's age: the oldest any of its cells has been, passed through the plant and never lowered. A plant younger than `GROWN_AGE` (~3 s) is a seedling. | `GROWN_AGE` |
| Bloom | Moving energy from a cell with at least `BLOOM_E` that pushes into open air grows a new cell there (1 in `BLOOM_WATER_ODDS` times it grows into water, replacing it). Building the cell takes one water's worth (`WATER_GAIN`) of the packet; the new cell gets the rest and the packet's momentum. Two gates: <ul><li>Distance: in grown plants growth is rarer near the roots, `BLOOM_NEAR` per mille as often at the roots, rising smoothly to certain at `BLOOM_DIST` cells. So a wet plant doesn't climb the water that feeds it.</li><li>Support: a new cell that would touch only its parent in the block (the tip of a one-cell ray) grows `BLOOM_TIP` per mille as often, so growth advances as thick fronts, not rays.</li></ul> | `BLOOM_E`, `BLOOM_WATER_ODDS`, `BLOOM_DIST`, `BLOOM_NEAR`, `BLOOM_TIP` |
| Retirement | A cell ages and retires after about 255 × `AGE_ODDS` steps (~3 min). Its structure goes back as a seed (1 in `SEED_DROP_ODDS`), or as steam if it's at the plant's surface (deep inside, it leaves a gap). The energy it held goes to a plant neighbor. | `AGE_ODDS`, `SEED_DROP_ODDS` |
| Germination | A seed touching water becomes a plant cell. | `GERM_E`, `GERM_ODDS` |

All tuning lives in `TUNING` in `src/config.js`, with timings at 3x (~180 steps/s).

Rendering: plant brightness tracks energy, from 0.25x (nearly empty) to 1.25x at `PLANT_GLOW` and above.

## Other rules

- Sand, seeds and embers sink through water at half speed.
- Smoke and steam rise and drift sideways; steam bubbles up through water.
- Fire or ember touching water boils it to steam; steam condenses back to water (falls as rain), so water is conserved through the cycle.
- The brush (GPU) only fills empty cells; the eraser clears everything. Neither touches the 1px stone border around the grid, which the sim keeps as stone. Strokes are queued per pointer event, so fast swipes and quick taps are drawn whole.

## Dev scenarios

`node dev/strip.mjs plants` runs the plant suite headlessly on the real shaders and writes annotated time-lapse strips to `dev/out/`. Each strip says what it tests and what good looks like. The suite:
- `waterfall`: a stream falling onto seeds.
- `pipe`: an enclosed stem from water to air.
- `tunnel`: the same with an air gap around the stem.
- `reservoir`: a mound drowned on one side.
- `meadow`: phone-style watering.

Scenarios live in `dev/scenarios/`, and any run takes tuning overrides (`BLOOM_E=4`). See [dev/README.md](dev/README.md) for the workflow, how to read a strip, and how to write a scenario. Older standalone pages (`flow`, `dist`, `trickle`, `pool`, `garden`, `elements`) still run through the same tool, e.g. `node dev/strip.mjs garden.html`.

## Cell encoding

One `u32` per cell: `type | data << 8 | variant << 16`. `data` is per-type (fire/smoke/ember lifetime, plant energy). `variant` bits 0-1 pick a color; plants keep their energy as 14 bits (`data` plus variant bits 2-7, in `ENERGY_RES` fine units). Plant momentum and root distance live in a parallel buffer, two `u32`s per cell: signed 16-bit momentum x and y, then the distance (in half cells, capped at 255; bits 0-7) with the age packed above it (bits 8-15 the cell's own, 16-23 the plant's).

## Adding a particle type

1. Add an ID to `T` and its colors to `CMAP` in `config.js` (and to `TOOLS` if it should be drawable).
2. Add a `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s interaction loop.
3. If it needs starting data when drawn, set it in `src/shaders/brush.wgsl.js`.
