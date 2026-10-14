// language: JavaScript, file: tests/plugin-host/index.mjs
//
// The plugin host is where "the whole catalogue, and only the set is on" is
// either true or a slogan, so it is tested against fixtures rather than against
// the vendored tree: the fixtures are small, they are allowed to be wrong on
// purpose, and the test never touches the real plugins.state.json.
//
// Plain node, no Electron - the host itself imports nothing but node builtins:
//
//   node tests/plugin-host/index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginHost } from "../../src/plugin-host.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(root, "manifest.json");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-plugins-"));
const scratch = (name) => path.join(tmp, name + ".json");
const trace = () => globalThis.__pluginTrace || [];
const reset = () => {
  delete globalThis.__pluginTrace;
  delete globalThis.__alphaCtx;
};

function makeCtx() {
  const sent = [];
  const notes = [];
  return {
    sent,
    notes,
    ctx: {
      // a client with no control server is the normal state, and the plugins
      // must treat it as such rather than as a failure
      api: {
        request: async () => ({ ok: false, status: 0, error: "no control server configured" }),
        session: async () => ({ ok: false, status: 404, error: "no route" }),
      },
      ui: { notify: (t, b) => notes.push([t, b]), send: (kind, payload) => sent.push([kind, payload]) },
    },
  };
}

function hostFor(stateFile, extra = {}) {
  const { ctx } = makeCtx();
  const logs = [];
  const host = new PluginHost({
    root,
    manifestPath,
    stateFile,
    ctx,
    log: (line) => logs.push(line),
    ...extra,
  });
  return { host, logs };
}

/* ---- 1. the catalogue is metadata, and a first run is the set ------------ */

reset();
const stateOne = scratch("one");
{
  const { host } = hostFor(stateOne);
  host.load();
  ok("the catalogue is read from the manifest", host.meta.size === 5, "entries " + host.meta.size);
  ok("loading the catalogue imports no plugin code", globalThis.__pluginTrace === undefined);
  ok("a first run starts as exactly the default set", JSON.stringify(host.state.enabled) === '["alpha"]', JSON.stringify(host.state.enabled));
  ok("the default set is remembered on disk", fs.existsSync(stateOne));
  const status = host.status();
  ok("status counts the catalogue and what is on", status.catalogue === 5 && status.enabled === 1, JSON.stringify(status));
  ok("status names the set", status.defaultSet === "Hyper" && status.defaults.includes("alpha"), JSON.stringify(status));
  ok("nothing is running before startEnabled", status.running.length === 0);

  /* ---- 2. enabling is the only moment code is touched -------------------- */

  const on = await host.enable("alpha");
  ok("enabling a plugin starts it", on.ok === true, JSON.stringify(on));
  ok("its start() actually ran", trace().includes("alpha:start"), JSON.stringify(trace()));
  ok("and it is marked running", host.status().running.includes("alpha"));
  const listed = host.list().find((p) => p.id === "alpha");
  ok("the manager lists it as on and running", listed.enabled === true && listed.running === true && listed.broken === "");

  const again = await host.enable("alpha");
  ok("enabling twice does not start it twice", again.already === true && trace().filter((t) => t === "alpha:start").length === 1, JSON.stringify(trace()));

  /* ---- 3. settings belong to the plugin, not to the process ------------- */

  host.setSetting("alpha", "greeting", "hey");
  ok("a setting is readable through the context", globalThis.__alphaCtx.setting("greeting") === "hey", String(globalThis.__alphaCtx.setting("greeting")));
  ok("and the host reports it", host.settingsFor("alpha").greeting === "hey");

  /* ---- 4. a bad plugin is isolated -------------------------------------- */

  const boom = await host.enable("boom");
  ok("a plugin that throws is refused, not fatal", boom.ok === false && /refused to start/.test(boom.error), JSON.stringify(boom));
  ok("and it is marked broken with the reason", (host.list().find((p) => p.id === "boom") || {}).broken.includes("boom: refused to start"));
  ok("the host still works after a plugin blew up", (await host.enable("alpha")).ok === true && host.meta.size === 5);

  /* ---- 5. what cannot be loaded says so, by name ------------------------ */

  // The vendored catalogue is TypeScript, so this process cannot load it - the built runtime
  // in the page does. What the host can do for such a plugin is remember the operator's
  // choice, which is the record the loader hands to the runtime at every start, and it must
  // not report that as a plugin it started.
  const ts = await host.enable("typescript");
  ok("a TypeScript entry is not imported, and the choice is recorded for the built runtime", ts.ok === true && ts.runtime === true && ts.running === undefined, JSON.stringify(ts));
  ok(
    "and the record is what the loader hands over at the next start",
    host.status().runtime.includes("typescript") && (host.list().find((p) => p.id === "typescript") || {}).enabled === true,
    JSON.stringify(host.status().runtime),
  );
  const tsOff = await host.disable("typescript");
  ok("turning it off takes the record back", tsOff.ok === true && host.status().runtime.length === 0, JSON.stringify(host.status().runtime));
  const gone = await host.enable("missing");
  ok("a missing entry is refused as not vendored", gone.ok === false && /not vendored/.test(gone.error), JSON.stringify(gone));
  const who = await host.enable("nobody");
  ok("an unknown id is refused cleanly", who.ok === false && /no such plugin/.test(who.error), JSON.stringify(who));

  /* ---- 6. disabling drops it ------------------------------------------- */

  const off = await host.disable("alpha");
  ok("disabling stops it", off.ok === true && trace().includes("alpha:stop"), JSON.stringify(trace()));
  ok("and it is no longer running", !host.status().running.includes("alpha"));
  ok("and the manager lists it as off", (host.list().find((p) => p.id === "alpha") || {}).enabled === false);
}

/* ---- 7. a second process sees the same settings and listens to the user -- */

{
  const { host } = hostFor(stateOne);
  host.load();
  ok("settings survive a fresh host on the same state file", host.settingsFor("alpha").greeting === "hey", JSON.stringify(host.settingsFor("alpha")));
  ok("an operator who turned the set off is respected", host.state.enabled.length === 0, JSON.stringify(host.state.enabled));
}

/* ---- 8. dependencies start first, whatever order they are listed in ----- */

reset();
{
  const stateTwo = scratch("two");
  // beta is listed before alpha on purpose: the array order must not decide it
  fs.writeFileSync(stateTwo, JSON.stringify({ enabled: ["beta", "alpha"], settings: {}, chosen: true }));
  const { host } = hostFor(stateTwo);
  host.load();
  ok("a saved choice is taken as it is", JSON.stringify(host.state.enabled) === '["beta","alpha"]', JSON.stringify(host.state.enabled));
  const status = await host.startEnabled();
  ok("startEnabled started a dependency before its dependent", JSON.stringify(trace()) === '["alpha:start","beta:start-after-alpha"]', JSON.stringify(trace()));
  ok("startEnabled reports both running", status.running.includes("alpha") && status.running.includes("beta"), JSON.stringify(status.running));
}

/* ---- 9. a file that is not there, and one that is ---------------------- */

{
  const { host } = hostFor(scratch("three"));
  host.load();
  const shown = host.list();
  ok("the manager lists the whole catalogue", shown.length === 5);
  // Every entry says whose switch it is, and the state travels only with the side that has
  // one: the host runs what it can load, the built runtime runs the vendored catalogue, and
  // a host doing guesswork about a plugin it cannot load is how a card and the runtime came
  // to disagree about whether a plugin was on.
  ok("every entry carries what the UI needs, and says whose switch it is", shown.every((p) => p.id && p.name && Array.isArray(p.authors) && (p.owner === "host" || p.owner === "runtime")));
  ok(
    "and running is claimed only by the side that runs a plugin",
    shown.every((p) => (p.owner === "host" ? typeof p.enabled === "boolean" && typeof p.running === "boolean" : typeof p.enabled === "boolean" && p.running === false)),
    JSON.stringify(shown.map((p) => ({ id: p.id, owner: p.owner, enabled: p.enabled, running: p.running }))),
  );
  ok(
    "the vendored one is the runtime's, and the host says so instead of guessing",
    (shown.find((p) => p.id === "typescript") || {}).owner === "runtime" && shown.filter((p) => p.owner === "runtime").length === 1,
  );
  // a plugin whose entry this host cannot load at all (not the runtime's, so not even a
  // record) must leave the rest of the set alone
  const broken = await host.enable("missing");
  ok("a refused plugin does not stop the host starting its set", broken.ok === false && (await host.startEnabled()).running.includes("alpha"));
}

/* ---- 10. the shell drives a feature through the plugin that owns it ----- */

{
  const { host } = hostFor(scratch("four"));
  host.load();
  ok("a plugin that has not started has no handle", host.handle("alpha") === null);
  await host.enable("alpha");
  const handle = host.handle("alpha");
  // the fixture returns { said: <its own setting>, id: "alpha" }: the shell must
  // see exactly that object, because it is the plugin's live surface
  ok("starting a plugin leaves what it returned reachable", handle !== null && handle.id === "alpha" && handle.said === "hi", JSON.stringify(handle));
  ok("the handle is the same object, not a copy", host.handle("alpha") === handle);
  ok("handles() lists the running plugins by id", Object.keys(host.allHandles()).includes("alpha"), JSON.stringify(Object.keys(host.allHandles())));
  const entry = host.list().find((p) => p.id === "alpha");
  ok("the manager is told the plugin's declared settings schema", Array.isArray(entry.settings) && entry.settings.some((s) => s.key === "greeting"), JSON.stringify(entry.settings));
  await host.disable("alpha");
  ok("disabling drops the handle with the module", host.handle("alpha") === null && Object.keys(host.allHandles()).length === 0, JSON.stringify(Object.keys(host.allHandles())));
}

/* ---- 11. stopping the host leaves nothing of a plugin running ----------- */

// "Closing the client kills every background activity of ours" is a claim about
// timers, and the only way to check it is to leave one running on purpose. The probe
// fixture asks the host for its timer and its cleanups, so this is the contract the
// helpers exist for: what the host holds, the host can take back.
{
  delete globalThis.__probeSeen;
  const probeManifest = path.join(tmp, "probe-manifest.json");
  fs.writeFileSync(
    probeManifest,
    JSON.stringify(
      {
        name: "Hypercord",
        defaults: { set: "Probe", enabled: ["probe"] },
        plugins: [{ id: "probe", name: "probe", entry: "plugins/probe/index.js", builtin: true, deps: [], defaultOn: true }],
      },
      null,
      1,
    ),
  );
  // the active-resource reading is the honest one: a timer that is still referenced
  // shows up here, and an unref'd one that the host cleared does not
  const timeouts = () => (typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length : 0);
  const before = timeouts();
  // the ctx is supplied here for one reason: `local` is what the caller of the host hands
  // plugins when they need the client's own services (the Beef engine today), so the
  // fixture checks it arrives rather than the host assuming it always does
  const { host } = hostFor(scratch("probe"), {
    manifestPath: probeManifest,
    ctx: { api: null, ui: { notify: () => {}, send: () => {} }, local: { beef: { state: () => ({}) } } },
  });
  host.load();
  await host.startEnabled();
  ok("the probe fixture is running", host.status().running.includes("probe"), JSON.stringify(host.status()));
  ok("the context offers a plugin the host can stop, and the services it was given", globalThis.__probeSeen.via === "function,function,function,object", String(globalThis.__probeSeen.via));
  await new Promise((resolve) => setTimeout(resolve, 90));
  ok("its interval is ticking", globalThis.__probeSeen.ticks > 0, "ticks " + globalThis.__probeSeen.ticks);
  ok("and the host is the one holding it", host.timers.get("probe") instanceof Set && host.timers.get("probe").size === 1, JSON.stringify(host.timers.size));
  ok("as it holds the cleanups it registered", (host.cleanups.get("probe") || []).length === 2, JSON.stringify((host.cleanups.get("probe") || []).length));

  const report = await host.stopAll();
  ok("stopAll() reports what it stopped", report.stopped.includes("probe") && report.failed.length === 0, JSON.stringify(report));
  ok("the plugin's own stop() hook ran, with its context", globalThis.__probeSeen.stopped === 1 && globalThis.__probeSeen.stopCtx === "probe", JSON.stringify(globalThis.__probeSeen.stopped));
  ok("its cleanups ran, newest first", globalThis.__probeSeen.cleaned === 2 && globalThis.__probeSeen.order.join(",") === "second,first", JSON.stringify(globalThis.__probeSeen.order));
  ok("and the host holds nothing for it any more", host.timers.size === 0 && host.cleanups.size === 0, JSON.stringify([host.timers.size, host.cleanups.size]));
  const frozen = globalThis.__probeSeen.ticks;
  await new Promise((resolve) => setTimeout(resolve, 90));
  ok("the interval is stopped, not merely forgotten", globalThis.__probeSeen.ticks === frozen, "was " + frozen + " now " + globalThis.__probeSeen.ticks);
  ok("nothing of ours is left keeping the loop alive", timeouts() <= before, "before " + before + " after " + timeouts());
  ok("the module, the handle and the running list are dropped", host.modules.size === 0 && host.running.size === 0 && Object.keys(host.allHandles()).length === 0, JSON.stringify([host.modules.size, host.running.size]));
  const afterStop = await host.enable("probe");
  ok("a stopped host starts nothing again", afterStop.ok === false && /stopped/.test(afterStop.error), JSON.stringify(afterStop));
}

/* ---- 12. and disabling one takes the same two things down --------------- */

{
  delete globalThis.__probeSeen;
  const probeManifest = path.join(tmp, "probe-manifest.json");
  const { host } = hostFor(scratch("probe-two"), { manifestPath: probeManifest });
  host.load();
  await host.enable("probe");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const ticking = globalThis.__probeSeen.ticks;
  ok("disabling runs the plugin's own stop() hook", (await host.disable("probe")).ok === true && globalThis.__probeSeen.stopped === 1, JSON.stringify(globalThis.__probeSeen.stopped));
  ok("and its cleanups", globalThis.__probeSeen.cleaned === 2, String(globalThis.__probeSeen.cleaned));
  ok("and the timers the host held", host.timers.size === 0 && host.cleanups.size === 0, JSON.stringify([host.timers.size, host.cleanups.size]));
  await new Promise((resolve) => setTimeout(resolve, 60));
  ok("so the interval that was ticking stopped", globalThis.__probeSeen.ticks === ticking, "was " + ticking + " now " + globalThis.__probeSeen.ticks);
  ok("and the host is not left stopped by a single disable", (await host.enable("probe")).ok === true, "disabled host refused to start again");
  await host.stopAll();
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
