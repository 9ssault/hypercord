// language: JavaScript, file: scripts/build_runtime.mjs
//
// The vendored catalogue's plugins, as something the client can actually run.
//
//   node scripts/build_runtime.mjs            build the runtime
//   node scripts/build_runtime.mjs --check     report whether it is missing or stale
//
// Why this exists at all: the 371 entries in plugins/manifest.json are TypeScript
// *sources* under vendor/equicord/src. Nothing loads them as they are - they import
// Equicord's own modules and reach Discord's internals through the webpack runtime that
// only exists inside a loaded page. Upstream solves that with a build, and the vendored
// tree ships the build and its whole toolchain (`vendor/equicord/node_modules`, esbuild
// and the rest), so the honest thing is to run their build rather than invent a second
// one: its output is a single script that installs the runtime, the plugin manager and
// every plugin into the page.
//
// src/loader.cjs injects that script into Discord's windows (`readRuntime`,
// `buildRuntimeInjection`), and the settings sheet drives the plugins it installs. So
// this script is the other half of that flow: without it, the loader says the runtime is
// not built, and the Plugins page keeps saying so about every vendored entry.
//
// It runs the vendored build in its own directory, because that build reads its
// tsconfig, its aliases and its `src` from there - and it reports the two things worth
// knowing: which file the loader will inject, and how old it is against the sources it
// was built from.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const vendored = path.join(root, "vendor", "equicord");
const renderer = path.join(vendored, "dist", "desktop", "renderer.js");
const browser = path.join(vendored, "dist", "browser", "browser.js");
// What the client actually injects, and what a *release* can be built from.
//
// The vendored tree is a submodule with its own toolchain, so it is not in a CI checkout: a
// desktop job there has no `vendor/equicord/dist` to read and no `node_modules` to build one
// with. The bundle therefore also lands here, in this repository, and this directory - not the
// submodule - is what the packaging step ships and what the loader falls back to. It is the
// same file, copied after every build, which is why the freshness check can treat it as an
// input of the packed app.
const output = path.join(root, "vendor", "runtime", "browser.js");
// And the stylesheet that goes with it, copied in the same pass and for the same reason: the
// browser build is a userscript, so its CSS is a *second* file beside the bundle rather than
// part of it - 218kb of `.vc-` rules live in `browser.css`, and `browser.js` contains none of
// them (measured: `grep -c vc-card-base vendor/runtime/browser.js` is 0, while `browser.css`
// defines it three times). A client shipped one file without the other gets a runtime whose
// own pages - the plugin browser, the theme browser, the settings windows - are drawn as bare
// markup with no stylesheet behind them.
const stylesheet = output.replace(/\.js$/i, ".css");
const entry = path.join(vendored, "src", "Vencord.ts");
const args = process.argv.slice(2);
const check = args.includes("--check");

/** The newest mtime under a directory, which is how old the sources are. */
function newestSource(dir) {
  let newest = 0;
  const walk = (at) => {
    let rows = [];
    try {
      rows = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const row of rows) {
      const full = path.join(at, row.name);
      if (row.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|css|json)$/.test(row.name)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* a file that went away while walking is not a source anymore */
      }
    }
  };
  walk(dir);
  return newest;
}

/** Which of the bundles this install would inject: see readRuntime in src/loader.cjs. */
function preferred() {
  const built = fs.existsSync(browser) ? browser : renderer;
  return fs.existsSync(built) ? built : output;
}

/** The bundle the loader would read, and where it came from. */
function builtInfo() {
  const file = preferred();
  try {
    const stat = fs.statSync(file);
    const first = String(fs.readFileSync(file, "utf8").split("\n", 1)[0] || "").replace(/^\/\/\s*/, "").trim();
    return { ok: true, file, at: stat.mtimeMs, bytes: stat.size, version: first, shipped: file === output };
  } catch {
    return { ok: false, file };
  }
}

const built = builtInfo();
const sourceAt = newestSource(path.join(vendored, "src"));

/** Whether the copy this repository ships carries both halves: the bundle and its stylesheet. */
function shipped() {
  try {
    return { js: fs.statSync(output).size, css: fs.statSync(stylesheet).size };
  } catch {
    return { js: 0, css: 0 };
  }
}

if (check) {
  if (!built.ok) {
    console.log("[hypercord] build:runtime: not built - the loader will say so and the vendored catalogue will not run");
    process.exit(0);
  }
  const stale = !built.shipped && sourceAt > built.at + 1000;
  console.log(
    "[hypercord] build:runtime: " +
      (stale ? "stale" : "current") +
      " - " +
      built.version +
      ", " +
      Math.round(built.bytes / 1024) +
      "kb from " +
      path.relative(root, built.file).split(path.sep).join("/") +
      (stale ? " (vendored sources are newer: run npm run build:runtime)" : "") +
      (built.shipped ? " - the committed copy; the vendored build is what npm run build:runtime refreshes" : ""),
  );
  // On its own line, because a runtime without its stylesheet is not "half built": it is a
  // runtime whose every page is drawn unstyled, which is exactly what a broken browser of
  // hundreds of plugins looks like while every count in it is correct.
  console.log(
    "[hypercord] build:runtime: the runtime's stylesheet is " +
      (shipped().css ? Math.round(shipped().css / 1024) + "kb in " + path.relative(root, stylesheet).split(path.sep).join("/") : "MISSING - run npm run build:runtime, or every one of the runtime's own pages is drawn unstyled"),
  );
  process.exit(0);
}

// Which of the vendored builds this repository ships, decided before anything is run.
//
// The file the loader injects is the *web* build: `dist/browser/browser.js` and the stylesheet
// beside it are the userscript pair this repository copies into vendor/runtime (see
// `preferred()` above), and `browser.js` is the one the client's page runs. The desktop build
// beside it - `dist/desktop/renderer.js` - is the Electron half and is not that file: running it
// here left the shipped bundle exactly as it was, so a change to the vendored sources - a
// rebrand, a fix - never reached the client no matter how many times this script was run.
// The desktop build stays as the fallback for a tree that has no web build to run.
const webBuild = path.join("scripts", "build", "buildWeb.mjs");
const desktopBuild = path.join("scripts", "build", "build.mjs");
const chosen = fs.existsSync(path.join(vendored, webBuild)) ? webBuild : desktopBuild;
if (!fs.existsSync(path.join(vendored, chosen))) {
  console.log("[hypercord] build:runtime: the vendored tree has no build to run (" + vendored + ")");
  process.exit(1);
}
if (!fs.existsSync(path.join(vendored, "node_modules"))) {
  console.log("[hypercord] build:runtime: the vendored tree has no toolchain installed (vendor/equicord/node_modules is missing): run the package manager in that directory first");
  process.exit(1);
}
if (!fs.existsSync(entry)) {
  console.log("[hypercord] build:runtime: the vendored tree has no " + entry);
  process.exit(1);
}

console.log(
  "[hypercord] build:runtime: building the vendored runtime (this is their build, in their directory: " +
    chosen.split(path.sep).join("/") +
    ")",
);
const started = Date.now();
const done = spawnSync(process.execPath, [chosen], {
  cwd: vendored,
  stdio: "inherit",
  env: { ...process.env, HYPERCORD_RUNTIME_BUILD: "1" },
});
if (done.error) {
  console.log("[hypercord] build:runtime: the build could not run: " + String(done.error.message || done.error));
  process.exit(1);
}
if (done.status !== 0) {
  console.log("[hypercord] build:runtime: the build failed with status " + String(done.status));
  process.exit(done.status || 1);
}

const builtBundle = preferred();
if (!fs.existsSync(builtBundle)) {
  console.log("[hypercord] build:runtime: the build reported success but neither " + browser + " nor " + renderer + " is there");
  process.exit(1);
}
// The build writes the bundle and its stylesheet side by side (`browser.js`, `browser.css`),
// and a browser without the second one is the failure this pair exists to prevent.
const builtCss = builtBundle.replace(/\.js$/i, ".css");
if (!fs.existsSync(builtCss)) {
  console.log("[hypercord] build:runtime: the build reported success but its stylesheet is not there (" + path.relative(root, builtCss).split(path.sep).join("/") + "): the runtime's own pages would be drawn unstyled");
  process.exit(1);
}
// and the copy this repository ships, so a release can carry the runtime without the submodule
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(builtBundle, output);
fs.copyFileSync(builtCss, stylesheet);
const after = builtInfo();
console.log(
  "[hypercord] build:runtime: " +
    after.version +
    " - " +
    Math.round(after.bytes / 1024) +
    "kb in " +
    Math.round((Date.now() - started) / 1000) +
    "s" +
    "\n[hypercord] build:runtime: shipped copy written to " +
    path.relative(root, output).split(path.sep).join("/") +
    " and " +
    path.relative(root, stylesheet).split(path.sep).join("/") +
    " (" +
    path.basename(builtBundle) +
    " + " +
    path.basename(builtCss) +
    "); the packaging step ships both files and the loader falls back to them. Restart the client to load it.",
);
