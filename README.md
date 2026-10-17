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

Plants run on "ageism": energy only flows from older cells to younger ones. Each plant cell stores its age in variant bits 2-7, a generation count: a germinated seed is generation 0 and each sprout is one more than the cell that grew it. The count wraps at 64, and a neighbor counts as younger when it's 1-31 generations ahead, so the gradient runs through a plant of any length.

- **Germination:** a seed touching water consumes it and becomes a plant cell with `GERM_E`.
- **Drinking:** any plant cell touching water occasionally absorbs one, while below `PLANT_CAP` ("full").
- **Transport:** a cell passes its energy above `STEM_RESERVE` (up to `FLOW_RATE` per step) to a younger neighbor that isn't full.
- **Growth:** only when there's nowhere left for energy to flow and the cell is full does it try to sprout (every ~`GROW_ODDS` steps), claiming an empty neighbor for a noise-dependent cost. The new cell is one generation younger and starts with `BIRTH_E`. Otherwise energy accumulates.
- **Death:** every cell burns energy slowly, now and then breathing out steam (transpiration: forests make their own rain); starved cells vanish, sometimes leaving a seed.

So water drunk at a plant's old end is carried to its youngest growth, wherever that is. All tuning lives in `TUNING` in `src/config.js`, with timings at 3x (~180 steps/s).

Rendering: plant brightness tracks stored energy, young (drinking) cells show as bright cells.

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

One `u32` per cell: `type | data << 8 | variant << 16`. `data` is per-type (fire/smoke/ember lifetime, plant energy). `variant` bits 0-1 pick a color; plants use bits 2-7 for age (a wrapping generation count).

## Adding a particle type

1. Add an ID to `T` and its colors to `CMAP` in `config.js` (and to `TOOLS` if it should be drawable).
2. Add a `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s interaction loop.
3. If it needs starting data when drawn, set it in `src/shaders/brush.wgsl.js`.
