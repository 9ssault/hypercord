// language: JavaScript, file: src/main.js
//
// The shell. Deliberately thin, and deliberately not resident:
//
//   * no tray, no background process, no login item. Closing the window ends
//     Hypercord; nothing of ours keeps running, and nothing of ours starts at
//     boot. A chat client that squats in the tray holds a renderer and a few
//     hundred megabytes for a feature nobody asked for;
//   * everything Hypercord adds lives *inside* the Discord window - the token
//     option beside the login form, and Discord's own settings, where every
//     Hypercord page is one of its sections - so there is no second window to
//     find, raise or close, and nothing here polls: the sheet and the page are
//     driven by the events they are subscribed to;
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
import { appRoute, captureSessionScript, clientSignInScript, decideSignIn, looksLikeUserToken, pickClientAuth, signInCandidates, storageProbeScript, tokenWriteScript } from "./signin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = () => path.join(app.getPath("userData"), "hypercord.json");
const DISCORD = "https://discord.com/app";
// The client does not act on a stored token every boot: measured against the live
// page, the same write was taken up by its gateway once and ignored four times.
// One click therefore makes two passes over the two places a token can go.
const SIGN_IN_ROUNDS = 2;

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
let state = { controlUrl: "", accounts: [], account: "" };
let sessionToken = ""; // memory only, when the OS keychain is unavailable
// read once at boot: what is injected into Discord's page - our own stylesheet, the
// token option and Hypercord's settings pages - is five small files, injected whole,
// with no watcher and no reload loop
let assets = { css: "", promptHtml: "", panesHtml: "", panesCss: "", panesJs: "" };

/* ---- state: plain json, and a token that is never in it in clear ---------- */

function readState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE(), "utf8")) || {};
    state = {
      controlUrl: String(saved.controlUrl || state.controlUrl || ""),
      accounts: Array.isArray(saved.accounts) ? saved.accounts.map(String) : [],
      account: String(saved.account || state.account || ""),
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
  // No invention on a timeout: the verdict is only ever what the route says. The old
  // return read "a token is still in storage" as accepted, which is the exact bug the
  // sign-in suite pins - and the live log shows the token sitting there while the
  // client ignores it, so that shortcut would have called this a success.
  if (!last.pathname && win && !win.isDestroyed()) {
    try {
      last.pathname = new URL(win.webContents.getURL()).pathname;
    } catch {
      /* the window is mid-navigation: no route to report, and none is invented */
    }
  }
  return { verdict: decideSignIn(last), ...last, timedOut: true };
}

/**
 * Does the client actually use the token? The one question a route cannot answer,
 * and it separates the two failures that need opposite fixes: the client never read
 * the entry, or it read it and Discord refused the token.
 *
 * Watches the window's own session for a request whose authorization header is the
 * token, keeps only that fact - never the value, never a URL - and lets the
 * listener go as soon as there is an answer or the wait runs out.
 */
function watchForTokenUse(win, secret, timeoutMs = 25000) {
  const wanted = String(secret || "");
  return new Promise((resolve) => {
    if (!wanted || !win || win.isDestroyed()) return resolve(false);
    const ses = win.webContents.session;
    let timer = null;
    const stop = (answer) => {
      clearTimeout(timer);
      try {
        ses.webRequest.onBeforeSendHeaders(null);
      } catch {
        /* never attached, or the session is gone */
      }
      resolve(answer);
    };
    timer = setTimeout(() => stop(false), timeoutMs);
    try {
      ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        const headers = details.requestHeaders || {};
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === "authorization" && String(headers[name] || "") === wanted) {
            stop(true);
            break;
          }
        }
        callback({ requestHeaders: headers });
      });
    } catch {
      stop(false);
    }
  });
}

/**
 * One line per sign-in attempt, in the user's own data directory: what the write
 * did, whether the client used the token, where it landed. Never the token and
 * never a header value - a log that could leak a credential is worse than no log.
 */
function logSignIn(line) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "signin.log"), new Date().toISOString() + " " + redact(String(line)) + "\n");
  } catch {
    /* a log that cannot be written is not a sign-in that did not happen */
  }
}

/**
 * Resolve once the window has finished loading the route it was sent to - or once
 * the wait runs out, so a page that never finishes loading cannot hang a sign-in.
 */
function settledLoad(win, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      win.webContents.off("did-finish-load", done);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    win.webContents.on("did-finish-load", done);
  });
}

/**
 * Ask the live page what it holds, and log the answer.
 *
 * This exists because the previous version of this file asserted a measurement it had
 * never made ("the client reads localStorage.token at boot"). The probe reports which
 * storages exist in each world, which keys they hold with their lengths and types,
 * which cookies exist, and which IndexedDB databases/stores/keys are present - names
 * and shapes only, never a value, never a cookie value. Its answer is what orders the
 * sign-in placements, and it is written to signin.log so the next reader has facts.
 */
async function probeAuth(win) {
  try {
    const answer = JSON.parse(String(await win.webContents.executeJavaScript(storageProbeScript(), true)) || "null");
    if (!answer) {
      logSignIn("probe: the page answered nothing");
      return null;
    }
    const names = (keys) => (Array.isArray(keys) ? keys.map((key) => key.name + (key.auth ? "*" : "")).join(",") : "?");
    const stores = (answer.indexeddb || [])
      .map((db) => db.database + ":" + (db.stores || []).map((store) => store.store + "=" + (store.keys || []).map((key) => key.name + "(" + key.length + ")" + (key.auth ? "*" : "")).join("+")).join(" "))
      .join(" | ");
    logSignIn(
      "probe: page.local=[" + names(answer.page && answer.page.localKeys) + "] page.session=[" + names(answer.page && answer.page.sessionKeys) +
        "] frame.local=[" + names(answer.frame && answer.frame.localKeys) + "] cookies=[" + (answer.cookies || []).join(",") + "] indexeddb=[" + stores + "]",
    );
    // The client's own modules, by name only: this is the half that answers "where does
    // this build keep a session", so it belongs in the log beside the storage report.
    const client = answer.client || {};
    const named = (client.candidates || []).map((one) => one.module + "[" + (one.auth || []).join(",") + "]" + ((one.callable || []).length ? "->" + one.callable.join(",") : "")).join(" ");
    logSignIn("probe client: registry=" + Boolean(client.registry) + " require=" + Boolean(client.require) + " modules=" + Number(client.modules || 0) + " candidates=[" + named + "]");
    for (const note of client.notes || []) logSignIn("probe client note: " + redact(String(note)).slice(0, 140));
    for (const note of answer.notes || []) logSignIn("probe note: " + redact(String(note)).slice(0, 140));
    return answer;
  } catch (err) {
    logSignIn("probe failed: " + redact(String((err && err.message) || err)).slice(0, 140));
    return null;
  }
}

/**
 * Read back a session the client itself established, and store it.
 *
 * This is the half of token login that does not depend on any placement working: if
 * the page ends up signed in - by a token, by the password form, by a session that was
 * already there - the client has stored that session somewhere, and this finds it at
 * the places the probe named. The value goes to the token store; the log records the
 * place and the key and never the value.
 */
async function captureSession(win, probe) {
  try {
    const answer = JSON.parse(String(await win.webContents.executeJavaScript(captureSessionScript(probe), true)) || "null");
    if (!answer || !answer.value) {
      logSignIn("capture: nothing at any place the probe named");
      return { ok: false, where: "", key: "" };
    }
    if (!looksLikeUserToken(answer.value)) {
      logSignIn("capture: " + String(answer.where) + "/" + String(answer.key) + " holds something that is not a user token - left alone");
      return { ok: false, where: String(answer.where), key: String(answer.key) };
    }
    logSignIn("capture: a session is in " + String(answer.where) + " at key " + String(answer.key));
    return { ok: true, where: String(answer.where), key: String(answer.key), value: String(answer.value) };
  } catch (err) {
    logSignIn("capture failed: " + redact(String((err && err.message) || err)).slice(0, 140));
    return { ok: false, where: "", key: "" };
  }
}

/**
 * Sign this client in with a stored user token.
 *
 * Each placement is tried in the order src/signin.js documents, the window is sent to
 * the app route (the login page never restores a session) and the route it lands on is
 * judged. What is *not* claimed: that any placement is the one the client reads - the
 * sign-in log shows the frame write landing while the client ignores it, so the
 * placements are ordered by evidence and a probe of the live page's storage is taken
 * first and written to the log. Nothing about the token is logged, cached in this
 * process or echoed; "stored" and "signed in" stay two different things, and when the
 * client does end up signed in its own session is captured and stored through the
 * token store - the half that works without any placement working.
 */
async function useToken(account) {
  if (!tokens) return { ok: false, error: "no token store in this run" };
  const id = String(account || "").trim();
  const secret = tokens.get(id);
  if (!secret) return { ok: false, error: "no user token stored for " + (id || "this client") };
  const win = accountWindow();
  const tried = [];
  // Ask before writing: the probe's answer is what orders the placements, and a
  // placement it rules out is recorded as not attempted rather than as a failure.
  const probe = await probeAuth(win);
  // Two passes over every placement, because a client can take a token on one boot
  // and not the next: one click should not have to be clicked twice.
  const queue = [];
  for (let round = 1; round <= SIGN_IN_ROUNDS; round += 1) for (const form of signInCandidates(secret, { probe })) queue.push({ form, round });
  for (const { form, round } of queue) {
    if (form.skipped) {
      tried.push({ form: form.name, round, result: "not attempted", why: form.skipped });
      logSignIn("attempt round=" + round + " write=" + form.name + " not attempted: " + form.skipped);
      continue;
    }
    try {
      // The script src/signin.js defines, and the one the diagnostics measure: it
      // writes through a same-origin frame, because the page's own world has no
      // storage at all, and it answers with its reason rather than a bare false -
      // a write that failed silently is what made this look like a working sign-in.
      const wrote = String(await win.webContents.executeJavaScript(tokenWriteScript(form), true));
      if (!wrote.startsWith("ok")) {
        tried.push({ form: form.name, round, result: "unwritable", why: wrote.slice(0, 90) });
        continue;
      }
    } catch (err) {
      return { ok: false, account: id, error: redact(String((err && err.message) || err)).slice(0, 160), tried };
    }
    // The login page never restores a session: the client reads the entry when the
    // *app* boots, so the window is sent there and where it lands is the answer.
    const watching = watchForTokenUse(win, form.value);
    const settled = settledLoad(win);
    win.loadURL(appRoute(win.webContents.getURL())).catch(() => {});
    await settled;
    const outcome = await waitForSignIn(win);
    const used = await watching;
    tried.push({ form: form.name, round, result: outcome.verdict, url: outcome.pathname, used });
    logSignIn("attempt round=" + round + " write=" + form.name + " used=" + used + " landed=" + String(outcome.pathname) + " verdict=" + outcome.verdict);
    if (outcome.verdict === "accepted") {
      // The client is on its own routes, which means it has a session of its own -
      // captured here, so the store holds the session this client actually uses no
      // matter which placement, if any, did the work.
      const captured = await captureSession(win, probe);
      if (captured.ok && captured.value !== secret) {
        const known = (tokens.list() || []).find((one) => String(one && one.account) === id) || {};
        const kept = tokens.put(id, captured.value, { label: String(known.label || id) });
        logSignIn("capture: stored this client's own session for " + id + " (" + (kept && kept.ok ? "stored" : "refused") + ")");
      }
      return { ok: true, account: id, stored: form.name, used, captured: captured.where, tried };
    }
  }
  // The client's own sign-in, when the probe found it. This is the path that does not
  // depend on knowing which storage key the client reads: the shapes above are the older
  // ecosystem's, and the log shows this build ignoring them, so if the client exposes an
  // auth export then that is the thing to call. Attempted once, only with a target the
  // probe named, and its answer says what happened.
  const clientTarget = pickClientAuth(probe);
  if (clientTarget) {
    try {
      const watching = watchForTokenUse(win, secret);
      const answer = String(await win.webContents.executeJavaScript(clientSignInScript(secret, probe), true));
      const outcome = await waitForSignIn(win, 20000);
      const used = await watching;
      tried.push({ form: "client " + clientTarget.module + "." + clientTarget.method, result: answer.startsWith("ok") ? "called" : "refused", why: answer.slice(0, 90), url: outcome.pathname, used });
      logSignIn("client sign-in: " + answer.slice(0, 120) + " used=" + used + " landed=" + String(outcome.pathname) + " verdict=" + outcome.verdict);
      if (outcome.verdict === "accepted") {
        const captured = await captureSession(win, probe);
        if (captured.ok && captured.value !== secret) tokens.put(id, captured.value, { label: id });
        return { ok: true, account: id, stored: "client", used, captured: captured.where, tried };
      }
    } catch (err) {
      logSignIn("client sign-in failed: " + redact(String((err && err.message) || err)).slice(0, 140));
    }
  } else {
    logSignIn("client sign-in: not attempted - the probe found no callable auth export");
  }
  const writable = tried.filter((one) => one.result !== "unwritable");
  const used = writable.some((one) => one.used === true);
  const landed = writable.map((one) => one.url).filter(Boolean).pop();
  logSignIn("failed used=" + used + " writes=" + writable.length);
  return {
    ok: false,
    account: id,
    used,
    error: used
      ? "the client read that token and Discord refused it (it came back to " + String(landed || "its login page") + "): the token is expired, reset, or not a user token"
      : clientTarget
        ? "the client never used that token: its storage was written and its own sign-in (" + clientTarget.module + "." + clientTarget.method + ") was called, and it stayed on its login page. signin.log's probe line says what this page holds; signing in with the email and password form is captured either way"
        : !writable.length
          ? "this client could not write the token into the page: " + String((tried[0] && tried[0].why) || "the page offers no storage")
          : "the client never used that token: it did not read it from the page's storage, and the probe found no auth export to call. signin.log has the probe line; signing in with the email and password form is captured either way",
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

function accountWindow() {
  if (!win) createWindow();
  return win;
}

/**
 * The one CSS string the page gets: the enabled themes and quick CSS, then the
 * stylesheet of our own injected pieces (whose every selector is scoped to an
 * element Hypercord owns and Discord does not, so a theme can restyle Discord and
 * still cannot touch the token option or the settings entries).
 */
function pageCss() {
  const themed = themes ? themes.css() : "";
  return [themed, assets.css].filter(Boolean).join("\n");
}

/** Everything the page needs after a reload. */
function syncPage() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("push", "themes:css", pageCss());
  win.webContents.send("push", "plugins:changed", host ? host.status() : null);
  // the sign-in prompt follows this, so storing a token anywhere makes the prompt
  // go away everywhere
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
 * There is no second window any more: Hypercord's pages are part of the page,
 * mounted by the preload, so opening one is a push and nothing is created, raised or
 * released. Which page that is still goes through the plugin that owns it, so the
 * pages and the plugin cannot disagree about which one was last shown.
 */
function openPanes(view) {
  const owner = host && host.handle("hyperPanes");
  const wanted = owner ? owner.open(view) : String(view || "commands");
  if (!win || win.isDestroyed()) createWindow();
  if (win) win.webContents.send("push", "panes:open", wanted);
  return wanted;
}

/* ---- the bridge ---------------------------------------------------------- */

// The passkey policy, handed to the preload synchronously: the preload runs
// sandboxed (no sibling files to read) and must have this *before* Discord's own
// scripts, so an async channel would be too late. See src/passkeys.cjs.
ipcMain.on("passkeys:policy", (event) => {
  event.returnValue = String(passkeys && passkeys.POLICY ? passkeys.POLICY : "");
});

/* ---- the log the settings pane reads -------------------------------------- */

// The Logs pane used to show the control server's log, which on a machine with no
// server was an error in its header and an empty box below it. What this client can
// honestly show is its own log, so every line the shell already prints to the
// terminal is also kept here, bounded - a long session cannot grow it without end.
const LOG_LINES = 400;
const logRing = [];
function note(line) {
  for (const part of redact(String(line === undefined || line === null ? "" : line)).split("\n")) {
    logRing.push(part);
    if (logRing.length > LOG_LINES) logRing.shift();
  }
}

ipcMain.handle("logs:read", (_event, lines) => {
  const want = Math.max(1, Math.min(LOG_LINES, Number(lines) || 200));
  return { lines: logRing.slice(-want), total: logRing.length, limit: LOG_LINES };
});

ipcMain.handle("api:request", async (_event, endpoint, opts = {}) => {
  if (!api) buildApi();
  return api.request(String(endpoint || "/"), opts || {});
});
// What the preload asks for once, at boot, and what it is handed: one style string and
// the markup of the pieces the window injects (the token option and the settings pages).
ipcMain.handle("ui:ready", () => {
  syncPage();
  return { ok: true, account: state.account };
});
ipcMain.handle("ui:assets", () => ({
  css: pageCss(),
  promptHtml: assets.promptHtml,
  // the settings pages: they are mounted inside Discord's own settings, so the preload
  // needs their markup, their one scoped stylesheet, and their script
  panesHtml: assets.panesHtml,
  panesCss: assets.panesCss,
  panesJs: assets.panesJs,
}));
ipcMain.handle("panes:open", (_event, view) => {
  openPanes(view);
  return { ok: true };
});
// Leaving Discord's settings asks the shell to close the sheet, so the sheet never
// hides itself behind the shell's back
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
  // tokens.file() - the function itself is not structured-cloneable, and returning
  // the reference instead of calling it was an "object could not be cloned" error
  // on a screen that only wanted to show where the store lives
  return { ok: true, file: String(tokens.file()), encrypted: safeStorage.isEncryptionAvailable(), count: tokens.size() };
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
  const done = patch(found.install, {
    loader: path.join(here, "loader.cjs"),
    // our stylesheet and the themes are baked in at patch time, so the real client
    // shows them without the shell having to be running at all
    assets: { css: pageCss() },
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
      update: updater ? updater.describe() : null,
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
  readState();
  buildApi();
  buildTokens();
  // the pane and the terminal must not be able to disagree about what happened, so
  // the lines this shell prints are the same lines the ring keeps (never a secret:
  // everything goes through redact first)
  const print = console.log.bind(console);
  console.log = (...parts) => {
    note(parts.map((part) => String(part)).join(" "));
    print(...parts);
  };
  // a launch can be handed its token: HYPERCORD_USER_TOKEN=… is stored (after
  // Discord confirms it) and used, which is how a scripted start skips the login
  if (process.env.HYPERCORD_USER_TOKEN) {
    addToken(String(process.env.HYPERCORD_USER_TOKEN), { label: "HYPERCORD_USER_TOKEN", use: false })
      .then((res) => console.log("[hypercord] user token from the environment: " + (res.ok ? "stored for " + res.account : "refused (" + res.error + ")")))
      .catch((err) => console.log("[hypercord] user token from the environment failed: " + redact(String((err && err.message) || err))));
  }
  // read once: our own stylesheet, the token option, the settings sheet. Injected
  // whole, no watcher and no reload loop.
  for (const [key, file] of [
    ["css", "injected.css"],
    ["promptHtml", "prompt.html"],
    ["panesHtml", "panes.html"],
    ["panesCss", "panes.css"],
    ["panesJs", "panes.js"],
  ]) {
    try {
      assets[key] = fs.readFileSync(path.join(here, file), "utf8");
    } catch (err) {
      console.log("[hypercord] could not read " + file + ": " + String((err && err.message) || err));
    }
  }
  themes = createThemes({ userData: app.getPath("userData"), log: (line) => console.log(line) });
  // The client comes up black. The built-in AMOLED default goes through the same
  // sanitising gate as a theme a user installs (see src/themes.js), it is installed
  // idempotently, and a theme the user chose is never replaced by it.
  try {
    themes.installDefault();
  } catch (err) {
    console.log("[hypercord] could not install the default theme: " + String((err && err.message) || err));
  }
  createWindow();
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
