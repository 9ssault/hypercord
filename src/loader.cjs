// language: JavaScript, file: src/loader.cjs
//
// The loader. This is the file Discord's patched entry point requires, so it
// runs inside Discord's own Electron main process - not inside Hypercord's.
// That decides everything about it:
//
//   * CommonJS and node builtins only, because that is what it is loaded as;
//   * it is required for its side effect, so starting is what requiring it does
//     (guarded, so a plain `require` in a test or a linter attaches to nothing);
//   * it writes two things into a Discord window, both through
//     webContents.executeJavaScript: a <style> element with the themes, and the built
//     plugin runtime. The second one is what makes the vendored catalogue runnable at
//     all - those plugins are TypeScript sources that reach into Discord's own webpack
//     runtime, so they only exist as the one script upstream's build produces. Both run
//     in the page's own world by Electron's own rule for executeJavaScript, which is why
//     the settings sheet, which runs there too, can drive the plugins it installs;
//   * it writes one file into Hypercord's data directory - runtime.log - because a
//     patched Discord is a GUI process whose stdout goes nowhere, so the one thing worth
//     knowing about the runtime (did it install, and how many plugins did it find) would
//     otherwise be unreadable in exactly the run where it matters;
//   * no timers and no polling: windows as they appear, and nothing on an
//     interval, which is the same rule the rest of the client follows.
//
// The CSS comes from Hypercord's own state, handed over at patch time
// (resources/app/hypercord.json) or through HYPERCORD_LOADER_CONFIG. When there
// is nothing to inject it says so once and attaches nothing, rather than
// pretending.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const STYLE_ID = "hypercord-theme";

/**
 * The windows already wired to be injected into.
 *
 * A window is handed to the loader more than once - it is both in the list of open windows
 * and announced as created - and what must happen once is the *wiring*: a second
 * did-finish-load handler would inject twice per load for no reason. The injection itself
 * runs on every one of those events, which is the difference this WeakSet is careful about.
 */
const WATCHED = new WeakSet();

/**
 * The host this loader started, kept so it can be taken down again.
 *
 * A host that is never stopped is a plugin host, an ipc handler set and an update
 * interval still live inside a process that is on its way out: `exit(0)` hides that
 * rather than ending it, and anything of ours that is mid-flight (a token write, an
 * update check) is cut off instead of finishing. Held here, at module scope, because
 * the teardown is called from an event, not from the code that started it.
 */
let runningHost = null;
let stopping = false;

/**
 * The mark that says a window is the client's own rather than one of its helpers.
 *
 * It is set on the windows Hypercord took over, in the constructor Discord calls, and it
 * is what tells the close handling below which window is the one whose closing means the
 * client is closing: an untitled helper window coming and going is none of its business.
 */
const CLIENT_WINDOW = Symbol.for("hypercord.clientWindow");

/** The script handed to executeJavaScript: one style element, and nothing else. */
function buildInjection({ css = "" } = {}) {
  return (
    "(() => {\n" +
    "  const CSS = " + JSON.stringify(String(css || "")) + ";\n" +
    "  const root = document.documentElement;\n" +
    "  let style = document.getElementById(" + JSON.stringify(STYLE_ID) + ");\n" +
    "  if (!style) {\n" +
    "    style = document.createElement('style');\n" +
    "    style.id = " + JSON.stringify(STYLE_ID) + ";\n" +
    "    (document.head || root).appendChild(style);\n" +
    "  }\n" +
    "  style.textContent = CSS;\n" +
    "  return { ok: true, css: CSS.length };\n" +
    "})()"
  );
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) || null;
  } catch {
    return null;
  }
}

/**
 * The built plugin runtime, on disk.
 *
 * The catalogue's 371 entries are TypeScript *sources*, and no amount of pointing a
 * loader at them makes them run: they import Vencord's own modules and look Discord's
 * internals up through the webpack runtime that only exists inside a loaded page. The
 * vendored tree ships a build for exactly that (`scripts/build/build.mjs`, run with the
 * toolchain in `vendor/equicord/node_modules`), and its output is one script that
 * installs the runtime, the plugin manager and every plugin into the page.
 *
 * So the vendored catalogue is served the way upstream serves it: the built script is
 * injected once per window, in the page's own world, before anything of ours looks for
 * a plugin in it. The first line of the file names the build (`// Equicord <commit>`),
 * which is what makes a stale bundle diagnosable rather than mysterious.
 */
function readRuntime(opts = {}) {
  const override = String(opts.runtimeFile || process.env.HYPERCORD_RUNTIME || "");
  // The *browser* build comes first, and it is not an accident: it is the artifact upstream
  // builds to be injected into a loaded page, with its own fallbacks for everything a page
  // cannot do (settings and quick CSS on the page's storage, no native bridge needed). The
  // desktop build is the one for their own patcher, which brings a native bridge and a main
  // process of its own; injecting it raw into someone else's page is the harder road, so it
  // is the fallback rather than the choice.
  const candidates = override
    ? [override]
    : [
        path.join(__dirname, "..", "vendor", "equicord", "dist", "browser", "browser.js"),
        path.join(__dirname, "..", "vendor", "equicord", "dist", "desktop", "renderer.js"),
        // What a *release* carries. The vendored tree is a submodule with its own toolchain, so
        // it is not in this repository's packages: without this copy a packed client had no
        // runtime at all - every vendored plugin's card said "no runtime", and the catalogue was
        // unloadable in exactly the build a person downloads. `npm run build:runtime` writes it
        // (see scripts/build_runtime.mjs), and the packaged check asserts it is in the page.
        path.join(__dirname, "..", "vendor", "runtime", "browser.js"),
      ];
  let last = "";
  for (const file of candidates) {
    try {
      const source = fs.readFileSync(file, "utf8");
      const first = String(source.split("\n", 1)[0] || "").replace(/^\/\/\s*/, "").trim();
      // And the stylesheet that ships *beside* the bundle rather than inside it. The browser
      // build is a userscript, and a userscript's stylesheet is a second file its loader puts
      // in the page (`browser.css`, 218kb of it, next to `browser.js`); the bundle itself
      // contains no `.vc-` rule at all - measured, not assumed: `grep vc-card-base
      // vendor/runtime/browser.js` finds nothing and `browser.css` defines it three times.
      // Injecting the script and not this file is why every one of the runtime's own surfaces
      // - its plugin page, its theme page, its settings windows, its toasts - was drawn as
      // bare markup with no stylesheet behind it, which is what a broken browser of hundreds
      // of plugins looks like when the list itself is fine.
      let css = "";
      const stylesheet = file.replace(/\.js$/i, ".css");
      try {
        css = fs.readFileSync(stylesheet, "utf8");
      } catch {
        /* a build with no stylesheet beside it: the bundle still runs, unstyled as it was */
      }
      return { ok: true, file, source, css, stylesheet, version: (first || "unknown build") + " (" + path.basename(file) + ")" };
    } catch (err) {
      last = String((err && err.message) || err);
    }
  }
  return { ok: false, file: candidates[0], error: "the plugin runtime is not built: " + last };
}

/**
 * The script that installs the runtime in a page.
 *
 * Two details decide whether this works at all. The bundle declares `var Vencord` at its
 * own top level, so it has to be evaluated as a *script* (where `var` is global), not
 * inside a function - that is what puts `Vencord` on the page where the settings sheet
 * and any plugin can reach it. And the guard has to be a separate statement before it,
 * because re-running the bundle would re-patch Discord's modules on top of the first
 * pass. The value the script evaluates to is the runtime's own report: how it went, and
 * how many plugins it knows.
 */
function buildRuntimeInjection({ source = "", version = "", marker = "__hypercordRuntime", native = true, enabled = [], css = "" } = {}) {
  const key = JSON.stringify(String(marker));
  const stamp = JSON.stringify(String(version));
  // The runtime's own stylesheet, first, and whether or not the bundle is already in the page:
  // a window whose script landed but whose stylesheet did not is the broken-looking one, and
  // the guard is an id rather than a variable so a second injection cannot add it twice. It
  // runs before the bundle for the same reason the bundle does: the runtime's first draw is
  // while it is being imported.
  // It is placed by a function rather than straight away, because the preload runs this while
  // the document is still being created: there is a `document` to create a style element with
  // and no root to put it in yet (the runtime's own styles do the same thing - its
  // `vencord-root` is appended on DOMContentLoaded for exactly this reason). So the placement
  // is retried on DOMContentLoaded, and the report calls it once more so that a window whose
  // stylesheet *is* there cannot be reported as one whose is not.
  const stylesheet = String(css || "")
    ? "(function () {\n" +
      "  var CSS = " + JSON.stringify(String(css)) + ";\n" +
      "  var place = function () {\n" +
      "    try {\n" +
      "      if (document.getElementById('hypercord-runtime-css')) return true;\n" +
      "      var root = document.head || document.documentElement;\n" +
      "      if (!root) return false;\n" +
      "      var sheet = document.createElement('style');\n" +
      "      sheet.id = 'hypercord-runtime-css';\n" +
      "      sheet.setAttribute('data-hypercord', 'runtime');\n" +
      "      sheet.textContent = CSS;\n" +
      "      root.appendChild(sheet);\n" +
      "      return true;\n" +
      "    } catch (e) { return false; }\n" +
      "  };\n" +
      "  window.__hypercordRuntimeCss = place;\n" +
      "  if (!place()) {\n" +
      "    try { document.addEventListener('DOMContentLoaded', place, { once: true }); } catch (e) {}\n" +
      "  }\n" +
      "})();\n"
    : "";
  // The runtime reads a native bridge for the things a page cannot do itself - settings,
  // quick CSS, the theme folder, the updater - and it reads the *settings* half
  // synchronously while it is being imported (`VencordNative.settings.get()` feeds its
  // settings store directly), so it cannot be filled in later: without it the whole bundle
  // throws on the way in and the catalogue stays unloadable.
  //
  // Two properties of this page decide the shape of the bridge below, both measured on
  // discord.com/app rather than assumed:
  //
  //   * the bundle installs a bridge of its own (`window.VencordNative = { ... }`), and a
  //     plain assignment threw ours away - so the switches this file records were handed to
  //     a store that had already been replaced, and a plugin switched on with "restart to
  //     apply" came back off at every start. `VencordNative` is therefore installed with a
  //     *setter*: the bundle's own object is kept for everything it is better at (themes,
  //     quick CSS, the plugin helpers, the content-security policy) and its `settings`
  //     half is grafted over, because that half is the one this client owns;
  //   * the page has no storage at all - `localStorage` and `sessionStorage` are both
  //     *removed* there - so a store backed by them forgets every option and every switch
  //     by the next start. Ours reads and writes Hypercord's own file through the preload
  //     (see `runtimeStore`), which is synchronous on both sides, and falls back to the
  //     page's storage and then to this window's memory for a page that has neither.
  //
  // The operator's switches are applied on top of the stored settings, and on top of each
  // other's fields, so a plugin's own options survive while the switch stays ours: this file
  // is the owner of "is this plugin on", and nothing in the page can quietly overturn it.
  // See readRuntimeChoices for why the record is not kept in the page.
  // One entry per chosen plugin: the names the runtime might know it by, best first. The runtime keeps
  // its plugins and their settings under the plugin's own name, which is not always the name the
  // catalogue gives it (see runtimeKeysFor), so the key is decided here, against the settings object
  // the runtime itself holds - a name it has never heard of is inserted (the old behaviour), and one
  // it knows is merged into so both stores stay under the same key.
  const asked = JSON.stringify(Array.isArray(enabled) ? enabled : []);
  const shim = native
    ? "(function () {\n" +
      "  if (window.__hypercordBridge) return;\n" +
      "  window.__hypercordBridge = true;\n" +
      "  var asked = " + asked + ";\n" +
      "  var bridge = function () {\n" +
      "    try { return window.hypercord && window.hypercord.runtime && window.hypercord.runtime.settings ? window.hypercord.runtime.settings : null; } catch (e) { return null; }\n" +
      "  };\n" +
      "  var memory = null;\n" +
      "  var read = function () {\n" +
      "    var box = bridge();\n" +
      "    if (box && typeof box.read === 'function') { try { var raw = box.read(); if (typeof raw === 'string' && raw) return JSON.parse(raw); } catch (e) {} }\n" +
      "    try { var held = window.localStorage.getItem('hypercord.runtime.settings'); if (held) return JSON.parse(held); } catch (e) {}\n" +
      "    return memory && typeof memory === 'object' ? memory : {};\n" +
      "  };\n" +
      "  var write = function (data) {\n" +
      "    var text = '';\n" +
      "    try { text = JSON.stringify(data); } catch (e) { return false; }\n" +
      "    var box = bridge();\n" +
      "    if (box && typeof box.write === 'function') { try { if (box.write(text)) return true; } catch (e) {} }\n" +
      "    try { window.localStorage.setItem('hypercord.runtime.settings', text); return true; } catch (e) {}\n" +
      "    memory = data;\n" +
      "    return false;\n" +
      "  };\n" +
      "  var withChoices = function (data) {\n" +
      "    var out = data && typeof data === 'object' ? data : {};\n" +
      "    var box = out.plugins && typeof out.plugins === 'object' ? out.plugins : (out.plugins = {});\n" +
      "    for (var i = 0; i < asked.length; i++) {\n" +
      "      var keys = asked[i];\n" +
      "      var key = '';\n" +
      "      for (var j = 0; j < keys.length; j++) { if (Object.prototype.hasOwnProperty.call(box, keys[j])) { key = keys[j]; break; } }\n" +
      "      if (!key) key = keys[0];\n" +
      "      box[key] = Object.assign({}, box[key], { enabled: true });\n" +
      "    }\n" +
      "    return out;\n" +
      "  };\n" +
      "  var mine = {\n" +
      "    settings: { get: function () { return withChoices(read()); }, set: function (data) { return write(data); }, getSettingsDir: function () { return ''; }, openFolder: function () {} },\n" +
      "    quickCss: { get: function () { return ''; }, set: function () { return false; }, openEditor: function () { return false; } },\n" +
      "    themes: { getThemesList: function () { return []; }, getSystemValues: function () { return { theme: 'dark' }; }, openFolder: function () {}, uploadTheme: function () { return false; }, getThemeData: function () { return null; } },\n" +
      "    updater: { getUpdates: function () { return []; } },\n" +
      "    native: { openExternal: function (url) { try { window.open(String(url), '_blank', 'noopener'); } catch (e) {} } }\n" +
      "  };\n" +
      // The bundle's own object, with our settings grafted on: every other half it makes for
      // itself is kept, and the half this client owns is the one that survives.
      "  var graft = function (value) {\n" +
      "    var box = value && typeof value === 'object' ? value : {};\n" +
      "    var theirs = box.settings && typeof box.settings === 'object' ? box.settings : {};\n" +
      "    var settings = {};\n" +
      "    for (var a in theirs) settings[a] = theirs[a];\n" +
      "    for (var b in mine.settings) settings[b] = mine.settings[b];\n" +
      "    box.settings = settings;\n" +
      "    return box;\n" +
      "  };\n" +
      "  var held = null;\n" +
      "  try {\n" +
      "    Object.defineProperty(window, 'VencordNative', {\n" +
      "      configurable: true,\n" +
      // Before the bundle installs its own, ours answers - that is the bridge it reads while
      // importing. After, the bundle's object answers with our settings grafted into it.
      "      get: function () { return held || mine; },\n" +
      "      set: function (value) { held = graft(value); }\n" +
      "    });\n" +
      "  } catch (e) { window.VencordNative = mine; }\n" +
      "})();\n"
    : "";
  return (
    stylesheet +
    shim +
    // The guard is a *block*, not a function that returns early: the bundle declares
    // `var Vencord` at its own top level, and only a top-level `var` becomes the global the
    // page and the settings sheet reach. Putting the bundle inside a function would keep
    // the runtime private to that call, and letting the guard merely return early would let
    // a second injection re-patch Discord's modules on top of the first pass.
    "var __hypercordAlready = window[" + key + "] === " + stamp + ";\n" +
    "var __hypercordError = \"\";\n" +
    "if (!__hypercordAlready) {\n" +
    // `executeJavaScript` reports only "script failed to execute", which is useless in a
    // GUI process nobody can open a console in. The bundle is therefore evaluated inside a
    // try/catch so the reason travels back with the rest of the report and lands in
    // runtime.log: a thrown error here is the difference between a page with 371 plugins
    // and a page with none, and it has to be readable from the outside.
    "  try {\n" +
    String(source) +
    "\n  } catch (err) {\n" +
    "    __hypercordError = String((err && err.stack) || (err && err.message) || err).slice(0, 800);\n" +
    "  }\n" +
    "  if (__hypercordError) {\n" +
    "    window[" + key + "] = \"\";\n" +
    "  } else {\n" +
    "    window[" + key + "] = " + stamp + ";\n" +
    "    if (typeof Vencord !== \"undefined\") window.Vencord = Vencord;\n" +
    "  }\n" +
    "}\n" +
    "(function () {\n" +
    "  var V = window.Vencord;\n" +
    "  var box = V && V.Plugins && V.Plugins.plugins ? V.Plugins.plugins : null;\n" +
    // `vencord` and `url` are here because "0 plugins" on its own is not a diagnosis: a
    // page the bundle never reached and a page it reached and could not use look identical
    // in a log that only counts plugins. Both are read from where the bundle would have put
    // them, so the line says which of the two it was.
    // `css` for the same reason `plugins` is here: a runtime whose pages are drawn without its
    // stylesheet is a page that looks broken while every count in this report says it is fine.
    // Read defensively and by asking the placer as well, so a window whose stylesheet is
    // there is never reported as one whose is not; this same script is also evaluated in test
    // contexts that have no document at all.
    "  var __hypercordCss = false;\n" +
    "  try { __hypercordCss = (typeof window.__hypercordRuntimeCss === 'function' && window.__hypercordRuntimeCss() === true) || Boolean(document.getElementById('hypercord-runtime-css')); } catch (e) {}\n" +
    "  return { ok: Boolean(V) && !__hypercordError, already: __hypercordAlready, version: " + stamp + ", plugins: box ? Object.keys(box).length : 0, css: __hypercordCss, vencord: typeof V, url: String((window.location && window.location.href) || \"\"), bridge: Boolean(window.hypercord && window.hypercord.runtime), error: __hypercordError };\n" +
    "})()"
  );
}

/**
 * The switches the operator set for the built runtime, read from Hypercord's own state file.
 *
 * This is the half of the plugin state the runtime cannot keep for itself. It stores its
 * settings through the page's storage, and Discord's own page has none: `localStorage` and
 * `sessionStorage` are both *removed* there (measured on discord.com/app - undefined - while
 * they are objects on example.com and on a local file), so a flag written in the page is gone
 * by the next start. The record lives in Hypercord's data directory instead, this reads it,
 * and the shim built below hands it to the runtime as the settings it starts from - which is
 * what makes a switch in the settings sheet survive a restart of Discord.
 */
function readRuntimeChoices({ dataDir = "" } = {}) {
  try {
    const file = path.join(dataDir || hypercordDataDir(), "plugins.state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    return Array.isArray(saved.runtime) ? saved.runtime.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The built runtime's own settings, in Hypercord's data directory.
 *
 * The runtime keeps its settings the way a web app does, and Discord's page has nowhere to
 * put them: `localStorage` and `sessionStorage` are both *removed* there (measured on
 * discord.com/app). So its settings store came up empty on every start - every plugin's
 * options and the runtime's own idea of which plugin is on were gone by the next run, and a
 * plugin switched on with "restart to apply" came back off. The page asks *this* instead,
 * through the preload's bridge (`window.hypercord.runtime.settings`), which is why the file
 * below is read and written synchronously: the bundle reads its settings while it is being
 * imported, and an asynchronous answer arrives after the store has already been built.
 *
 * The file is bounded, parsed before it is written, and swapped in atomically, so a crash
 * during a save leaves the previous settings rather than half a file.
 */
function runtimeStore({ ipcMain = null, dataDir = "", log = () => {} } = {}) {
  const file = path.join(dataDir || hypercordDataDir(), "runtime.settings.json");
  const LIMIT = 4 * 1024 * 1024;
  const read = () => {
    try {
      const raw = String(fs.readFileSync(file, "utf8") || "");
      if (!raw || raw.length > LIMIT) return "{}";
      JSON.parse(raw);
      return raw;
    } catch {
      return "{}";
    }
  };
  const write = (text) => {
    try {
      const out = JSON.stringify(JSON.parse(String(text)));
      if (out.length > LIMIT) return false;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const staging = file + ".tmp";
      fs.writeFileSync(staging, out);
      fs.renameSync(staging, file);
      return true;
    } catch {
      return false;
    }
  };
  const ok = Boolean(ipcMain && typeof ipcMain.on === "function");
  if (ok) {
    ipcMain.on("hypercord:runtime-settings", (event, action, payload) => {
      // the answer is the reply: the page's read is synchronous, so it is `returnValue` and
      // never a promise, and an action this file does not know is a `false`, not a throw
      event.returnValue = action === "read" ? read() : action === "write" ? write(payload) : false;
    });
  }
  return { ok, file, read, write, log };
}

/**
 * Where a window is, as a string, or "" when it cannot be asked.
 */
function pageUrl(contents) {
  try {
    return String(contents && typeof contents.getURL === "function" ? contents.getURL() || "" : "");
  } catch {
    return "";
  }
}

/**
 * Whether a window is on Discord's own page, which is what a Discord window is.
 *
 * This is the test for two different questions and it has to be the same one for both: the
 * runtime may only be injected into a page that is Discord (2.5 MB of webpack patches and
 * a localStorage read on the way in - see `attach`), and a window may only be *the client's*
 * when it is showing the client (`quitWithTheWindows`).
 *
 * What it is deliberately not is "has a title and a preload": Discord's own splash window
 * has both. It is `.../resources/hypercord.app.asar/splash/index.html` - a local file, not
 * Discord - and it is the window Discord always closes, a couple of seconds in, without
 * asking. Counting it as the client is what made this client die at startup, and no amount
 * of guessing about titles fixes that: the page says which window it is.
 */
function isDiscordPage(contents) {
  const url = pageUrl(contents);
  return /^https:\/\/(?:[a-z0-9-]+\.)?discord\.com(?:\/|$)/i.test(url) || /^https:\/\/(?:[a-z0-9-]+\.)?discordapp\.com(?:\/|$)/i.test(url);
}

/**
 * One line per window about the runtime, in the data directory.
 *
 * A patched Discord is a GUI process whose stdout goes nowhere, so a loader that only
 * logged would be unreadable in exactly the run where it matters. This is the file the
 * loader's report lands in, next to signin.log, and it is what makes "did the built
 * plugins load in the real client" a question with an answer.
 */
function noteRuntime(line, { dataDir = "", log = () => {} } = {}) {
  const text = String(line || "");
  log("[hypercord] " + text);
  try {
    const dir = dataDir || hypercordDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "runtime.log"), new Date().toISOString() + " " + text + "\n");
  } catch {
    /* a report that cannot be written is still a report that was logged */
  }
}

/**
 * Where the CSS comes from, in the order that keeps the client self-describing:
 * what was baked in when Discord was patched, then an explicit override, then a
 * hypercord.json beside this loader (i.e. in Hypercord's own app).
 */
function loadConfig({ dir = __dirname, env = process.env, mainDir = "" } = {}) {
  const config = String(env.HYPERCORD_LOADER_CONFIG || "").trim();
  if (config) {
    const baked = readJson(config);
    if (baked && baked.css) return { css: String(baked.css), found: config };
  }
  if (mainDir) {
    const baked = readJson(path.join(mainDir, "hypercord.json"));
    const assets = baked && baked.assets && typeof baked.assets === "object" ? baked.assets : null;
    if (assets && assets.css) return { css: String(assets.css), found: path.join(mainDir, "hypercord.json") };
  }
  for (const file of [path.join(dir, "..", "hypercord.json"), path.join(dir, "hypercord.json")]) {
    const beside = readJson(file);
    if (beside && beside.css) return { css: String(beside.css), found: file };
  }
  return { css: "", found: "" };
}

/**
 * Attach to Discord's windows. `appLike` is only ever used through `on`,
 * `whenReady` and `BrowserWindow.getAllWindows`, which is what makes this
 * testable without Discord: a fake app object is enough.
 */
/**
 * The same list, as the names the runtime might know each plugin by.
 *
 * Hypercord keys a plugin the way its own catalogue does - by the directory the plugin's source
 * lives in ("accountPanelServerProfile") - and the runtime keys the same plugin by the plugin's own
 * name ("AccountPanelServerProfile"), which is what its plugin list and its settings are both keyed
 * by. So a switch handed over under the catalogue's id lands where the runtime never looks: the
 * choice survived to the next start and was then quietly ignored, which is the failure that looks
 * like a record that was never written.
 *
 * There is no single reliable spelling in the catalogue to convert to. Measured against the built
 * bundle's own 372 keys: the catalogue's `name` is the runtime's key for 336 of the 371 entries,
 * the directory's name in upper camel ("voiceJoinMessages" -> "VoiceJoinMessages") is the key for
 * 318, they agree on 309, and between them they cover 345 - the other 26 are plugins this build
 * does not ship at all (platform variants and dev plugins). Each entry therefore travels with the
 * keys it could be, best first, and the injected shim turns on whichever one the runtime's settings
 * actually have (see buildRuntimeInjection): given a name the runtime has never heard of, it inserts
 * the first candidate, which is the behaviour that existed before this mapping did.
 */
function runtimeKeysFor(ids, { manifestFile = "" } = {}) {
  const named = new Map();
  if (manifestFile) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) || {};
      for (const entry of Array.isArray(manifest.plugins) ? manifest.plugins : []) {
        if (entry && entry.id) named.set(String(entry.id), String(entry.name || ""));
      }
    } catch {
      /* no catalogue to read: the id itself is the only candidate, as it was before */
    }
  }
  return (Array.isArray(ids) ? ids : []).map((id) => {
    const key = String(id);
    // some ids carry the platform the plugin belongs to on the end ("clipUpload.desktop"); the
    // runtime's own key never does
    const bare = key.split(".")[0];
    const pascal = bare.replace(/^./, (c) => c.toUpperCase());
    const name = named.get(key) || "";
    // the catalogue's id itself is never one of them: the runtime's keys are the plugins' names,
    // and the id is the directory ("voiceJoinMessages"), which no key is
    return [...new Set([name, pascal].filter(Boolean))];
  });
}

/**
 * The script that installs the runtime in a page, built from this install.
 *
 * One place builds it, because two things inject it: the preload, at document start, which is
 * the only moment the runtime can do its job - it patches Discord's webpack as Discord defines
 * its module factories, and a runtime that arrives after those have loaded can list all 372
 * plugins and reach not one of them (measured: `Webpack.wreq` undefined, `findModuleId`
 * throwing, every plugin "started" with its patches applied to nothing) - and the loader's own
 * did-finish-load pass, which is what a window with no preload of ours still gets.
 */
function runtimeScriptFor(opts = {}) {
  const runtime = opts.runtime || readRuntime(opts);
  if (!runtime.ok) return "";
  const manifestFile = opts.manifestFile || path.join(opts.dir || __dirname, "..", "plugins", "manifest.json");
  const chosen = runtimeKeysFor(readRuntimeChoices({ dataDir: opts.dataDir || "" }), { manifestFile });
  return buildRuntimeInjection({ source: runtime.source, version: runtime.version, enabled: chosen, css: runtime.css || "" });
}

/**
 * Hands the preload the script to inject, for the windows that load before ours can reach them.
 *
 * Synchronous for the same reason the passkey policy is: the preload asks while the document is
 * being created and has to have the answer in hand before the page's own scripts run. An empty
 * answer is legal and means "no runtime" (`HYPERCORD_RUNTIME=off`, or a tree whose bundle was
 * never built), and the preload then leaves the page alone.
 */
function registerRuntimeScript({ ipcMain = null, script = "", log = () => {} } = {}) {
  const text = String(script || "");
  const ok = Boolean(ipcMain && typeof ipcMain.on === "function");
  if (ok) {
    ipcMain.on("hypercord:runtime-script", (event) => {
      event.returnValue = text;
    });
  }
  return { ok, bytes: text.length, log };
}

function attach(appLike, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const cfg = opts.config || loadConfig({ dir: opts.dir || __dirname, env: opts.env || process.env, mainDir: opts.mainDir || "" });
  const css = opts.css === undefined ? cfg.css : String(opts.css || "");
  const script = buildInjection({ css });
  let injected = 0;

  if (!appLike || typeof appLike.on !== "function") return { ok: false, error: "no app to attach to", injected };
  // Nothing to style is not nothing to inject: the stylesheet is skipped below, and the
  // plugin runtime still goes in - it is not ours to leave out on the theme's account. A
  // client patched with no assets used to come up with no plugins at all, silently.
  if (!css) log("[hypercord] no theme or injected assets were handed to the loader, so the windows get the plugin runtime and no styling");

  // The vendored catalogue's plugins only exist once this has run: see readRuntime above.
  // `HYPERCORD_RUNTIME=off` leaves it out, and a tree whose runtime was never built gets
  // one honest line instead of a page that silently has no plugins in it.
  const runtimeOpt = String(opts.env ? opts.env.HYPERCORD_RUNTIME : process.env.HYPERCORD_RUNTIME || "");
  const runtime = opts.runtime || (runtimeOpt.toLowerCase() === "off" ? { ok: false, file: "", error: "disabled by HYPERCORD_RUNTIME=off" } : readRuntime(opts));
  // the operator's switches, under the names the runtime might know them by (see runtimeKeysFor)
  const manifestFile = opts.manifestFile || path.join(opts.dir || __dirname, "..", "plugins", "manifest.json");
  const chosen = runtimeKeysFor(readRuntimeChoices({ dataDir: opts.dataDir || "" }), { manifestFile });
  const runtimeScript = runtime.ok ? runtimeScriptFor({ ...opts, runtime, manifestFile }) : "";
  let runtimeInjected = 0;
  let skippedPages = 0;

  const injectRuntime = (contents, label) => {
    if (!runtimeScript || typeof contents.executeJavaScript !== "function") return false;
    Promise.resolve(contents.executeJavaScript(runtimeScript)).then(
      (report) => {
        runtimeInjected += 1;
        const shape = report && typeof report === "object" ? report : {};
        // the shape a report comes back in is not guaranteed by executeJavaScript: a
        // script whose value is undefined resolves to undefined, and reading fields off
        // that is how "0 plugins" was printed for a run that had not happened at all
        const where = shape.vencord ? " (vencord " + shape.vencord + ", " + String(shape.url || "no url").slice(0, 80) + ")" : "";
        if (shape.error) noteRuntime("plugin runtime threw in " + label + ": " + String(shape.error), { dataDir: opts.dataDir || "", log });
        else if (shape.plugins)
          noteRuntime(
            shape.already
              ? "plugin runtime already in " + label + " (" + runtime.version + ")"
              : "plugin runtime in " + label + ": " + String(shape.plugins) + " plugins, build " + runtime.version,
            { dataDir: opts.dataDir || "", log },
          );
        else noteRuntime("the plugin runtime reported no plugins in " + label + where + ": " + (shape.already ? "the build was already there" : "it ran and the page has no runtime"), { dataDir: opts.dataDir || "", log });
        // Its own pages are drawn with its own stylesheet, and one without the other is the
        // state that reads as "broken": every card there, every switch there, none of it
        // styled. Said out loud rather than left to be noticed.
        if (shape.css === false) noteRuntime("the plugin runtime's stylesheet is not in " + label + ": its own pages will be drawn unstyled", { dataDir: opts.dataDir || "", log });
      },
      (err) => noteRuntime("plugin runtime failed in " + label + ": " + String((err && err.message) || err), { dataDir: opts.dataDir || "", log }),
    );
    return true;
  };

  /**
   * Everything one window needs, every time its page is loaded.
   *
   * Every load, not only the first one: both of the things injected here live on the page
   * - a <style> element, and the runtime's own global - so a reload takes both away. That
   * was measured, not assumed: after one reload of Discord's page, `window.Vencord` was
   * undefined (372 plugins before it, none after) and the theme's style element was gone
   * with it. What that looks like from the client is a window that has gone back to plain
   * Discord and a Plugins page where every vendored plugin says "TypeScript source, not
   * built" - the settings sheet finds no runtime to drive and asks our own host instead,
   * which is right to refuse it. Ctrl+R, a Discord update, and switching account all end
   * in a reload, so this is not a rare path.
   *
   * Re-injecting on a page that already has them is free: the stylesheet finds its element
   * by id, and the runtime is stamped with the build it installed and stops at the guard.
   */
  const injectInto = (contents, label) => {
    if (!contents || typeof contents.executeJavaScript !== "function") return false;
    if (css) {
      Promise.resolve(contents.executeJavaScript(script)).then(
        () => {
          injected += 1;
          log("[hypercord] injected into " + label);
        },
        (err) => log("[hypercord] injection failed: " + String((err && err.message) || err)),
      );
    }
    // the runtime goes in after the stylesheet and independently of it: a page with the
    // theme and no plugins is a better failure than a page with neither - and only into
    // Discord's own page, which is the only window it can run in (see isDiscordPage)
    if (!isDiscordPage(contents)) {
      if (skippedPages < 3) {
        skippedPages += 1;
        noteRuntime("no plugin runtime in " + label + ": that window is not on Discord's page (" + (pageUrl(contents) || "no url") + ")", { dataDir: opts.dataDir || "", log });
      }
      return true;
    }
    injectRuntime(contents, label);
    return true;
  };

  const handle = (win) => {
    if (!win || !win.webContents) return;
    const contents = win.webContents;
    // once per window, however many times it is handed to us: what runs again is the
    // injection below, not this registration
    const label = String(win.id || "window");
    if (WATCHED.has(contents)) return;
    WATCHED.add(contents);
    // The page can be loaded again at any time - a reload, an update, a navigation - so the
    // injection is wired to the load itself rather than run once here and hoped for. This is
    // the event the page is guaranteed to fire, and the injection is idempotent, so the
    // cost of a load that changes nothing is one no-op script per page.
    if (typeof contents.on === "function") contents.on("did-finish-load", () => injectInto(contents, label));
    else if (typeof contents.once === "function") contents.once("did-finish-load", () => injectInto(contents, label));
    // and now, if the page is already there. A window whose page is not loaded yet - and a
    // window that has no url at all, which is Discord's windows the instant they are built -
    // would only be injected into while it was still empty, which is what cost the client's
    // own window its runtime (the runtime is for Discord's page, and the gate cannot tell
    // one from an empty window).
    const loading = typeof contents.isLoading === "function" && contents.isLoading();
    if (!loading && pageUrl(contents)) injectInto(contents, label);
  };

  const all = appLike.BrowserWindow && typeof appLike.BrowserWindow.getAllWindows === "function" ? appLike.BrowserWindow.getAllWindows() : [];
  for (const win of Array.isArray(all) ? all : []) handle(win);
  appLike.on("browser-window-created", (_event, created) => {
    // Electron passes (event, window); anything else that looks like a window is
    // accepted so a version difference cannot silently stop the injection
    handle(created && created.webContents ? created : _event);
  });
  if (!runtime.ok) noteRuntime(runtime.error || "no plugin runtime to inject", { dataDir: opts.dataDir || "", log });
  return { ok: true, injected, empty: !css, config: cfg.found, script, runtime: { ok: Boolean(runtime.ok), file: runtime.file, version: runtime.version || "", error: runtime.error || "" }, runtimeInjected };
}

/**
 * Where Hypercord's own data lives, whoever is running this loader.
 *
 * In the patched client the process belongs to Discord, so `app.getPath("userData")`
 * is Discord's directory and cannot be used: the plugin state, the token store, the
 * themes and the log would all land in Discord's profile. The paths are the ones the
 * README documents for Hypercord itself.
 */
function hypercordDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Hypercord");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Hypercord");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Hypercord");
}

/**
 * Hand Discord's own windows to Hypercord's preload.
 *
 * This is the piece that makes the patched client *be* the client rather than a themed
 * Discord: without it nothing of ours runs in Discord's page at all, because a preload
 * is the only code that gets there before Discord's own bundle. It replaces Electron's
 * BrowserWindow with a subclass, so that every window Discord creates loads our preload
 * - and therefore Discord's, which our preload requires first, since we are the ones
 * taking its path out of the window options.
 *
 * Only the client's own windows are touched: Discord's helper windows and Electron's
 * own popups have no title, or brought no preload with them, and are left exactly as
 * they were. `sandbox` goes off for ours, which is what lets a preload of ours require
 * anything at all - the same trade Vencord's patcher makes for the same reason.
 */
function installWindowPreload({ electron, preload, note } = {}) {
  const Original = electron && electron.BrowserWindow;
  const our = String(preload || "");
  // A patched client is a GUI process whose stdout goes nowhere, and every decision in
  // this function is one somebody reads a log to find out: which window was taken over,
  // which was left alone and why. So they all go to the same file as the rest of the
  // loader's report (noteRuntime), and the console lines stay for a plain `node` run.
  const tell = typeof note === "function" ? note : () => {};
  if (typeof Original !== "function" || !our) {
    return { ok: false, patched: false, error: "no BrowserWindow to replace, or no preload to install" };
  }

  let reported = 0;
  class HypercordWindow extends Original {
    constructor(options) {
      const given = options && typeof options === "object" ? options : {};
      const web = given.webPreferences;
      // Discord's own window is the one with a title and a preload of its own; anything
      // else is a helper, and a helper is not ours to change. What was decided is
      // logged, because "nothing of ours is in Discord's page" and "the window was
      // never swapped" look identical from the outside, and the next reader of this
      // file should not have to guess which one they are looking at.
      if (!given.title || !web || !web.preload) {
        if (reported < 4 && (given.title || (web && web.preload))) {
          reported += 1;
          const why = "a window was left alone: title " + JSON.stringify(given.title || null) + ", preload " + Boolean(web && web.preload);
          console.log("[hypercord] " + why);
          tell(why);
        }
        super(given);
        return;
      }
      console.log("[hypercord] the client window will load Hypercord's preload");
      tell("a window is the client's own (title " + JSON.stringify(given.title) + "), so it loads Hypercord's preload");
      // Discord's preload path travels to our preload, which requires it first
      process.env.HYPERCORD_DISCORD_PRELOAD = String(web.preload);
      // copied rather than mutated: Discord keeps its own options object and must not
      // see our window's options in it
      super({ ...given, webPreferences: { ...web, preload: our, sandbox: false } });
      // marked here, in the constructor Discord calls: this is the window whose closing
      // means the client is closing, and quitWithTheWindows below has no other way to
      // tell it from the helpers Discord opens and closes as it likes
      this[CLIENT_WINDOW] = true;
    }
  }

  // Electron's module object is what Discord's main required, and its name is what
  // Electron itself matches on for getFocusedWindow and friends
  try {
    Object.assign(HypercordWindow, Original);
    Object.defineProperty(HypercordWindow, "name", { value: "BrowserWindow", configurable: true });
  } catch {
    /* a frozen class: the window still works, it is only the name that is left alone */
  }
  // Assigning over `electron.BrowserWindow` does nothing: the property is a getter with
  // no setter and is not configurable, so the only thing that changes what Discord gets
  // is the module cache entry it will read. The replacement is built from the property
  // *descriptors*, never by spreading the module: reading every property of Electron's
  // main-process module before the app is ready throws for some of them, and a spread
  // that throws here is a swap that never happened - which is exactly how this silently
  // did nothing the first time it was written.
  try {
    electron.BrowserWindow = HypercordWindow;
  } catch {
    /* expected: the getter has no setter. The cache swap below is the real one. */
  }
  const resolved = (() => {
    try {
      return require.resolve("electron");
    } catch {
      return "";
    }
  })();
  const entry = resolved ? require.cache[resolved] : null;
  if (entry && entry.exports) {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(entry.exports);
      descriptors.BrowserWindow = { value: HypercordWindow, writable: true, enumerable: true, configurable: true };
      const replacement = Object.create(Object.getPrototypeOf(entry.exports), descriptors);
      // Vencord's injector deletes before it assigns, for the same reason: the entry is
      // what every later require reads, and half of it being ours is worse than neither
      delete require.cache[resolved].exports;
      require.cache[resolved].exports = replacement;
    } catch {
      /* an unusual module shape: `replaced` below reports whether it worked anyway */
    }
  }
  // asked rather than assumed, because this is the line the whole feature rests on: what
  // Discord's own code gets when it requires electron
  const replaced = (() => {
    try {
      return require("electron").BrowserWindow === HypercordWindow;
    } catch {
      return false;
    }
  })();
  return { ok: true, patched: replaced, replaced, viaCache: Boolean(entry), preload: our };
}

/**
 * Hypercord's host, started inside Discord's own main process.
 *
 * The settings pages are the same pages either way, and they are driven over the same
 * channels: src/host.js is the one host both clients use - Hypercord's own window runs
 * it in src/main.js - so in the patched client the host runs here, in Discord's main
 * process, and answers its own windows. Nothing is asked of Hypercord's install beyond
 * the files it already ships.
 *
 * Every callback is something the host is handed rather than something it reaches for,
 * because there is no Hypercord window in this process: pushes go to whatever windows
 * Discord has, which is the window the pages are in.
 */
function startHost(electron) {
  const openWindows = () => {
    try {
      return electron.BrowserWindow.getAllWindows().filter((one) => one && one.webContents && typeof one.isDestroyed === "function" && !one.isDestroyed());
    } catch {
      return [];
    }
  };
  return import(pathToFileURL(path.join(__dirname, "host.js")).href)
    .then(({ createHost }) => {
      const host = createHost({
        electron,
        dir: __dirname,
        userData: hypercordDataDir(),
        log: (line) => console.log(line),
        // A line from the *page* goes to the file as well as to stdout, and the file is the
        // half that matters here: this process's stdout is Discord's, which nobody can read.
        // It is what makes "the entries are in the sidebar and clicking one does nothing" a
        // question with an answer (see the `note` channel in src/host.js).
        report: (line) => noteRuntime(String(line), { dataDir: hypercordDataDir(), log: (text) => console.log(text) }),
        notify: (title, body) => {
          try {
            if (!electron.Notification || !electron.Notification.isSupported || !electron.Notification.isSupported()) return false;
            new electron.Notification({ title: String(title || "Hypercord"), body: String(body || "").slice(0, 400) }).show();
            return true;
          } catch {
            return false;
          }
        },
        push: (kind, payload) => {
          for (const one of openWindows()) one.webContents.send("push", String(kind), payload);
        },
        windowFor: () => openWindows()[0] || null,
        reloadWindow: () => {
          const one = openWindows()[0];
          if (one) one.webContents.reload();
        },
      });
      return Promise.resolve(host.start()).then(() => {
        // remembered the moment it is up, and only when it is up: a host that failed to
        // start has nothing to stop, and a teardown that finds nothing must not claim
        // it took something down
        runningHost = host;
        console.log("[hypercord] the settings pages are live in Discord's own settings");
        return host;
      });
    })
    .catch((err) => {
      console.log("[hypercord] the host did not start, so only the styling is in place: " + String((err && err.stack) || err));
      return null;
    });
}

/**
 * Closing the client closes it.
 *
 * Discord keeps itself alive with no window: the X hides it and the process stays in the
 * background - that is what the tray icon and "still running" are - so the client is
 * there for the rest of the session with nothing on screen to come back to, and its
 * helpers stay with it. Nothing in this client asks for that, and it is the one thing
 * about closing that has to mean what it says.
 *
 * Two events, and either one ends the process:
 *
 *   * a window of ours closing - registered while the window is being built, which is
 *     before Discord attaches the handler that hides it instead, so the client is gone
 *     before that handler would have run. The order is the whole trick: a listener added
 *     afterwards cannot stop a close that has already been answered;
 *   * the last window closing, for a window that goes away without its close event being
 *     answered at all: nothing may leave the process behind.
 *
 * `exit` and not `quit`, on purpose: quit asks every window and handler to agree first,
 * and the handler that disagrees is exactly the one holding the client in the background.
 *
 * Every one of those paths tears the host down first (stopHost above). A quit that came
 * through the tray menu, a second instance asking the first to go, or the OS asking
 * Electron to finish registers its own events, and none of them passes through the
 * window's close: leaving those unhandled is how a client ends with its plugins still
 * running in a dying process.
 */
function quitWithTheWindows(appLike, opts = {}) {
  if (!appLike || typeof appLike.on !== "function" || typeof appLike.exit !== "function") {
    return { ok: false, error: "no app to close with" };
  }
  const tell = typeof opts.note === "function" ? opts.note : () => {};
  const stop = typeof opts.stop === "function" ? opts.stop : stopHost;
  // Whatever a teardown returns, none of it may reach the process as an unhandled
  // rejection: a plugin that fails to stop on the way out must not turn closing the client
  // into an error report nobody can read. stopHost above already answers its own promise;
  // this is the same guarantee for any stop a caller hands in.
  const teardown = () => {
    try {
      const pending = stop();
      if (pending && typeof pending.then === "function") {
        Promise.resolve(pending).catch((err) => console.log("[hypercord] the host did not stop cleanly: " + String((err && err.message) || err)));
      }
    } catch (err) {
      console.log("[hypercord] the host did not stop cleanly: " + String((err && err.message) || err));
    }
  };
  const leave = (code) => {
    teardown();
    appLike.exit(code);
  };
  // "The last window closed" only means the client is over once the client has had a window.
  // Discord shows a splash window while it loads and takes it down again before the real one
  // is up, so a bare window-all-closed fires in the middle of a healthy startup - and exiting
  // there is a client that dies seventeen seconds after it opens, which is what it did. The
  // event still ends the process for a window that goes away without answering its own close
  // (that is the case this hook exists for); it just cannot fire before the client's own
  // window has been built.
  let clientSeen = false;
  appLike.on("window-all-closed", () => {
    tell("the last window closed (" + (clientSeen ? "the client had a window" : "no client window was ever built") + ")");
    if (clientSeen) leave(0);
  });
  /**
   * Count a window as the client's own *when its page is Discord* - and only then.
   *
   * A window is handed over here before its page is loaded, so the url is usually empty at
   * that moment and the answer comes a moment later: `markClient` is tried now and again on
   * the window's own did-finish-load, once. The splash is the reason this is a page test and
   * not a window test - it comes with a title and a preload like the client's window does,
   * and Discord closes it two seconds after it opens.
   */
  const markClient = (win) => {
    if (clientSeen) return true;
    const contents = win && win.webContents;
    if (!contents || !isDiscordPage(contents)) return false;
    clientSeen = true;
    tell("the client's window is on Discord's page (" + pageUrl(contents) + "); closing it will close the client");
    win.on("close", () => {
      tell("the client's window closed, so the client is closing");
      leave(0);
    });
    return true;
  };
  appLike.on("browser-window-created", (_event, created) => {
    // Only a window our preload is in can be the client's own: a helper window is not
    // ours to close, and the marker is set in the constructor Discord calls (the same
    // place installWindowPreload decided this window was Discord's to begin with).
    const win = created && typeof created.on === "function" ? created : null;
    if (!win || !win[CLIENT_WINDOW]) return;
    if (markClient(win)) return;
    const contents = win.webContents;
    if (contents && typeof contents.once === "function") contents.once("did-finish-load", () => markClient(win));
  });
  // the quits that never see a window close: registering them is cheap and the one that
  // is missing is the one that leaves us running
  for (const event of ["before-quit", "will-quit", "quit"]) appLike.on(event, () => teardown());
  return { ok: true };
}

/**
 * Take Hypercord's host down, once, before the process goes away.
 *
 * Every path that ends this client runs through here (see quitWithTheWindows), and it
 * has to be safe in all of them: it may run before a host ever started, it may run twice
 * - the window closing and the app quitting are two events for one quit - and it must
 * never throw, because a throw on the way out is a quit that does not finish. The stop
 * is a promise, and it is not waited on: a plugin that hangs in its own stop() must not
 * be able to hold the client open, so the exit is fired either way and the failure is
 * reported in one line.
 */
function stopHost() {
  if (stopping) return { ok: true, already: true };
  const host = runningHost;
  if (!host || typeof host.stop !== "function") return { ok: true, stopped: false };
  stopping = true;
  try {
    Promise.resolve(host.stop()).catch((err) => console.log("[hypercord] the host did not stop cleanly: " + String((err && err.message) || err)));
  } catch (err) {
    console.log("[hypercord] the host did not stop cleanly: " + String((err && err.message) || err));
  }
  runningHost = null;
  return { ok: true, stopped: true };
}

/**
 * The side effect requiring this file has: attach to Discord when there is a
 * Discord to attach to. Wrapped, because this file may also be required by a
 * test or a tool where there is no Electron at all.
 */
function start() {
  let electron = null;
  try {
    electron = require("electron");
  } catch {
    return { ok: false, error: "electron is not available" };
  }
  if (!electron || !electron.app || typeof electron.app.on !== "function") return { ok: false, error: "electron is not running" };

  // Before anything else, and before our caller requires Discord's main module (which is
  // the very next thing it does): the window preload has to be installed while no window
  // exists yet, and the passkey policy has to be answerable the moment one loads, because
  // the preload asks for it synchronously at document start. See src/passkeys.cjs.
  // The loader's own reports go to runtime.log with no console echo, because these lines
  // were already printed by the console.log beside each of them and a GUI process has no
  // console to read: the file is the only place any of it is readable.
  const tell = (line) => noteRuntime(line, { dataDir: hypercordDataDir(), log: () => {} });
  const install = installWindowPreload({ electron, preload: path.join(__dirname, "attach-preload.cjs"), note: tell });
  if (!install.ok) console.log("[hypercord] the window preload was not installed: " + install.error);
  else if (!install.patched) console.log("[hypercord] Discord's own electron module could not be replaced (" + (install.viaCache ? "the cache entry was there" : "no module cache entry") + "), so only the styling will be in place");
  else console.log("[hypercord] Discord's windows will load Hypercord's preload");
  // before Discord's own main module is required, which is the caller's next line: its
  // handler for the last window is registered by that module, and this is what makes the
  // client quit with its window instead of living on in the background
  const quitting = quitWithTheWindows(electron.app, { note: tell });
  if (quitting.ok) console.log("[hypercord] closing the client's window will close the client");
  else console.log("[hypercord] the client will not be closed with its window: " + quitting.error);
  try {
    const passkeys = require(path.join(__dirname, "passkeys.cjs"));
    if (passkeys && passkeys.POLICY && electron.ipcMain && typeof electron.ipcMain.on === "function") {
      electron.ipcMain.on("passkeys:policy", (event) => {
        event.returnValue = String(passkeys.POLICY);
      });
    }
  } catch (err) {
    console.log("[hypercord] the passkey policy is not in place: " + String((err && err.message) || err));
  }

  // The other end of the page's settings bridge: the built runtime's settings, in the data
  // directory. Without this the preload has nothing to answer with, and the runtime's store
  // starts empty at every launch (see runtimeStore).
  const settings = runtimeStore({ ipcMain: electron.ipcMain, dataDir: hypercordDataDir(), log: (line) => console.log(line) });
  if (settings.ok) console.log("[hypercord] the runtime's settings are kept in " + settings.file);
  else console.log("[hypercord] the page cannot keep the runtime's settings: no ipcMain to answer on");

  // And the script the preload injects at document start. It is built here, before any window
  // exists, and answered synchronously to each of them: the runtime has to be in the page
  // *before* Discord's own bundle, because that bundle is what defines the module factories its
  // patches wrap (see runtimeScriptFor). The loader's own per-window pass still runs - it is
  // what a window without our preload gets - and finds the runtime already there.
  const runtime = registerRuntimeScript({ ipcMain: electron.ipcMain, script: runtimeScriptFor({ dataDir: hypercordDataDir(), dir: __dirname }), log: (line) => console.log(line) });
  if (runtime.ok) console.log("[hypercord] the runtime is handed to every window's preload (" + Math.round(runtime.bytes / 1024) + "kb)");
  else console.log("[hypercord] no preload can be handed the runtime: no ipcMain to answer on");

  // Where the baked manifest is: Discord's own app directory, which is where patching put
  // it. `require.main` is the obvious guess and it is *not* reliable inside Electron (the
  // entry module is loaded by Electron itself, so `require.main` can be undefined), and
  // getting this wrong fails silently and completely: no stylesheet, no plugin runtime, no
  // plugins - a themed-nothing client that looks like a broken one. `process.resourcesPath`
  // is set by Electron in the main process of a packaged app, so it is the fallback that
  // always exists in a patched Discord.
  const resourcesApp = String(process.resourcesPath || "") ? path.join(String(process.resourcesPath), "app") : "";
  const mainDir = (require.main && require.main.filename ? path.dirname(require.main.filename) : "") || resourcesApp;
  const run = () => {
    const res = attach(electron.app, { mainDir, log: (line) => console.log(line) });
    // The one line that says where the styling and the runtime came from. A GUI process has
    // nowhere to print, so this goes where the other loader reports go, and it is what makes
    // "themes or no themes" answerable from outside the client.
    noteRuntime(
      res.empty
        ? "no theme assets: looked for hypercord.json in " + (mainDir || "(nowhere)") + ", so the windows get the plugin runtime and no styling"
        : "assets from " + String(res.config || "(nowhere)") + ", " + res.injected + " window(s), runtime " + String((res.runtime && (res.runtime.ok ? res.runtime.version : res.runtime.error)) || "none"),
      { dataDir: hypercordDataDir(), log: (line) => console.log(line) },
    );
    if (res.ok && !res.empty) console.log("[hypercord] loader attached to " + res.injected + " window(s)");
    return startHost(electron).then((host) => ({ ...res, host: host ? { ok: true } : { ok: false } }));
  };
  if (typeof electron.app.whenReady === "function") {
    const ready = electron.app.whenReady();
    if (ready && typeof ready.then === "function") return ready.then(run);
  }
  return run();
}

const started = process.env.HYPERCORD_LOADER_SKIP === "1" ? { ok: false, error: "skipped by HYPERCORD_LOADER_SKIP" } : start();

module.exports = { buildInjection, buildRuntimeInjection, readRuntime, readRuntimeChoices, runtimeScriptFor, registerRuntimeScript, runtimeStore, runtimeKeysFor, noteRuntime, attach, loadConfig, start, started, stopHost, STYLE_ID, CLIENT_WINDOW, installWindowPreload, quitWithTheWindows, hypercordDataDir, startHost };
