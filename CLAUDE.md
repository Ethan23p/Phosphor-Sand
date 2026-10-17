# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Phosphor Sand is a WebGPU falling-sand toy. It's plain ES modules with no build step, no dependencies and no package.json. See README.md for the user-facing rules, the plant model and the cell encoding.

## Running

- **Local:** `python -m http.server 8000` from the repo root, then open http://localhost:8000. ES modules don't load over `file://`.
- **Phone:** `powershell -ExecutionPolicy Bypass -File serve.ps1` starts the server plus a cloudflared quick tunnel and prints an https URL. WebGPU needs a secure context.
  - Keep `serve.ps1` ASCII-only. It's run by PowerShell 5.1, which misparses non-ASCII characters in BOM-less UTF-8.
  - Phone browsers cache modules, so after a change the tab may need to be closed and reopened.

## Testing: dev scenarios

There's no unit test suite. Behavior is verified by running the real shaders on the GPU:
- `dev/*.html` pages (`tunnel`, `pool`, `garden`, `elements`) script an initial grid and brush input with `dev/harness.js`.
- Each page renders a time-lapse strip into `#cv` and per-snapshot stats into `#out`.
- Open one through the server, e.g. `/dev/garden.html`.

To run one headlessly:
- Use playwright-core with the installed Chrome: `executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'`, `args: ['--enable-unsafe-webgpu']`.
- Wait until `#out` no longer says `running...`, then read `#out` and screenshot `#cv`.
- Keep that script in the scratchpad, not the repo.

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
- **Blocks:** each step, the grid is split into 2×2 blocks, offset by `phase` (`step & 1`). Each step reads `grids[cur]` and writes `grids[1-cur]`, then the two are swapped.
- **Shared computation:** all four threads of a block compute the whole block identically, and each writes only its own cell. So all randomness must come from the block (`b.rng`, `roll(b, i, salt)`), never from thread IDs.
  - Give each probability check its own unique `salt`, so checks don't share random bits.
- **Pipeline order:** `movement` (swaps only) → per-type `tick_*` (cells visited from a random start slot) → fire `convection`.
- **Interaction range:** cells can only interact with cells in the same block. A neighbor in a given direction is only reachable on some phases (`dir_slot` returns `4u` otherwise, meaning "wait").
  - Diagonal pairs sometimes never share a block, so neighbor rules (like plant energy transfer) should rely on orthogonal neighbors.
- **Conservation is a design goal.**
  - Movement only swaps cells.
  - Reactions should conserve matter, e.g. water ↔ steam. Plants turn water into energy, and transpiration returns part of it as steam.
  - Don't add rules that create matter from nothing.

**Cell encoding:** each cell is one `u32`: `type | data<<8 | variant<<16`.
- Use the accessors `gt`, `gd`, `gv` and the constructor `mc` from `common.wgsl.js`; `makeCell` is the JS equivalent.
- Plants use variant bits 2-7 as age (a generation count wrapping at 64; energy flows only to younger neighbors). Their `data` is energy.

**Brush** (`brush.wgsl.js`):
- It's a GPU capsule stamp that edits the current grid in place. It only fills empty cells; the eraser clears all.
- The starting `data` for a drawn type (fire life, ember life, seed energy) is set here.
- `src/input.js` queues one `[from, to]` segment per pointer event into `state.segs`, and `main.js` dispatches one brush pass per segment before the sim steps.

**Adding a particle type:**
1. Add it to `T`, `CMAP` and optionally `TOOLS`.
2. Write `tick_<type>` in `sim.wgsl.js` and dispatch it in `main`'s visit loop.
3. Set its starting data in `brush.wgsl.js` if it needs any.
