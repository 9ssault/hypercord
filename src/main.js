// language: JavaScript, file: src/main.js
//
// The shell. Deliberately thin, and deliberately not resident:
//
//   * no tray, no background process, no login item. Closing the window ends
//     Hypercord; nothing of ours keeps running, and nothing of ours starts at
//     boot. A chat client that squats in the tray holds a renderer and a few
//     hundred megabytes for a feature nobody asked for;
//   * everything Hypercord adds lives *inside* the Discord window - the rail, the
//     token option beside the login form, and the manager sheet - so there is no
//     second window to find, raise or close, and nothing here polls: the rail,
//     the sheet and the page are driven by the events they are subscribed to;
//   * when a real Discord install is present the client *is* Discord, patched -
//     see src/patcher.js. The Electron window is the fallback for a machine with
//     no Discord installed, not the product.
import { app, BrowserWindow, Notification, globalShortcut, ipcMain, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApi } from "./api.js";
import { PluginHost } from "./plugin-host.js";
import { createThemes } from "./themes.js";
import { createTokens, redact } from "./tokens.js";
import { createUpdater } from "./updater.js";
import { findDiscord, patch } from "./patcher.js";
import passkeys from "./passkeys.cjs";
import { decideSignIn, signInForms } from "./signin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = () => path.join(app.getPath("userData"), "hypercord.json");
const RAIL_TOGGLE = "CommandOrControl+Shift+H";
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
let api = null;
let host = null;
let themes = null;
let tokens = null;
let updater = null;
const DISCORD_API = "https://discord.com/api/v9";
let state = { controlUrl: "", accounts: [], account: "", railOpen: true };
let sessionToken = ""; // memory only, when the OS keychain is unavailable
// read once at boot: the rail, the token option and the manager sheet are six
// small files, injected whole, with no watcher and no reload loop
let rail = { css: "", html: "", prompt: "", panesHtml: "", panesCss: "", panesJs: "" };

/* ---- state: plain json, and a token that is never in it in clear ---------- */

function readState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE(), "utf8")) || {};
    state = {
      controlUrl: String(saved.controlUrl || state.controlUrl || ""),
      accounts: Array.isArray(saved.accounts) ? saved.accounts.map(String) : [],
      account: String(saved.account || state.account || ""),
      railOpen: saved.railOpen !== false,
    };
    if (saved.token && safeStorage.isEncryptionAvailable()) {
      try {
        sessionToken = safeStorage.decryptString(Buffer.from(String(saved.token), "base64"));
      } catch {
        sessionToken = "";
      }
    }
  } catch {
    /* first run */
  }
  return state;
}

function writeState() {
  const out = { ...state };
  if (sessionToken && safeStorage.isEncryptionAvailable()) {
    out.token = safeStorage.encryptString(sessionToken).toString("base64");
  }
  try {
    fs.mkdirSync(path.dirname(STATE()), { recursive: true });
    fs.writeFileSync(STATE(), JSON.stringify(out, null, 1));
    return true;
  } catch {
    return false;
  }
}

function setControlToken(value) {
  // a token is held in memory; it only reaches the disk through the OS keychain
  sessionToken = String(value || "");
  if (api) api.setToken(sessionToken);
  if (sessionToken && !safeStorage.isEncryptionAvailable()) {
    console.log("[hypercord] no OS keychain here: the control token stays in memory for this run");
  }
  writeState();
}

function buildApi() {
  api = createApi({ baseUrl: state.controlUrl, token: sessionToken });
  return api;
}

/* ---- user tokens --------------------------------------------------------- */

/**
 * The token store. Secrets go through the OS keychain and nowhere else: with no
 * keychain available the store refuses to write, and a token stays in memory for
 * the run rather than landing in a file in clear. The store logs nothing, and
 * every line that could carry a value is redacted on the way out anyway.
 */
function buildTokens() {
  const cipher = safeStorage.isEncryptionAvailable()
    ? {
        encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
        decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, "base64")),
      }
    : null;
  tokens = createTokens({
    userData: app.getPath("userData"),
    cipher,
    log: (line) => console.log(redact(String(line))),
  });
  return tokens;
}

/**
 * Check a user token against Discord itself. This is the only place a token is
 * used, it goes to Discord and nowhere else, and the reply - not the token - is
 * what comes back to the caller.
 */
async function identifyToken(secret) {
  const value = String(secret || "");
  if (!value) return { ok: false, error: "there is no token to check" };
  try {
    const res = await fetch(DISCORD_API + "/users/@me", {
      headers: { authorization: value },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, error: "Discord rejected that token" };
    if (!res.ok) return { ok: false, status: res.status, error: "Discord answered " + res.status };
    const me = await res.json();
    return { ok: true, identity: { id: String(me.id || ""), username: String(me.username || ""), name: String(me.global_name || me.username || "") } };
  } catch (err) {
    // never the request and never the value
    return { ok: false, error: String((err && err.message) || err).slice(0, 160) };
  }
}

/** What the page says about itself: where it is, and whether the token survived. */
const READ_AUTH = `(() => {
  try {
    return JSON.stringify({
      pathname: location.pathname,
      tokenPresent: Boolean(localStorage.getItem("token")),
      form: localStorage.getItem("hypercord.token.form") || "",
    });
  } catch {
    return "";
  }
})()`;

/**
 * Watch the page after a sign-in attempt until it settles.
 *
 * This is a bounded wait, not polling: it runs only while a sign-in is in flight,
 * and it ends the moment the client either lands on an auth route (refused) or on
 * the app's own routes (accepted). If it times out with no redirect and the token
 * still in storage, the client kept it, and that counts as accepted - the token
 * itself is what Discord validates, and it will bounce an invalid one itself.
 */
async function waitForSignIn(win, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  let last = { pathname: "", tokenPresent: false };
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (!win || win.isDestroyed()) break;
    let observed = null;
    try {
      observed = JSON.parse(String(await win.webContents.executeJavaScript(READ_AUTH, true)) || "null");
    } catch {
      continue; // mid-navigation: nothing to read yet, not an answer
    }
    if (!observed) continue;
    last = observed;
    const verdict = decideSignIn(observed);
    if (verdict !== "waiting") return { verdict, ...observed };
  }
  return { verdict: last.tokenPresent ? "accepted" : "rejected", ...last, timedOut: true };
}

/**
 * Sign this client in with a stored user token.
 *
 * The value goes into the page's own storage and the page reloads, which is what
 * skips Discord's login screen. Nothing about the token is logged, cached in this
 * process or echoed - but the *outcome* is looked at, and reported: the shapes a
 * client may read are not documented (see src/signin.js), so this writes one,
 * reloads, watches where the client ended up, and writes the other if the first
 * was refused. "Stored" and "signed in" are two different things, and the caller
 * is told which one happened.
 */
async function useToken(account) {
  if (!tokens) return { ok: false, error: "no token store in this run" };
  const id = String(account || "").trim();
  const secret = tokens.get(id);
  if (!secret) return { ok: false, error: "no user token stored for " + (id || "this client") };
  const win = accountWindow();
  const tried = [];
  for (const form of signInForms(secret)) {
    try {
      const wrote = await win.webContents.executeJavaScript(
        "(() => { try { localStorage.setItem('token', " +
          JSON.stringify(form.value) +
          "); localStorage.setItem('hypercord.token.form', " +
          JSON.stringify(form.name) +
          "); return true; } catch { return false; } })()",
        true,
      );
      if (!wrote) return { ok: false, account: id, error: "this client cannot write to the page's storage", tried };
    } catch (err) {
      return { ok: false, account: id, error: redact(String((err && err.message) || err)).slice(0, 160), tried };
    }
    win.webContents.reload();
    const outcome = await waitForSignIn(win);
    tried.push({ form: form.name, result: outcome.verdict });
    if (outcome.verdict === "accepted") return { ok: true, account: id, stored: form.name, tried };
  }
  return {
    ok: false,
    account: id,
    error: "Discord did not accept that token (tried " + tried.map((one) => one.form).join(" then ") + ") - it may be expired or reset",
    tried,
  };
}

/**
 * The path the prompt uses: paste a token, have Discord confirm who it belongs
 * to, then store it under that account's own id with the username as its label.
 * A token Discord will not accept is never written.
 */
async function addToken(secret, { label = "", use = true } = {}) {
  if (!tokens) return { ok: false, error: "no token store in this run" };
  const check = await identifyToken(secret);
  if (!check.ok) return check;
  const account = check.identity.id;
  const stored = tokens.put(account, String(secret), { label: String(label || check.identity.username) });
  if (!stored.ok) return stored;
  const signedIn = use ? await useToken(account) : { ok: true, skipped: true };
  // the token is real - Discord confirmed it - but that is not the same as this
  // client having signed in with it, and the difference is what the caller shows
  return {
    ok: true,
    account,
    label: String(label || check.identity.username),
    identity: check.identity,
    signedIn,
    signedInOk: Boolean(signedIn && signedIn.ok),
  };
}

/* ---- the window ---------------------------------------------------------- */

function createWindow() {
  const account = state.account || "default";
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: "#1e1f22",
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

function accountWindow() {
  if (!win) createWindow();
  return win;
}

/**
 * The one CSS string the page gets: the enabled themes and quick CSS, then the
 * rail's own stylesheet (whose every selector is scoped to #hypercord-rail, so a
 * theme can restyle Discord and still cannot touch the rail).
 */
function pageCss() {
  const themed = themes ? themes.css() : "";
  return [themed, rail.css].filter(Boolean).join("\n");
}

/** Everything the page and the rail need after a reload. */
function syncPage() {
  if (!win || win.isDestroyed()) return;
  const owner = host && host.handle("hyperRail");
  win.webContents.send("push", "rail:visible", owner ? owner.isOpen() : state.railOpen);
  if (owner) win.webContents.send("push", "rail:side", owner.side());
  win.webContents.send("push", "themes:css", pageCss());
  win.webContents.send("push", "plugins:changed", host ? host.status() : null);
  // the rail's token panel and the sign-in prompt both follow this, so storing a
  // token anywhere makes the prompt go away everywhere
  win.webContents.send("push", "tokens:changed", tokens ? tokens.list() : []);
}

/** Every account gets its own partition, so switching never mixes sessions. */
async function switchAccount(id) {
  const next = String(id || "").trim();
  if (!next || next === state.account) return { ok: true, account: state.account };
  state.account = next;
  writeState();
  if (win) {
    win.destroy();
    win = null;
  }
  createWindow();
  await loginAs(next);
  return { ok: true, account: next };
}

/**
 * Log this client in as one of the accounts on the control server. The token is
 * asked for over the authenticated channel, handed straight to the page's own
 * storage, and never logged, cached in clear, or shown in the UI. If the route
 * is not there yet (the client scope lands with the accounts plugin), we say so
 * instead of fabricating a login: the window keeps whatever session it has.
 */
async function loginAs(account) {
  if (!api) return { ok: false, error: "no control server configured" };
  const res = await api.session(account);
  if (!res.ok || !res.json || !res.json.token) {
    const why = res.status === 404 ? "the control server has no /api/client/session route yet" : res.error || "no token in the reply";
    console.log("[hypercord] cannot log in as " + account + ": " + why);
    return { ok: false, error: why };
  }
  const value = String(res.json.token);
  try {
    await accountWindow().webContents.executeJavaScript(
      "(() => { try { localStorage.setItem('token', " + JSON.stringify(value) + "); return true; } catch { return false; } })()",
      true,
    );
    accountWindow().webContents.reload();
    return { ok: true, account };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err).slice(0, 160) };
  }
}

/* ---- the platform -------------------------------------------------------- */

async function startPlugins() {
  host = new PluginHost({
    root: path.join(here, ".."),
    manifestPath: path.join(here, "..", "plugins", "manifest.json"),
    stateFile: path.join(app.getPath("userData"), "plugins.state.json"),
    ctx: {
      api,
      ui: {
        notify: (title, body) => showNotification(title, body),
        send: (kind, payload) => win && !win.isDestroyed() && win.webContents.send("push", String(kind), payload),
      },
    },
    log: (line) => console.log(line),
  }).load();
  const status = await host.startEnabled();
  console.log("[hypercord] plugins: " + JSON.stringify(status));
  return status;
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return false;
  // no sound storm: an alert here is a critical one, and the client only
  // forwards what the watchdog already decided is worth waking the owner
  new Notification({ title: String(title || "Hypercord"), body: String(body || "").slice(0, 400), silent: false }).show();
  return true;
}

/**
 * Open the manager inside the Discord window.
 *
 * There is no second window any more: the sheet is part of the page, mounted by
 * the preload, so opening a view is a push and nothing is created, raised or
 * released. The view itself still goes through the plugin that owns it, so the
 * sheet and the plugin cannot disagree about which view was last shown.
 */
function openPanes(view) {
  const owner = host && host.handle("hyperPanes");
  const wanted = owner ? owner.open(view) : String(view || "commands");
  if (!win || win.isDestroyed()) createWindow();
  if (win) win.webContents.send("push", "panes:open", wanted);
  return wanted;
}

function toggleRail(open) {
  // the rail plugin owns the state when it is running; the shell's copy is the
  // fallback for a client whose plugin set is off
  const owner = host && host.handle("hyperRail");
  const next = owner ? owner.toggle(open === null || open === undefined ? null : open) : (state.railOpen = open === null || open === undefined ? !state.railOpen : Boolean(open));
  if (state.railOpen !== next) {
    state.railOpen = next;
    writeState();
  }
  return next;
}

/* ---- the bridge ---------------------------------------------------------- */

// The passkey policy, handed to the preload synchronously: the preload runs
// sandboxed (no sibling files to read) and must have this *before* Discord's own
// scripts, so an async channel would be too late. See src/passkeys.cjs.
ipcMain.on("passkeys:policy", (event) => {
  event.returnValue = String(passkeys && passkeys.POLICY ? passkeys.POLICY : "");
});

ipcMain.handle("api:request", async (_event, endpoint, opts = {}) => {
  if (!api) buildApi();
  return api.request(String(endpoint || "/"), opts || {});
});
ipcMain.handle("rail:ready", () => {
  syncPage();
  return { ok: true, plugins: host ? host.status() : null, account: state.account, accounts: state.accounts };
});
ipcMain.handle("rail:toggle", (_event, open) => toggleRail(open === null ? null : open));
// the same shape the loader bakes into a patched Discord: one style string, one
// rail markup string, one side
ipcMain.handle("rail:assets", () => ({
  css: pageCss(),
  html: rail.html,
  promptHtml: rail.prompt,
  // the manager sheet: it is mounted inside the page, so the preload needs its
  // markup, its one scoped stylesheet, and its script
  panesHtml: rail.panesHtml,
  panesCss: rail.panesCss,
  panesJs: rail.panesJs,
  side: host && host.handle("hyperRail") ? host.handle("hyperRail").side() : "right",
  js: "",
}));
ipcMain.handle("panes:open", (_event, view) => {
  openPanes(view);
  return { ok: true };
});
// the sheet's Close button asks the shell, so the sheet never hides itself
// behind the shell's back
ipcMain.handle("panes:close", () => {
  if (win && !win.isDestroyed()) win.webContents.send("push", "panes:close", true);
  return { ok: true };
});
ipcMain.handle("notify", (_event, title, body) => ({ ok: showNotification(title, body) }));

ipcMain.handle("tokens:list", () => (tokens ? tokens.list() : []));
ipcMain.handle("tokens:add", async (_event, secret, label) => {
  const res = await addToken(secret, { label: label === undefined ? "" : String(label) });
  syncPage();
  return res;
});
ipcMain.handle("tokens:put", (_event, account, secret, label) => {
  if (!tokens) return { ok: false, error: "no token store in this run" };
  const res = tokens.put(String(account || ""), String(secret || ""), { label: label === undefined ? "" : String(label) });
  syncPage();
  return res;
});
ipcMain.handle("tokens:remove", (_event, account) => {
  const res = tokens ? tokens.remove(String(account || "")) : { ok: false, error: "no token store in this run" };
  syncPage();
  return res;
});
ipcMain.handle("tokens:forgetAll", () => {
  const res = tokens ? tokens.forgetAll() : { ok: false, error: "no token store in this run" };
  syncPage();
  return res;
});
ipcMain.handle("tokens:test", async (_event, account) => {
  if (!tokens) return { ok: false, error: "no token store in this run" };
  const check = await identifyToken(tokens.get(String(account || "")));
  if (check.ok && check.identity) return { ok: true, identity: check.identity };
  return check;
});
ipcMain.handle("tokens:use", (_event, account) => useToken(account));
ipcMain.handle("tokens:store", () => {
  // what the UI is allowed to know: where the store is and whether it can keep a
  // secret at all - never what is in it
  if (!tokens) return { ok: false, error: "no token store in this run" };
  return { ok: true, file: tokens.file, encrypted: safeStorage.isEncryptionAvailable(), count: tokens.size() };
});

ipcMain.handle("plugins:list", () => (host ? host.list() : []));
ipcMain.handle("plugins:status", () => (host ? host.status() : null));
ipcMain.handle("plugins:enable", async (_event, id) => {
  if (!host) return { ok: false, error: "no plugin host in this run" };
  const res = await host.enable(String(id || ""));
  syncPage();
  return res;
});
ipcMain.handle("plugins:disable", async (_event, id) => {
  if (!host) return { ok: false, error: "no plugin host in this run" };
  const res = await host.disable(String(id || ""));
  syncPage();
  return res;
});
ipcMain.handle("plugins:settings", (_event, id) => (host ? host.settingsFor(String(id || "")) : {}));
ipcMain.handle("plugins:setSetting", (_event, id, key, value) => (host ? { ok: true, value: host.setSetting(String(id || ""), String(key || ""), value) } : { ok: false, error: "no plugin host in this run" }));

ipcMain.handle("themes:list", () => (themes ? themes.list() : []));
ipcMain.handle("themes:css", () => (themes ? themes.css() : ""));
ipcMain.handle("themes:install", async (_event, source, name) => {
  if (!themes) return { ok: false, error: "no theme store in this run" };
  const res = await themes.install(String(source || ""), name === undefined ? undefined : String(name));
  syncPage();
  return res;
});
ipcMain.handle("themes:remove", (_event, id) => {
  const res = themes ? themes.remove(String(id || "")) : { ok: false, error: "no theme store in this run" };
  syncPage();
  return res;
});
ipcMain.handle("themes:enable", (_event, id, on) => {
  const res = themes ? themes.setEnabled(String(id || ""), Boolean(on)) : { ok: false, error: "no theme store in this run" };
  syncPage();
  return res;
});
ipcMain.handle("themes:quick", (_event, css) => {
  const res = themes ? themes.setQuickCss(String(css === undefined ? "" : css)) : { ok: false, error: "no theme store in this run" };
  syncPage();
  return res;
});
ipcMain.handle("themes:quickCss", () => (themes ? themes.quickCss() : ""));

ipcMain.handle("perf:metrics", () => app.getAppMetrics().map((m) => ({
  pid: m.pid,
  type: m.type,
  cpu: m.cpu ? m.cpu.percentCPUUsage : 0,
  memMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
})));
ipcMain.handle("update:check", () => (updater ? updater.checkNow() : { ok: false, error: "no updater in this run" }));
ipcMain.handle("update:install", () => (updater ? updater.installNow() : { ok: false, error: "no updater in this run" }));
ipcMain.handle("update:state", () => (updater ? updater.describe() : { mode: "dev", supported: false, error: "no updater in this run" }));
ipcMain.handle("account:current", () => ({ account: state.account, accounts: state.accounts }));
ipcMain.handle("account:switch", (_event, id) => switchAccount(id));

/* ---- the real client ----------------------------------------------------- */

// Finding Discord is not the same as being Discord. When an install is here,
// `--attach` (and the tray-free menu item that calls the same function) patches
// it once and starts it: the client the user gets is the actual Discord, with
// Hypercord's loader in front of it, not a window of ours showing the web app.
function attachToDiscord({ launch = true } = {}) {
  const found = findDiscord();
  if (!found.ok) {
    console.log("[hypercord] no Discord install found: " + found.error);
    return { ok: false, error: found.error };
  }
  const owner = host && host.handle("hyperRail");
  const done = patch(found.install, {
    loader: path.join(here, "loader.cjs"),
    // the rail and the themes are baked in at patch time, so the real client
    // shows them without the shell having to be running at all
    assets: { css: pageCss(), html: rail.html, side: owner ? owner.side() : "right" },
    log: (line) => console.log(line),
  });
  if (!done.ok) return done;
  if (!launch) return done;
  const started = found.install.launch();
  console.log("[hypercord] the real Discord client started" + (started.ok ? "" : ": " + started.error));
  return done;
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
// flags as a normal run - the only difference is who closes it. Both states are
// forced rather than assumed: the first snapshot is taken with the rail open and
// the second with it closed, whatever the saved preference said.
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
    railOpen: state.railOpen,
    timers: liveTimers(),
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: Number((m.cpu && m.cpu.percentCPUUsage) || 0),
      memMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
    })),
  });
  // app.getAppMetrics reports CPU as a delta since the previous call, so this
  // priming read makes both snapshots averages over a real idle window instead
  // of averages over the process's whole life
  app.getAppMetrics();
  (async () => {
    report("HYPERCORD_INFO " + JSON.stringify({
      packaged: app.isPackaged,
      plugins: host ? host.status() : null,
      update: updater ? updater.describe() : null,
      version: app.getVersion(),
    }));
    await wait(seconds * 1000); // let Discord finish loading and go quiet
    toggleRail(true);
    await wait(windowMs); // an idle window with the rail open
    report("HYPERCORD_PERF " + JSON.stringify(snapshot("rail-open")));
    toggleRail(false);
    await wait(windowMs); // an idle window with the rail dropped
    report("HYPERCORD_PERF " + JSON.stringify(snapshot("rail-closed")));
    // app.exit, not app.quit: a page that asks before unloading must never be
    // able to hold the measurement - or the client - open
    app.exit(0);
  })();
  return true;
}

/* ---- boot ---------------------------------------------------------------- */

async function boot() {
  readState();
  buildApi();
  buildTokens();
  // a launch can be handed its token: HYPERCORD_USER_TOKEN=… is stored (after
  // Discord confirms it) and used, which is how a scripted start skips the login
  if (process.env.HYPERCORD_USER_TOKEN) {
    addToken(String(process.env.HYPERCORD_USER_TOKEN), { label: "HYPERCORD_USER_TOKEN", use: false })
      .then((res) => console.log("[hypercord] user token from the environment: " + (res.ok ? "stored for " + res.account : "refused (" + res.error + ")")))
      .catch((err) => console.log("[hypercord] user token from the environment failed: " + redact(String((err && err.message) || err))));
  }
  // read once: the rail, the token option, the manager sheet. Injected whole, no
  // watcher and no reload loop.
  for (const [key, file] of [
    ["css", "rail.css"],
    ["html", "rail.html"],
    ["prompt", "prompt.html"],
    ["panesHtml", "panes.html"],
    ["panesCss", "panes.css"],
    ["panesJs", "panes.js"],
  ]) {
    try {
      rail[key] = fs.readFileSync(path.join(here, file), "utf8");
    } catch (err) {
      console.log("[hypercord] could not read " + file + ": " + String((err && err.message) || err));
    }
  }
  themes = createThemes({ userData: app.getPath("userData"), log: (line) => console.log(line) });
  createWindow();
  globalShortcut.register(RAIL_TOGGLE, () => toggleRail());
  await startPlugins();
  // the feed stays empty until a Hypercord release repository exists; a packed
  // build uses the feed electron-builder baked in, and the updater is silent
  updater = createUpdater({ log: (line) => console.log(line), feed: String(process.env.HYPERCORD_UPDATE_FEED || "") });
  updater.start();
  const rc = await api.request("/api/state");
  if (rc.ok && rc.json && Array.isArray(rc.json.accounts)) {
    state.accounts = rc.json.accounts.map(String);
    writeState();
  }
  // no tray and no hidden window: the app is exactly the window, so a launch
  // with --attach starts the real client instead of a second window
  if (process.argv.includes("--attach")) attachToDiscord();
  if (perfMode()) return;
  syncPage();
}

if (gotLock) {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(boot);
}

app.on("window-all-closed", () => {
  // always: no tray means no reason to stay alive without a window
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (updater) updater.stop();
});
