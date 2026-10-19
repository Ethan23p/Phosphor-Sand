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

Plant energy runs on two quantities, energy and momentum; larger behavior (flow toward open space, bottlenecks filling up) is meant to emerge from them rather than from special rules. Separately, each cell tracks its root distance, which decides where the plant grows. Each step runs consume → transfer → root distance → bloom → decay → damp.

| Mechanic | What it does | Parameters |
|---|---|---|
| Energy | A scalar: the cell's stored energy (14 bits). | `ENERGY_RES` (fine units per energy) |
| Momentum | A vector in a second buffer, \|p\| ≤ E. \|p\| is the moving part of the energy, the rest is at rest. \|p\| counts the axis part plus √2 × the diagonal part. | none |
| Consumption | A cell that isn't full drinks a neighboring water. The new energy is all moving, straight away from the water, turned only slightly (by the noise map, the same way every time at a given spot, plus a little random spread). | `WATER_GAIN`, `DRINK_TURN`, `DRINK_SPREAD`, `PLANT_CAP` |
| Transfer | The moving energy splits between the two nearest of the 8 directions and moves one cell, carrying its momentum; arrivals add up, so head-on ones cancel into rest. Diagonals take 1 phase in 4 to come around, axes 2, so axis moves are taken with chance 1/√2 to keep pace. Open air reflects with hardly any loss near the roots, rising to `AIR_LOSS` far out, so energy races through the young plant and slows at its far edges; water reflects with small loss; both bounces turn like drinking does (noise map plus random spread). Stone, seeds and the like, the stone border, and full plant cells turn the momentum about 90° (with `CRADLE: 1` a full cell instead acts like a Newton's cradle, taking the momentum but not the energy), the side picked with odds set by the noise map, and the packet goes on sideways in the same step when that cell is a plant with room. | `PLANT_CAP`, `CRADLE`, `AIR_LOSS`, `WATER_LOSS`, `SOLID_LOSS`, `DEFLECT_SPREAD`, `NOISE_TURN`, `SPREAD` |
| Root distance | How far a cell is from where the plant last drank, measured through the plant. Drinking (or sprouting) sets it to 0; otherwise a cell takes the shortest route its plant neighbors offer, +1 per step (+1.5 diagonally). Unconfirmed distances creep up, so a cut-off branch drifts to the cap. | `DIST_CREEP_ODDS` |
| Bloom | A cell with high energy and little moving grows into an orthogonal neighbor of open air, or, less often and only fuller, water (replacing it). Near the roots it rarely does; the chance per step rises as (distance / `BLOOM_DIST`)^`BLOOM_RAMP`, certain at `BLOOM_DIST` cells out. Squared rather than linear, so energy settling a few cells from the water waits instead of blooming at once, and the plant flourishes where the water lands rather than climbing into the fall. The new cell gets half the energy, at rest. With `BLOOM_PUSH` (off by default) a packet from a cell that full can also push on into open air instead of bouncing, with the same distance odds, the new cell taking the packet's energy and momentum: thick fast tendrils that grow toward the water and climb a falling stream. | `BLOOM_E`, `BLOOM_MOVING`, `BLOOM_PUSH`, `BLOOM_DIST`, `BLOOM_NEAR_ODDS`, `BLOOM_RAMP`, `BLOOM_WATER_E`, `BLOOM_WATER_ODDS` |
| Decay | Energy slowly burns, sometimes breathed out as steam; a cell that runs empty dies, sometimes leaving a seed. | `METAB_ODDS`, `TRANSPIRE_ODDS`, `SEED_DROP_ODDS` |
| Damp | Every step a little momentum settles into rest: hardly any near the roots, rising to `DAMP` per mille at `BLOOM_DIST` cells out, so energy stays lively near its source and settles toward the tips. | `DAMP` |
| Germination | A seed touching water becomes a plant cell. | `GERM_E`, `GERM_ODDS` |

All tuning lives in `TUNING` in `src/config.js`, with timings at 3x (~180 steps/s).

Rendering: plant brightness tracks fullness, from 0.25x (nearly empty) to 1.25x (full).

## Other rules

- Sand, seeds and embers sink through water at half speed.
- Smoke and steam rise and drift sideways; steam bubbles up through water.
- Fire or ember touching water boils it to steam; steam condenses back to water (falls as rain), so water is conserved through the cycle.
- The brush (GPU) only fills empty cells; the eraser clears everything. Neither touches the 1px stone border around the grid, which the sim keeps as stone. Strokes are queued per pointer event, so fast swipes and quick taps are drawn whole.

## Dev scenarios

`dev/` pages run the real shaders on the GPU with scripted input and render a time-lapse strip plus stats:
`flow` (two big slabs of plant at rest with water along one edge, to watch energy travel frame by frame; its second row shows moving energy), `dist` (a splotchy plant block in a stone tray under a slowly draining pool, every plant starting at the distance cap; extra rows show the stored root distance beside the true distance to water), `waterfall` (a basin, kept topped up, drains through a 3px hole in a long fall onto seeds on a plateau whose runoff is erased: does the plant flourish where the water lands or climb the stream and eat the waterfall?), `tunnel` (water at one end, growth at the other), `reservoir` (a bowl drains through a hole onto seeds; left on open floor, right inside a stone cup whose roof gap and floor slit are the plant's only ways out, with a ramp keeping water off the cup's outside), `sealed` (a sealed reservoir drains through a one-cell neck onto a root; the only air is the far chamber, where the plant should grow modestly), `pool` (seeds in a pool), `garden` (repeated watering, then drought), `elements` (fire/water/steam/embers/sinking).
Any page takes tuning overrides in its query string for sweeps, e.g. `/dev/waterfall.html?BLOOM_RAMP=4`. Open through the server, e.g. http://localhost:8000/dev/garden.html. `dev/harness.js` is the shared harness.

## Cell encoding

One `u32` per cell: `type | data << 8 | variant << 16`. `data` is per-type (fire/smoke/ember lifetime, plant energy). `variant` bits 0-1 pick a color; plants keep their energy as 14 bits (`data` plus variant bits 2-7, in `ENERGY_RES` fine units). Plant momentum and root distance live in a parallel buffer, two `u32`s per cell: signed 16-bit momentum x and y, then the distance (in half cells, capped at 255).

## Adding a particle type

1. Add an ID to `T` and its colors to `CMAP` in `config.js` (and to `TOOLS` if it should be drawable).
2. Add a `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s interaction loop.
3. If it needs starting data when drawn, set it in `src/shaders/brush.wgsl.js`.
