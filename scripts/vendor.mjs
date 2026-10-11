// language: JavaScript, file: scripts/vendor.mjs
//
// The fork step, on the record and repeatable. Run it from hypercord/:
//
//   node scripts/vendor.mjs            # merge, rebrand, write the catalogue
//   node scripts/vendor.mjs --check    # report only, change nothing
//
// What it does, in order:
//
//   1. takes Equicord's tree as the build base (it already contains Vencord's
//      core) and merges Vencord's plugin folders into it - a plugin Equicord
//      does not have is added, and where both ship the same folder Equicord
//      wins, which is what we chose;
//   2. rebrands the display strings only. Operational identifiers stay exactly
//      as upstream has them (`Vencord` the renderer global, the `vencord:` and
//      `equicord:` protocols, the `~plugins` virtual import, source-map URLs):
//      renaming those breaks plugin imports, themes and the injector;
//   3. writes plugins/manifest.json - the catalogue our plugin host reads. It is
//      metadata only, so browsing hundreds of plugins never imports plugin code;
//   4. records provenance (both commit SHAs) so attribution is checkable, and
//      never touches the LICENSE files or upstream credit lines.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const vendor = path.join(root, "vendor");
const core = path.join(vendor, "equicord"); // the build base
const upstream = path.join(vendor, "vencord"); // merged in, never overwritten
const checkOnly = process.argv.includes("--check");

const log = (line) => console.log(line);
let problems = 0;

function fail(line) {
  problems += 1;
  console.log("FAIL " + line);
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function commitOf(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/* ---- 1. merge: Vencord's plugins that Equicord does not have ------------- */

if (!exists(core)) fail("no vendored core at vendor/equicord - clone it first");
if (!exists(upstream)) fail("no vendored upstream at vendor/vencord - clone it first");

let added = 0;
let alreadyThere = 0;
if (!problems) {
  for (const [from, to] of [
    [path.join(upstream, "src", "plugins"), path.join(core, "src", "plugins")],
    [path.join(upstream, "src", "userplugins"), path.join(core, "src", "userplugins")],
  ]) {
    if (!exists(from)) continue;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const target = path.join(to, entry.name);
      if (exists(target)) {
        alreadyThere += 1; // Equicord's version wins
        continue;
      }
      if (!checkOnly) fs.cpSync(path.join(from, entry.name), target, { recursive: true });
      log("  + " + entry.name + " (from Vencord)");
      added += 1;
    }
  }
  log("merge: " + added + " folder(s) added from Vencord, " + alreadyThere + " kept from Equicord");
}

/* ---- 2. rebrand: display strings only ------------------------------------ */

// Every entry is a string a person reads. Nothing in this list is an identifier
// the build depends on, and no LICENSE or credit line is touched.
const REBRAND = [
  ['"name": "equicord"', '"name": "hypercord"'],
  ["Equicord QuickCSS Editor", "Hypercord QuickCSS Editor"],
  ["About Equicord", "About Hypercord"],
  ["Update Equicord", "Update Hypercord"],
  ["<h1>Equicord</h1>", "<h1>Hypercord</h1>"],
  ["latest version of Equicord", "latest version of Hypercord"],
  ["update for Equicord", "update for Hypercord"],
  ["relaunching Equicord", "relaunching Hypercord"],
  ["updating Equicord", "updating Hypercord"],
  ["Equicord Updater", "Hypercord Updater"],
  ["Equicord Installer", "Hypercord Installer"],
  ["[Equicord]", "[Hypercord]"],
  ["Equicord Host Permissions", "Hypercord Host Permissions"],
];

/**
 * A whole-word mention. `retainEquicord`, `generateEquicordPluginJson` and
 * `--equicord` are identifiers the core's own code and scripts use - renaming
 * them is not rebranding, it is breaking the build - while `[Equicord] Rollback
 * step failed` is a string a person reads and therefore ours to change.
 */
const MENTION = /\bEquicord\b/;

const TOUCH = [
  path.join(core, "package.json"),
  path.join(core, "src", "main", "about.html"),
  path.join(core, "src", "main", "trayMenu.ts"),
  path.join(core, "src", "main", "ipcMain.ts"),
  path.join(core, "src", "main", "index.ts"),
  path.join(core, "src", "main", "hostUpdateHook.ts"),
  path.join(core, "src", "main", "themes", "index.ts"),
  path.join(core, "src", "main", "utils", "constants.ts"),
];

/**
 * Lines that legitimately keep saying Equicord: links, the credit list, the
 * licence line, the data directory and anything that is an identifier rather
 * than something a person reads. Attribution is not rebrandable - it is the
 * GPL's condition - so these are left, on purpose, and the audit says so.
 */
const KEEP = [
  /https?:\/\//,
  /git\+/,
  /EquicordData/,
  /equicord:/i,
  /Devs\./,
  /GPL/,
  /licensed under/i,
  /Suncord/,
  /Vendetta/,
  /fork of/i,
  /@equicord\//i,
];

// about.html is the About/credits page: its whole job is to name upstream, so the
// only thing rebranded in it is the product heading, and it is exempt from the
// display-string audit for that reason.
const AUDIT_EXEMPT = [path.join(core, "src", "main", "about.html")];

/** Every file under a directory, without pulling in node_modules. */
function walk(dir, out = []) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The rebrand, decided line by line rather than file by file.
 *
 * A hand-picked list of files was the first version of this, and it was wrong: a
 * log prefix in a file nobody listed kept saying Equicord forever, and every
 * upstream release would have meant another entry. What is *ours to change* is a
 * line a person reads; what is not is a link, a credit, the licence, a data path
 * somebody's install already uses, or an identifier the core's own code and
 * scripts call. So a line mentioning upstream is rewritten only when it is not
 * one of those, and the audit below then checks that the rebrand changed display
 * strings and nothing else.
 */
function rebrandText(text) {
  let changed = 0;
  const lines = text.split("\n").map((line) => {
    if (!MENTION.test(line)) return line;
    if (KEEP.some((pattern) => pattern.test(line))) return line;
    let out = line;
    for (const [find, repl] of REBRAND) out = out.split(find).join(repl);
    // still naming upstream on a line that is ours means a whole-word display
    // string: `[Equicord] Starting up...`, a window title, a menu label. Names
    // like retainEquicord and generateEquicordPluginJson never reach here, because
    // there is no word boundary to match.
    out = out.replace(/\bEquicord\b/g, "Hypercord");
    if (out !== line) changed += out.split("Equicord").length - 1 === 0 ? 1 : 1;
    return out;
  });
  return { text: lines.join("\n"), changed };
}

// Only source and page files are eligible. LICENSE, LICENSE.md, README.md and the
// rest of the upstream documentation are never opened, which is what keeps the
// GPL attribution intact by construction as well as by audit.
const ELIGIBLE = [path.join(core, "package.json"), ...walk(path.join(core, "src", "main"))];

let rewritten = 0;
let hits = 0;
let changedTotal = 0;
const after = new Map();
if (!problems) {
  for (const file of ELIGIBLE) {
    const before = fs.readFileSync(file, "utf8");
    const out = rebrandText(before);
    after.set(file, out.text);
    changedTotal += out.changed;
    if (out.text !== before) {
      if (!checkOnly) fs.writeFileSync(file, out.text);
      rewritten += 1;
      const shown = path.relative(root, file).split(path.sep).join("/");
      log("  ~ " + shown + " (" + String(out.changed) + " line(s))");
      hits += out.changed;
    }
  }
  log("rebrand: " + hits + " display line(s) in " + rewritten + " of " + ELIGIBLE.length + " source file(s)");

  // The audit is what makes "rebranded" checkable instead of asserted: after the
  // rewrite, every remaining mention of upstream is either kept on purpose (a
  // link, a credit, a data path, an identifier) or it is a display string somebody
  // will read in Hypercord's own UI, and a display string that still says
  // Equicord is a failure of this step, not a matter of taste.
  // The audit reads what the tree WILL contain, not what is on disk - in --check
  // mode the disk still holds the un-rebranded text, and auditing that reported
  // lines the rebrand was about to fix.
  const left = [];
  let kept = 0;
  for (const file of ELIGIBLE) {
    if (AUDIT_EXEMPT.includes(file)) continue;
    for (const line of (after.get(file) || "").split("\n")) {
      if (!MENTION.test(line)) continue;
      if (KEEP.some((pattern) => pattern.test(line))) {
        kept += 1;
        continue;
      }
      left.push(path.relative(root, file).split(path.sep).join("/") + ": " + line.trim().slice(0, 120));
    }
  }
  log("rebrand audit: " + kept + " line(s) keep naming upstream on purpose (links, credits, licence, data paths, identifiers)");
  log("rebrand audit: " + ELIGIBLE.length + " file(s) under src/main + package.json checked for display strings");
  for (const line of left.slice(0, 12)) fail("a display string still says Equicord - " + line);
  if (left.length > 12) fail("...and " + (left.length - 12) + " more");

  // And the other half of the audit: the rebrand must not have overreached. A
  // check that the identifiers and the licence survived is what makes "display
  // strings only" a fact about the tree rather than a claim about this script.
  const identifiers = ["retainEquicord", "generateEquicordPluginJson", "--equicord", "EquicordData"];
  const whole = [...ELIGIBLE, path.join(core, "src", "api", "Themes.ts")].map((file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }).join("\n");
  for (const name of identifiers) {
    const present = whole.includes(name);
    if (!present) log("rebrand audit: identifier " + name + " is not in this version (nothing to preserve)");
  }
  const license = path.join(core, "LICENSE");
  if (exists(license)) {
    const text = fs.readFileSync(license, "utf8");
    if (!/GNU GENERAL PUBLIC LICENSE/i.test(text)) fail("the vendored LICENSE is not the GPL - attribution is broken");
  } else {
    fail("the vendored core has no LICENSE at " + path.relative(root, license));
  }
  const preserved = ["retainEquicord", "generateEquicordPluginJson"]
    .filter((name) => whole.includes(name))
    .length;
  log("rebrand audit: " + preserved + " upstream identifier(s) still present untouched, licence intact");
}

/* ---- 3. the catalogue our plugin host reads ------------------------------ */

const SET = { name: "Hyper", description: "the Hypercord set, on by default" };

// Only these are on the first time: everything else in the catalogue is one
// click away, present and discoverable, and costs nothing while it is off.
const HYPER_ON = new Set(["hyperBridge", "hyperRail", "hyperAccounts", "hyperPanes", "hypercordRPC"]);

// Upstream writes `authors: [Devs.Ven, Devs.AutumnVN]`, so the names live in the
// Devs map rather than in the plugin. Resolve them there, and keep the raw
// reference too: attribution must be checkable, never guessed.
let devMap = null;
function devs() {
  if (devMap) return devMap;
  devMap = new Map();
  const file = path.join(core, "src", "utils", "constants.ts");
  if (exists(file)) {
    const src = fs.readFileSync(file, "utf8");
    // scoped to the Devs object itself: the file holds other maps whose keys
    // repeat (and would otherwise rename people)
    const start = src.indexOf("export const Devs");
    const end = start === -1 ? -1 : src.indexOf("\n});", start);
    const block = start === -1 ? "" : src.slice(start, end === -1 ? undefined : end);
    for (const hit of block.matchAll(/(\w+):\s*\{\s*name:\s*"([^"]+)",\s*id:\s*(\d+)n/g)) {
      devMap.set(hit[1], { name: hit[2], id: hit[3] });
    }
  }
  return devMap;
}

function metaOf(pluginDir) {
  const files = ["index.ts", "index.tsx", "index.js", "index.mjs"].map((f) => path.join(pluginDir, f));
  const entry = files.find((f) => exists(f));
  if (!entry) return null;
  const src = fs.readFileSync(entry, "utf8");
  const pick = (key) => {
    const hit = new RegExp(key + ':\\s*"([^"]+)"').exec(src);
    return hit ? hit[1] : "";
  };
  const authors = [];
  const authorRefs = [];
  const authorBlock = /authors:\s*\[([\s\S]*?)\]/.exec(src);
  if (authorBlock) {
    const block = authorBlock[1];
    for (const name of block.matchAll(/name:\s*"([^"]+)"/g)) authors.push(name[1]);
    for (const ref of block.matchAll(/Devs\.(\w+)/g)) {
      authorRefs.push("Devs." + ref[1]);
      const known = devs().get(ref[1]);
      if (known && !authors.includes(known.name)) authors.push(known.name);
    }
  }
  const id = path.basename(pluginDir);
  const name = pick("name") || id;
  return {
    id,
    name,
    description: pick("description"),
    authors,
    authorRefs,
    version: "",
    entry: path.relative(root, entry).split(path.sep).join("/"),
    built: false,
    builtin: true,
    deps: [],
    defaultOn: HYPER_ON.has(id),
    source: id.startsWith("hyper") ? "hypercord" : "upstream",
    defaultOnSet: HYPER_ON.has(id) ? SET.name : "",
  };
}

// Upstream keys its plugin object by plugin name, and scans src/plugins before
// src/equicordplugins - so a later folder wins a collision at runtime. The
// catalogue mirrors that exactly (Equicord wins), and our own plugins are last
// word on our own ids.
function collect(dir, out, rank) {
  if (!exists(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const meta = metaOf(path.join(dir, entry.name));
    if (!meta) continue;
    const seen = out.get(meta.id);
    if (seen && seen.rank > rank) continue;
    out.set(meta.id, { ...meta, rank });
  }
  return out;
}

/**
 * The theme half of the catalogue. Hypercord's own theme system is `src/themes.js`
 * (local files, an online theme fetched once at install, quick CSS, one injection
 * point), and the vendored core keeps its own theme code and the theme store, so
 * both are recorded here: what the client ships, and where upstream's copy lives
 * for attribution and for the day the core is built.
 */
function themeSection(entries) {
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const themePlugins = entries
    .filter((p) => /theme/i.test(p.id) || /theme/i.test(p.name))
    .map((p) => ({ id: p.id, name: p.name, source: p.source }));
  const vendored = [
    path.join(core, "src", "api", "Themes.ts"),
    path.join(core, "src", "main", "themes", "index.ts"),
    path.join(core, "src", "main", "themes", "LICENSE"),
  ]
    .filter((file) => exists(file))
    .map((file) => rel(file));
  return {
    note: "CSS only: a theme is text injected at one point and can never execute",
    injection: "one <style> element (id hypercord-theme), replaced whole by src/preload.cjs",
    implementation: "src/themes.js",
    sources: [
      { id: "local", description: "a .theme.css file installed into the user's themes folder, read only while enabled" },
      { id: "online", description: "a theme fetched once, at the moment it is installed, then read from disk - never on a timer" },
      { id: "quick", description: "one quick-CSS string edited in the manager window" },
    ],
    refuses: ["</style>", "<script", "@import", "javascript:", "expression(", "behavior:"],
    vendored,
    themePlugins,
  };
}

if (!problems) {
  const plugins = new Map();
  collect(path.join(core, "src", "plugins"), plugins, 1); // Vencord's, as merged
  collect(path.join(core, "src", "equicordplugins"), plugins, 2); // Equicord's own wins
  collect(path.join(root, "plugins"), plugins, 3); // ours, last word on our own ids
  // ours live one level down, under plugins/hyper/<id>, so the Hyper set is
  // itself a directory that can be shipped, replaced or removed as one thing
  collect(path.join(root, "plugins", "hyper"), plugins, 3);

  const entries = [...plugins.values()].map(({ rank, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    name: "Hypercord",
    generatedAt: new Date().toISOString(),
    note: "metadata only: the plugin manager reads this, never plugin code",
    provenance: { core: "Equicord", coreCommit: commitOf(core), merged: "Vencord", mergedCommit: commitOf(upstream) },
    themes: themeSection(entries),
    defaults: {
      set: SET.name,
      description: SET.description,
      // the intent, whether or not those plugins are vendored yet: everything
      // else in the catalogue is available and off
      enabled: [...HYPER_ON],
      present: entries.filter((p) => p.defaultOn).map((p) => p.id),
    },
    plugins: entries,
  };
  if (!checkOnly) {
    fs.mkdirSync(path.join(root, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugins", "manifest.json"), JSON.stringify(manifest, null, 1));
  }
  const on = manifest.plugins.filter((p) => p.defaultOn).length;
  log("catalogue: " + manifest.plugins.length + " plugin(s), " + on + " on by default");
  if (!manifest.plugins.length) fail("the catalogue came out empty - is vendor/equicord cloned?");
  if (on > 6) fail("more than six plugins default on - that is not the Hypercord set");
}

console.log("");
console.log(problems ? "VENDOR FAILED (" + problems + " problem(s))" : "VENDOR OK" + (checkOnly ? " (check only, nothing written)" : ""));
process.exit(problems ? 1 : 0);
