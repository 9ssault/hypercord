// language: JavaScript, file: src/main.js
//
// The shell. Deliberately thin, and deliberately not resident:
//
//   * no tray, no background process, no login item. Closing the window ends
//     Hypercord; nothing of ours keeps running, and nothing of ours starts at
//     boot. A chat client that squats in the tray holds a renderer and a few
//     hundred megabytes for a feature nobody asked for;
//   * everything Hypercord adds lives *inside* the client window - the token
//     option beside the login form, and the client's own settings, where every
//     Hypercord page is one of its sections - so there is no second window to
//     find, raise or close, and nothing here polls: the sheet and the page are
//     driven by the events they are subscribed to;
//   * when a real Discord install is present the client *is* Discord, patched -
//     see src/patcher.js. This Electron window is then the fallback for a machine
//     with no Discord installed, and src/loader.cjs puts the same host inside the
//     real Discord instead (src/host.js).
//
// What is left here is only what needs an Electron app of its own: the window, the
// passkey policy the preload must have before the page's scripts, the single-instance
// lock, and the measurement mode. Everything the pages actually talk to - the state,
// the token store, the theme store, the plugin host and every channel they call - is
// in src/host.js, because the real Discord runs that same host in its own main process.
import { app, BrowserWindow, Notification, globalShortcut, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./host.js";
import { findDiscord, patch } from "./patcher.js";
import passkeys from "./passkeys.cjs";

// src/loader.cjs is required for one function - the one that puts the stylesheet and the
// built plugin runtime into a window - and it is the same function Discord's own windows
// are given. Requiring it also starts it, which is exactly right inside Discord and exactly
// wrong here: it would replace Electron's BrowserWindow in this process, install its window
// preload over ours, and start a second plugin host beside the one this shell already runs.
// So the side effect is turned off for the length of this one require and restored straight
// after, then nothing this shell starts later - Discord itself, when it is launched - can
// inherit the opt-out.
const require = createRequire(import.meta.url);
const loaderSkipWasSet = process.env.HYPERCORD_LOADER_SKIP;
process.env.HYPERCORD_LOADER_SKIP = "1";
const loader = require("./loader.cjs");
// restored, not deleted: somebody who set this themselves meant it, and Discord is started
// from this process - it would inherit whatever is left in the environment here
if (loaderSkipWasSet === undefined) delete process.env.HYPERCORD_LOADER_SKIP;
else process.env.HYPERCORD_LOADER_SKIP = loaderSkipWasSet;

const here = path.dirname(fileURLToPath(import.meta.url));
const DISCORD = "https://discord.com/app";

// Windows stops painting an occluded window with this on, which is the
// difference between an idle client and one that keeps burning a core behind
// another window. Harmless elsewhere.
app.commandLine.appendSwitch("enable-features", "CalculateNativeWinOcclusion");

// One instance only, and never a hidden one: a second launch hands over to the
// window that already exists. Asked once, because asking twice is a different
// question than asking once.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let host = null;

/**
 * One of our events, to the client window.
 *
 * It builds the window when there is none: opening a page of ours is a request to see
 * it, and a client with nothing on screen has nothing to push to. This is the shell's
 * half of the host's contract - the host decides what happens, this decides where it
 * lands.
 */
function pushToWindow(kind, payload) {
  if (!win || win.isDestroyed()) createWindow();
  if (win && !win.isDestroyed()) win.webContents.send("push", String(kind), payload);
}

/** The client window, built if it is not there yet: what the host asks for. */
function accountWindow() {
  if (!win) createWindow();
  return win;
}

/** A fresh window, for the one thing that needs it: switching account. */
function reloadWindow() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  createWindow();
}

/** Every account gets its own partition, so switching never mixes sessions. */
function createWindow() {
  const account = (host && host.state.account) || "default";
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    // AMOLED: the client's own surfaces are true black, matching the default theme
    backgroundColor: "#000000",
    title: "Hypercord",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      partition: "persist:hypercord-" + account,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Discord registers a beforeunload handler, which Electron turns into a
  // "Leave site?" dialog that blocks quitting - in a desktop client that prompt
  // is noise, and it can hold the process open forever (it held our own
  // measurement runs open until they were killed). Ignore it and unload.
  win.webContents.on("will-prevent-unload", (event) => event.preventDefault());
  win.on("closed", () => {
    win = null;
  });
  win.loadURL(DISCORD).catch((err) => console.log("[hypercord] discord did not load: " + String((err && err.message) || err)));
  return win;
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return false;
  // no sound storm: an alert here is a critical one, and the client only
  // forwards what the watchdog already decided is worth waking the owner
  new Notification({ title: String(title || "Hypercord"), body: String(body || "").slice(0, 400), silent: false }).show();
  return true;
}

/* ---- the passkey policy -------------------------------------------------- */

// The passkey policy, handed to the preload synchronously: the preload runs
// sandboxed (no sibling files to read) and must have this *before* Discord's own
// scripts, so an async channel would be too late. See src/passkeys.cjs.
ipcMain.on("passkeys:policy", (event) => {
  event.returnValue = String(passkeys && passkeys.POLICY ? passkeys.POLICY : "");
});

// The other end of the page's settings bridge, registered for the same reason: the built
// runtime asks for its settings while it is importing, synchronously, and an unregistered
// channel answers nothing - which is how its store came up empty at every start, taking
// every plugin's options and the switches in the sheet with it (see `runtimeStore` in
// src/loader.cjs). This is the fallback window's copy; a patched Discord gets the loader's
// own, registered in `start()` there.
const runtimeSettings = loader.runtimeStore({ ipcMain, dataDir: app.getPath("userData") });
console.log("[hypercord] the runtime's settings are kept in " + runtimeSettings.file);

// And the script this window's preload injects before Discord's own bundle. The runtime patches
// Discord's webpack as Discord defines its module factories, so a runtime that arrives after
// those have loaded lists all 372 plugins and reaches none of them - which is what the
// did-finish-load pass did on its own (see `runtimeScriptFor` in src/loader.cjs).
const runtimeScript = loader.registerRuntimeScript({ ipcMain, script: loader.runtimeScriptFor({ dataDir: app.getPath("userData"), dir: here }) });
console.log("[hypercord] the runtime is handed to the window's preload (" + Math.round(runtimeScript.bytes / 1024) + "kb)");

/* ---- the real client ----------------------------------------------------- */

// Finding Discord is not the same as being Discord. When an install is here,
// `--attach` patches it once and starts it: the client the user gets is the actual
// Discord, with Hypercord in front of it, not a window of ours showing the web app.
function attachToDiscord({ launch = true } = {}) {
  const found = findDiscord();
  if (!found.ok) {
    console.log("[hypercord] no Discord install found: " + found.error);
    return { ok: false, error: found.error };
  }
  const done = patch(found.install, {
    loader: path.join(here, "loader.cjs"),
    // our stylesheet and the themes are baked in at patch time, so the real client
    // shows them without the shell having to be running at all
    assets: { css: host ? host.css() : "" },
    log: (line) => console.log(line),
  });
  if (!done.ok) {
    // A refusal that is not printed is a client that silently stays themed-and-nothing
    // -else, so the reason goes to the log the Logs page reads, every time.
    console.log("[hypercord] the real client was not patched (" + String(done.state || "unknown") + "): " + String(done.error || "no reason given"));
    return done;
  }
  if (!launch) return { ...done, started: null };
  const started = found.install.launch();
  console.log("[hypercord] the real Discord client started" + (started.ok ? "" : ": " + started.error));
  // the caller decides what a launch that failed means: for `--attach` it means there is
  // no client running to look at, so the fallback window is the right answer rather than
  // an exit.
  return { ...done, started };
}

/* ---- the measurement mode ------------------------------------------------ */

// Live timers in this process, so "no idle polling" is a reading and not a
// promise. `_getActiveHandles` is internal but stable, and guarded anyway.
function liveTimers() {
  try {
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    return handles.filter((h) => h && h.constructor && h.constructor.name === "Timeout").length;
  } catch {
    return -1;
  }
}

// `--perf=45` runs the client exactly as it ships, waits, prints what Electron
// itself reports per process, and quits. It is the same window and the same
// flags as a normal run - the only difference is who closes it, and nothing about
// the client's state is forced to make a reading possible.
function perfMode() {
  const flag = process.argv.find((arg) => arg.startsWith("--perf"));
  if (!flag) return false;
  const seconds = Math.max(5, Number(String(flag).split("=")[1]) || 45);
  // A packaged Windows build is a GUI-subsystem binary with no console attached,
  // so its stdout goes nowhere. HYPERCORD_PERF_OUT names a file the readings are
  // appended to as well, which is the only way to measure a real build.
  const outFile = String(process.env.HYPERCORD_PERF_OUT || "");
  const report = (line) => {
    console.log(line);
    if (!outFile) return;
    try {
      fs.appendFileSync(outFile, line + "\n");
    } catch {
      /* a measurement that cannot be written is still a measurement that ran */
    }
  };
  // the idle window is separate and settable, so an interleaved measurement can
  // trade window length for sample count without editing code
  const windowMs = Math.max(5000, Number(process.env.HYPERCORD_PERF_WINDOW) || 20000);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const snapshot = (label) => ({
    label,
    at: new Date().toISOString(),
    timers: liveTimers(),
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: Number((m.cpu && m.cpu.percentCPUUsage) || 0),
      memMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
    })),
  });
  // app.getAppMetrics reports CPU as a delta since the previous call, so this
  // priming read makes the reading an average over a real idle window instead
  // of an average over the process's whole life
  app.getAppMetrics();
  (async () => {
    report("HYPERCORD_INFO " + JSON.stringify({
      packaged: app.isPackaged,
      plugins: host ? host.status() : null,
      update: host ? host.updateState() : null,
      version: app.getVersion(),
    }));
    await wait(seconds * 1000); // let Discord finish loading and go quiet
    await wait(windowMs); // one idle window, with nothing forced open
    report("HYPERCORD_PERF " + JSON.stringify(snapshot("idle")));
    // app.exit, not app.quit: a page that asks before unloading must never be
    // able to hold the measurement - or the client - open
    app.exit(0);
  })();
  return true;
}

/* ---- boot ---------------------------------------------------------------- */

async function boot() {
  host = createHost({
    electron: { app, ipcMain, Notification, safeStorage },
    dir: here,
    userData: app.getPath("userData"),
    log: (line) => console.log(line),
    notify: (title, body) => showNotification(title, body),
    push: (kind, payload) => pushToWindow(kind, payload),
    windowFor: () => accountWindow(),
    reloadWindow: () => reloadWindow(),
  });
  // the pane and the terminal must not be able to disagree about what happened, so
  // the lines this shell prints are the same lines the ring keeps (never a secret:
  // everything goes through redact first)
  const print = console.log.bind(console);
  console.log = (...parts) => {
    const line = parts.map((part) => String(part)).join(" ");
    if (host) host.note(line);
    print(line);
  };
  // the partition the window opens with comes from the stored account, so the state
  // is read before there is a window to put it in
  host.readState();
  await host.start();
  // The window this shell builds is a Discord page like any other, so it gets the same two
  // things Discord's own windows get: the theme, and the runtime the vendored catalogue's
  // plugins only exist inside. Without the second one the Plugins page in here lists all 371
  // vendored plugins as broken and answers every switch with "TypeScript source, not built"
  // - which is the truth about a window that has no runtime in it, and was the whole of this
  // client on a machine with no Discord install. `attach` watches windows as they are
  // created and re-injects on every load of one, so this is called once, before the window.
  loader.attach(
    { on: (event, fn) => app.on(event, fn), BrowserWindow: { getAllWindows: () => BrowserWindow.getAllWindows() } },
    { css: host.css(), log: (line) => console.log(line), dataDir: app.getPath("userData") },
  );
  // a launch can be handed its token: HYPERCORD_USER_TOKEN=… is stored (after
  // Discord confirms it) and used, which is how a scripted start skips the login
  if (process.env.HYPERCORD_USER_TOKEN) {
    host
      .addToken(String(process.env.HYPERCORD_USER_TOKEN), { label: "HYPERCORD_USER_TOKEN", use: false })
      .then((res) => console.log("[hypercord] user token from the environment: " + (res.ok ? "stored for " + res.account : "refused (" + res.error + ")")))
      .catch((err) => console.log("[hypercord] user token from the environment failed: " + String((err && err.message) || err)));
  }
  // The measurement window is ours, so perf mode always builds it.
  if (perfMode()) {
    createWindow();
    return;
  }
  // `--attach` means "the client is the real Discord": it is patched, started, and this
  // shell is finished. Keeping a window open here would mean two complete clients alive at
  // once - two Discord renderers, two GPU workloads, two plugin hosts, two token stores -
  // for one client the user is looking at in the other, and that doubled client is the
  // idle memory this shell used to cost. A machine with nothing to patch keeps the
  // fallback window, which is exactly what it always was.
  if (process.argv.includes("--attach")) {
    const attached = attachToDiscord();
    const running = attached.ok && attached.started && attached.started.ok !== false;
    if (running) {
      // the host goes down before the process does, so nothing of ours is left mid-flight
      await host.stop();
      console.log("[hypercord] the real client is patched and running: Discord owns the client now, and this shell has nothing left to show, so it exits");
      app.exit(0);
      return;
    }
    console.log("[hypercord] there was nothing to attach to, so this window is the client");
  }
  // no tray and no hidden window: the app is exactly the window
  createWindow();
  host.syncPage();
}

if (gotLock) {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  // A boot that throws must say so: without this the window simply sits there with
  // none of the client behind it, which is the one failure nobody can see.
  app.whenReady().then(() =>
    boot().catch((err) => {
      console.log("[hypercord] the client did not finish starting: " + String((err && err.stack) || err));
    }),
  );
}

app.on("window-all-closed", () => {
  // always: no tray means no reason to stay alive without a window
  app.quit();
});

// Closing the window has to be the end of everything of ours, not just of the window:
// every running plugin gets its stop() hook, the timers the host held for it are cleared,
// the updater loses its interval and its settle timeout, and our channels stop answering.
// Host.stop() is asynchronous because a plugin's stop() hook is, and will-quit cannot
// wait for a promise, so the quit is held open exactly once: the first pass prevents the
// default, tears the host down, and asks to quit again; the second pass goes through.
let quitting = false;
app.on("before-quit", (event) => {
  globalShortcut.unregisterAll();
  if (quitting || !host) return;
  event.preventDefault();
  quitting = true;
  Promise.resolve(host.stop())
    .catch((err) => console.log("[hypercord] the host did not stop cleanly: " + String((err && err.message) || err)))
    .finally(() => app.quit());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // a quit that somehow reached here without passing before-quit (a caller of
  // app.quit() inside a module of ours, say) still gets the teardown
  if (host && !quitting) host.stop();
});
