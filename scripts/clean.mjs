// language: JavaScript, file: scripts/clean.mjs
//
// Reclaim the disk the build leaves behind, and only that.
//
//   node scripts/clean.mjs            delete it, and print what was freed
//   node scripts/clean.mjs --dry-run  print the same list, delete nothing
//
// Why a script rather than a shell one-liner: every path here is regenerable output, and
// the difference between "regenerable" and "mine" is a mistake nobody notices until their
// work is gone. So each candidate is checked twice before it is removed - it must be in a
// directory the build writes, and `git ls-files` must not know it. A tracked file is never
// deleted, whatever the pattern said.
//
// What it removes:
//
//   * `dist/` entries from versions other than the one in package.json. A release matrix
//     (x64 + arm64 setup, portable, blockmaps) is ~100 MB per version, and every version
//     that was ever packed stays there; 0.3.16's tree held 1.6 GB of 0.3.4 and 0.3.5.
//   * source maps under `vendor/equicord/dist/`. The packaging step strips `!**/*.map`
//     anyway, so these never ship; they are 10 MB each and only useful inside a debugger.
//   * Python bytecode from the helper scripts (`__pycache__`), which the interpreter
//     writes itself on the next run.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.slice(2).includes("--dry-run");
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/** Every path git tracks, so a tracked file cannot be removed by a pattern. */
function tracked() {
  const done = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (done.error || done.status !== 0) return null; // no git: fall back to the directory rule only
  return new Set(String(done.stdout || "").split("\0").filter(Boolean));
}

/** The bytes a file or directory occupies, without following symlinks. */
function sizeOf(target) {
  let total = 0;
  const walk = (file) => {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const row of fs.readdirSync(file)) walk(path.join(file, row));
      return;
    }
    total += stat.size;
  };
  walk(target);
  return total;
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
}

/** The build directories this script is allowed to look inside. */
const BUILD_DIRS = ["dist", path.join("vendor", "equicord", "dist"), "release"];

function insideBuildDir(file) {
  const fromRoot = rel(file);
  return BUILD_DIRS.some((dir) => fromRoot === dir || fromRoot.startsWith(dir.replace(/\\/g, "/") + "/"));
}

const known = tracked();
const candidates = [];
const note = (why) => candidates.push(why);

// 1. installers and unpacked builds from other versions
const dist = path.join(ROOT, "dist");
const current = version();
if (current && fs.existsSync(dist)) {
  for (const row of fs.readdirSync(dist)) {
    const full = path.join(dist, row);
    // `builder-debug.yml`, `latest.yml` and a `.blockmap` beside the current version belong
    // to this version's feed and are how the updater's channel file is produced.
    if (/^(builder-debug\.yml|latest.*\.yml)$/.test(row)) continue;
    const named = /(\d+\.\d+\.\d+)/.exec(row);
    if (named && named[1] !== current) {
      note({ path: full, why: `packed for ${named[1]}, this tree is ${current}` });
    }
  }
}

// 2. the vendored build's source maps
const vendorDist = path.join(ROOT, "vendor", "equicord", "dist");
const maps = [];
const collectMaps = (at) => {
  let rows = [];
  try {
    rows = fs.readdirSync(at, { withFileTypes: true });
  } catch {
    return;
  }
  for (const row of rows) {
    const full = path.join(at, row.name);
    if (row.isDirectory()) collectMaps(full);
    else if (/\.map$/i.test(row.name)) maps.push(full);
  }
};
collectMaps(vendorDist);
for (const file of maps) note({ path: file, why: "a source map the packaging step strips" });

// 3. Python bytecode
const pycache = [];
const collectPyc = (at, depth = 0) => {
  let rows = [];
  try {
    rows = fs.readdirSync(at, { withFileTypes: true });
  } catch {
    return;
  }
  for (const row of rows) {
    if (!row.isDirectory()) continue;
    const full = path.join(at, row.name);
    if (row.name === "__pycache__") {
      pycache.push(full);
      continue;
    }
    if (row.name === "node_modules" || row.name === ".git" || depth > 3) continue;
    collectPyc(full, depth + 1);
  }
};
collectPyc(ROOT);
for (const dir of pycache) note({ path: dir, why: "bytecode the interpreter rewrites on the next run" });

/* ---- removals ------------------------------------------------------------ */

let freed = 0;
let kept = 0;
const removed = [];
for (const candidate of candidates) {
  if (!insideBuildDir(candidate.path)) {
    console.log(`skip ${rel(candidate.path)}  (not inside ${BUILD_DIRS.join(", ")})`);
    kept += 1;
    continue;
  }
  const file = rel(candidate.path);
  if (known && known.has(file)) {
    console.log(`skip ${file}  (tracked by git)`);
    kept += 1;
    continue;
  }
  const bytes = sizeOf(candidate.path);
  freed += bytes;
  removed.push({ file, bytes, why: candidate.why });
  if (!dryRun) {
    try {
      fs.rmSync(candidate.path, { recursive: true, force: true });
    } catch (error) {
      console.log(`FAIL ${file}: ${String((error && error.message) || error)}`);
      freed -= bytes;
      kept += 1;
    }
  }
}

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + " MB";
removed.sort((a, b) => b.bytes - a.bytes);
for (const row of removed) console.log(`${dryRun ? "would remove" : "removed"} ${row.file}  ${mb(row.bytes)}  (${row.why})`);
console.log(
  `\n${dryRun ? "would free" : "freed"} ${mb(freed)} across ${removed.length} path(s)` +
    (kept ? `, ${kept} left alone` : "") +
    (dryRun ? " - nothing was deleted" : ""),
);
