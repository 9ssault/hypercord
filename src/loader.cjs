// language: JavaScript, file: src/loader.cjs
//
// The loader. This is the file Discord's patched entry point requires, so it
// runs inside Discord's own Electron main process - not inside Hypercord's.
// That decides everything about it:
//
//   * CommonJS and node builtins only, because that is what it is loaded as;
//   * it is required for its side effect, so starting is what requiring it does
//     (guarded, so a plain `require` in a test or a linter attaches to nothing);
//   * it writes exactly one thing into a Discord window - a <style> element -
//     through webContents.executeJavaScript, so no script ever enters the page
//     and contextIsolation stays on;
//   * no timers and no polling: windows as they appear, and nothing on an
//     interval, which is the same rule the rest of the client follows.
//
// The CSS comes from Hypercord's own state, handed over at patch time
// (resources/app/hypercord.json) or through HYPERCORD_LOADER_CONFIG. When there
// is nothing to inject it says so once and attaches nothing, rather than
// pretending.
const fs = require("node:fs");
const path = require("node:path");

const STYLE_ID = "hypercord-theme";
const INJECTED = new WeakSet();

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
function attach(appLike, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const cfg = opts.config || loadConfig({ dir: opts.dir || __dirname, env: opts.env || process.env, mainDir: opts.mainDir || "" });
  const css = opts.css === undefined ? cfg.css : String(opts.css || "");
  const script = buildInjection({ css });
  let injected = 0;

  if (!appLike || typeof appLike.on !== "function") return { ok: false, error: "no app to attach to", injected };
  if (!css) {
    log("[hypercord] nothing to inject: no theme or injected assets were handed to the loader");
    return { ok: true, injected: 0, empty: true, config: cfg.found };
  }

  const injectInto = (contents, label) => {
    if (!contents || typeof contents.executeJavaScript !== "function") return false;
    if (INJECTED.has(contents)) return false;
    INJECTED.add(contents);
    Promise.resolve(contents.executeJavaScript(script)).then(
      () => {
        injected += 1;
        log("[hypercord] injected into " + label);
      },
      (err) => log("[hypercord] injection failed: " + String((err && err.message) || err)),
    );
    return true;
  };

  const handle = (win) => {
    if (!win || !win.webContents) return;
    const contents = win.webContents;
    // a window whose page has not loaded yet would drop the injection, so wait
    // for the one event that says it is ready - once, never on a timer
    if (typeof contents.isLoading === "function" && contents.isLoading() && typeof contents.once === "function") {
      contents.once("did-finish-load", () => injectInto(contents, String(win.id || "window")));
      return;
    }
    injectInto(contents, String(win.id || "window"));
  };

  const all = appLike.BrowserWindow && typeof appLike.BrowserWindow.getAllWindows === "function" ? appLike.BrowserWindow.getAllWindows() : [];
  for (const win of Array.isArray(all) ? all : []) handle(win);
  appLike.on("browser-window-created", (_event, created) => {
    // Electron passes (event, window); anything else that looks like a window is
    // accepted so a version difference cannot silently stop the injection
    handle(created && created.webContents ? created : _event);
  });
  return { ok: true, injected, config: cfg.found, script };
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
  const mainDir = require.main && require.main.filename ? path.dirname(require.main.filename) : "";
  const run = () => {
    const res = attach(electron.app, { mainDir, log: (line) => console.log(line) });
    if (res.ok && !res.empty) console.log("[hypercord] loader attached to " + res.injected + " window(s)");
    return res;
  };
  if (typeof electron.app.whenReady === "function") {
    const ready = electron.app.whenReady();
    if (ready && typeof ready.then === "function") return ready.then(run);
  }
  return run();
}

const started = process.env.HYPERCORD_LOADER_SKIP === "1" ? { ok: false, error: "skipped by HYPERCORD_LOADER_SKIP" } : start();

module.exports = { buildInjection, attach, loadConfig, start, started, STYLE_ID };
