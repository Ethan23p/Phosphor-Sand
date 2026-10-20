# Dev scenarios

Behavior is checked by running the real shaders on the GPU with a scripted grid and scripted input, then looking at a time-lapse strip. There's no unit test suite.

## Run

```
node dev/strip.mjs plants                       # the plant suite: every variant of every plant scenario
node dev/strip.mjs waterfall/heavy BLOOM_E=4    # one variant, with a tuning override
node dev/strip.mjs pipe --tag before            # every variant of one scenario, files tagged "before"
node dev/strip.mjs garden.html                  # an older standalone page (no checks)
```

It serves the repo itself, drives the installed Chrome headlessly (playwright-core is installed once into `%LOCALAPPDATA%/phosphor-sand-tools`), runs up to 4 scenarios at once (`--jobs n`), prints every snapshot as it lands, and ends with a PASS/FAIL table. Each run writes to `dev/out/` (gitignored):
- `<tag>_<scenario>_<variant>[_overrides].png`: the strip, headed by what the scenario is for and what good looks like.
- `.txt`: the per-snapshot stats and the checks.

The whole plant suite takes about 30 s. Overrides (`NAME=value`) replace `TUNING` entries for that run only, so sweeps don't touch `config.js`.

Checks are a quick signal, not the verdict: always look at the strips.

To watch one live, serve the repo (`python -m http.server 8000`) and open `/dev/scenario.html?s=pipe&v=curved`.

## Reading a strip

Columns are snapshots in time (step / seconds at 3x). Rows:
1. The cells, colored as in the game (plant brightness tracks energy).
2. Moving energy: black at rest, red to white when moving fast.
3. Root distance: white at the water, through yellow and red to blue at 40 cells, magenta at the cap (cut off from water).
4. Age: bright for young cells, dimming toward retirement. Green: grown plant; orange: seedling.

Stats per region:
- `plant`: cell count.
- `E`: total energy; `mov`: total moving energy.
- `width`: median branch width (about 1 for a one-cell ray, 10 for a 10px tendril).
- `thick`: share of cells in a body at least 5 cells wide.

## The plant suite

| Scenario | Variants | What it asks |
|---|---|---|
| `waterfall` | `light` (1px), `heavy` (5px) | A topped-up stream falls onto seeds on a plateau. The plant should flourish at the bottom and never climb the stream ("eat the waterfall"). |
| `pipe` | `straight`, `curved` | A thick stem fully enclosed in stone, water resting on one end, a big open chamber at the other. Energy should be piped through, and the plant should flourish in the chamber. |
| `tunnel` | `straight`, `curved` | Same, but with an air gap around the stem the whole way. At least some energy should reach the far end. |
| `reservoir` | `plant`, `seed` | A mound drowned on one side by a pour. The dry side should flourish fast. |
| `meadow` | | Phone-style play: seeds on a floor, a water stroke dragged for 1 s every 3 s. This is what a thriving plant should look like: thick bodies filling out, a bushy front led by thick (10px+) tendrils. |

## The elements suite

`node dev/strip.mjs elements`. Cells-only strips (`plantRows: false`) with each variant's own numbers (`measure`).

| Scenario | Variants | What it asks |
|---|---|---|
| `gravity` | `fall`, `pile`, `dam`, `sink`, `utube`, `fountain`, `erode` | Blobs of each material dropped from the top should speed up. Sand poured from a point should pile below 45°. Sand should sink and seeds float. Targets that fail today because only surface water moves (no pressure): a tall water column should level within a few seconds (`dam`), a full tank and an empty one joined under a wall should level (`utube`), a high tank should spout from a low outlet (`fountain`), and a stream on a sand slope should carve it and carry sand to its foot (`erode`; the stream pools into a still mound instead of running). |

## Writing a scenario

A scenario is `dev/scenarios/<name>.js`, default-exporting an object. It imports nothing browser-side (the page passes it `lib`), so `strip.mjs` can read its variants in node. Shared builders live in `_*.js` files beside it (e.g. `_conduit.js`).

```js
export default {
  intent: 'What this strip is for, in a sentence or three.',           // shown in the header
  expect: ['what good looks like', '...'],                             // shown in the header
  legend: 'Rows / regions explained (optional).',
  variants: { light: { hole: 1 }, heavy: { hole: 5 } },                // v.name is added; one '' key for none
  times: [5, 15, 30, 60, 90, 120],                                     // snapshot times, seconds at 3x
  build(g, v, lib) {},             // fill the grid g; may return { mom } (a plant buffer to start from)
  init(h, v, lib) {},              // optional: brush strokes before the first step (seeds etc.)
  input(h, step, v, lib) {},       // optional: called before every step (pours, sumps, play)
  regions: v => ({ name: (x, y) => bool }),                           // measured separately
  checks: (series, v) => [{ ok, text }],                               // series: one measure() per snapshot
  measure(a, lib, v) {},           // optional: this scenario's own numbers per snapshot ({ name: number }), replacing the plant stats
  plantRows: false,                // optional: strip shows only the cells row
};
```

`lib` has `fill`, `disc`, `path` (thick polylines), `blankGrid`, `makeCell`, `makePlant`, `plantE`, `T`, `TUNING`, `W`, `H`, and the `STONE` / `WATER` / `SAND` cells. `h` is the harness (`dev/harness.js`): `h.brush({ x0, y0, x1, y1, r, type, density })`, `h.step`, `h.read()`.

Guidelines:
- Emulate play rather than lab setups: keep input going, use the real brush size and density (radius 3, density 160 for water, one stamp per frame = every 3 steps), and drain runoff into erased sumps so the plant is watered, not drowned. Watch the water count in the stats: a plant sitting in a growing pool is being drowned, and that's a scenario problem as much as a sim problem.
- Keep the header honest: `intent` says what's being tested and why the setup looks the way it does.
- Make checks match the user-facing goal and be lenient. They catch regressions; the strip is the judgment.
