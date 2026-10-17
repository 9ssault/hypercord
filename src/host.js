// language: JavaScript, file: src/host.js
//
// The host: everything Hypercord's main process does, in one place, and with no
// opinion about which client it is running inside.
//
// There are two clients and one host. In the fallback window src/main.js owns the
// BrowserWindow and hands this module the Electron pieces it needs; inside a patched
// real Discord, src/loader.cjs runs in Discord's own main process and hands it the
// same pieces. Both get one plugin host, one theme store, one token store and one set
// of channels to answer, because a page that works in one client and not the other is
// the failure this split exists to prevent.
//
// Nothing here imports Electron directly: `electron` is injected, so the whole host
// can be built in a test with stubs, and so this file cannot grow a second opinion
// about which app it is running in. What it cannot do alone is a callback the caller
// supplies - creating or recreating the client window, notifying the OS, and pushing
// to whatever windows the caller owns.
import fs from "node:fs";
import path from "node:path";
import { createApi } from "./api.js";
import { createBeef } from "./beef.js";
import { PluginHost } from "./plugin-host.js";
import { createThemes } from "./themes.js";
import { createTokens, redact } from "./tokens.js";
import { inspect, listInstalls, patchFreshness } from "./patcher.js";
import { appRoute, captureSessionScript, clientSignInScript, decideSignIn, looksLikeUserToken, pickClientAuth, signInCandidates, storageProbeScript, tokenLoginScript, tokenWriteScript } from "./signin.js";

const DISCORD_API = "https://discord.com/api/v9";

// The runtime's own requests, and how far they may reach.
//
// The two backends the runtime's cloud tab offers before anything is configured; a client set to
// a self-hosted one is served that origin as well, because it is the one the tab shows. The
// bounds are here rather than in the handler so the timeout and the ceiling read as what they
// are: one answer a page can be handed, and one it is refused for.
const RUNTIME_BACKENDS = ["https://cloud.equicord.org", "https://api.vencord.dev"];
const RUNTIME_REQUEST_TIMEOUT = 20000;
const RUNTIME_REQUEST_LIMIT = 8 * 1024 * 1024;
// The client does not act on a stored token every boot: measured against the live
// page, the same write was taken up by its gateway once and ignored four times.
// One click therefore makes two passes over the two places a token can go.
const SIGN_IN_ROUNDS = 2;
// The files this host injects into a page, read once at start: our own stylesheet, the
// token option and Hypercord's settings pages, injected whole, with no watcher and no
// reload loop.
const ASSET_FILES = [
  ["css", "injected.css"],
  ["promptHtml", "prompt.html"],
  ["panesHtml", "panes.html"],
  ["panesCss", "panes.css"],
  ["panesJs", "panes.js"],
];

/**
 * Build the host.
 *
 * `electron` is { app, ipcMain, Notification, safeStorage } - the pieces of Electron
 * this host uses, so a test can hand it stubs. `dir` is Hypercord's src directory: the
 * assets live beside it and the plugin catalogue one level up. `userData` is where the
 * state, the token store and the plugin state live, and it is always passed in: inside
 * a patched Discord, `app.getPath("userData")` is Discord's directory, and a client
 * that wrote its settings into somebody else's data directory would be a bug that only
 * shows up after an uninstall.
 *
 * The callbacks are the caller's half of the contract: `notify` shows an OS
 * notification, `push` sends one of our events to the caller's windows, `windowFor`
 * returns the client window (creating it if there is none), and `reloadWindow` throws
 * the client window away and builds a fresh one, which is what switching account does.
 */
export function createHost({
  electron = {},
  dir = "",
  userData = "",
  log = () => {},
  // Where a line from the *page* goes, as opposed to one from this process. Both clients pass
  // the same function (`log`) by default; the patched one passes the loader's own sink, because
  // there Discord's stdout is not readable and a report that only printed would be a report
  // nobody can find. See the `note` channel below.
  report = log,
  notify = () => false,
  push = () => {},
  reloadWindow = () => {},
  windowFor = () => null,
} = {}) {
  const { app, ipcMain, safeStorage } = electron;
  const STATE = () => path.join(userData, "hypercord.json");

  let api = null;
  let plugins = null;
  let themes = null;
  let tokens = null;
  let updater = null;
  let beef = null;
  let stopped = false;
  let state = { controlUrl: "", accounts: [], account: "" };
  let sessionToken = ""; // memory only, when the OS keychain is unavailable
  const assets = { css: "", promptHtml: "", panesHtml: "", panesCss: "", panesJs: "" };
  const registered = [];
  // The decision the shell made about which client this run is, when a shell made one. Null
  // inside a patched Discord, where no shell ran at all - the facts are measured instead.
  let clientPolicy = null;

  /* ---- state: plain json, and a token that is never in it in clear ---------- */

  function readState() {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE(), "utf8")) || {};
      state = {
        controlUrl: String(saved.controlUrl || state.controlUrl || ""),
        accounts: Array.isArray(saved.accounts) ? saved.accounts.map(String) : [],
        account: String(saved.account || state.account || ""),
      };
      if (saved.token && safeStorage && safeStorage.isEncryptionAvailable()) {
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
    if (sessionToken && safeStorage && safeStorage.isEncryptionAvailable()) {
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
    if (sessionToken && !(safeStorage && safeStorage.isEncryptionAvailable())) {
      log("[hypercord] no OS keychain here: the control token stays in memory for this run");
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
    const cipher =
      safeStorage && safeStorage.isEncryptionAvailable()
        ? {
            encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
            decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob, "base64")),
          }
        : null;
    tokens = createTokens({
      userData,
      cipher,
      log: (line) => log(redact(String(line))),
    });
    return tokens;
  }

  /**
   * Check a user token against Discord itself. This is the only place a token is
   * used, it goes to Discord and nowhere else, and the reply - not the token - is
   * what comes back to the caller.
   */
  /**
   * The avatar URL Discord itself serves for a user: the hash when there is one, and the
   * default avatar for the index Discord derives from the id when there is not. It is a
   * public URL - no token, no auth header - which is why the Accounts page can show it,
   * and why it is built here rather than in the page.
   */
  function avatarUrl(me) {
    const id = String((me && me.id) || "");
    if (!id) return "";
    const hash = String((me && me.avatar) || "");
    if (hash) return "https://cdn.discordapp.com/avatars/" + id + "/" + hash + ".png?size=64";
    let index = 0;
    try {
      index = Number((BigInt(id) >> 22n) % 6n);
    } catch {
      index = 0; // an id that is not a snowflake: the first default avatar is as good as any
    }
    return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
  }

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
      return {
        ok: true,
        identity: {
          id: String(me.id || ""),
          username: String(me.username || ""),
          name: String(me.global_name || me.username || ""),
          avatar: avatarUrl(me),
        },
      };
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
      fs.appendFileSync(path.join(userData, "signin.log"), new Date().toISOString() + " " + redact(String(line)) + "\n");
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
    const win = windowFor();
    if (!win) return { ok: false, error: "there is no client window to sign in" };
    const tried = [];
    // Ask before writing: the probe's answer is what orders the placements, and a
    // placement it rules out is recorded as not attempted rather than as a failure.
    const probe = await probeAuth(win);
    // The client's own token login first, because it is the only path measured to work: the
    // storage placements below write into a page whose own localStorage is unreadable, so the
    // write lands in a frame's storage the client does not read - the window routes to /app,
    // bounces to /login, and the verdict is `rejected` for a token Discord accepts over HTTP.
    // `loginToken` is the client's own function for exactly this and lands on /channels/@me.
    try {
      const direct = String(await win.webContents.executeJavaScript(tokenLoginScript(secret), true));
      logSignIn("client token login: " + direct.slice(0, 160));
      if (direct.startsWith("ok")) {
        const outcome = await waitForSignIn(win);
        tried.push({ form: direct.replace(/^ok:/, ""), result: outcome.verdict, url: outcome.pathname, used: true });
        if (outcome.verdict === "accepted") {
          // the session the client just made is what the store keeps, so a later start signs
          // in with the key this client itself uses rather than the one it was handed
          const captured = await captureSession(win, probe);
          if (captured.ok && captured.value !== secret) tokens.put(id, captured.value, { label: id });
          return { ok: true, account: id, stored: direct.replace(/^ok:/, ""), used: true, captured: captured.where, tried };
        }
      }
    } catch (err) {
      logSignIn("client token login failed: " + redact(String((err && err.message) || err)).slice(0, 140));
    }
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
  async function addToken(rawSecret, { label = "", use = true } = {}) {
    if (!tokens) return { ok: false, error: "no token store in this run" };
    // Trimmed here as well as in the two forms that hand a token over, because this is the
    // one place every path goes through: a copy carries the line break the person did not
    // mean to paste, and whitespace is not something Discord's tokens have.
    const secret = String(rawSecret === undefined || rawSecret === null ? "" : rawSecret).trim();
    const check = await identifyToken(secret);
    if (!check.ok) {
      // Said out loud, because this refusal happens before any sign-in is attempted and
      // otherwise leaves no trace at all - the reason the prompt showed was the only copy.
      logSignIn("token refused before it was stored: " + String(check.error || "no reason given"));
      return check;
    }
    const account = check.identity.id;
    // what Discord just told us about the account is stored with the key: a page that
    // shows a name and an avatar should not have to ask again, and a machine that is
    // offline later still knows whose key it holds
    const stored = tokens.put(account, secret, { label: String(label || check.identity.username), identity: check.identity });
    if (!stored.ok) {
      logSignIn("token for " + account + " was not stored: " + String(stored.error || "no reason given"));
      return stored;
    }
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

  /* ---- the pieces the page is handed --------------------------------------- */

  /**
   * Read the five files the page is injected with.
   *
   * Read at start, and again every time the page asks for them (`ui:assets`), because
   * these are files on disk and a page that asks for its own markup is asking for what is
   * on disk *now*. Reading only once made every change to our own pages - the sheet's
   * script, its markup, its stylesheet - need a whole new Discord process, when the page
   * asking again is enough: a reload of the window re-runs this, and nothing else about the
   * client has to move. It is still not a watcher and still not a timer: nothing of ours
   * looks at a file the page did not ask about. A file that has gone missing keeps the copy
   * already held, so a half-finished edit cannot blank a page that was working.
   */
  function readAssets() {
    for (const [key, file] of ASSET_FILES) {
      try {
        assets[key] = fs.readFileSync(path.join(dir, file), "utf8");
      } catch (err) {
        log("[hypercord] could not read " + file + ": " + String((err && err.message) || err));
      }
    }
    return assets;
  }

  /**
   * The one CSS string the page gets: the enabled themes and quick CSS, then the
   * stylesheet of our own injected pieces (whose every selector is scoped to an
   * element Hypercord owns and Discord does not, so a theme can restyle Discord and
   * still cannot touch the token option or the settings entries).
   */
  function css() {
    const themed = themes ? themes.css() : "";
    return [themed, assets.css].filter(Boolean).join("\n");
  }

  /** Everything the page needs after a reload. */
  function syncPage() {
    push("themes:css", css());
    push("plugins:changed", plugins ? plugins.status() : null);
    // the sign-in prompt follows this, so storing a token anywhere makes the prompt
    // go away everywhere
    push("tokens:changed", tokens ? tokens.list() : []);
    // which client this is goes out with everything else, so the page can say it without
    // asking, and so a client that changes (a patch applied, an install appearing) says so
    push("client:info", clientInfo());
  }

  /**
   * Open a page of ours in the client, through the plugin that owns the list.
   *
   * Which page that is goes through the plugin, so the pages and the plugin cannot
   * disagree about which one was last shown; the caller's `push` is what reaches the
   * window, and in the fallback client it is what creates one if none is there.
   */
  function openPanes(view) {
    const owner = plugins && plugins.handle("hyperPanes");
    const wanted = owner ? owner.open(view) : String(view || "commands");
    push("panes:open", wanted);
    return wanted;
  }

  /* ---- the plugins --------------------------------------------------------- */

  async function startPlugins() {
    plugins = new PluginHost({
      root: path.join(dir, ".."),
      manifestPath: path.join(dir, "..", "plugins", "manifest.json"),
      stateFile: path.join(userData, "plugins.state.json"),
      ctx: {
        api,
        ui: {
          notify: (title, body) => notify(title, body),
          send: (kind, payload) => push(kind, payload),
        },
        // the client's own services, for a plugin that has no control server to talk to:
        // src/beef.js is the first of them (the Beef section's generator, its reload and
        // rollback, the line lab and the last beef, all in this process)
        local: { beef },
      },
      log: (line) => log(line),
    }).load();
    const status = await plugins.startEnabled();
    log("[hypercord] plugins: " + JSON.stringify(status));
    return status;
  }

  /* ---- which client this is ------------------------------------------------ */

  /**
   * What this process is, from the process itself.
   *
   * Read here rather than taken from a caller, and that is the whole point: in a patched
   * client this host runs inside *Discord's* main process, where src/main.js never ran. So
   * "which client am I" has to be answerable from here or it is not answerable at all.
   */
  function runningApp() {
    const name = String((app && typeof app.getName === "function" && app.getName()) || "");
    return { name, ours: /hypercord/i.test(name), packaged: Boolean(app && app.isPackaged) };
  }

  /**
   * The patch record of the install this process is running inside, or null.
   *
   * In a patched Discord the main process resolves its own modules inside the version
   * directory we patched, so `resourcesPath` *is* that install's resources directory and the
   * manifest is one known path inside it - the same file src/loader.cjs already reads for its
   * assets. A file that is not there, or is not ours, answers null rather than a guess.
   */
  function runningInstall() {
    const resources = String(process.resourcesPath || "");
    if (!resources) return null;
    const manifest = path.join(resources, "app", "hypercord.json");
    try {
      const record = JSON.parse(fs.readFileSync(manifest, "utf8")) || null;
      if (!record || record.tool !== "hypercord") return null;
      return { resources, manifest, record, discord: String(record.version || "") };
    } catch {
      return null;
    }
  }

  /**
   * The build that is *running*, which is not the same as the build this process is.
   *
   * Inside Discord `app.getVersion()` is Discord's number, so comparing it against the build
   * recorded in the manifest would compare Discord's version with Hypercord's and conclude
   * nonsense. The honest source is the app that owns the loader this install was patched
   * with: the manifest records its path, and its package.json sits beside it. When that
   * cannot be read the answer is empty, which reads as "cannot be ordered" downstream rather
   * than as a wrong version.
   */
  function runningBuildVersion(inside) {
    if (inside && inside.record && inside.record.loader) {
      try {
        const beside = path.join(path.dirname(String(inside.record.loader)), "..", "package.json");
        const pkg = JSON.parse(fs.readFileSync(beside, "utf8")) || {};
        if (pkg.version) return String(pkg.version);
      } catch {
        return "";
      }
    }
    return String((app && typeof app.getVersion === "function" && app.getVersion()) || "");
  }

  /** The manifest, trimmed to what a report needs - the baked stylesheet stays out of it. */
  function patchRecord(install) {
    const state = inspect(install);
    const record = state.manifest && typeof state.manifest === "object" ? state.manifest : null;
    return {
      state: state.state,
      version: String((record && record.version) || install.version || ""),
      patchedByVersion: String((record && record.patchedByVersion) || ""),
      patchedAt: String((record && record.patchedAt) || ""),
      runtime: record && record.runtime ? record.runtime : null,
      platform: record && record.platform ? record.platform : null,
      error: String(state.error || ""),
    };
  }

  /** Every Discord install on this machine, newest first, with what state each is in. */
  function discordInstalls() {
    try {
      return listInstalls().map((install) => ({
        channel: String(install.channel || ""),
        channelName: String(install.channelName || ""),
        version: String(install.version || ""),
        root: String(install.root || ""),
        patch: patchRecord(install),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Which client this is, as data: the process, the Discord it stands in front of, whether the
   * patch took, and - when the build that patched an install is not the build asking - that
   * too. Plain values only, so it can cross the IPC boundary as it is.
   */
  function clientInfo() {
    const me = runningApp();
    const inside = runningInstall();
    const installs = discordInstalls();
    const newest = installs[0] || null;
    const running = runningBuildVersion(inside);
    const record = inside ? inside.record : newest && newest.patch.state === "patched" ? newest.patch : null;
    const freshness = record ? patchFreshness({ patchedByVersion: record.patchedByVersion }, running) : null;
    return {
      mode: inside ? "patched" : me.ours ? "window" : "other",
      title: inside
        ? "inside " + (me.name || "the client") + ", patched by Hypercord"
        : me.ours
          ? "Hypercord's own window"
          : me.name
            ? "inside " + me.name
            : "inside an unnamed process",
      host: me.name,
      packaged: me.packaged,
      version: running,
      discord: inside ? inside.discord : newest ? newest.version : "",
      manifest: inside ? inside.manifest : "",
      patchedBy: String((record && record.patchedByVersion) || ""),
      patchedAt: String((record && record.patchedAt) || ""),
      runtime: (record && record.runtime) || null,
      platform: (record && record.platform) || null,
      freshness,
      policy: clientPolicy
        ? { attach: Boolean(clientPolicy.attach), reason: String(clientPolicy.reason || ""), state: String(clientPolicy.state || ""), channel: String(clientPolicy.channel || ""), version: String(clientPolicy.version || "") }
        : null,
      installs,
      os: process.platform,
      arch: process.arch,
      at: Date.now(),
    };
  }

  /**
   * Ask for the patch to be refreshed, from wherever this client is.
   *
   * A patched client cannot re-apply its own patch: Electron read the entry point when the
   * process started, so nothing written now takes effect in this process. What this can do is
   * record the request for the one process that *can* write it - the shell, at its next start.
   * Staying silent about that would be the worse answer: a button that appears to work and
   * changes nothing until a restart nobody mentioned.
   */
  function requestReapply() {
    const file = path.join(userData, "repatch.request");
    const me = runningApp();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ requestedAt: new Date().toISOString(), from: me.name || "unknown", version: runningBuildVersion(runningInstall()) }, null, 1) + "\n",
      );
      log("[hypercord] a patch refresh was requested; Hypercord applies it at its next start");
      return { ok: true, queued: true, path: file, note: "Hypercord refreshes the patch the next time it starts" };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  /**
   * One file a person can send to somebody else: which client this is, which Discord and which
   * runtime are in play, whether the patch took, what the stores hold, and this host's own log.
   *
   * Two things make it safe to hand over. It is assembled from facts that are already
   * non-secret - key rows are the store's own masks, never a token - and the whole text passes
   * through `redact` once more on the way out with *every stored secret supplied*, because a
   * plugin's error text or a path is exactly where a pasted secret turns up. And it says in its
   * own header what it deliberately leaves out, because the reader of a support file should not
   * have to trust that someone thought about it.
   */
  function supportBundle() {
    const lines = [];
    const say = (label, value) => lines.push(label + ": " + (value === undefined || value === null || value === "" ? "not reported" : String(value)));
    const info = clientInfo();
    say("written", new Date().toISOString());
    lines.push("");
    lines.push("== this process ==");
    say("client", info.title);
    say("host process", info.host || "unnamed");
    say("mode", info.mode);
    say("build", info.version || "unknown");
    say("packaged", info.packaged ? "yes" : "no");
    say("operating system", info.os + " " + info.arch);
    if (info.policy) {
      say("attach decision", info.policy.attach ? "attached" : "kept this window");
      say("attach reason", info.policy.reason);
    }
    lines.push("");
    lines.push("== the Discord in front of it ==");
    for (const install of info.installs) {
      lines.push(
        "  " + install.channelName + " " + (install.version || "unknown version") + " - " + install.patch.state + " - " + install.root,
      );
      if (install.patch.patchedByVersion) lines.push("      patched by Hypercord " + install.patch.patchedByVersion + " at " + install.patch.patchedAt);
      if (install.patch.error) lines.push("      " + install.patch.error);
    }
    if (!info.installs.length) lines.push("  no Discord install was found");
    lines.push("");
    lines.push("== the patch ==");
    say("record", info.manifest || "no patch record is readable from this process");
    say("patched by", info.patchedBy || "not recorded");
    say("patched at", info.patchedAt || "not recorded");
    say("this build", info.version || "unknown");
    say("freshness", info.freshness ? info.freshness.state + (info.freshness.reason ? " - " + info.freshness.reason : "") : "nothing recorded to compare");
    if (info.runtime) {
      for (const file of info.runtime.files || []) lines.push("  runtime " + file.name + " " + file.bytes + " bytes " + (file.sha256 || "no digest"));
      if (info.runtime.provenance) {
        const p = info.runtime.provenance;
        lines.push("  built from " + p.core + " " + p.coreCommit + " with " + p.merged + " " + p.mergedCommit + " merged (" + p.generatedAt + ")");
      }
      if (info.runtime.note) lines.push("  " + info.runtime.note);
    } else {
      lines.push("  runtime: not recorded");
    }
    if (info.platform) {
      const p = info.platform;
      lines.push("  recorded platform " + p.os + " " + p.arch + " " + (p.release || "") + ", electron " + (p.electron || "?") + ", chrome " + (p.chrome || "?") + ", node " + (p.node || "?"));
    }
    lines.push("");
    lines.push("== updates ==");
    const update = updater ? updater.describe() : null;
    say("mode", update ? update.mode : "no updater in this run");
    if (update) {
      say("supported", update.supported ? "yes" : "no");
      say("feed", update.feed || "");
      say("last checked", update.checkedAt ? new Date(update.checkedAt).toISOString() : "never");
      say("available", update.version || "none seen");
      say("downloaded", update.downloaded || "nothing");
      say("note", update.note || "");
      say("last error", update.error || "");
    }
    lines.push("");
    lines.push("== plugins ==");
    const status = plugins ? plugins.status() : null;
    if (status) {
      say("catalogue", status.catalogue);
      say("enabled", status.enabled);
      say("running", Array.isArray(status.running) ? status.running.length : 0);
      for (const id of Object.keys(status.broken || {})) lines.push("  broken: " + id + " - " + String(status.broken[id]));
    } else {
      lines.push("  no plugin host in this run");
    }
    lines.push("");
    lines.push("== themes, keys and beef ==");
    const installed = themes ? themes.list() : [];
    say("themes installed", Array.isArray(installed) ? installed.length : 0);
    say("themes enabled", Array.isArray(installed) ? installed.filter((one) => one && one.enabled).length : 0);
    const rows = tokens ? tokens.list() : [];
    say("keys stored", Array.isArray(rows) ? rows.length : 0);
    for (const row of Array.isArray(rows) ? rows : []) {
      // the store's own masks and nothing else - there is no path by which a token reaches this file
      lines.push("  " + String(row.account) + " \"" + String(row.label || "") + "\" fingerprint " + String(row.fingerprint || "") + " ends " + String(row.last4 || "") + (row.memoryOnly ? " (this session only)" : ""));
    }
    const generator = beef ? beef.state() : null;
    if (generator) {
      say("beef generator", generator.ready ? "ready" : "not ready");
      say("beef source", generator.sourceLabel || generator.source || "");
      say("beef categories", Array.isArray(generator.categories) ? generator.categories.length : 0);
      say("beef last error", generator.lastError || "");
    }
    lines.push("");
    lines.push("== log (this host's own lines, newest last) ==");
    for (const line of logRing.slice(-200)) lines.push("  " + line);
    lines.push("");
    lines.push("== not in this file ==");
    lines.push("  token values, passkeys, cookies, page storage, message contents, theme and generator css.");
    lines.push("  Account ids, labels, fingerprints and file paths are included; the log is this host's own.");

    const secrets = [];
    if (tokens) {
      for (const row of Array.isArray(rows) ? rows : []) {
        const value = tokens.get(String(row.account));
        if (value) secrets.push(value);
      }
    }
    const text = redact(lines.join("\n") + "\n", ...secrets);
    // downloads first, then documents, then the client's own directory: somewhere a person can
    // find, and a directory that always exists. The name is stamped, and the colons of an ISO
    // timestamp are replaced, because a colon is not a legal character in a Windows file name.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const candidates = [];
    for (const kind of ["downloads", "documents"]) {
      try {
        const dir = app && typeof app.getPath === "function" ? String(app.getPath(kind) || "") : "";
        if (dir) candidates.push(path.join(dir, "hypercord-support-" + stamp + ".txt"));
      } catch {
        /* a path this platform does not have: the next one */
      }
    }
    if (userData) candidates.push(path.join(userData, "hypercord-support-" + stamp + ".txt"));
    let wrote = "";
    let failure = "";
    for (const file of candidates) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
        wrote = file;
        break;
      } catch (err) {
        failure = String((err && err.message) || err);
      }
    }
    if (!wrote) return { ok: false, error: failure || "there was nowhere to write a support file" };
    log("[hypercord] support bundle written to " + wrote);
    return { ok: true, path: wrote, bytes: Buffer.byteLength(text), lines: text.split("\n").length - 1, text };
  }

  /* ---- the log the settings page reads ------------------------------------- */

  // The Logs page cannot show the control server's log on a machine with no server:
  // what this client can honestly show is its own log, so every line the host prints
  // is also kept here, bounded - a long session cannot grow it without end.
  const LOG_LINES = 400;
  const logRing = [];
  function note(line) {
    for (const part of redact(String(line === undefined || line === null ? "" : line)).split("\n")) {
      logRing.push(part);
      if (logRing.length > LOG_LINES) logRing.shift();
    }
  }

  /* ---- the accounts -------------------------------------------------------- */

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
      log("[hypercord] cannot log in as " + account + ": " + why);
      return { ok: false, error: why };
    }
    const value = String(res.json.token);
    const win = windowFor();
    if (!win) return { ok: false, error: "there is no client window to sign in" };
    try {
      await win.webContents.executeJavaScript(
        "(() => { try { localStorage.setItem('token', " + JSON.stringify(value) + "); return true; } catch { return false; } })()",
        true,
      );
      win.webContents.reload();
      return { ok: true, account };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 160) };
    }
  }

  /** Every account gets its own partition, so switching never mixes sessions. */
  async function switchAccount(id) {
    const next = String(id || "").trim();
    if (!next || next === state.account) return { ok: true, account: state.account };
    state.account = next;
    writeState();
    reloadWindow();
    await loginAs(next);
    return { ok: true, account: next };
  }

  /** A page whose contents a plugin owns, described by the plugin itself. */
  function pluginSection(id) {
    const handle = plugins ? plugins.handle(String(id || "")) : null;
    if (!handle || typeof handle.section !== "function") return null;
    const section = handle.section();
    return section && typeof section === "object" ? section : null;
  }

  /* ---- the channels -------------------------------------------------------- */

  /**
   * The origins the runtime's own requests may reach: the backends its cloud tab offers, and
   * whatever that tab is set to in the runtime's own settings file.
   *
   * Read from the file each time rather than remembered, because changing the backend in that
   * tab is a settings write: a client switched to a self-hosted cloud has to be able to reach it
   * at the next sync, not at the next start. A settings file that is absent, unreadable or not
   * JSON is not an error here - it means nothing is configured, and the two defaults stand.
   */
  function runtimeRequestOrigins() {
    const found = new Set(RUNTIME_BACKENDS);
    try {
      const raw = fs.readFileSync(path.join(userData || "", "runtime.settings.json"), "utf8");
      const url = String((JSON.parse(raw) || {}).cloud?.url || "");
      if (url) found.add(new URL(url).origin);
    } catch {
      /* nothing configured, or nothing readable: the defaults are the answer */
    }
    return [...found];
  }

  /**
   * Register every channel the preload calls. One function, one list: a handler that
   * exists in one client and not the other is the bug this table prevents, and
   * `stop()` unregisters exactly what this registered.
   */
  function registerHandlers() {
    const handle = (channel, fn) => {
      ipcMain.handle(channel, fn);
      registered.push(channel);
    };

    handle("logs:read", (_event, lines) => {
      const want = Math.max(1, Math.min(LOG_LINES, Number(lines) || 200));
      return { lines: logRing.slice(-want), total: logRing.length, limit: LOG_LINES };
    });

    handle("api:request", async (_event, endpoint, opts = {}) => {
      if (!api) buildApi();
      return api.request(String(endpoint || "/"), opts || {});
    });

    // The runtime's own requests, made here instead of in the page.
    //
    // Everything the vendored runtime fetches - its cloud backend's OAuth configuration, and the
    // settings it syncs to and from there - used to be fetched by the page. Discord's page refuses
    // a request to an origin its content-security policy does not name, so the cloud tab reported
    // "Setup failed (couldn't retrieve OAuth configuration)" for a backend that answers perfectly
    // well from anywhere else, and every sync after it failed the same silent way. The request is
    // made here instead: this process has no such policy, and it hands the answer to the page.
    //
    // What it deliberately is not is a general proxy. A page script that could ask for any URL
    // would have exactly the way around that policy which the policy exists to deny, so a request
    // is served only when it is https and its origin is the cloud backend this client is set to
    // (see `runtimeRequestOrigins`). Anything else is refused with its reason, which is what the
    // page then shows - a named refusal beats the same empty failure this replaces.
    handle("runtime:request", async (_event, url, options = {}) => {
      const target = String(url || "");
      let parsed = null;
      try {
        parsed = new URL(target);
      } catch {
        return { ok: false, error: "that is not a URL" };
      }
      if (parsed.protocol !== "https:") return { ok: false, error: "only https is served here" };
      const allowed = runtimeRequestOrigins();
      if (!allowed.includes(parsed.origin)) {
        return {
          ok: false,
          error:
            "the runtime may only reach its own cloud backend (" +
            allowed.join(", ") +
            "), and this request is for " +
            parsed.origin,
        };
      }
      const headers = options && typeof options.headers === "object" && options.headers ? options.headers : {};
      const body =
        options && typeof options.bodyBase64 === "string" && options.bodyBase64
          ? Buffer.from(String(options.bodyBase64), "base64")
          : undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RUNTIME_REQUEST_TIMEOUT);
      try {
        const res = await fetch(target, {
          method: String((options && options.method) || "GET").toUpperCase(),
          headers,
          body,
          redirect: "follow",
          signal: controller.signal,
        });
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > RUNTIME_REQUEST_LIMIT) {
          return { ok: false, error: "that answer is larger than this client hands to a page (" + buffer.length + " bytes)" };
        }
        const type = String(res.headers.get("content-type") || "");
        // Text stays text and everything else travels as bytes: the synced settings are deflated
        // before they are uploaded and inflated after they are fetched, so a body read as a
        // string would arrive corrupted and fail as "settings could not be imported".
        const textual = !type || /^text\/|json|javascript|xml|urlencoded/i.test(type);
        return {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          contentType: type,
          ...(textual ? { text: buffer.toString("utf8") } : { bodyBase64: buffer.toString("base64") }),
        };
      } catch (err) {
        return {
          ok: false,
          error:
            err && err.name === "AbortError"
              ? "the cloud backend did not answer within " + Math.round(RUNTIME_REQUEST_TIMEOUT / 1000) + "s"
              : String((err && err.message) || err),
        };
      } finally {
        clearTimeout(timer);
      }
    });
    // What the preload asks for once, at boot, and what it is handed: one style string and
    // the markup of the pieces the window injects (the token option and the settings pages).
    handle("ui:ready", () => {
      syncPage();
      return { ok: true, account: state.account };
    });
    handle("ui:assets", () => {
      // asked for, so read: this is the call a page makes as it mounts, and our own pages
      // are files on disk (see readAssets)
      readAssets();
      return {
        css: css(),
        promptHtml: assets.promptHtml,
        // the settings pages: they are mounted inside Discord's own settings, so the preload
        // needs their markup, their one scoped stylesheet, and their script
        panesHtml: assets.panesHtml,
        panesCss: assets.panesCss,
        panesJs: assets.panesJs,
      };
    });
    handle("panes:open", (_event, view) => {
      openPanes(view);
      return { ok: true };
    });
    // What the page could not do, said somewhere a person can read it.
    //
    // The preload runs in Discord's renderer, and in a patched client that renderer's stdout
    // goes nowhere: a settings entry that refuses to open - because Discord's settings content
    // column could not be found to place the sheet in - was previously a click that did
    // nothing and a reason recorded only as an attribute on the document, which needs a
    // debugger to read. A GUI process whose failures are only readable with a debugger is the
    // failure this file's log exists for, so the page reports over a channel and this lands in
    // the ring the Logs page shows and in the log the loader keeps (see `report`).
    handle("note", (_event, line) => {
      const text = String(line === undefined || line === null ? "" : line).slice(0, 400);
      if (text) {
        if (typeof report === "function") report("panes: " + text);
        note("[hypercord] panes: " + text);
      }
      return { ok: true };
    });
    // Leaving Discord's settings asks the client to close the sheet, so the sheet never
    // hides itself behind the client's back
    handle("panes:close", () => {
      push("panes:close", true);
      return { ok: true };
    });
    handle("notify", (_event, title, body) => ({ ok: notify(title, body) }));

    handle("tokens:list", () => (tokens ? tokens.list() : []));
    handle("tokens:add", async (_event, secret, label) => {
      const res = await addToken(secret, { label: label === undefined ? "" : String(label) });
      syncPage();
      return res;
    });
    handle("tokens:put", (_event, account, secret, label) => {
      if (!tokens) return { ok: false, error: "no token store in this run" };
      const res = tokens.put(String(account || ""), String(secret || ""), { label: label === undefined ? "" : String(label) });
      syncPage();
      return res;
    });
    handle("tokens:remove", (_event, account) => {
      const res = tokens ? tokens.remove(String(account || "")) : { ok: false, error: "no token store in this run" };
      syncPage();
      return res;
    });
    handle("tokens:forgetAll", () => {
      const res = tokens ? tokens.forgetAll() : { ok: false, error: "no token store in this run" };
      syncPage();
      return res;
    });
    handle("tokens:test", async (_event, account) => {
      if (!tokens) return { ok: false, error: "no token store in this run" };
      const check = await identifyToken(tokens.get(String(account || "")));
      if (check.ok && check.identity) {
        // the check is also the moment the identity is learned: keeping it is what makes
        // the account's name and avatar survive a page that was never opened while online
        tokens.setIdentity(String(account || ""), check.identity);
        syncPage();
        return { ok: true, identity: check.identity };
      }
      return check;
    });
    // A label is the owner's own name for an account, so changing it never touches the
    // key: the store rewrites the label and nothing else, and the page is told so it and
    // the sign-in prompt cannot disagree about what this account is called.
    handle("tokens:rename", (_event, account, label) => {
      if (!tokens) return { ok: false, error: "no token store in this run" };
      const res = tokens.rename(String(account || ""), label === undefined || label === null ? "" : String(label));
      if (res.ok) syncPage();
      return res;
    });
    handle("tokens:use", (_event, account) => useToken(account));
    handle("tokens:store", () => {
      // what the UI is allowed to know: where the store is and whether it can keep a
      // secret at all - never what is in it
      if (!tokens) return { ok: false, error: "no token store in this run" };
      // tokens.file() - the function itself is not structured-cloneable, and returning
      // the reference instead of calling it was an "object could not be cloned" error
      // on a screen that only wanted to show where the store lives
      return { ok: true, file: String(tokens.file()), encrypted: Boolean(safeStorage && safeStorage.isEncryptionAvailable()), count: tokens.size() };
    });

    handle("plugins:list", () => (plugins ? plugins.list() : []));
    handle("plugins:status", () => (plugins ? plugins.status() : null));
    handle("plugins:enable", async (_event, id) => {
      if (!plugins) return { ok: false, error: "no plugin host in this run" };
      const res = await plugins.enable(String(id || ""));
      syncPage();
      return res;
    });
    handle("plugins:disable", async (_event, id) => {
      if (!plugins) return { ok: false, error: "no plugin host in this run" };
      const res = await plugins.disable(String(id || ""));
      syncPage();
      return res;
    });
    handle("plugins:settings", (_event, id) => (plugins ? plugins.settingsFor(String(id || "")) : {}));
    handle("plugins:setSetting", (_event, id, key, value) => (plugins ? { ok: true, value: plugins.setSetting(String(id || ""), String(key || ""), value) } : { ok: false, error: "no plugin host in this run" }));
    // A page whose contents a plugin owns: the plugin describes its own section as data
    // (`section()`) and this hands that description to the settings page, which renders it
    // without knowing anything about beef. `sectionAction` runs one of the functions the
    // section declares and nothing else - the declaration is what makes a method
    // reachable, so a page cannot call a plugin's internals by guessing a name - and what
    // the plugin returns travels back whole, with `ok` normalized so a refusal is never
    // mistaken for an answer.
    handle("plugins:section", (_event, id) => {
      const section = pluginSection(id);
      const name = String(id || "");
      return section
        ? { ok: true, section }
        : { ok: false, error: "no running plugin in this run describes a section called " + (name || "nothing") };
    });
    handle("plugins:sectionAction", async (_event, id, action, input) => {
      const name = String(id || "");
      const section = pluginSection(name);
      if (!section) return { ok: false, error: "no running plugin in this run describes a section called " + (name || "nothing") };
      const wanted = String(action || "");
      const declared = (Array.isArray(section.actions) ? section.actions : []).map((one) => String((one && one.id) || ""));
      if (!declared.includes(wanted)) {
        return { ok: false, error: "the " + (section.title || name) + " section declares no \"" + wanted + "\" function" };
      }
      const owner = plugins.handle(name);
      if (typeof owner[wanted] !== "function") {
        return { ok: false, error: "this build has no " + wanted + " on " + name };
      }
      try {
        const result = await owner[wanted](input === undefined ? null : input);
        if (result && typeof result === "object") return { ...result, ok: result.ok !== false };
        return { ok: true, value: result === undefined ? null : result };
      } catch (err) {
        // a section function that throws is reported in the page, never as a dead click
        return { ok: false, error: String((err && err.message) || err) };
      }
    });

    // Which client this is, and the two things a person can do about it: ask for the patch to be
    // refreshed where a refresh is possible, and put everything worth knowing in one file. Each
    // of these answers without a control server, like every other channel here.
    handle("client:info", () => clientInfo());
    handle("client:reapply", () => requestReapply());
    handle("support:bundle", () => supportBundle());

    handle("themes:list", () => (themes ? themes.list() : []));
    // the library browser: one fetch when the page asks for it, through the same theme
    // store that installs from a link, so a theme from the library and a theme from a
    // pasted URL are the same thing by the time either is on disk
    handle("themes:index", (_event, force) =>
      themes ? themes.index({ force: Boolean(force) }) : { ok: false, error: "no theme store in this run" },
    );
    // a preview picture, fetched by this process and handed to the page as a data URL:
    // Discord's own Content-Security-Policy decides what the page's images may be, and one
    // row of the library keeps its thumbnail on a third party's host, so the page is never
    // the one asking for it. One request per preview somebody opens, then nothing.
    handle("themes:thumbnail", (_event, url) =>
      themes ? themes.thumbnail(String(url || "")) : { ok: false, error: "no theme store in this run" },
    );
    handle("themes:css", () => (themes ? themes.css() : ""));
    handle("themes:install", async (_event, source, name) => {
      if (!themes) return { ok: false, error: "no theme store in this run" };
      const res = await themes.install(String(source || ""), name === undefined ? undefined : String(name));
      syncPage();
      return res;
    });
    handle("themes:remove", (_event, id) => {
      const res = themes ? themes.remove(String(id || "")) : { ok: false, error: "no theme store in this run" };
      syncPage();
      return res;
    });
    handle("themes:enable", (_event, id, on) => {
      const res = themes ? themes.setEnabled(String(id || ""), Boolean(on)) : { ok: false, error: "no theme store in this run" };
      syncPage();
      return res;
    });
    handle("themes:quick", (_event, cssText) => {
      const res = themes ? themes.setQuickCss(String(cssText === undefined ? "" : cssText)) : { ok: false, error: "no theme store in this run" };
      syncPage();
      return res;
    });
    handle("themes:quickCss", () => (themes ? themes.quickCss() : ""));

    handle("perf:metrics", () =>
      app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        cpu: m.cpu ? m.cpu.percentCPUUsage : 0,
        memMB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024),
      })),
    );
    handle("update:check", () => (updater ? updater.checkNow() : { ok: false, error: "no updater in this run" }));
    handle("update:install", () => (updater ? updater.installNow() : { ok: false, error: "no updater in this run" }));
    handle("update:state", () => (updater ? updater.describe() : { mode: "dev", supported: false, error: "no updater in this run" }));
    // Restarting the client, from a page of ours.
    //
    // One thing genuinely cannot be applied to a process that is already running: the
    // main-process half (this host and the loader that started it) and every plugin that
    // patches Discord while it loads. Switching one of those on is a record that the next start
    // reads, and the card says "restart to apply" rather than pretending. What was missing is
    // the restart itself: it was Discord's tray icon and a person doing it by hand, while the
    // page that knows a restart is due is the page they are looking at. `relaunch()` arranges
    // the new process and `exit()` ends this one, in that order and no other: exiting first
    // (or exiting when the relaunch failed) closes the client and opens nothing. A run with
    // no app to relaunch - the host tests, or a headless reader of these pages - answers
    // honestly instead of taking something down.
    handle("client:relaunch", () => {
      if (!app || typeof app.relaunch !== "function" || typeof app.exit !== "function") {
        return { ok: false, error: "this run has no client to restart" };
      }
      try {
        app.relaunch();
      } catch (err) {
        return { ok: false, error: "the client could not be started again: " + String((err && err.message) || err).slice(0, 160) };
      }
      try {
        app.exit(0);
      } catch (err) {
        // the replacement is on its way, so this is not a refusal: the page says the restart
        // is happening and the operator closes the old window if it stays
        log("[hypercord] a restart was arranged but this process would not exit: " + String((err && err.message) || err));
        return { ok: true, exiting: false };
      }
      return { ok: true };
    });

    handle("account:current", () => ({ account: state.account, accounts: state.accounts }));
    handle("account:switch", (_event, id) => switchAccount(id));

    return registered.length;
  }

  /* ---- start and stop ------------------------------------------------------ */

  /**
   * Bring the host up: state, the services, the assets, the plugins, the updater and
   * every channel. Idempotent enough to be called once per process, which is what both
   * clients do - the fallback window at boot, and Discord's own main process when the
   * loader starts.
   */
  async function start() {
    readState();
    buildApi();
    buildTokens();
    readAssets();
    // The client comes up black. The built-in AMOLED default goes through the same
    // sanitising gate as a theme a user installs (see src/themes.js), it is installed
    // idempotently, and a theme the user chose is never replaced by it.
    themes = createThemes({ userData, log: (line) => log(line) });
    // The beef engine reads the generator the operator supplies, from this client's data
    // directory, and answers from the built-in banks when there is none. It is built here
    // so the settings page works with no control server configured at all, and it owns no
    // timer: a replaced generator is noticed by a stat when the page asks.
    beef = createBeef({ userData, log: (line) => log(line) });
    try {
      themes.installDefault();
    } catch (err) {
      log("[hypercord] could not install the default theme: " + String((err && err.message) || err));
    }
    const status = await startPlugins();
    // The feed stays empty until a Hypercord release repository exists; a packed build
    // uses the feed electron-builder baked in, and the updater is silent. src/updater.js
    // is the one module here that needs Electron's own module and electron-updater to
    // exist at import time, so it is loaded at this point rather than at the top of the
    // file: a host built without Electron (a check, a tool) still comes up, and a machine
    // where it cannot load answers with the guarded "no updater in this run" below
    // instead of failing before anything else has started.
    try {
      const { createUpdater } = await import("./updater.js");
      updater = createUpdater({ log: (line) => log(line), feed: String(process.env.HYPERCORD_UPDATE_FEED || "") });
      updater.start();
    } catch (err) {
      log("[hypercord] no updater in this run: " + String((err && err.message) || err));
    }
    const rc = await api.request("/api/state");
    if (rc.ok && rc.json && Array.isArray(rc.json.accounts)) {
      state.accounts = rc.json.accounts.map(String);
      writeState();
    }
    registerHandlers();
    return { ok: true, plugins: status, account: state.account };
  }

  /**
   * Take the host down: every background activity of ours, in one place.
   *
   * Closing the client has to be the end of us. In order: each running plugin's own
   * stop() hook runs (and the timers this host held for it are cleared, so a plugin
   * cannot keep the event loop alive on its way out), the updater clears its interval and
   * its settle timeout and detaches its listeners, no channel of ours is left answering, and
   * the stores are dropped so the code they loaded - plugin modules, theme CSS, the token
   * store - can be collected instead of being held by a host that is going away.
   *
   * It is idempotent: a second call is a no-op, which matters because the two clients
   * reach it from different events (src/main.js on before-quit, src/loader.cjs inside a
   * patched Discord on window-all-closed and on the app's own quit events).
   */
  async function stop() {
    if (stopped) return { ok: true, already: true, plugins: null, updater: null };
    stopped = true;
    let pluginReport = null;
    if (plugins && typeof plugins.stopAll === "function") {
      try {
        pluginReport = await plugins.stopAll();
      } catch (err) {
        pluginReport = { stopped: [], failed: ["stopAll threw: " + String((err && err.message) || err).slice(0, 120)] };
      }
    }
    const updateReport = updater ? updater.stop() : null;
    if (ipcMain && typeof ipcMain.removeHandler === "function") {
      while (registered.length) ipcMain.removeHandler(registered.pop());
    }
    // the references, not just the work: a host kept alive by a closure holds every
    // plugin module it ever imported
    plugins = null;
    updater = null;
    themes = null;
    tokens = null;
    api = null;
    beef = null;
    sessionToken = "";
    return { ok: true, already: false, plugins: pluginReport, updater: updateReport };
  }

  return {
    start,
    stop,
    note,
    /** what the Beef section reads when there is no control server: this process's own */
    get beef() {
      return beef;
    },
    assets: () => ({ ...assets }),
    css,
    syncPage,
    openPanes,
    status: () => (plugins ? plugins.status() : null),
    updateState: () => (updater ? updater.describe() : { mode: "dev", supported: false, error: "no updater in this run" }),
    addToken,
    useToken,
    /** the shell's own answer about which client this is, recorded for the settings page */
    setClient: (policy) => {
      clientPolicy = policy && typeof policy === "object" ? policy : null;
      return clientPolicy;
    },
    clientInfo,
    supportBundle,
    requestReapply,
    setControlToken,
    readState,
    // the pieces a caller may need to reason about, rather than a second copy of them
    get api() {
      return api;
    },
    get tokens() {
      return tokens;
    },
    get themes() {
      return themes;
    },
    get plugins() {
      return plugins;
    },
    get state() {
      return state;
    },
  };
}
