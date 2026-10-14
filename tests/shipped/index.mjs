// language: JavaScript, file: tests/shipped/index.mjs
//
// What this client actually ships, all of it, checked as one thing:
//
//   node tests/shipped/index.mjs
//
// The other suites test a mechanism against fixtures - the plugin host against five made-up
// plugins, the themes against two made-up stylesheets. That is how a mechanism should be tested,
// and it is exactly why this file exists: a mechanism that passes its fixtures says nothing
// about the catalogue in plugins/manifest.json, the five plugins this client runs in its own
// process, or the example plugin and theme it hands people to copy. Those are what a release
// carries, so those are what this suite walks - the real manifest, the real modules, the real
// examples, and nothing substituted.
//
// What it can and cannot check is worth being exact about. The 371 vendored entries are
// TypeScript sources that reach Discord's internals through the webpack runtime that only exists
// inside a loaded page: nothing in this process can run them, and pretending otherwise would be
// a test that passes while proving nothing. So for those, what is checked is that the catalogue
// is complete and consistent - every entry has the file it names, every dependency exists, the
// default set and the vendored theme plugins are all entries - and that the bundle the client
// actually injects was built from this tree.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginHost } from "../../src/plugin-host.js";
import { validateAddon } from "../../plugins/index.js";
import { nativeTheme } from "../../themes/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}
/** What a check could not answer here, said rather than passed over. */
const note = (line) => console.log("note  " + line);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-shipped-"));
const manifest = JSON.parse(read("plugins/manifest.json"));
const catalogue = Array.isArray(manifest.plugins) ? manifest.plugins : [];

/* ---- 1. the catalogue: every entry is one this tree can account for ------ */

// Two halves, because the catalogue names files in two places. The entries the client owns are
// files in this repository and are checked wherever this suite runs. The rest point into
// `vendor/equicord`, the fork a developer clones - and a *release* checkout does not carry it: the
// fork's build is what travels, in `vendor/runtime`, which is tracked (see the note at the top of
// scripts/build_runtime.mjs, which says the same thing about the packaging step). So where the
// fork is not here, the vendored entries are checked for everything this tree can answer for them
// and the half that needs the fork is *said* rather than counted as a pass.
const FORK = path.join(root, "vendor", "equicord", "src");
const forkHere = fs.existsSync(FORK);
const VENDORED = "vendor/equicord/";

{
  const seen = new Set();
  const duplicates = [];
  const ours = [];
  const vendored = [];
  for (const entry of catalogue) {
    const id = String(entry && entry.id);
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
    const rel = String(entry.entry);
    (rel.startsWith(VENDORED) ? vendored : ours).push({ id: id, rel: rel });
  }
  const missingOurs = ours.filter((one) => !exists(one.rel));
  const missingVendored = vendored.filter((one) => !exists(one.rel));
  ok(
    "every entry the client owns names a file this tree has",
    catalogue.length > 300 && ours.length > 0 && missingOurs.length === 0,
    missingOurs.length ? missingOurs.slice(0, 5).map((one) => one.id + " -> " + one.rel).join(", ") : ours.length + " of " + catalogue.length + " entries are this repository's own",
  );
  if (forkHere) {
    ok(
      "and every vendored entry names a file the fork in this tree has",
      missingVendored.length === 0,
      missingVendored.slice(0, 5).map((one) => one.id + " -> " + one.rel).join(", "),
    );
  } else {
    note(
      "the vendored fork is not in this tree, so " +
        vendored.length +
        " vendored entries were not checked against it: a release checkout does not carry it (its build travels in vendor/runtime), so clone vendor/equicord and vendor/vencord, run `npm run vendor`, and run this suite again to check them",
    );
  }
  ok("no two entries share an id", duplicates.length === 0, duplicates.slice(0, 5).join(", "));

  const unresolved = [];
  for (const entry of catalogue) {
    for (const dep of Array.isArray(entry.deps) ? entry.deps : []) {
      if (!seen.has(String(dep))) unresolved.push(entry.id + " -> " + dep);
    }
  }
  ok("every dependency is another entry, so nothing is enabled into a missing plugin", unresolved.length === 0, unresolved.slice(0, 5).join(", "));

  const defaults = Array.isArray(manifest.defaults && manifest.defaults.enabled) ? manifest.defaults.enabled.map(String) : [];
  const present = Array.isArray(manifest.defaults && manifest.defaults.present) ? manifest.defaults.present.map(String) : [];
  ok(
    "the default set is part of the catalogue, and every member of it is present",
    defaults.length > 0 && defaults.every((id) => seen.has(id)) && defaults.every((id) => present.includes(id)),
    JSON.stringify({ defaults: defaults, present: present }),
  );
  const themed = (manifest.themes && Array.isArray(manifest.themes.themePlugins) ? manifest.themes.themePlugins : []).map((one) => String(one.id));
  ok(
    "every theme plugin the manifest names is an entry",
    themed.length > 0 && themed.every((id) => seen.has(id)),
    themed.filter((id) => !seen.has(id)).join(", "),
  );
  // The provenance is not decoration: it is how a release can say which upstream this tree was
  // taken from, and the rebrand pass leans on the licence that travels with it.
  ok(
    "the catalogue records where the vendored core came from",
    Boolean(manifest.provenance && manifest.provenance.core && manifest.provenance.coreCommit),
    JSON.stringify(manifest.provenance),
  );
}

/* ---- 2. the plugins this client runs itself ------------------------------ */

// The host runs what it can load. Everything else in the catalogue is the built runtime's, and
// the split is the host's own answer - `owner` - rather than a guess made here.
const stateFile = path.join(tmp, "plugins.state.json");
const notes = [];
const sent = [];
const beefStub = {
  state: () => ({ ready: false, categories: [], declared: [], dropped: [], remapped: {}, generations: 0, reloadMs: 0, source: "", lastError: "", backup: null, banks: 0, log: 0 }),
  reload: () => ({ ok: true }),
  install: () => ({ ok: true }),
  rollback: () => ({ ok: true }),
  inspect: () => ({ ok: true, read: "" }),
  last: () => ({ ok: true }),
};
const ctx = {
  // The client always builds an api, and with no control server configured it answers every
  // request with that, rather than being absent - which is the shape a plugin meets in the wild.
  api: { base: "", request: async () => ({ ok: false, status: 0, error: "no control server configured" }), session: async () => ({ ok: false, status: 404, error: "no route" }) },
  ui: { notify: (title, body) => notes.push([title, body]), send: (kind, payload) => sent.push([kind, payload]) },
  local: { beef: beefStub },
};
const hostFor = (file = stateFile) => new PluginHost({ root, manifestPath: path.join(root, "plugins", "manifest.json"), stateFile: file, ctx, log: () => {} });

{
  const host = hostFor();
  host.load();
  ok("the catalogue the host loads is the catalogue on disk", host.meta.size === catalogue.length, host.meta.size + " vs " + catalogue.length);

  const ours = host.list().filter((entry) => entry.owner === "host");
  const ids = ours.map((entry) => entry.id).sort();
  const defaults = (manifest.defaults.enabled || []).map(String).sort();
  ok(
    "the plugins this process runs are exactly the manifest's own set",
    JSON.stringify(ids) === JSON.stringify(defaults) && ids.length > 0,
    JSON.stringify(ids),
  );
  ok(
    "a first run starts with that set enabled, and nothing else",
    JSON.stringify(host.state.enabled.slice().sort()) === JSON.stringify(defaults),
    JSON.stringify(host.state.enabled),
  );
  // Every plugin of ours is enabled by default, so a plugin that is never started is either a
  // bug in the manifest or a plugin nobody can reach - and both are worth failing on.
  ok(
    "no plugin of ours is left out of the set it claims to belong to",
    ours.every((entry) => entry.defaultOn === true),
    JSON.stringify(ours.map((entry) => [entry.id, entry.defaultOn])),
  );
}

/* ---- 3. every one of them starts, is what it says, and stops ------------- */

// The documented surface of each plugin of ours: the helpers the shell and the pages call by
// name. A plugin that starts without the function its page calls is a plugin whose page is
// broken while every switch in the manager says it is on, which is the failure this checks.
const SURFACE = {
  hyperPanes: ["open", "available", "last"],
  hyperBridge: ["check", "announce", "state"],
  hyperAccounts: ["refresh", "login", "state"],
  hypercordRPC: ["publish", "state"],
  hyperBeef: ["state", "section", "refresh", "reload", "install", "rollback", "inspect", "last", "start", "setSetting", "via"],
};

for (const id of (manifest.defaults.enabled || []).map(String)) {
  const one = path.join(tmp, "one-" + id + ".json");
  const host = hostFor(one);
  host.load();
  const started = await host.enable(id);
  const entry = host.list().find((row) => row.id === id) || {};
  ok(
    id + " starts, and says so without being marked broken",
    started.ok === true && host.running.has(id) && entry.running === true && entry.enabled === true && entry.broken === "",
    JSON.stringify({ started: started, running: entry.running, enabled: entry.enabled, broken: entry.broken }),
  );
  const handle = host.handle(id);
  const wanted = SURFACE[id] || [];
  ok(
    id + " hands the shell every helper its own pages call",
    handle !== null && wanted.every((name) => typeof handle[name] === "function"),
    wanted.filter((name) => !handle || typeof handle[name] !== "function").join(", "),
  );
  ok(
    id + " declares the settings the manager shows, each one a key and a type it can render",
    Array.isArray(entry.settings) && entry.settings.length > 0 && entry.settings.every((field) => field && typeof field.key === "string" && ["boolean", "string", "number"].includes(field.type)),
    JSON.stringify(entry.settings),
  );
  const stopped = await host.disable(id);
  ok(
    id + " stops, and leaves nothing of itself behind",
    stopped.ok === true && host.handle(id) === null && host.running.size === 0 && host.timers.size === 0 && host.cleanups.size === 0 && host.modules.size === 0,
    JSON.stringify({ stopped: stopped, handle: host.handle(id), running: host.running.size, timers: host.timers.size, cleanups: host.cleanups.size }),
  );
}

/* ---- 4. the whole set at once, and nothing left running after ----------- */

{
  const host = hostFor(path.join(tmp, "set.json"));
  host.load();
  const status = await host.startEnabled();
  const defaults = (manifest.defaults.enabled || []).map(String);
  ok(
    "the whole set starts together, every member running",
    defaults.every((id) => status.running.includes(id)) && host.broken.size === 0 && status.catalogue === catalogue.length,
    JSON.stringify({ running: status.running, broken: [...host.broken.keys()] }),
  );
  const report = await host.stopAll();
  ok(
    "and stopping the client takes every one of them down with it",
    report.stopped.length === defaults.length && report.failed.length === 0 && host.running.size === 0 && host.timers.size === 0 && host.cleanups.size === 0,
    JSON.stringify({ stopped: report.stopped, failed: report.failed, timers: host.timers.size }),
  );
}

/* ---- 5. what the plugins announce is what the sheet has ----------------- */

{
  // The pages a plugin offers are announced, and src/preload.cjs turns the announcement into a
  // row in Discord's settings. Two lists that have to agree: a page the sheet does not have is a
  // row that opens nothing, and a page the sheet has but nothing announces is unreachable.
  const host = hostFor(path.join(tmp, "panes.json"));
  host.load();
  await host.enable("hyperPanes");
  const announced = sent.filter(([kind]) => kind === "panes:views").at(-1);
  const views = announced ? announced[1] : [];
  const sheet = [...read("src/panes.html").matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
  ok(
    "the settings pages the panes plugin announces are the pages the sheet has, in the same order",
    JSON.stringify(views) === JSON.stringify(sheet) && sheet.length > 0,
    JSON.stringify({ announced: views, sheet: sheet }),
  );
  const pane = host.handle("hyperPanes");
  const before = sent.length;
  const picked = pane.open("beef");
  const pushed = sent.slice(before).find(([kind]) => kind === "panes:view");
  ok(
    "opening one of them says which, and remembers it",
    picked === "beef" && Boolean(pushed) && pushed[1] === "beef" && pane.last() === "beef" && host.settingsFor("hyperPanes").lastView === "beef",
    JSON.stringify({ picked: picked, pushed: pushed, last: pane.last(), stored: host.settingsFor("hyperPanes") }),
  );
  ok(
    "a page the sheet does not have is refused rather than opened on nothing",
    pane.open("nonsense") === "beef" && pane.last() === "beef",
    JSON.stringify({ last: pane.last() }),
  );
  await host.stopAll();
}

/* ---- 6. with no control server, every plugin still answers --------------- */

{
  // The state the machine in front of this client is usually in. What must not happen is a
  // plugin that throws because the server is missing: the sheet reads these answers to draw its
  // pages, and a rejected promise in the main process is a crash path, not an empty page.
  const host = hostFor(path.join(tmp, "offline.json"));
  host.load();
  await host.enable("hyperBridge");
  await host.enable("hyperAccounts");
  await host.enable("hypercordRPC");
  await host.enable("hyperBeef");
  const bridge = await host.handle("hyperBridge").check();
  ok(
    "the link says it is unconfigured rather than down, because that is what it is",
    bridge.state === "unconfigured" && /no control server/.test(bridge.reason || ""),
    JSON.stringify(bridge),
  );
  const accounts = await host.handle("hyperAccounts").refresh();
  const refused = await host.handle("hyperAccounts").login("someone");
  ok(
    "the accounts list answers empty and says why, and a sign-in is refused rather than thrown",
    Array.isArray(accounts.accounts) && accounts.accounts.length === 0 && refused.ok === false && String(refused.error || "").length > 0,
    JSON.stringify({ accounts: accounts, refused: refused }),
  );
  const hello = await host.handle("hypercordRPC").publish();
  ok(
    "a client with nowhere to say hello to is not told it failed",
    hello.error === "" && hello.at > 0 && hello.skipped !== true,
    JSON.stringify(hello),
  );
  const beef = host.handle("hyperBeef").section();
  ok(
    "beef's section is drawn from the client's own engine and names every action it documents",
    beef && beef.id === "beef" && Array.isArray(beef.actions) && beef.actions.length >= 7 && beef.actions.every((action) => action.id && action.label && action.route),
    JSON.stringify(beef && beef.actions && beef.actions.map((action) => action.id)),
  );
  ok(
    "and it says which of the two paths answered",
    host.handle("hyperBeef").via() === "local engine",
    String(host.handle("hyperBeef").via()),
  );
  await host.stopAll();
}

/* ---- 7. the examples this client ships are valid addons ----------------- */

{
  const examplePlugins = fs.readdirSync(path.join(root, "plugins", "examples")).map((name) => ["plugins/examples/" + name, name]);
  const exampleThemes = fs.readdirSync(path.join(root, "themes", "examples")).map((name) => ["themes/examples/" + name, name]);
  const judged = [...examplePlugins, ...exampleThemes].map(([rel, name]) => {
    try {
      const { manifest: parsed, hasHooks } = validateAddon(read(rel), name);
      return { rel: rel, ok: true, id: parsed.id, kind: parsed.kind, hasHooks: hasHooks, parsed: parsed };
    } catch (err) {
      return { rel: rel, ok: false, error: String((err && err.message) || err) };
    }
  });
  ok(
    "every example addon this client ships loads, and is the kind its folder says",
    judged.length > 0 && judged.every((one) => one.ok) && examplePlugins.every((_, index) => judged[index].kind === "plugin") && exampleThemes.every((_, index) => judged[examplePlugins.length + index].kind === "theme"),
    JSON.stringify(judged.map((one) => ({ file: one.rel, ok: one.ok, kind: one.kind, error: one.error }))),
  );
  // A theme is data: code in one is refused at install time, and the colour tokens it declares
  // have to be ones the runtime can actually paint with, which is a question about the mapping
  // rather than about the file.
  const theme = judged.find((one) => one.kind === "theme");
  const painted = theme && theme.ok ? nativeTheme({ manifest: theme.parsed, settings: {} }) : null;
  ok(
    "a shipped theme has no lifecycle code in it, and its tokens reach the runtime's own colours",
    Boolean(painted) && theme.hasHooks === false && Object.keys(painted.semanticColors || {}).length > 0 && Object.values(painted.semanticColors).every((triple) => Array.isArray(triple) && triple.length === 3),
    JSON.stringify(painted && painted.semanticColors),
  );
}

/* ---- 8. the bundle the client injects was built from this tree ---------- */

{
  // The vendored entries above are sources; the file the client actually runs is the built one.
  // A tree whose sources were changed and whose bundle was not rebuilt is a tree where every
  // count is right and nothing that changed is in the client - which is what this check is for.
  const bundle = path.join(root, "vendor", "runtime", "browser.js");
  const stylesheet = path.join(root, "vendor", "runtime", "browser.css");
  const built = fs.existsSync(bundle) ? fs.statSync(bundle) : null;
  // The freshness half needs the sources, and asks about *their* mtimes - which only mean anything
  // in a working copy someone built from. It is skipped, with the reason, where the fork is not
  // here; the half that matters for a release, that the bundle and its stylesheet are present and
  // substantial, is checked in every tree.
  const newest = (() => {
    if (!forkHere) return 0;
    let at = 0;
    const walk = (dir) => {
      for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
        if (row.name === "node_modules" || row.name.startsWith(".")) continue;
        const full = path.join(dir, row.name);
        if (row.isDirectory()) walk(full);
        else if (/\.(ts|tsx|css|json)$/.test(row.name)) at = Math.max(at, fs.statSync(full).mtimeMs);
      }
    };
    walk(FORK);
    return at;
  })();
  ok(
    "the runtime the loader injects is there, with the stylesheet that dresses its pages",
    Boolean(built) && built.size > 1000000 && fs.existsSync(stylesheet) && fs.statSync(stylesheet).size > 50000,
    built ? built.size + " bytes" : "no bundle",
  );
  if (newest) {
    ok(
      "and it was built after the sources it was built from",
      Boolean(built) && newest <= built.mtimeMs + 1000,
      JSON.stringify({ sourcesAt: new Date(newest).toISOString(), bundleAt: built ? new Date(built.mtimeMs).toISOString() : null }),
    );
  } else {
    note("no vendored sources in this tree, so whether the shipped bundle is newer than them was not checked: clone the fork and run `npm run build:runtime` to check that here");
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
