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

  const ts = await host.enable("typescript");
  ok("a TypeScript entry is refused instead of imported", ts.ok === false && /TypeScript source/.test(ts.error), JSON.stringify(ts));
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
  ok("every entry carries what the UI needs", shown.every((p) => p.id && p.name && Array.isArray(p.authors) && typeof p.enabled === "boolean"));
  const broken = await host.enable("typescript");
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
