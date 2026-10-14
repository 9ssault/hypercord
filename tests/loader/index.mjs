// language: JavaScript, file: tests/loader/index.mjs
//
// The loader is what a patched Discord runs first, inside Discord's own main
// process, so the two things it does there are the two things worth a check: it
// hands the page one style element (the themes, and nothing else), and it puts
// Hypercord's own preload in front of Discord's, which is the only moment the
// settings pages can be mounted inside Discord's window at all.
//
// Nothing here needs Electron: the loader takes the Electron surface as an
// argument, so a stub class is enough and no window ever opens.
//
//   node tests/loader/index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const loader = require("../../src/loader.cjs");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-loader-"));
const write = (name, value) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

/* ---- 1. the one style element ------------------------------------------ */

const script = loader.buildInjection({ css: ".hc { color: red; }" });
ok("the injection is a script", typeof script === "string" && script.length > 0, String(typeof script));
ok("it takes the stylesheet whole", script.includes(JSON.stringify(".hc { color: red; }")), script.slice(0, 120));
ok("it writes one style element with our id", script.includes("createElement('style')") && script.includes(JSON.stringify(loader.STYLE_ID)) && script.includes("style.textContent = CSS"), "");
// One element, found again by id: a reload of Discord's page must restyle the
// sheet that is there rather than stack a second copy of the themes on top of it.
ok("it finds an existing element by id before creating one", script.indexOf("getElementById(" + JSON.stringify(loader.STYLE_ID) + ")") < script.indexOf("createElement('style')"), "");
ok("and it reports the length it wrote", script.includes("return { ok: true, css: CSS.length }"), "");

/* ---- 2. where the css comes from --------------------------------------- */

ok("with nothing anywhere, there is nothing to inject", JSON.stringify(loader.loadConfig({ dir: path.join(tmp, "empty"), env: {}, mainDir: "" })) === JSON.stringify({ css: "", found: "" }), JSON.stringify(loader.loadConfig({ dir: path.join(tmp, "empty"), env: {}, mainDir: "" })));

const besideDir = path.join(tmp, "beside");
fs.mkdirSync(besideDir, { recursive: true });
write(path.join("beside", "hypercord.json"), { css: ".from-beside" });
const fromBeside = loader.loadConfig({ dir: besideDir, env: {}, mainDir: "" });
ok("a hypercord.json beside the loader is read", fromBeside.css === ".from-beside" && String(fromBeside.found).endsWith("hypercord.json"), JSON.stringify(fromBeside));

const override = write("override.json", { css: ".from-env" });
const fromEnv = loader.loadConfig({ dir: besideDir, env: { HYPERCORD_LOADER_CONFIG: override }, mainDir: "" });
ok("and an explicit override wins over it", fromEnv.css === ".from-env" && fromEnv.found === override, JSON.stringify(fromEnv));

const mainDir = path.join(tmp, "mainDir");
fs.mkdirSync(mainDir, { recursive: true });
write(path.join("mainDir", "hypercord.json"), { assets: { css: ".from-assets" } });
const fromMain = loader.loadConfig({ dir: path.join(tmp, "empty"), env: {}, mainDir });
ok("the baked assets Discord was patched with are read from its own directory", fromMain.css === ".from-assets", JSON.stringify(fromMain));
ok("a directory that is not there is not a crash, just nothing to inject", loader.loadConfig({ dir: path.join(tmp, "nowhere"), env: {}, mainDir: path.join(tmp, "nowhere") }).css === "", "");

/* ---- 3. attaching is the side effect the loader exists for --------------- */

const injected = [];
const app = {
  on: (event, fn) => {
    app.events.push(event);
    void fn;
  },
  events: [],
  BrowserWindow: { getAllWindows: () => [] },
};
const attached = loader.attach(app, { css: ".attached" });
ok("attach() reports what it did", attached.ok === true && attached.injected === 0, JSON.stringify({ ok: attached.ok, injected: attached.injected }));
ok("it subscribes to windows as they appear, never to a timer", app.events.includes("browser-window-created"), JSON.stringify(app.events));
// A window gets two things now, and each of them exactly once: the stylesheet, and the
// built plugin runtime (a second copy of either is a second pass over the page).
ok("a window is injected into once, per thing", (() => {
  // Discord's own page, because that is the only window the runtime is for: the stylesheet
  // goes to every window, the runtime only to the one that can run it (see 3b below)
  const win = { id: 7, webContents: { isLoading: () => false, getURL: () => "https://discord.com/app", executeJavaScript: (source) => injected.push(source) } };
  loader.attach({ on: () => {}, BrowserWindow: { getAllWindows: () => [win] } }, { css: ".x" });
  // the stylesheet is found by something only it contains: a 3.2MB bundle contains ".x"
  // somewhere, so matching on the class name would count the runtime as a second style
  // and by the id only it writes, because the runtime's own script creates a style element
  // too now (its stylesheet, `hypercord-runtime-css`): counting style elements would count it
  // as a second copy of the theme
  const style = injected.filter((source) => String(source).includes(loader.STYLE_ID));
  const runtime = injected.filter((source) => String(source).includes("__hypercordRuntime"));
  return injected.length === 2 && style.length === 1 && runtime.length === 1;
})(), JSON.stringify({ injected: injected.length, heads: injected.map((source) => String(source).slice(0, 22)) }));
ok("with nothing to inject it says so instead of faking one", loader.attach({ on: () => {}, BrowserWindow: { getAllWindows: () => [] } }, { css: "" }).empty === true, "");

/* ---- 3b. the built plugin runtime ------------------------------------- */

// The vendored catalogue is TypeScript source, so the only way those 371 plugins run at all
// is Equicord's own built runtime, which the loader injects into Discord's page. Two things
// about it are checkable without Discord: the script that installs it (its guard, its
// native shim, and what it reports back), and that the injection really happens, once per
// window, with the outcome written where a GUI process's stdout cannot hide it.
if (typeof loader.buildRuntimeInjection !== "function" || typeof loader.readRuntime !== "function") {
  ok("src/loader.cjs exports the runtime pieces", false, "readRuntime and buildRuntimeInjection are not exported yet");
} else {
  ok("readRuntime reports a bundle that is not built instead of throwing", loader.readRuntime({ runtimeFile: path.join(tmp, "no-such-renderer.js") }).ok === false, "");
  ok("and the message says which file it wanted", /not built/.test(loader.readRuntime({ runtimeFile: path.join(tmp, "no-such-renderer.js") }).error || ""), String(loader.readRuntime({ runtimeFile: path.join(tmp, "no-such-renderer.js") }).error));
  const built = loader.readRuntime();
  ok("the vendored bundle is readable when it has been built", built.ok === true ? String(built.version).includes("Equicord") : /not built/.test(built.error || ""), JSON.stringify({ ok: built.ok, version: built.version || built.error }));

  // The runtime is two files, not one: the browser build is a userscript, and its stylesheet
  // ships *beside* the bundle (`browser.css`, 218kb of `.vc-` rules, while `browser.js` has
  // none of them). A client that injected the script and not the css handed out a runtime whose
  // every page - the plugin browser, the theme browser, the settings windows - was drawn
  // unstyled, which is what a broken browser of hundreds of plugins looks like while every
  // count in it is correct. This is the pair that must travel together.
  ok("readRuntime brings the stylesheet that ships beside the bundle", (() => { const built = loader.readRuntime(); return built.ok !== true || (String(built.css || "").length > 100000 && /\.css$/.test(String(built.stylesheet || ""))); })(), (() => { const built = loader.readRuntime(); return built.ok ? String(built.stylesheet) + " " + String(built.css || "").length + " bytes" : built.error; })());

  const fakeBundle = "var Vencord = { Plugins: { plugins: { one: { name: 'one' }, two: { name: 'two' } } } };\n";
  const script = loader.buildRuntimeInjection({ source: fakeBundle, version: "test-build" });
  ok("the runtime script carries the bundle", script.includes(fakeBundle), "");
  // and the stylesheet, in the same script, so a window cannot get one without the other
  const withCss = loader.buildRuntimeInjection({ source: fakeBundle, version: "test-build", css: ".vc-card-base{padding:14px}" });
  ok("the runtime script carries its stylesheet when there is one", withCss.includes("hypercord-runtime-css") && withCss.includes(".vc-card-base{padding:14px}"), "");
  // its own block, not the id it reports on: the report always says whether the stylesheet is
  // in the page, and that line is in every script
  ok("and leaves the page alone when there is not", !script.includes("sheet.id = 'hypercord-runtime-css'"), "");
  ok("it stamps the version it installed", script.includes('window["__hypercordRuntime"] = "test-build"'), "");
  ok("it gives the page the native bridge the bundle reads while importing", script.includes("Object.defineProperty(window, 'VencordNative'") && script.includes("settings: { get:"), "");
  ok("and that bridge can be left out deliberately", !loader.buildRuntimeInjection({ source: fakeBundle, version: "x", native: false }).includes("Object.defineProperty(window, 'VencordNative'"), "");

  // The contract that matters is what the page is left with, so the script is evaluated:
  // the runtime has to end up on the page under its own name, and a second injection of the
  // same build must be a no-op rather than a second pass over Discord's modules.
  const vm = await import("node:vm");
  const store = new Map();
  const page = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    open: () => {},
  };
  // `window` is the page itself in a real window, which is the detail that matters here:
  // the bundle declares `var Vencord` at its top level, and a top-level `var` lands on the
  // global - so the runtime only appears at `window.Vencord` if window *is* the global
  page.window = page;
  const context = vm.createContext(page);
  const first = vm.runInContext(loader.buildRuntimeInjection({ source: fakeBundle, version: "test-build" }), context);
  ok("evaluating it installs the runtime on the page", page.Vencord && page.Vencord.Plugins && Object.keys(page.Vencord.Plugins.plugins).length === 2, JSON.stringify(Object.keys(page).slice(0, 4)));
  ok("and reports what it found", first && first.ok === true && first.plugins === 2 && first.version === "test-build", JSON.stringify(first));
  ok("the bridge answers synchronously, the way the bundle reads it", typeof page.VencordNative.settings.get() === "object" && page.VencordNative.settings.set({ a: 1 }) === true && JSON.parse(store.get("hypercord.runtime.settings")) .a === 1, JSON.stringify(store.get("hypercord.runtime.settings")));
  const second = vm.runInContext(loader.buildRuntimeInjection({ source: fakeBundle, version: "test-build" }), context);
  ok("injecting the same build twice is a no-op", second && second.already === true, JSON.stringify(second));

  // The stylesheet lands as one element with a known id, and a second injection does not add a
  // second one: the same guard that makes the *bundle* a no-op has to hold for the css, because
  // the two are injected separately (the preload at document start, the loader per window).
  const styled = await import("node:vm");
  const cssStore = new Map();
  const cssPage = {
    localStorage: { getItem: (k) => (cssStore.has(k) ? cssStore.get(k) : null), setItem: (k, v) => cssStore.set(k, String(v)) },
    open: () => {},
    document: {
      head: {
        children: [],
        appendChild(node) {
          this.children.push(node);
          return node;
        },
      },
      getElementById: (id) => cssPage.document.head.children.find((one) => one.id === id) || null,
      createElement: (tag) => ({ tagName: tag, id: "", attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }),
    },
  };
  cssPage.window = cssPage;
  const cssContext = styled.createContext(cssPage);
  const withSheet = loader.buildRuntimeInjection({ source: fakeBundle, version: "test-build", css: ".vc-settings-tab{display:block}" });
  const report1 = vm.runInContext(withSheet, cssContext);
  const report2 = vm.runInContext(withSheet, cssContext);
  ok(
    "the stylesheet is one element in the page's head, and the report says so",
    cssPage.document.head.children.length === 1 && cssPage.document.head.children[0].textContent === ".vc-settings-tab{display:block}" && report1.css === true && report2.css === true,
    JSON.stringify({ sheets: cssPage.document.head.children.length, css: report1.css }),
  );

  // The runtime installs a bridge of its own while it is importing (`window.VencordNative =
  // { ... }`), and a plain assignment used to throw the loader's away: the switches the sheet
  // recorded were handed to a store that had already been replaced, so a plugin switched on
  // with "restart to apply" came back off at every start - reported from the client, not
  // theorised about. The bridge is installed with a setter for that reason, and this is the
  // assertion that it survives the bundle's own: the parts the bundle makes for itself are
  // kept, and the part this client owns is the one that answers.
  const ownBridge =
    "var Vencord = { Plugins: { plugins: { one: { name: 'one' }, two: { name: 'two' } } } };\n" +
    "window.VencordNative = { settings: { get: function () { return {}; }, set: function () {} }, themes: { marker: 'theirs' } };\n";
  const page2 = { localStorage: { getItem: () => null, setItem: () => {} }, open: () => {} };
  page2.window = page2;
  vm.runInContext(loader.buildRuntimeInjection({ source: ownBridge, version: "test-build", enabled: [["one"]] }), vm.createContext(page2));
  const kept = page2.VencordNative || {};
  ok("the bundle's own bridge keeps every half that is not the settings store", Boolean(kept.themes) && kept.themes.marker === "theirs", JSON.stringify(Object.keys(kept)));
  ok(
    "and a recorded switch is what the runtime reads at start, not the empty store it built",
    JSON.parse(JSON.stringify(kept.settings.get())).plugins.one.enabled === true && JSON.parse(JSON.stringify(kept.settings.get())).plugins.two === undefined,
    JSON.stringify(kept.settings.get()),
  );

  // And the store the page's bridge answers out of: one file in the data directory, bounded,
  // parsed before it is written, swapped in atomically. `localStorage` is *removed* on
  // Discord's page, so without this file the runtime's store came up empty at every start.
  const channels = [];
  const fakeIpc = { on: (channel, handler) => channels.push({ channel, handler }) };
  const runtimeSettings = loader.runtimeStore({ ipcMain: fakeIpc, dataDir: tmp });
  ok(
    "the runtime's settings are kept in a file in the data directory",
    runtimeSettings.ok === true && runtimeSettings.file === path.join(tmp, "runtime.settings.json") && channels.length === 1 && channels[0].channel === "hypercord:runtime-settings",
    runtimeSettings.file,
  );
  const reply = (action, payload) => {
    const event = {};
    channels[0].handler(event, action, payload);
    return event.returnValue;
  };
  ok("a store that was never written reads as empty settings rather than throwing", reply("read") === "{}", String(reply("read")));
  ok(
    "a write is kept and read back",
    reply("write", JSON.stringify({ plugins: { one: { enabled: true } } })) === true && JSON.parse(reply("read")).plugins.one.enabled === true,
    String(reply("read")),
  );
  ok("and what is not JSON, or not an action this file knows, is refused rather than written", reply("write", "{not json") === false && reply("nope") === false, "");

  // and the injection itself, in the shape `attach` uses
  const runtimeCalls = [];
  const runtimeWin = {
    id: 42,
    webContents: {
      isLoading: () => false,
      // the runtime is only for Discord's own page, so this is the detail that decides
      // whether the injection happens at all
      getURL: () => "https://discord.com/app",
      executeJavaScript: (source) => {
        runtimeCalls.push(source);
        return Promise.resolve(source.includes("__hypercordRuntime") ? { ok: true, version: "test-build", plugins: 3 } : { ok: true, css: 1 });
      },
    },
  };
  const runtimeApp = { on: () => {}, BrowserWindow: { getAllWindows: () => [runtimeWin] } };
  const runtimeReport = loader.attach(runtimeApp, { css: ".r", dataDir: tmp, log: () => {}, runtime: { ok: true, file: "fake", source: fakeBundle, version: "test-build" } });
  ok("attach() reports the runtime it will inject", runtimeReport.runtime && runtimeReport.runtime.ok === true && runtimeReport.runtime.version === "test-build", JSON.stringify(runtimeReport.runtime));
  ok("a window gets the stylesheet and the runtime, in that order", runtimeCalls.length === 2 && runtimeCalls[0].includes(loader.STYLE_ID) && runtimeCalls[1].includes("__hypercordRuntime"), JSON.stringify(runtimeCalls.map((one) => one.slice(0, 24))));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const runtimeLog = fs.readFileSync(path.join(tmp, "runtime.log"), "utf8");
  ok("and the outcome is written where a GUI process can be read", /plugin runtime in 42: 3 plugins, build test-build/.test(runtimeLog), runtimeLog.trim().split("\n").pop() || "(empty)");

  // A window that is not on Discord's page gets the styling and nothing else. Measured,
  // not assumed: the bundle patches Discord's webpack runtime and reads the page's
  // localStorage while it is being imported, and injected into a window with neither it
  // threw "SecurityError: Failed to read the 'localStorage' property" - 2.5 MB of patches
  // evaluated in a page that cannot use one line of them.
  const otherCalls = [];
  const otherWin = {
    id: 43,
    webContents: {
      isLoading: () => false,
      getURL: () => "about:blank",
      executeJavaScript: (source) => {
        otherCalls.push(source);
        return Promise.resolve({ ok: true });
      },
    },
  };
  loader.attach({ on: () => {}, BrowserWindow: { getAllWindows: () => [otherWin] } }, { css: ".r", dataDir: tmp, log: () => {}, runtime: { ok: true, file: "fake", source: fakeBundle, version: "test-build" } });
  ok("a window that is not on Discord's page gets the styling and not the runtime", otherCalls.length === 1 && otherCalls[0].includes(loader.STYLE_ID), JSON.stringify(otherCalls.map((one) => one.slice(0, 20))));
  await new Promise((resolve) => setTimeout(resolve, 30));
  ok("and the report says why that window has no plugins", /not on Discord's page/.test(fs.readFileSync(path.join(tmp, "runtime.log"), "utf8")), fs.readFileSync(path.join(tmp, "runtime.log"), "utf8").trim().split("\n").pop() || "(empty)");
  fs.writeFileSync(path.join(tmp, "runtime.log"), "");

  // No stylesheet handed to the loader is not nothing to inject: the runtime is not ours to
  // leave out because the theme is missing. A client patched with no assets used to come up
  // with no plugins at all, and say nothing about it - the failure that looks like a client
  // where nothing works.
  const bare = [];
  const bareWin = {
    id: 44,
    webContents: {
      isLoading: () => false,
      getURL: () => "https://discord.com/app",
      executeJavaScript: (source) => {
        bare.push(source);
        return Promise.resolve({ ok: true, plugins: 1 });
      },
    },
  };
  const unstyled = loader.attach({ on: () => {}, BrowserWindow: { getAllWindows: () => [bareWin] } }, { css: "", dataDir: tmp, log: () => {}, runtime: { ok: true, file: "fake", source: fakeBundle, version: "test-build" } });
  ok(
    "with no stylesheet nothing is styled and the runtime still goes in",
    unstyled.ok === true && unstyled.injected === 0 && unstyled.empty === true && bare.length === 1 && bare[0].includes("__hypercordRuntime"),
    JSON.stringify({ empty: unstyled.empty, injected: unstyled.injected, calls: bare.length }),
  );
}

/* ---- 3c. the record reaches the runtime under the name it uses --------- */

// Hypercord keys a plugin the way its catalogue does, by the directory the plugin's source lives
// in ("accountPanelServerProfile"); the runtime keys it by the plugin's own name
// ("AccountPanelServerProfile") - measured against the built bundle, whose plugin list *and*
// settings are both keyed that way. Handing the record over under the catalogue's id puts every
// switch where the runtime never looks, which is indistinguishable from a record that was never
// written. That is what this checks, and the catalogue that matters is the real one.
{
  const handover = path.join(tmp, "handover");
  fs.mkdirSync(path.join(handover, "plugins"), { recursive: true });
  const manifest = path.join(handover, "plugins", "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      plugins: [{ id: "accountPanelServerProfile", name: "AccountPanelServerProfile", entry: "plugins/accountPanelServerProfile/index.tsx" }],
    }),
  );
  const dataDir = path.join(handover, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "plugins.state.json"), JSON.stringify({ runtime: ["accountPanelServerProfile"] }));

  const mapped = loader.runtimeKeysFor(["accountPanelServerProfile"], { manifestFile: manifest });
  ok("the catalogue's id becomes the plugin's own name", JSON.stringify(mapped) === '[["AccountPanelServerProfile"]]', JSON.stringify(mapped));
  const unknown = loader.runtimeKeysFor(["nobody"], { manifestFile: manifest });
  ok("and an id the catalogue does not describe goes as its directory, in the case the runtime builds keys with", JSON.stringify(unknown) === '[["Nobody"]]', JSON.stringify(unknown));
  const noCatalogue = loader.runtimeKeysFor(["accountPanelServerProfile"], { manifestFile: path.join(tmp, "no-such-manifest.json") });
  ok("with no catalogue to read, the directory is still all there is to go on", JSON.stringify(noCatalogue) === '[["AccountPanelServerProfile"]]', JSON.stringify(noCatalogue));
  // a platform suffix is carried by the catalogue and never by the runtime's key, so the
  // directory without it is one of the names an entry offers
  fs.writeFileSync(manifest, JSON.stringify({ plugins: [{ id: "clipUpload.desktop", name: "", entry: "plugins/clipUpload/index.tsx" }] }));
  const suffixed = loader.runtimeKeysFor(["clipUpload.desktop"], { manifestFile: manifest });
  ok("a platform suffix is not part of the runtime's key", JSON.stringify(suffixed) === '[["ClipUpload"]]', JSON.stringify(suffixed));
  // and the real catalogue, which is what a patched client reads: resolved from this file rather
  // than from the working directory, which is not the same place
  const shipped = path.join(path.dirname(require.resolve("../../package.json")), "plugins", "manifest.json");
  const real = loader.runtimeKeysFor(["accountPanelServerProfile", "voiceJoinMessages"], { manifestFile: shipped });
  ok(
    "the shipped catalogue names each entry exactly once - including the nine whose name used to be a label",
    JSON.stringify(real) === '[["AccountPanelServerProfile"],["VoiceJoinMessages"]]',
    JSON.stringify(real),
  );
  // and a label is still survivable: the directory's own name travels beside it, and the runtime
  // turns on whichever of the two its settings actually have (the shim, asserted below)
  fs.writeFileSync(manifest, JSON.stringify({ plugins: [{ id: "voiceJoinMessages", name: "Clyde", entry: "plugins/voiceJoinMessages/index.ts" }] }));
  const labelled = loader.runtimeKeysFor(["voiceJoinMessages"], { manifestFile: manifest });
  ok("a name the runtime does not know travels with the directory's name beside it", JSON.stringify(labelled) === '[["Clyde","VoiceJoinMessages"]]', JSON.stringify(labelled));

  const injected = [];
  const recordWin = {
    id: 9,
    webContents: {
      isLoading: () => false,
      getURL: () => "https://discord.com/app",
      executeJavaScript: (source) => {
        injected.push(source);
        return Promise.resolve({ ok: true, plugins: 372 });
      },
    },
  };
  const bundle = "var Vencord = { Plugins: { plugins: {} } };\n";
  loader.attach(
    { on: () => {}, BrowserWindow: { getAllWindows: () => [recordWin] } },
    { css: "", dataDir, manifestFile: manifest, log: () => {}, runtime: { ok: true, file: "fake", source: bundle, version: "test-build" } },
  );
  const windowScript = injected.find((one) => one.includes("__hypercordRuntime")) || "";
  ok("the window is injected with the switch under the runtime's own name", windowScript.includes('[["AccountPanelServerProfile"]]'), windowScript.slice(windowScript.indexOf("var asked"), windowScript.indexOf("var asked") + 90));
  ok("and not under the catalogue's id", windowScript.length > 0 && !windowScript.includes('"accountPanelServerProfile"'), "");
  // the shim decides between the candidate names against the runtime's own settings, and inserts
  // the first one only when the runtime has never heard of any of them - so a switch is never
  // written under a name the runtime does not read, and a name it does have is never doubled
  ok(
    "and the choice is made against the settings the runtime actually holds",
    windowScript.includes("hasOwnProperty.call(box, keys[j])") && windowScript.includes("if (!key) key = keys[0]"),
    "",
  );
}

/* ---- 4. Discord's windows get Hypercord's preload ---------------------- */

// The mechanism, and the reason this file grew: Discord builds its own windows in
// its own main process, so the only place to put our preload in front of Discord's
// is the constructor Discord calls. Discord's own preload is not dropped - it is
// handed to us through the environment, because our preload has to run it.
const install = loader.installWindowPreload;
if (typeof install !== "function") {
  ok("src/loader.cjs exports installWindowPreload", false, "not exported yet");
} else {
  class StubWindow {
    constructor(options) {
      this.options = options;
      StubWindow.created.push(options);
    }
  }
  StubWindow.created = [];
  const electron = { app: { on: () => {} }, BrowserWindow: StubWindow };
  const PRELOAD = path.join(tmp, "attach-preload.cjs");

  delete process.env.HYPERCORD_DISCORD_PRELOAD;
  const swapped = install({ electron, preload: PRELOAD });
  ok("installWindowPreload reports the swap", swapped && swapped.ok !== false, JSON.stringify(swapped));
  ok("Electron's BrowserWindow is replaced in place", electron.BrowserWindow !== StubWindow, String(electron.BrowserWindow === StubWindow));

  new electron.BrowserWindow({ title: "Discord", webPreferences: { preload: "/discord/preload.js", sandbox: true } });
  const built = StubWindow.created[StubWindow.created.length - 1] || {};
  ok("the client's window loads our preload", built.webPreferences && built.webPreferences.preload === PRELOAD, JSON.stringify(built.webPreferences));
  ok("and Discord's own preload is kept for us to require afterwards", process.env.HYPERCORD_DISCORD_PRELOAD === "/discord/preload.js", String(process.env.HYPERCORD_DISCORD_PRELOAD));
  ok("the window is unsandboxed, because a sandboxed preload cannot read our files", built.webPreferences && built.webPreferences.sandbox === false, JSON.stringify(built.webPreferences));

  StubWindow.created.length = 0;
  new electron.BrowserWindow({ title: "Discord", webPreferences: { sandbox: true } });
  const noIncoming = StubWindow.created[StubWindow.created.length - 1] || {};
  ok("a window that brought no preload of its own is left alone", !noIncoming.webPreferences || noIncoming.webPreferences.preload === undefined, JSON.stringify(noIncoming.webPreferences));

  StubWindow.created.length = 0;
  new electron.BrowserWindow({ webPreferences: { preload: "/discord/helper.js" } });
  const untitled = StubWindow.created[StubWindow.created.length - 1] || {};
  ok("so is Discord's own untitled helper window", untitled.webPreferences && untitled.webPreferences.preload === "/discord/helper.js", JSON.stringify(untitled.webPreferences));
  ok("and the swap did not claim its preload as ours", process.env.HYPERCORD_DISCORD_PRELOAD === "/discord/preload.js", String(process.env.HYPERCORD_DISCORD_PRELOAD));
  delete process.env.HYPERCORD_DISCORD_PRELOAD;
}

/* ---- 5. closing the client closes it ----------------------------------- */

// Discord keeps itself alive with no window when the client is closed, which is a
// background process nobody asked for. The check is the wiring itself: which events it
// listens for, which window counts as the client's own, and that either event ends the
// process - a listener that is registered and a listener that never fires look the same
// from here, so they are fired.
if (typeof loader.quitWithTheWindows !== "function") {
  ok("src/loader.cjs exports quitWithTheWindows", false, "not exported yet");
} else {
  class MarkedWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      // Every BrowserWindow has contents, and it is now the *page* that says which window
      // this is - so a fixture without one is not a window, it is a stub nothing can be
      // asked about. The url comes from the options so a test can build Discord's splash
      // window as easily as its client window.
      this.webContents = {
        // mutable, because a window's page can change under it and the fixture has to be
        // able to say so - the client's window is empty at first and lands on Discord's
        // page a moment later
        url: String((options && options.url) || ""),
        getURL() {
          return this.url;
        },
        isLoading: () => false,
        once: (name, fn) => {
          this.webContents.waited = { name, fn };
        },
        // the page finishing, on the fixture: the injection is the event's consumer
        land: function () {
          const waited = this.waited;
          this.waited = null;
          if (waited && waited.name === "did-finish-load") waited.fn();
        },
      };
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
  }
  const exits = [];
  const closingApp = {
    handlers: [],
    on(event, fn) {
      closingApp.handlers.push([event, fn]);
    },
    exit: (code) => exits.push(code),
  };
  const emit = (event, ...args) => {
    for (const [name, fn] of closingApp.handlers) if (name === event) fn({}, ...args);
  };

  const wired = loader.quitWithTheWindows(closingApp);
  ok(
    "it listens for the client's own window closing and for the last window going",
    wired.ok === true && closingApp.handlers.some(([e]) => e === "browser-window-created") && closingApp.handlers.some(([e]) => e === "window-all-closed"),
    JSON.stringify(closingApp.handlers.map(([e]) => e)),
  );
  ok("an app it cannot close is refused rather than armed", loader.quitWithTheWindows(null).ok === false, "");

  const electron = { app: closingApp, BrowserWindow: MarkedWindow };
  const installed = loader.installWindowPreload({ electron, preload: path.join(tmp, "attach-preload.cjs") });
  ok("the window it will close is the one Hypercord took over", installed.ok === true, JSON.stringify(installed));
  // Discord's splash window: a title and a preload of its own, exactly like the client's
  // window, and on a local page instead of Discord - and the one window Discord always
  // closes, a couple of seconds in, without anybody asking it to. The client used to die
  // here: the splash was counted as the client's window, so its going away ended the
  // process (measured in the real client - window 1 is
  // `.../resources/hypercord.app.asar/splash/index.html`).
  const splash = new electron.BrowserWindow({
    title: "Discord",
    url: "file:///C:/Users/x/AppData/Local/Discord/app-1.0.9261/resources/hypercord.app.asar/splash/index.html",
    webPreferences: { preload: "/discord/preload.js" },
  });
  emit("browser-window-created", splash);
  splash.handlers.close && splash.handlers.close();
  ok("the splash going away is not the client closing", exits.length === 0, JSON.stringify(exits));
  emit("window-all-closed");
  ok("and the last window going before Discord's own page was ever loaded is not either", exits.length === 0, JSON.stringify(exits));

  const helper = new electron.BrowserWindow({ webPreferences: { preload: "/discord/helper.js" } });
  emit("browser-window-created", helper);
  helper.handlers.close && helper.handlers.close();
  ok("a helper window coming and going does not close the client", exits.length === 0, JSON.stringify(exits));

  // the client's window, which is the one that *lands* on Discord's page: it is handed over
  // before its page is loaded, so the url is empty when it is created and the answer comes
  // a moment later, on the window's own did-finish-load
  const loading = new electron.BrowserWindow({ title: "Discord", webPreferences: { preload: "/discord/preload.js" } });
  emit("browser-window-created", loading);
  ok("a Discord window is left alone until its page is there", exits.length === 0, JSON.stringify(exits));
  loading.webContents.url = "https://discord.com/app";
  loading.webContents.land();
  loading.handlers.close && loading.handlers.close();
  ok("closing the client's own window ends the process", exits.length === 1 && exits[0] === 0, JSON.stringify(exits));
  emit("window-all-closed");
  ok("and so does the last window going without a close of its own", exits.length === 2 && exits[1] === 0, JSON.stringify(exits));
}

/* ---- 6. closing the client takes Hypercord's activity with it ---------- */

// Inside a patched Discord the host is *ours*, running in Discord's own main process:
// plugins, the timers they asked for, an update interval and our ipc handlers. Closing
// Discord has to end all of it, and Discord does not end through one event - the window
// going, a menu quit, the app's own quit - so every path that ends it is fired here, and
// the teardown is watched happening *before* the process is allowed to exit.
if (typeof loader.stopHost !== "function") {
  ok("src/loader.cjs exports stopHost", false, "not exported yet");
} else {
  ok("stopHost is reachable from outside the loader", typeof loader.stopHost === "function");
  // with no host started there is nothing to stop, and saying so is the whole contract:
  // a teardown that throws where there is nothing to tear down would break a quit
  const idle = loader.stopHost();
  ok("stopHost with no host reports that there was nothing to stop", idle && idle.ok === true, JSON.stringify(idle));

  // one app per scenario: a handler registered by an earlier call would still be there to
  // answer a later event, and this test is about which event fires which teardown
  const appWith = (order, stop) => {
    const app = {
      handlers: [],
      on(event, fn) {
        this.handlers.push([event, fn]);
      },
      exit: (code) => order.push("exit:" + code),
    };
    app.emit = (event, ...args) => {
      for (const [name, fn] of app.handlers) if (name === event) fn({}, ...args);
    };
    loader.quitWithTheWindows(app, { stop });
    return app;
  };

  // The client window is built the way Discord builds it: through the replaced
  // BrowserWindow, so it carries the marker that says it is the client's own window. A
  // `window-all-closed` before that has happened is Discord's splash taking itself down in
  // the middle of a healthy startup, and it must not end the process - that is the bug this
  // check is here for (the client used to die about seventeen seconds after it opened).
  const buildClientWindow = (app) => {
    const electron = { app, BrowserWindow: class StubWindow {} };
    loader.installWindowPreload({ electron, preload: path.join(tmp, "attach-preload.cjs") });
    const win = new electron.BrowserWindow({ title: "Discord", webPreferences: { preload: "/discord/preload.js" } });
    if (typeof win.on !== "function") win.on = () => {};
    // the page, which is what makes this window the client's own (see section 5): the
    // window alone cannot say it, because Discord's splash window looks the same
    win.webContents = { getURL: () => "https://discord.com/app", isLoading: () => false };
    app.emit("browser-window-created", win);
    return win;
  };

  const early = [];
  const splashApp = appWith(early, () => early.push("stop"));
  splashApp.emit("window-all-closed");
  ok("a window that goes before the client has one is Discord's splash, not the client closing", early.length === 0, JSON.stringify(early));

  const closed = [];
  const closedApp = appWith(closed, () => closed.push("stop"));
  buildClientWindow(closedApp);
  closedApp.emit("window-all-closed");
  ok("once the client has had a window, the last window going tears the host down before the process exits", closed.join(",") === "stop,exit:0", JSON.stringify(closed));

  for (const event of ["before-quit", "will-quit", "quit"]) {
    const order = [];
    appWith(order, () => order.push("stop")).emit(event);
    ok(
      "a quit that never sees a window close still stops the host (" + event + ")",
      order.join(",") === "stop",
      JSON.stringify(order),
    );
  }

  // A plugin whose own stop() hangs must not hold the client open: the teardown is fired,
  // the quit proceeds, and the rejection is answered rather than left unhandled - which is
  // the difference between a client that closes and one that exits with an error nobody
  // can see.
  const rejections = [];
  const onRejection = (reason) => rejections.push(String((reason && reason.message) || reason));
  process.on("unhandledRejection", onRejection);
  const failing = [];
  let threw = "";
  const failingApp = appWith(failing, () => {
    failing.push("stop");
    return Promise.reject(new Error("a plugin hung"));
  });
  try {
    buildClientWindow(failingApp);
    failingApp.emit("window-all-closed");
  } catch (err) {
    threw = String((err && err.message) || err);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.off("unhandledRejection", onRejection);
  ok("a teardown that rejects is not thrown into the quit path", threw === "", threw);
  ok("and the process is still allowed to exit", failing.join(",") === "stop,exit:0", JSON.stringify(failing));
  ok("and its rejection is answered, not left unhandled", rejections.length === 0, JSON.stringify(rejections));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
