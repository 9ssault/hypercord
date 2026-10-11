# PERF.md

What "light" means here, and what the machine actually said. Baseline is plain
Electron showing the same Discord web app, same window size, same GPU flag, no
preload, no plugin host, no rail, no control-server client. Hypercord's **added**
cost is the interesting number, because Discord's own web app dominates the total
either way.

## Budget

| Metric | Budget | State |
| --- | --- | --- |
| Added RSS with the rail closed | <= 60 MB | **not met** as measured: see below |
| Added RSS with the rail open, idle | <= 90 MB | **not met** as measured: see below |
| Idle CPU, nothing happening | <= 1% of one core | confounded by Discord's own work: see below |
| Steady timers or polling loops while idle | 0 | **met: 0 in every state, in every run** |
| Plugins enabled on first run | the Hyper set only | **met: 5 enabled, 5 running, of 371** |
| Background processes after the window closes | 0 | **met: nothing of ours survives a close** |
| Login item / start on boot | none | **met: never registered, never set** |

## How it is measured

1. `app.getAppMetrics()` inside the process for per-process memory and CPU. CPU is
   reported as a delta since the previous call, so the mode primes it once and
   then reads over a fixed idle window rather than over the process's whole life.
2. The same three states every time: rail open and idle, rail closed and idle. The
   rail is forced open for the first snapshot and forced closed for the second, so
   the label is true whatever the saved preference says.
3. Timers: `process._getActiveHandles()` filtered to live `Timeout` handles. Zero
   is the only acceptable number; it is printed in every snapshot.
4. `npm run test:baseline` (plain Electron) and `npx electron . --perf=<settle>`
   (Hypercord). Both settle, prime, then read over one 20-second idle window.

## Results

### Run A - baseline, plain Electron plus Discord web, no mods

`npx electron tests/baseline --perf=90` (90 s settle, then one 20 s idle window)

| State | Total RSS | CPU sum over the window | Timers |
| --- | --- | --- | --- |
| discord web, no mods | 963 MB | 2.86% of one core | 0 |

### Run B - Hypercord

`npx electron . --perf=90` (same shape; 371 plugins in the catalogue, 5 running)

| State | Total RSS | CPU sum over the window | Timers |
| --- | --- | --- | --- |
| rail open, idle | 1218 MB | 1.39% of one core | 0 |
| rail closed, idle | 1030 MB | 5.29% of one core | 0 |

### Run C - Hypercord, an earlier measurement of the same two states

| State | Total RSS | Timers |
| --- | --- | --- |
| rail open | 997 MB | 0 |
| rail closed | 909 MB | 0 |

## What these numbers actually say

- **Timers: 0 in every state, in every run.** This is the row that matters most
  and it is unambiguous. The plugin host, the theme system, the rail, the panes
  window and the shell schedule nothing while idle; a check is a call somebody
  makes, not an interval.
- **The added-RSS rows are not met, and at this precision they cannot be trusted
  either way.** Rail-closed readings for the same nominal state came out at 909 MB,
  1030 MB and 1377 MB across runs, and the no-mods baseline itself reads 963 MB —
  the spread between runs is larger than the whole budget. Discord's web app loads
  lazily, spawns renderers as you navigate and caches aggressively, so a single
  sample per state measures Discord's mood, not our footprint. Rail *closed* even
  came out 54 MB **below** the baseline in run C, which is the clearest sign that
  this precision is noise.
- **The idle-CPU rows are confounded the same way.** Rail-closed shows a *higher*
  CPU sum than rail-open in run B (5.29% vs 1.39%), which cannot be the rail
  becoming cheaper when it is open. The samples simply caught Discord doing work
  between them. No CPU claim is made from these readings.
- **What is structural, not measured:** the rail is DOM and CSS at one injection
  point plus a stylesheet whose every selector is scoped to the rail, the themes
  are one `<style>` element, a disabled plugin's code is dropped on disable, the
  catalogue is a JSON manifest that no code is read from, the manager sheet is
  markup that only mounts when a view is opened (there is no second window, and
  no window to create, raise or release), there is no tray or resident process,
  and the client quits with its window.

## What ships, and what actually weighs

Read from the tree and the build config, not measured - this section is a source
inventory, and every number in it that is an estimate says so. `scripts/measure.mjs`
now prints the same figures as a reading (`shipped: <files> file(s), <KiB> KiB |
packed asar <KiB> KiB`, also in `vendor/_measure.json` as `shipped`), so running it
once replaces the estimates below with measured bytes.

`package.json` decides what is packaged: `files` is `src/**/*`, `plugins/**/*`,
`pwa/**/*` with `!**/*.map`, `!**/*.ts`, `!**/*.tsx`; `asar: true`;
`compression: "maximum"`; `electronLanguages: ["en-US"]` - one locale pack instead
of roughly fifty. Everything else in the repository is repository weight, and the
only production dependency is `electron-updater`.

| What | Where | Ships? | Weight of the artifact |
| --- | --- | --- | --- |
| the shell, preload, rail, panes, prompt | `src/` - 18 files, all reached from `main.js`, `preload.cjs`, `panes.html` or `rail.html` | yes | kilobytes of JS, CSS and HTML |
| the plugin catalogue | `plugins/manifest.json` - 7,805 lines of indented JSON, **on the order of 300 KB (estimated from the line count, not measured)** | yes | the largest single file of ours |
| the interpreter and the host | `plugins/sandbox.js`, `plugins/index.js` | yes | kilobytes |
| our plugins | `plugins/hyper/` - 5 plugins, the ones on by default | yes | kilobytes |
| the reference addons | `plugins/examples/`, `themes/examples/`, `themes/index.js` | yes | kilobytes; inert for the desktop host, which reads the manifest rather than enumerating directories |
| the served manifest | `pwa/manifest.webmanifest` | yes | one file |
| the vendored catalogue's *bodies* | `vendor/vencord/`, `vendor/equicord/` | **no** | not in `build.files` at all; the `.ts`/`.tsx` exclusions would also drop them if it were |
| the Android client | `android/`, `core/`, `utils/`, `themes/` | **no** | not in `build.files`; an APK build is a separate artifact |
| Electron | the runtime | yes | **the floor of every number above** - a Chromium plus Node per platform, an order of magnitude more than everything of ours together |

Two consequences worth stating plainly, because both are easy to misread:

* **The 371-entry catalogue is metadata, not weight.** Every vendored entry records
  an `entry` under `vendor/equicord/src/...` with `"built": false`, and the host
  refuses a `.ts`/`.tsx` entry as "TypeScript source, not built". So the catalogue is
  browsable and its bodies are absent - browsing costs one JSON read, and "371 in the
  catalogue, 5 running" is the designed state, not a fault. A debloat that removed
  the manifest would remove the manager's entire plugin list, so it is load-bearing.
* **`compression: "maximum"` buys installer size with build time, not memory.** It
  changes the artifact on disk, never the RSS of a running client.

### Debloat list

1. **Scratch under `vendor/` - safe to remove.** `_asar.txt`, `_clone-status.txt`,
   `_clone-vencord.log`, `_electron-binary.log`, `_npm-install*.log`, `_pack*.log`,
   `_t-*.log`, `_perf-*.log`, `_app-run.log` and the rest are diagnostics from earlier
   runs. `.gitignore` already covers `*.log`, so the logs are untracked scratch; the
   `.txt` and `.json` siblings are **not** ignored, so they can still be committed by
   accident. Keep `vendor/_measure.json` - `scripts/measure.mjs` writes it on purpose -
   and either delete the rest or ignore `vendor/_*` explicitly. Cost of removing: none.
2. **The two upstream checkouts - the large one, and a risk rather than a bug.**
   `vendor/vencord/` and `vendor/equicord/` are full upstream trees, and there is **no
   `.gitmodules`**, so they are not submodules: they are checked into this repository's
   history. That is the single biggest thing here, and it also means the vendored
   commit the catalogue records has nothing pinning it. Cost of removing: the `vendor` script cannot
   rebuild `plugins/manifest.json` until they are cloned again; the shipped client is
   unaffected.
3. **Keep the `.ts`/`.tsx` and source-map exclusions.** They are doing real work: without
   them the vendored TypeScript would ship inside the asar.
4. **Keep `electronLanguages: ["en-US"]`.** Re-adding locales adds tens of megabytes of
   Chromium `.pak` files for no feature.
5. **Nothing found that ships and that nothing reads.** All 18 files in `src/` are
   reached from `main.js`, `preload.cjs`, `panes.html` or `rail.html`; `pwa/` is what
   `PLATFORMS.md` tells a TWA wrapper to use; `themes/index.js` is imported by
   `core/index.js` and `plugins/index.js`. There is no second copy of the rail, no
   bundled webview and no icon set beyond `build/` (which `make-icons.mjs` generates
   rather than committing opaque binaries).

## To settle the RSS question properly

Interleave the two apps rather than running them one after the other: N=5 samples
each, alternating, alternating order, both windows and Discord fully settled
before each read, then compare medians. Until that exists, treat the budget rows
as unproven and the timers/plugin-set/background rows as measured and green.
