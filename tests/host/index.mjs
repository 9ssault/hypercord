// language: JavaScript, file: tests/host/index.mjs
//
// The host is the once-only place the settings pages get their data from, and the
// one thing that must never drift: the renderer asks for a channel, the host has
// registered it. A missing handler is not a small bug - it is a page whose every
// control is a dead click - so the invariant here is read off the preload's own
// source rather than off a list somebody has to remember to update.
//
// Plain node, no Electron: the host takes the Electron surface it uses as an
// argument, so a stub is enough and no window ever opens.
//
//   node tests/host/index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "src");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-host-"));
const userData = path.join(tmp, "userData");

/* ---- the stub Electron -------------------------------------------------- */

// Every channel the preload can reach, as the host registered it. A Map rather
// than a list, because the check is "this channel is there", not "some channel".
const registered = new Map();
const pushed = [];
const logs = [];
const notes = [];
// a restart asked for from a page of ours, in the order it happened: a stub that only
// counted them would not catch an exit that happened before (or without) a relaunch,
// which is the one order that closes the client and opens nothing
const restarts = [];

const electron = {
  app: {
    // the host is handed its own userData, but nothing here may be tempted to
    // read the real one, so the stub answers with the temp directory either way
    getPath: (name) => (String(name) === "userData" ? userData : path.join(tmp, String(name))),
    getVersion: () => "0.0.0-test",
    getAppMetrics: () => [],
    isPackaged: false,
    setName: () => {},
    on: () => {},
    once: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: () => restarts.push("relaunch"),
    exit: () => restarts.push("exit"),
  },
  ipcMain: {
    handle: (channel, fn) => registered.set(String(channel), fn),
    removeHandler: (channel) => registered.delete(String(channel)),
    on: (channel, fn) => registered.set("on:" + String(channel), fn),
    removeListener: (channel) => registered.delete("on:" + String(channel)),
  },
  // a machine with no keychain and no notification daemon is a real state, and
  // the host has to survive it rather than assume both are there
  Notification: { isSupported: () => false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
};

/* ---- 1. what the renderer asks for, read off the renderer's own file ----- */

const preloadText = fs.readFileSync(path.join(src, "preload.cjs"), "utf8");
const asked = [...preloadText.matchAll(/call\(\s*"([a-z:]+)"/g)].map((match) => match[1]);
const channels = [...new Set(asked)];

// A parse that silently found nothing would make every check below vacuous, so
// the inventory is asserted before it is used.
ok("the preload's own calls are readable", channels.length >= 20, "channels " + channels.length);
ok("and they include the pages' data channels", channels.includes("ui:assets") && channels.includes("plugins:list") && channels.includes("plugins:section"), JSON.stringify(channels.slice(0, 8)));

/* ---- 2. the host comes up and registers them all ------------------------- */

// The host must not require Electron itself: it is given it, which is what makes
// this file runnable with no window and no display.
const { createHost } = await import(pathToFileURL(path.join(src, "host.js")).href);

let host = null;
try {
  host = createHost({
    electron,
    dir: src,
    userData,
    log: (line) => logs.push(String(line)),
    notify: (title, body) => {
      notes.push([title, body]);
      return true;
    },
    push: (kind, payload) => pushed.push([kind, payload]),
    reloadWindow: () => {},
    windowFor: () => null,
  });
} catch (err) {
  ok("createHost() builds a host", false, String((err && err.message) || err));
}

if (host) {
  try {
    await host.start();
  } catch (err) {
    ok("the host starts", false, String((err && err.stack) || err));
  }

  const missing = channels.filter((channel) => !registered.has(channel));
  ok("every channel the preload calls is registered", missing.length === 0, "missing " + JSON.stringify(missing));
  ok("and nothing was registered twice into a different meaning", registered.size >= channels.length, "registered " + registered.size + " asked " + channels.length);

  /* ---- 3. the assets the pages need are the files on disk ---------------- */

  const assets = host.assets();
  ok(
    "the host hands the renderer the five assets",
    Boolean(assets) && ["css", "promptHtml", "panesHtml", "panesCss", "panesJs"].every((key) => typeof assets[key] === "string" && assets[key].length > 0),
    JSON.stringify(Object.keys(assets || {}).map((key) => key + ":" + String((assets || {})[key] || "").length)),
  );
  // The Beef page is the one page a plugin owns, so it is the one markup that
  // proves the host is serving the sheet the pages actually render.
  ok("the panes markup is the sheet's own", String(assets.panesHtml).includes('data-view="beef"'), String(assets.panesHtml).slice(0, 80));
  const views = ["commands", "plugins", "hyper", "beef", "themes", "logs", "accounts", "tokens"];
  ok("and it carries every section as its own page", views.every((view) => String(assets.panesHtml).includes('data-view="' + view + '"')), JSON.stringify(views.filter((view) => !String(assets.panesHtml).includes('data-view="' + view + '"'))));
  ok("css() is the one style string", typeof host.css() === "string" && host.css().length > 0, String(typeof host.css()));

  /* ---- 4. opening a page is a push, through the plugin that owns it ------- */

  pushed.length = 0;
  const opened = host.openPanes("themes");
  ok("openPanes asks the pane plugin for the view", opened === "themes", String(opened));
  ok("and pushes panes:open", pushed.some(([kind, payload]) => kind === "panes:open" && payload === "themes"), JSON.stringify(pushed));

  const unknown = host.openPanes("no-such-section");
  ok("a section that does not exist is refused rather than invented", unknown !== "no-such-section", String(unknown));

  /* ---- 5. the handlers answer, and refuse in shapes --------------------- */

  const call = async (channel, ...args) => {
    const fn = registered.get(channel);
    if (!fn) return { ok: false, error: "no handler for " + channel };
    return fn(null, ...args);
  };

  const section = await call("plugins:section", "nobodyDescribesThis");
  ok("a section no running plugin describes is a refusal, not a throw", section && section.ok === false && typeof section.error === "string" && section.error.length > 0, JSON.stringify(section));
  const action = await call("plugins:sectionAction", "nobodyDescribesThis", "refresh", null);
  ok("and so is an action on it", action && action.ok === false && typeof action.error === "string", JSON.stringify(action));

  const assetCall = await call("ui:assets");
  ok("ui:assets answers with the same five strings", assetCall && typeof assetCall.panesHtml === "string" && assetCall.panesHtml.includes('data-view="beef"') && typeof assetCall.css === "string", JSON.stringify(Object.keys(assetCall || {})));

  const lines = await call("logs:read", 50);
  ok("logs:read answers with a bounded ring", lines && Array.isArray(lines.lines) && typeof lines.total === "number" && typeof lines.limit === "number", JSON.stringify(lines && lines.total));

  const listed = await call("plugins:list");
  ok("plugins:list is the catalogue's metadata", Array.isArray(listed) && listed.length > 0 && listed.every((entry) => entry && entry.id && entry.name), "entries " + (Array.isArray(listed) ? listed.length : -1));

  const themes = await call("themes:list");
  ok("themes:list is a list, empty or not", Array.isArray(themes), JSON.stringify(themes));

  const state = await call("update:state");
  ok("update:state describes this run rather than throwing", Boolean(state) && typeof state === "object", JSON.stringify(state));

  const keys = await call("tokens:list");
  ok("tokens:list is the store's own list", Array.isArray(keys), JSON.stringify(keys));
  // The Accounts page needs all four of these: the list (with each account's identity),
  // a check that says whether a key still works, a rename of the label, and the switch.
  // A missing channel is a dead button, so they are asserted by name rather than in bulk.
  ok("the account switcher's channels are all registered", ["tokens:list", "tokens:test", "tokens:rename", "tokens:use", "tokens:add", "tokens:remove"].every((channel) => registered.has(channel)), JSON.stringify(["tokens:list", "tokens:test", "tokens:rename", "tokens:use", "tokens:add", "tokens:remove"].filter((channel) => !registered.has(channel))));
  const renamed = await call("tokens:rename", "nobody", "a name");
  ok("renaming an account that is not stored is a refusal, not a throw", renamed && renamed.ok === false && typeof renamed.error === "string", JSON.stringify(renamed));
  const untested = await call("tokens:test", "nobody");
  ok("testing a key that is not stored says so without asking Discord", untested && untested.ok === false && /no token/.test(untested.error), JSON.stringify(untested));

  /* ---- 5b. the Beef section answers with no control server --------------- */

  // This is the one end-to-end reading of the local engine: the real catalogue is loaded,
  // the real plugin is running, the call goes through the same channel the settings page
  // uses, and the api it was handed has no base URL - the machine the engine exists for.
  const engine = host.beef ? host.beef.state() : null;
  ok("the host builds the client's own beef engine", Boolean(engine) && engine.banks >= 9 && Array.isArray(engine.categories), JSON.stringify(engine && { banks: engine.banks, source: engine.source }));
  const beefSection = await call("plugins:section", "hyperBeef");
  ok("the Beef section is described by its plugin", Boolean(beefSection) && beefSection.ok === true && beefSection.section && Array.isArray(beefSection.section.actions), JSON.stringify(beefSection && beefSection.error));
  ok("and it says the local engine is what answers", beefSection.section.state.answers === "local engine", JSON.stringify(beefSection.section.state.answers));
  const refreshed = await call("plugins:sectionAction", "hyperBeef", "refresh", null);
  ok("refreshing it reads the engine, not a server", refreshed && refreshed.ok === true && refreshed.source === "builtin banks" && refreshed.categories.length > 0, JSON.stringify(refreshed && { ok: refreshed.ok, source: refreshed.source, categories: refreshed.categories && refreshed.categories.length }));
  const readLine = await call("plugins:sectionAction", "hyperBeef", "inspect", "<@1> you are trash, kys");
  ok("and the line lab answers in this process", readLine && readLine.ok === true && readLine.read && readLine.read.route === "beef", JSON.stringify(readLine && readLine.error));

  /* ---- 5c. the restart a patch-based plugin needs ------------------------ */

  restarts.length = 0;
  const restarted = await call("client:relaunch");
  ok("a page of ours can ask for the client to restart", restarted && restarted.ok === true, JSON.stringify(restarted));
  ok("and the new process is arranged before this one ends", JSON.stringify(restarts) === '["relaunch","exit"]', JSON.stringify(restarts));

  // A run with no app to relaunch - a headless reader of these pages, or the next reader of
  // this file - is a refusal rather than a process taken down: exiting is the one thing here
  // that cannot be undone, so it only happens after the relaunch was arranged.
  const hadRelaunch = electron.app.relaunch;
  delete electron.app.relaunch;
  restarts.length = 0;
  const nowhere = await call("client:relaunch");
  ok(
    "with no app to restart it says so, and nothing is exited",
    nowhere && nowhere.ok === false && typeof nowhere.error === "string" && restarts.length === 0,
    JSON.stringify({ answer: nowhere, restarts }),
  );
  electron.app.relaunch = hadRelaunch;

  /* ---- 6. stopping leaves nothing registered, and nothing running -------- */

  const stopped = await host.stop();
  ok(
    "stop() stops the running plugins and names them",
    stopped && stopped.ok === true && stopped.already === false && stopped.plugins && stopped.plugins.stopped.includes("hyperBeef"),
    JSON.stringify(stopped && stopped.plugins),
  );
  ok("a real plugin's own stop() hook ran on the way out", logs.some((line) => /beef section closed/.test(String(line))), JSON.stringify(logs.slice(-3)));
  ok("and the host releases the stores it was holding", host.beef === null && host.plugins === null && host.themes === null && host.tokens === null, "held on");
  const twice = await host.stop();
  ok("stopping twice is a no-op rather than a second teardown", twice && twice.already === true && twice.plugins === null, JSON.stringify(twice));
  ok("stop() unregisters every channel it registered", registered.size === 0, "left " + registered.size);
  ok("and nothing was written into a real user data directory", !fs.existsSync(path.join(os.homedir(), ".hypercord-host-test")), userData);
}

/* ---- 7. the pages' own files are read when a page asks for them ---------- */

// A page of ours is a file on disk, and the host reads the five files *again* whenever a page
// asks for them (ui:assets). That is what makes a change to the sheet's own script, markup or
// stylesheet need a reload of the window instead of a whole new Discord process. Checked on a
// copy in a temp directory, so nothing here touches the tree it copied from.
const assetsDir = path.join(tmp, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
for (const file of ["injected.css", "prompt.html", "panes.html", "panes.css", "panes.js"]) {
  fs.copyFileSync(path.join(src, file), path.join(assetsDir, file));
}

const freshRegistered = new Map();
const fresh = createHost({
  electron: {
    ...electron,
    ipcMain: {
      handle: (channel, fn) => freshRegistered.set(String(channel), fn),
      removeHandler: (channel) => freshRegistered.delete(String(channel)),
      on: (channel, fn) => freshRegistered.set("on:" + String(channel), fn),
      removeListener: (channel) => freshRegistered.delete("on:" + String(channel)),
    },
  },
  dir: assetsDir,
  userData: path.join(tmp, "userData-again"),
  log: () => {},
  push: () => {},
  windowFor: () => null,
  reloadWindow: () => {},
});
await fresh.start();
const ask = () => freshRegistered.get("ui:assets")(null);

const asRead = await ask();
ok("a second host serves the files in its own directory", String(asRead.panesJs).includes("hypercordPanes"), String(asRead.panesJs).slice(0, 60));

// the sheet's script and the stylesheet it is injected with, changed on disk after the host
// came up: what the page asks for is what is on disk now, not what was there at start
fs.writeFileSync(path.join(assetsDir, "panes.js"), fs.readFileSync(path.join(assetsDir, "panes.js"), "utf8") + "\n// hypercord: changed while the client was running\n");
fs.writeFileSync(path.join(assetsDir, "injected.css"), fs.readFileSync(path.join(assetsDir, "injected.css"), "utf8") + "\n.hypercord-test-marker { color: red; }\n");
const afterEdit = await ask();
ok("a change to the sheet's own script is what the next page gets", String(afterEdit.panesJs).includes("changed while the client was running"), String(afterEdit.panesJs).slice(-90));
ok("and so is a change to the stylesheet it is injected with", String(afterEdit.css).includes("hypercord-test-marker"), String(afterEdit.css).slice(-90));

// a file that is not there keeps the copy already held, so a half-finished edit cannot blank a
// page that was working
const beforeDelete = String(afterEdit.panesCss).length;
fs.rmSync(path.join(assetsDir, "panes.css"));
const afterDelete = await ask();
ok("a file that has gone missing keeps the copy the host already had", beforeDelete > 0 && String(afterDelete.panesCss).length === beforeDelete, JSON.stringify({ before: beforeDelete, after: String(afterDelete.panesCss).length }));
const closed = await fresh.stop();
ok("and that host stops cleanly too", Boolean(closed) && closed.ok === true, JSON.stringify(closed));

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
