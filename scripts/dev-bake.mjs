// language: JavaScript, file: scripts/dev-bake.mjs
//
// Re-bake a patched client's asset bundle. Run it from hypercord/:
//
//   npm run dev:bake               # bake every patched Discord that was found
//   npm run dev:bake -- --dry-run  # say what would change, write nothing
//
// Why this exists: the pieces Hypercord injects into Discord's own window - the
// stylesheet, the token option beside the login form, and the settings pages with their
// scoped stylesheet and their script - are baked into `resources/app/hypercord.json` at
// patch time (src/patcher.js writes it, src/loader.cjs reads it). Editing src/panes.js
// therefore reaches a running client only once the patch runs again, and re-patching a
// client to pick up a paragraph of CSS is the kind of step people stop doing and then
// debug for an hour. This writes the one file that has to change.
//
// What it does *not* touch is the point of it: the archive, the entry point, the
// manifest's record of when it was patched and every other key in it are left exactly as
// they are. Only `assets` is replaced, with the files this repository has right now.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listInstalls } from "../src/patcher.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The five files a patched client is given, keyed the way the manifest, the loader and
// src/host.js key them. One list, so a key cannot be spelled differently here than it is
// read there - which would bake a client whose pages are missing without anything saying
// so.
const ASSETS = [
  ["css", "injected.css"],
  ["promptHtml", "prompt.html"],
  ["panesHtml", "panes.html"],
  ["panesCss", "panes.css"],
  ["panesJs", "panes.js"],
];

function fail(reason) {
  console.error("[hypercord] dev:bake: " + reason);
  process.exit(1);
}

function usage() {
  console.log(
    [
      "Bake the current src files into a patched Discord client, so an edit reaches it",
      "without patching again.",
      "",
      "  node scripts/dev-bake.mjs [--dry-run] [--help]",
      "",
      "  --dry-run  report which assets are stale and write nothing",
      "  --help     this text",
      "",
      "The manifest is found through src/patcher.js, so every platform it can patch is a",
      "platform this can bake: the Windows app-<version> folders, the macOS bundles and",
      "the Linux config folders, package installs and Flatpak deployments.",
    ].join("\n"),
  );
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  usage();
  process.exit(0);
}
const dryRun = argv.includes("--dry-run");
const unknown = argv.filter((one) => one !== "--dry-run");
if (unknown.length) fail("unknown argument " + unknown[0] + " (try --help)");

/* ---- the assets, read whole --------------------------------------------- */

// Read before anything is written: a bake that failed halfway through the five files
// would leave a client whose pages are half of one version and half of another.
const assets = {};
const sizes = [];
for (const [key, file] of ASSETS) {
  const full = path.join(ROOT, "src", file);
  let text = "";
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (err) {
    fail("cannot read src/" + file + ": " + String((err && err.message) || err));
  }
  if (!text.length) fail("src/" + file + " is empty: baking it would empty that asset in the client");
  assets[key] = text;
  sizes.push([key, Buffer.byteLength(text)]);
}

/* ---- the patched clients ------------------------------------------------- */

// The manifest only exists in a client this repository patched, and its `tool` says
// whose it is: a `resources/app` directory somebody else put there is not ours to write
// into, and is refused by not being collected at all.
const installs = listInstalls();
const patched = [];
for (const install of installs) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(install.manifest, "utf8")) || null;
  } catch {
    manifest = null;
  }
  if (manifest && manifest.tool === "hypercord") patched.push({ install, manifest });
}
if (!patched.length) {
  fail(
    installs.length
      ? "none of the " + installs.length + " Discord install(s) found is patched: run Hypercord once against an install so it patches it, then bake"
      : "no Discord install found, so there is nothing to bake",
  );
}

/* ---- write --------------------------------------------------------------- */

console.log("[hypercord] dev:bake: " + ASSETS.length + " asset(s) from src/");
for (const [key, bytes] of sizes) console.log("  " + key.padEnd(10) + bytes + " bytes");

let written = 0;
let current = 0;
for (const { install, manifest } of patched) {
  const before = manifest.assets && typeof manifest.assets === "object" ? manifest.assets : {};
  const stale = ASSETS.filter(([key]) => before[key] !== assets[key]).map(([key]) => key);
  if (!stale.length) {
    current += 1;
    console.log("[hypercord] dev:bake: already current: " + install.manifest);
    continue;
  }
  const where = install.channelName + " " + install.version + " (" + install.channel + ")";
  if (dryRun) {
    console.log("[hypercord] dev:bake: would write " + install.manifest + " - " + where + ", stale: " + stale.join(", "));
    continue;
  }
  // only `assets` changes: the record of the patch itself stays as it was, because this
  // is not a patch
  const next = { ...manifest, assets };
  try {
    fs.writeFileSync(install.manifest, JSON.stringify(next, null, 1) + "\n");
  } catch (err) {
    fail("could not write " + install.manifest + ": " + String((err && err.message) || err));
  }
  written += 1;
  console.log("[hypercord] dev:bake: wrote " + install.manifest + " - " + where + ", changed: " + stale.join(", "));
}

if (dryRun) console.log("[hypercord] dev:bake: dry run: " + (patched.length - current) + " client(s) would be baked, " + current + " already current");
else console.log("[hypercord] dev:bake: " + written + " client(s) baked, " + current + " already current - restart the client to see it");
