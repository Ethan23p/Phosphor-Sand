# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Phosphor Sand is a WebGPU falling-sand toy. It's plain ES modules with no build step, no dependencies and no package.json. See README.md for the user-facing rules, the plant model and the cell encoding.

## Running

- **Local:** `python -m http.server 8000` from the repo root, then open http://localhost:8000. ES modules don't load over `file://`.
- **Phone:** `powershell -ExecutionPolicy Bypass -File serve.ps1` starts the server plus a cloudflared quick tunnel and prints an https URL. WebGPU needs a secure context.
  - Keep `serve.ps1` ASCII-only. It's run by PowerShell 5.1, which misparses non-ASCII characters in BOM-less UTF-8.
  - Phone browsers cache modules, so after a change the tab may need to be closed and reopened.

## Testing: dev scenarios

There's no unit test suite. Behavior is verified by running the real shaders on the GPU. See `dev/README.md` for the full workflow.
- `node dev/strip.mjs elements` runs `gravity` (fall, pile, dam, sink, utube, fountain, erode). `dam`, `utube`, `fountain` and `erode` fail on purpose: they're targets for water pressure, which needs water carried through a body (only surface water moves today).
- `node dev/strip.mjs plants` runs the plant suite (`waterfall`, `pipe`, `tunnel`, `reservoir`, `meadow`, every variant; about 30 s). Name a scenario, `scenario/variant` or `page.html` to run less. Add `NAME=value` tuning overrides for sweeps and `--tag` to name the files.
- It prints each snapshot as it lands and ends with a PASS/FAIL table from each scenario's checks. Strips (`.png`, headed by the scenario's intent) and stats (`.txt`) land in `dev/out/` (gitignored).
- A scenario is a module in `dev/scenarios/` with `intent`, `expect`, `variants`, `build`, `input`, `regions` and `checks`. Run through `dev/scenario.html` and `dev/scenario.js`, it imports nothing browser-side.
- `createHarness({ wgsl, extra })` (`dev/harness.js`) runs a modified sim shader with extra bind group entries. Use it for temporary instrumentation, e.g. atomic counters at binding 5, and don't commit those probe pages.
- Strip rows: cells, moving energy, root distance, age (bright: young cell; green: grown plant, orange: seedling).

Expectations for sim changes:
- After any sim or tuning change, run the relevant scenarios and actually look at the screenshot strips. The user wants to see them.
- The user plays on a phone while constantly drawing new particles. Judge behavior under ongoing input and at the level of whole plant communities (spread, die-back, reseeding, water cycle), not just single cells in static setups.
- Timings in comments and stats assume 3x speed, about 180 sim steps/s.

## Architecture

**Config is the single source of truth.**
- `src/config.js` defines `T` (type IDs), `TUNING`, the palette, `CMAP` and `TOOLS`.
- `src/shaders/common.wgsl.js` emits every `T` and `TUNING` entry as a WGSL `const NAME:u32`, so tuning values must be non-negative integers.
- The render color table is generated from `CMAP`, and the toolbar is generated from `TOOLS`.

**Shaders are JS template literals** (`src/shaders/*.wgsl.js`).
- Never put backticks inside them, including in WGSL comments; a backtick ends the JS string.
- `src/debug.js` `validateWGSL` lints for WGSL reserved words and signed shifts before compiling.

**Margolus 2×2 block CA** (`sim.wgsl.js` `main`):
- **Blocks:** each step, the grid is split into 2×2 blocks, offset by `phase` (`step & 3`): offsets (0,0), (1,1), (0,1), (1,0). Each step reads `grids[cur]` and writes `grids[1-cur]`, then the two are swapped.
- **Shared computation:** all four threads of a block compute the whole block identically, and each writes only its own cell. So all randomness must come from the block (`b.rng`, `roll(b, i, salt)`), never from thread IDs.
  - Give each probability check its own unique `salt`, so checks don't share random bits.
- **Pipeline order:** `movement` (swaps only) → per-type `tick_*` (cells visited from a random start slot) → fire `convection`.
- **Border:** the outermost 1px ring of the grid is always stone (sim `main` rewrites it each step; the brush skips it), which also covers any block that would hang off the grid.
- **Interaction range:** cells can only interact with cells in the same block. A neighbor in a given direction is only reachable on some phases; otherwise the rule waits.
  - With four phases every neighbor pair shares a block on some phase: an orthogonal pair on 2 of 4, a diagonal pair on 1 of 4.
- **Conservation is a design goal.**
  - Movement only swaps cells.
  - Reactions should conserve matter, e.g. water ↔ steam. Plants turn water into energy, and transpiration returns part of it as steam.
  - Don't add rules that create matter from nothing.

**Cell encoding:** each cell is one `u32`: `type | data<<8 | variant<<16`.
- Use the accessors `gt`, `gd`, `gv` and the constructor `mc` from `common.wgsl.js`; `makeCell` is the JS equivalent.
- Loose cells (sand, water, seed, ember) keep a motion state in variant bits 2-7 (`fall_v`, `side_r`, `skid_v`, `motion` in `sim.wgsl.js`): fall speed, sideways direction, sideways momentum. Tick code that rebuilds such a cell with `mc` resets it, which is fine (it just comes to rest). The brush and condensing steam give water a random direction.
- Plant energy is 14 bits in fine units (`ENERGY_RES` per tuning unit): `data` holds the low 8, variant bits 2-7 the high 6. Use `pe`/`mp` (JS: `plantE`/`makePlant` in the harness).
- Plant momentum and root distance share a second ping-ponged buffer (sim bindings 3 and 4, `vec2u` per cell): `.x` is signed 16-bit momentum x and y (`unpack_mom`/`pack_mom`; JS `momOf`), `.y` the root distance in half cells (bits 0-7), and the age (bits 8-15 the cell's own, 16-23 the plant's); mask with `& 255` to read each. `h.read(true)` returns them interleaved. `main` loads them into `m`/`dist` for plant slots and writes zero for every other cell, so a new plant always starts at rest; a sprouting seed gets distance 0, a bloomed cell its parent's + 2, age 0 and its parent's plant age.
- Plant tick order: `plant_consume` → `plant_flow` (pressure and viscosity via `plant_press`, then transfer, mirror bounces and bloom) → `plant_dist` → `plant_age` (all for the whole block, right after `movement`) → `tick_plant` (retire by age, friction).
- Plant energy is a wave medium (pressure pushes momentum, momentum carries energy). Energy may only leave or enter at clean seams: drinking (water → energy), building a cell (one water's worth → structure) and retirement (structure → steam or seed). Friction, viscosity and bounces only slow energy; they never destroy it.

**Brush** (`brush.wgsl.js`):
- It's a GPU capsule stamp that edits the current grid in place. It only fills empty cells; the eraser clears all.
- The starting `data` for a drawn type (fire life, ember life, plant energy) is set here.
- `src/input.js` queues one `[from, to]` segment per pointer event into `state.segs`, and `main.js` dispatches one brush pass per segment before the sim steps.

**Adding a particle type:**
1. Add it to `T`, `CMAP` and optionally `TOOLS`.
2. Write `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s visit loop.
3. Set its starting data in `brush.wgsl.js` if it needs any.
