// language: JavaScript, file: scripts/measure.mjs
//
// The honest version of the PERF.md measurement. One sample per state is not a
// measurement: Discord's web app loads lazily and caches, so a single reading
// swings by more than the whole budget. This interleaves the two apps instead -
// baseline, Hypercord, baseline, Hypercord - so both meet the same Discord on the
// same machine on the same afternoon, discards a warm-up pair, takes N samples of
// each state and reports the MEDIAN of each, with the spread beside it.
//
//   node scripts/measure.mjs               # 5 samples, 25 s settle, 15 s window
//   node scripts/measure.mjs --samples=3 --settle=20 --window=10
//
// Hypercord itself is read in one state, idle, because that is the only state it
// has: the rail that used to be opened and closed over the client is gone, the
// settings pages live inside Discord's own settings and exist only while somebody
// is looking at them. A reading labelled "idle" is taken from the shell's own
// snapshot, whatever the shell calls it.
//
// It is deliberately slow and deliberately serial: two Electron clients loading
// Discord at once would contend for CPU and memory and produce numbers that
// describe the collision rather than either app.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const electron = path.join(
  root,
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? path.join("Electron.app", "Contents", "MacOS", "Electron") : "electron",
);

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? Number(hit.split("=")[1]) : fallback;
}

const SAMPLES = Math.max(1, arg("samples", 5));
const SETTLE = Math.max(5, arg("settle", 25));
const WINDOW = Math.max(5, arg("window", 15));

let failed = 0;
function log(line) {
  console.log(line);
}

/** One snapshot of the app as one process tree. */
function asReading(json) {
  return {
    rss: json.processes.reduce((a, p) => a + p.memMB, 0),
    cpu: json.processes.reduce((a, p) => a + p.cpu, 0),
    timers: json.timers,
    procs: json.processes.length,
  };
}

/**
 * One Hypercord run: the app idle, as { idle, label, plugins, update }.
 *
 * The shell prints one snapshot per state and this reads the idle one by name. A
 * build that prints a differently-labelled single snapshot is still read, because
 * "idle" is the only state the app has now and the label is the shell's wording,
 * not something to lose a measurement over; which label was used is reported.
 */
function runHypercord() {
  const res = spawnSync(electron, [".", "--perf=" + SETTLE], {
    cwd: root,
    encoding: "utf8",
    timeout: (SETTLE + WINDOW * 2 + 60) * 1000,
    env: { ...process.env, HYPERCORD_PERF_WINDOW: String(WINDOW * 1000) },
  });
  const text = String(res.stdout || "") + String(res.stderr || "");
  const lines = text.split("\n").filter((l) => l.includes("HYPERCORD_PERF"));
  const snapshots = lines.map((line) => {
    try {
      return JSON.parse(line.slice(line.indexOf("HYPERCORD_PERF") + "HYPERCORD_PERF".length).trim());
    } catch {
      return null;
    }
  });
  const idle = snapshots.filter(Boolean).find((json) => json.label === "idle") || snapshots.filter(Boolean)[0] || null;
  const plugins = /\[hypercord\] plugins: (\{.*\})/.exec(text);
  const update = /\[hypercord\] updates: ([^\n]*)/.exec(text);
  return { idle: idle ? asReading(idle) : null, label: idle ? String(idle.label || "") : "", plugins: plugins ? plugins[1] : "", update: update ? update[1] : "" };
}

/** One baseline run: plain Electron plus Discord web, nothing of ours. */
function runBaseline() {
  const res = spawnSync(electron, [path.join("tests", "baseline"), "--perf=" + SETTLE], {
    cwd: root,
    encoding: "utf8",
    timeout: (SETTLE + WINDOW + 60) * 1000,
    env: { ...process.env, HYPERCORD_PERF_WINDOW: String(WINDOW * 1000) },
  });
  const text = String(res.stdout || "") + String(res.stderr || "");
  const line = text.split("\n").find((l) => l.includes("BASELINE_PERF"));
  if (!line) return null;
  return asReading(JSON.parse(line.slice(line.indexOf("BASELINE_PERF") + "BASELINE_PERF".length).trim()));
}

/**
 * What the app actually weighs: the trees `package.json` packages, with the same
 * exclusions the build applies, plus the packed asar when one has been built.
 * PERF.md carried this as an estimate read off the file listings - the manifest is
 * thousands of lines, so "on the order of 300 KB" was the honest way to write it.
 * A number this script prints is the end of estimating it; the asar beside it is
 * the only figure that says what a person downloads.
 */
function shippedWeight() {
  let files = 0;
  let bytes = 0;
  const visit = (target) => {
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const entry of entries) visit(path.join(target, entry));
      return;
    }
    // the exclusions the build applies: no source maps, no TypeScript sources
    if (/\.(map|ts|tsx)$/i.test(target)) return;
    files += 1;
    bytes += stat.size;
  };
  for (const rel of ["src", "plugins", "pwa", "package.json"]) visit(path.join(root, rel));
  const asar =
    [
      "dist/win-unpacked/resources/app.asar",
      "dist/linux-unpacked/resources/app.asar",
      "dist/mac/Hypercord.app/Contents/Resources/app.asar",
      "dist/mac-arm64/Hypercord.app/Contents/Resources/app.asar",
    ]
      .map((rel) => path.join(root, rel))
      .find((file) => fs.existsSync(file)) || "";
  return {
    files,
    bytes,
    kib: Math.round(bytes / 1024),
    asar,
    asarKib: asar ? Math.round(fs.statSync(asar).size / 1024) : 0,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

const samples = { baseline: [], idle: [] };
const pairs = [];
let pluginLine = "";
let updateLine = "";
let idleLabel = "";

for (let i = 0; i <= SAMPLES; i += 1) {
  const warmup = i === 0;
  log((warmup ? "warm-up" : "sample " + i) + "/" + SAMPLES + ": baseline…");
  const base = runBaseline();
  log("                        Hypercord…");
  const hyper = runHypercord();
  if (hyper.plugins) pluginLine = hyper.plugins;
  if (hyper.update) updateLine = hyper.update;
  if (hyper.label) idleLabel = hyper.label;
  if (!base || !hyper.idle) {
    failed += 1;
    log("   MISSING a reading (baseline " + Boolean(base) + ", hypercord idle " + Boolean(hyper.idle) + ")");
    continue;
  }
  if (warmup) {
    log("   discarded (warm-up pair)");
    continue;
  }
  samples.baseline.push(base);
  samples.idle.push(hyper.idle);
  pairs.push({ base, idle: hyper.idle });
  log("   baseline " + base.rss + "MB / " + base.cpu.toFixed(2) + "% / " + base.timers + " timers | hypercord idle " + hyper.idle.rss + "MB / " + hyper.idle.cpu.toFixed(2) + "% / " + hyper.idle.timers + " timers");
}

const rss = (rows) => rows.map((r) => r.rss);
const cpu = (rows) => rows.map((r) => r.cpu);
const spread = (values) => (values.length ? Math.min(...values) + "-" + Math.max(...values) : "-");
const timers = [...samples.baseline, ...samples.idle].map((r) => r.timers);

const out = {
  at: new Date().toISOString(),
  settleSeconds: SETTLE,
  windowSeconds: WINDOW,
  samples: samples.baseline.length,
  idleLabel: idleLabel || "(none reported)",
  plugins: pluginLine,
  updater: updateLine,
  shipped: shippedWeight(),
  baseline: { rssMedian: median(rss(samples.baseline)), rssSpread: spread(rss(samples.baseline)), cpuMedian: median(cpu(samples.baseline)), cpuSpread: spread(cpu(samples.baseline).map((v) => Number(v.toFixed(2)))) },
  idle: { rssMedian: median(rss(samples.idle)), rssSpread: spread(rss(samples.idle)), cpuMedian: median(cpu(samples.idle)), cpuSpread: spread(cpu(samples.idle).map((v) => Number(v.toFixed(2)))) },
  deltaIdle: median(rss(samples.idle)) - median(rss(samples.baseline)),
  timersSeen: [...new Set(timers)].sort((a, b) => a - b),
  raw: pairs,
};

fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
fs.writeFileSync(path.join(root, "vendor", "_measure.json"), JSON.stringify(out, null, 1));

log("");
log("samples " + out.samples + " | settle " + SETTLE + "s | idle window " + WINDOW + "s | interleaved, warm-up discarded");
log("plugins: " + (pluginLine || "(none reported)") + " | updater: " + (updateLine || "(none reported)"));
log("");
log("state                  RSS median (spread)          CPU median (spread)      timers");
log("no mods, discord web   " + pad(out.baseline.rssMedian + "MB (" + out.baseline.rssSpread + ")") + pad(out.baseline.cpuMedian + "% (" + out.baseline.cpuSpread + ")") + JSON.stringify([...new Set(samples.baseline.map((r) => r.timers))]));
log("hypercord, idle        " + pad(out.idle.rssMedian + "MB (" + out.idle.rssSpread + ")") + pad(out.idle.cpuMedian + "% (" + out.idle.cpuSpread + ")") + JSON.stringify([...new Set(samples.idle.map((r) => r.timers))]));
log("");
log("added RSS, hypercord   " + (out.deltaIdle >= 0 ? "+" : "") + out.deltaIdle + " MB");
log("snapshot label read    " + out.idleLabel);
log("timers seen in any state: " + JSON.stringify(out.timersSeen));
log("");
const weight = out.shipped;
log("shipped: " + weight.files + " file(s), " + weight.kib + " KiB" + (weight.asar ? " | packed asar " + weight.asarKib + " KiB" : " | no packed build to compare"));
log("");
log("written: vendor/_measure.json");
process.exit(failed === 0 ? 0 : 1);

function pad(text, width = 26) {
  const value = String(text);
  return value + " ".repeat(Math.max(1, width - value.length));
}
