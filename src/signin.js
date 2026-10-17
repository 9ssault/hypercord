// language: JavaScript, file: src/signin.js
//
// Signing in with a user token, as decisions small enough to test on their own:
// where to put the token, what the client's storage actually holds, and whether the
// sign-in worked.
//
// What is *measured* here, and what is not - the distinction is the point of this
// file, because the previous version asserted a measurement it never made:
//
//   * MEASURED, by the write script's own read-back: a same-origin frame still has a
//     `localStorage` on discord.com even though the page's own world does not, and a
//     write through `frame.contentWindow.localStorage` lands and reads back exactly.
//     `typeof localStorage` in the page's own world is "undefined" and touching it
//     throws `ReferenceError`.
//   * MEASURED, and this is the part that was wrong before: the client did **not**
//     use the token. This client's `signin.log`, after a real attempt, reads
//     `write=same-origin frame used=false landed= verdict=rejected` - the bytes were
//     in storage, and no request the client made ever carried them. "Discord reads
//     localStorage.token at boot" is therefore NOT a measurement; it was an
//     assumption, and it is the reason token login did not work.
//   * NOT KNOWN, and now asked rather than assumed: where the client reads a session
//     from. `storageProbeScript()` answers that from the live page - which storages
//     and which keys exist, and which of the client's *own* modules expose an auth
//     export - never a value. `signInCandidates()` is ordered so a probe result can
//     move the storage shapes without the rest of this file changing, and
//     `pickClientAuth()`/`clientSignInScript()` are the other path: the client's own
//     sign-in code, called only when the probe actually found it.
//   * MEASURED IN THIS WORKSPACE, and the reason that second path is worth trying: the
//     selfbot in the sibling project signs a real account in with nothing but the raw
//     token - `await this.client.login(this.token)` in hypersb-edit/src/bot.js - so the
//     token is what Discord accepts on its gateway. What that does *not* prove is that
//     the web client reads one out of storage, which is why both paths are attempted
//     and the log records which one answered.
//   * Both paths can be right and the sign-in still be a question of the client's own
//     auth flow: whatever the client uses, the route it lands on is the only witness,
//     and a session it establishes itself is captured (`captureSessionScript`) so the
//     store ends up holding the session this build actually accepts.
//   * MEASURED, by route only: the client restores a session when the *app* boots,
//     never on the login page, so a sign-in boots `/app` and is judged by where it
//     lands. That part of the design holds and its tests hold with it.
//
// Nothing here ever logs, returns to a log, or reads back anything secret except
// `captureSessionScript`, whose value goes to the token store through src/main.js.

/** Routes that only an unauthenticated visitor sees. */
export const AUTH_PATHS = ["/login", "/register", "/verify", "/new-login", "/authorize"];

/* ---- the write shapes ---------------------------------------------------- */

/** The raw token as text: what the client puts in its IDENTIFY frame. */
function rawValue(secret) {
  return String(secret === undefined || secret === null ? "" : secret);
}

/**
 * The names the client's module registry is known by, in the order they are tried.
 *
 * `webpackChunkdiscord_app` is the platform's own global and is tried first. The
 * capital-D spelling is what a forked or simulated world uses - the sign-in suite's
 * harness is one - and both are listed because the failure this replaces was exactly a
 * name mismatch: the lookup read one spelling, the world held the other, and the shell
 * reported "the client's module registry is not in this page" about a page that had one.
 * A missing registry is a fact worth reporting; a wrong spelling of it is not a fact.
 */
export const REGISTRY_NAMES = ["webpackChunkdiscord_app", "webpackChunkDiscord_app"];

/**
 * The lookup a script performs to find the registry, as source text.
 *
 * The probe and the client sign-in both need it, and generating it once is what keeps
 * them from disagreeing about the name - which is the bug above. It requires a `push`
 * function, because a global with that name but no way to submit a chunk cannot hand
 * back a require function, so it is not a registry this code can use.
 */
function registryLookupSource() {
  return `(() => {
      // globalThis is read without ever naming window in the same breath: in a world
      // where window does not exist at all (the sign-in suite runs this script in plain
      // Node for exactly that case) naming window throws a ReferenceError, and a thrown
      // lookup would be reported as a client that refused to sign in rather than as the
      // page that has no client.
      const hosts = [];
      const root = typeof globalThis !== "undefined" ? globalThis : null;
      if (root) hosts.push(root);
      if (typeof window !== "undefined" && window && window !== root) hosts.push(window);
      for (const host of hosts) {
        for (const name of ${JSON.stringify(REGISTRY_NAMES)}) {
          let found = null;
          try { found = host[name]; } catch (err) { found = null; }
          if (found && typeof found.push === "function") return found;
        }
      }
      return null;
    })()`;
}

/**
 * Where to write the token, in the order to try it:
 *   "frame"   - through a same-origin frame's storage, which is the only storage the
 *               page offers today;
 *   "storage" - the page's own `localStorage`, for a page that still exposes one (an
 *               older build, a self-hosted one).
 *
 * Both write the raw token. This is the pair the older ecosystem wrote, and its write
 * is measured to land - which is why it stays first in `signInCandidates` - but its
 * *consumption* is unmeasured and, on this build, did not happen.
 */
export function signInForms(secret) {
  const value = rawValue(secret);
  return [
    { name: "same-origin frame", how: "frame", value },
    { name: "storage", how: "storage", value },
  ];
}

/**
 * The same rule the probe script applies to a key's name, exported so it can be
 * tested and so the shell and the page agree. The script cannot call out of itself,
 * so the rule is written twice and the pair is covered by the suite.
 */
export function looksLikeAuthName(name) {
  return /token|auth|session|credential|secret/i.test(String(name === undefined || name === null ? "" : name));
}

/**
 * Does this string look like a user token? Three base64url-ish parts, each long
 * enough to be a real one. Used to decide that what the client stored is a session
 * worth capturing, so a stray string in a storage key is never treated as one.
 */
export function looksLikeUserToken(value) {
  const text = rawValue(value).trim();
  if (text.length < 48 || text.length > 4096) return false;
  if (text.startsWith('"') || text.endsWith('"')) return false;
  if (!/^[A-Za-z0-9_\-+/=.]+$/.test(text)) return false;
  // Two or three dot-separated segments, a long one at each end - not "every part
  // is long", and not exactly three: the tokens this client is handed are
  // `<base64 id>.<hmac>` as often as `<base64 id>.<short>.<hmac>`, so demanding
  // three long parts rejected real ones. A single long string, or a dotted string
  // with a stub at either end, still fails.
  const parts = text.split(".");
  if (parts.length < 2 || parts.length > 3) return false;
  if (parts[0].length < 16 || parts[parts.length - 1].length < 16) return false;
  return parts.slice(1, -1).every((part) => part.length >= 4);
}

/* ---- what the client's storage actually holds ----------------------------- */

/**
 * The script that asks the live page what it has, and answers with names.
 *
 * Its whole purpose is to replace the assumption above with a fact: which storages
 * exist in the page's own world and in a same-origin frame, which keys they hold (name,
 * length and type - never a value), which cookies exist (**names only**), and which
 * IndexedDB databases, object stores and keys are present, marked when a name looks
 * like auth. The client's persistence layer is not `localStorage` on this build, so
 * the IndexedDB half is the part most likely to answer the open question.
 *
 * The answer is a JSON string, bounded (a handful of databases, stores and keys), so
 * a large client cannot make the report unbounded. Every step is guarded: a storage
 * that throws contributes a note instead of a failure.
 */
export function storageProbeScript() {
  return `(async () => {
    const AUTH = /token|auth|session|credential|secret/i;
    const out = { page: {}, frame: null, cookies: [], indexeddb: [], client: { registry: false, require: false, modules: 0, candidates: [], notes: [] }, notes: [] };
    const CLIENT_AUTH = /token|auth|session|credential|secret|login|logout/i;
    const describe = (store) => {
      const keys = [];
      if (!store) return keys;
      const total = Math.min(Number(store.length) || 0, 40);
      for (let i = 0; i < total; i += 1) {
        const name = store.key(i);
        if (name === null || name === undefined) continue;
        const value = store.getItem(name);
        keys.push({ name: String(name), length: String(value === null ? "" : value).length, auth: AUTH.test(String(name)) });
      }
      return keys;
    };
    const surface = (where) => {
      const seen = { localStorage: "missing", sessionStorage: "missing", indexedDB: "missing" };
      try { seen.localStorage = typeof localStorage; } catch (err) { seen.localStorage = "throws:" + (err && err.name); }
      try { seen.sessionStorage = typeof sessionStorage; } catch (err) { seen.sessionStorage = "throws:" + (err && err.name); }
      try { seen.indexedDB = typeof indexedDB; } catch (err) { seen.indexedDB = "throws:" + (err && err.name); }
      seen.localKeys = [];
      seen.sessionKeys = [];
      try { seen.localKeys = describe(localStorage); } catch (err) { out.notes.push(where + " localStorage unreadable: " + (err && err.name)); }
      try { seen.sessionKeys = describe(sessionStorage); } catch (err) { out.notes.push(where + " sessionStorage unreadable: " + (err && err.name)); }
      return seen;
    };
    out.page = surface("page");
    try {
      out.cookies = String(document.cookie || "").split(";").map((part) => part.split("=")[0].trim()).filter((name) => name).slice(0, 40);
    } catch (err) { out.notes.push("cookies unreadable: " + (err && err.name)); }
    try {
      const frame = document.createElement("iframe");
      frame.style.display = "none";
      (document.body || document.documentElement).appendChild(frame);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const inner = frame.contentWindow;
      out.frame = inner ? surface("frame") : { error: "the frame has no window" };
      if (inner) {
        try { out.frame.localKeys = describe(inner.localStorage); } catch (err) { out.notes.push("frame localStorage unreadable: " + (err && err.name)); }
        try { out.frame.sessionKeys = describe(inner.sessionStorage); } catch (err) { out.notes.push("frame sessionStorage unreadable: " + (err && err.name)); }
      }
      frame.remove();
    } catch (err) { out.notes.push("no frame in this page: " + (err && err.name)); }
    try {
      if (typeof indexedDB !== "undefined" && indexedDB && typeof indexedDB.databases === "function") {
        const dbs = (await indexedDB.databases()) || [];
        for (const info of dbs.slice(0, 6)) {
          const name = String(info && info.name ? info.name : "");
          if (!name) continue;
          const entry = { database: name, stores: [] };
          try {
            const db = await new Promise((resolve, reject) => {
              const request = indexedDB.open(name);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error || new Error("open refused"));
            });
            const names = Array.from(db.objectStoreNames || []).slice(0, 12);
            for (const storeName of names) {
              const storeEntry = { store: String(storeName), keys: [] };
              try {
                const keys = await new Promise((resolve, reject) => {
                  const tx = db.transaction(storeName, "readonly");
                  const request = tx.objectStore(storeName).getAllKeys();
                  request.onsuccess = () => resolve(request.result || []);
                  request.onerror = () => reject(request.error || new Error("keys refused"));
                });
                for (const key of keys.slice(0, 40)) {
                  const label = String(key);
                  let length = 0;
                  try {
                    const value = await new Promise((resolve, reject) => {
                      const tx = db.transaction(storeName, "readonly");
                      const request = tx.objectStore(storeName).get(key);
                      request.onsuccess = () => resolve(request.result);
                      request.onerror = () => reject(request.error || new Error("read refused"));
                    });
                    length = typeof value === "string" ? value.length : -1;
                  } catch (err) { length = -2; }
                  storeEntry.keys.push({ name: label, length, auth: AUTH.test(label) });
                }
              } catch (err) { storeEntry.error = String((err && err.message) || err).slice(0, 60); }
              entry.stores.push(storeEntry);
            }
            db.close();
          } catch (err) { entry.error = String((err && err.message) || err).slice(0, 60); }
          out.indexeddb.push(entry);
        }
      } else {
        out.notes.push("indexedDB.databases() is not available in this world");
      }
    } catch (err) { out.notes.push("indexeddb enumeration failed: " + (err && err.name)); }
    // The client's own modules. Its persistence is not localStorage on this build, so
    // the question "where is the session" is really "which of its modules owns auth" -
    // and a module registry that hands out a require function lets that be *read*: the
    // cache of already-required modules is walked, their export *names* are collected,
    // and nothing is called and no value is read. Only names, so the report can be
    // logged beside the storage report without carrying a secret.
    try {
      const registry = ${registryLookupSource()};
      if (!registry) out.client.notes.push("no module registry in this world (tried " + ${JSON.stringify(REGISTRY_NAMES.join(", "))} + ")");
      else {
        out.client.registry = true;
        let requireFunction = null;
        try {
          registry.push([["hypercord-probe-" + Date.now()], {}, (require_) => { requireFunction = require_; }]);
        } catch (err) { out.client.notes.push("the registry refused a probe chunk: " + (err && err.name)); }
        if (typeof requireFunction !== "function") out.client.notes.push("no require function came back from the registry");
        else {
          out.client.require = true;
          const cache = requireFunction.c || {};
          const ids = Object.keys(cache);
          out.client.modules = ids.length;
          for (let i = 0; i < ids.length && out.client.candidates.length < 8; i += 1) {
            const exported = cache[ids[i]] && cache[ids[i]].exports;
            if (!exported) continue;
            let keys = [];
            try { keys = Object.keys(exported); } catch (err) { continue; }
            const auth = keys.filter((key) => CLIENT_AUTH.test(key));
            if (!auth.length) continue;
            const callable = [];
            for (const key of auth) {
              try { if (typeof exported[key] === "function") callable.push(key); } catch (err) { /* a getter that throws is not callable */ }
            }
            out.client.candidates.push({ module: String(ids[i]), exports: keys.slice(0, 12), auth: auth.slice(0, 6), callable: callable.slice(0, 6) });
          }
        }
      }
    } catch (err) { out.client.notes.push("client modules unreadable: " + (err && err.name)); }
    return JSON.stringify(out);
  })()`;
}

/**
 * The placements a sign-in tries, ordered, each with the reason it is where it is.
 *
 * Order is evidence first, and a probe result can move a candidate without touching
 * the rest: the two storage writes provably land (and are therefore attempted), the
 * IndexedDB write is the one aimed at where the client actually persists, and when the
 * probe found no such store the candidate is marked `skipped` with its reason so the
 * shell records "not attempted" instead of a failure that says nothing.
 */
export function signInCandidates(secret, { probe = null } = {}) {
  const value = rawValue(secret);
  const list = [
    {
      name: "same-origin frame",
      how: "frame",
      value,
      verified: "write lands, read back",
      consumed: false,
      why: "the page's own world has no storage at all; a same-origin frame still has one, and this write is measured to land",
    },
    {
      name: "storage",
      how: "storage",
      value,
      verified: "write lands where a storage exists",
      consumed: false,
      why: "kept for a build or a self-hosted page that still exposes localStorage - cheap to try, and it is what an older client expects",
    },
  ];
  const target = pickIndexedTarget(probe);
  list.push({
    name: target ? "indexeddb " + target.database + "/" + target.store : "indexeddb",
    how: "indexeddb",
    value,
    database: target ? target.database : "",
    store: target ? target.store : "",
    key: target ? target.key : "token",
    verified: "",
    consumed: false,
    why: "the client does not read localStorage.token on this build, and its own persistence is not localStorage - this is the placement aimed at where it does persist",
    skipped: target ? "" : "the probe found no indexeddb store holding an auth-looking key",
  });
  return list;
}

/**
 * The IndexedDB place a candidate should write to, chosen from a probe report: the
 * first store that holds a key whose name looks like auth, falling back to the first
 * store at all. Returns null when the report has nothing to offer, which is a fact and
 * not a failure.
 */
export function pickIndexedTarget(probe) {
  const databases = probe && Array.isArray(probe.indexeddb) ? probe.indexeddb : [];
  let fallback = null;
  for (const entry of databases) {
    for (const store of (entry && entry.stores) || []) {
      const keys = Array.isArray(store.keys) ? store.keys : [];
      const authKey = keys.find((key) => key && key.auth);
      if (authKey) return { database: String(entry.database || ""), store: String(store.store || ""), key: String(authKey.name) };
      if (!fallback && store && store.store) fallback = { database: String(entry.database || ""), store: String(store.store), key: "token" };
    }
  }
  return fallback;
}

/* ---- the scripts the shell evaluates ------------------------------------- */

/**
 * The script that puts a token where the client will read it - the exact string the
 * shell evaluates in the page, kept here so it can be read and tested on its own.
 *
 * Every form writes the raw token and reads it back before reporting success, because
 * a write that only *seems* to have happened is the bug this replaces. The answer is a
 * string, never a bare boolean: "ok:<where>" or "err:<why>", so a failure carries its
 * reason all the way to the person reading it. A candidate that was skipped says so
 * instead of pretending to have been tried.
 */
export function tokenWriteScript(form) {
  if (form && form.skipped) return `(() => "err:not attempted: " + ${JSON.stringify(String(form.skipped))})()`;
  const value = JSON.stringify(rawValue(form && form.value));
  const body =
    form && form.how === "frame"
      ? `
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    (document.body || document.documentElement).appendChild(frame);
    const store = frame.contentWindow && frame.contentWindow.localStorage;
    if (!store) {
      frame.remove();
      return "err:a same-origin frame in this page has no storage either";
    }
    store.setItem("token", ${value});
    const back = store.getItem("token");
    frame.remove();
    return back === ${value} ? "ok:same-origin frame" : "err:the frame kept " + String(back).slice(0, 24);`
      : form && form.how === "indexeddb"
        ? `
    if (typeof indexedDB === "undefined" || !indexedDB) return "err:this page has no indexedDB";
    const database = ${JSON.stringify(String((form && form.database) || ""))};
    const storeName = ${JSON.stringify(String((form && form.store) || ""))};
    const keyName = ${JSON.stringify(String((form && form.key) || "token"))};
    if (!database || !storeName) return "err:no indexeddb target: the probe has not named a database and store yet";
    const put = await new Promise((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onerror = () => reject(request.error || new Error("open refused"));
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction(storeName, "readwrite");
          tx.objectStore(storeName).put(${value}, keyName);
          tx.oncomplete = () => { const store = db.transaction(storeName, "readonly").objectStore(storeName); const read = store.get(keyName); read.onsuccess = () => { db.close(); resolve(read.result); }; read.onerror = () => { db.close(); reject(read.error || new Error("read refused")); }; };
          tx.onerror = () => { db.close(); reject(tx.error || new Error("write refused")); };
        } catch (err) { db.close(); reject(err); }
      };
    }).catch((err) => err);
    if (put instanceof Error) return "err:indexeddb " + database + "/" + storeName + ": " + ((put && put.message) || put).slice(0, 80);
    return put === ${value} ? "ok:indexeddb " + database + "/" + storeName : "err:indexeddb kept " + String(put).slice(0, 24);`
        : `
    if (typeof localStorage === "undefined") return "err:this page has no localStorage of its own";
    localStorage.setItem("token", ${value});
    return localStorage.getItem("token") === ${value} ? "ok:this page's own storage" : "err:the page's storage kept something else";`;
  const async_ = form && form.how === "indexeddb" ? "async " : "";
  return `(${async_}() => { try {${body}\n  } catch (err) {\n    return "err:" + (err && err.name) + ": " + (err && err.message);\n  }\n})()`;
}

/**
 * The script that reads back a session the client itself has stored - the reliable
 * half of token login, and it must work whether or not any placement ever does.
 *
 * It reads only the places the probe reported (the frame's storage, the page's storage
 * and the auth-looking keys of the stores the probe named), in that order, and answers
 * with `{ where, key, value }` or an empty `where`. The value is the token: it goes to
 * the shell's token store, and the shell logs the place and the key, never the value.
 */
export function captureSessionScript(probe) {
  const targets = [];
  targets.push({ where: "frame storage", how: "frame", key: "token" });
  targets.push({ where: "page storage", how: "storage", key: "token" });
  for (const entry of (probe && Array.isArray(probe.indexeddb) ? probe.indexeddb : [])) {
    for (const store of (entry && entry.stores) || []) {
      for (const key of (Array.isArray(store.keys) ? store.keys : [])) {
        targets.push({ where: "indexeddb " + String(entry.database || "") + "/" + String(store.store || ""), how: "indexeddb", database: String(entry.database || ""), store: String(store.store || ""), key: String(key.name) });
      }
    }
  }
  return `(async () => {
    const targets = ${JSON.stringify(targets)};
    for (const target of targets) {
      try {
        let value = null;
        if (target.how === "frame") {
          const frame = document.createElement("iframe");
          frame.style.display = "none";
          (document.body || document.documentElement).appendChild(frame);
          await new Promise((resolve) => setTimeout(resolve, 60));
          const store = frame.contentWindow && frame.contentWindow.localStorage;
          value = store ? store.getItem(target.key) : null;
          frame.remove();
        } else if (target.how === "storage") {
          value = typeof localStorage === "undefined" ? null : localStorage.getItem(target.key);
        } else {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(target.database);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("open refused"));
          });
          value = await new Promise((resolve, reject) => {
            const request = db.transaction(target.store, "readonly").objectStore(target.store).get(target.key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("read refused"));
          });
          db.close();
        }
        if (typeof value === "string" && value) return JSON.stringify({ where: target.where, key: target.key, value });
      } catch (err) { /* a place that refuses is not the session; the next one may be */ }
    }
    return JSON.stringify({ where: "", key: "", value: "" });
  })()`;
}

/* ---- the client's own sign-in ------------------------------------------- */

/**
 * The export a sign-in should call, chosen from a probe report - the client's own
 * code, not a guessed storage key.
 *
 * Preference is deliberate and narrow: `handleTokenLogin` and `login` are the names a
 * client uses for "take this token and start a session", `setToken` and `startSession`
 * are the ones an older or forked build uses, and only if none of those is callable
 * does the first callable auth-looking export do. Returns null when the probe found
 * nothing to call, which is a fact to report and not a failure to dress up.
 */
export function pickClientAuth(probe) {
  const candidates = probe && probe.client && Array.isArray(probe.client.candidates) ? probe.client.candidates : [];
  const preferred = ["handleTokenLogin", "login", "setToken", "startSession", "authenticate"];
  for (const wanted of preferred) {
    for (const entry of candidates) {
      const callable = (entry && Array.isArray(entry.callable) ? entry.callable : []);
      if (callable.includes(wanted)) return { module: String((entry && entry.module) || ""), method: wanted };
    }
  }
  for (const entry of candidates) {
    const first = (entry && Array.isArray(entry.callable) ? entry.callable : [])[0];
    if (first) return { module: String((entry && entry.module) || ""), method: String(first) };
  }
  return null;
}

/**
 * The script that signs this client in through its own token login.
 *
 * Why this exists, in one sentence: every storage placement below writes the token into a
 * page whose own `localStorage` is unreadable (Discord throws ReferenceError there), so the
 * write lands in a same-origin frame's storage that the client does not read - the page then
 * routes to /app, bounces back to /login, and the log says `used=false verdict=rejected` for
 * a token Discord accepts over HTTP. The client does have a token login of its own: on the
 * 1.0.9262 build `loginToken(token)` dispatches LOGIN, stores the token and starts the
 * session, and it lands on /channels/@me in about two seconds.
 *
 * The module is found the client's own way: the runtime's `findByProps("login", "logout")`
 * when this page has a runtime in it, and otherwise the client's registry cache, scanned for
 * an exports object that can sign a token in. Nothing here guesses a module id, and the
 * answer is a short string that never carries the token.
 */
export function tokenLoginScript(secret) {
  const value = JSON.stringify(rawValue(secret));
  return `(async () => {
  const token = ${value};
  const scrub = (err) => {
    const said = String((err && err.message) || err || "no reason given");
    return (token ? said.split(String(token)).join("<the token>") : said).slice(0, 100);
  };
  const wanted = (exports) => Boolean(exports) && (typeof exports.loginToken === "function" || typeof exports.startSession === "function");
  const find = () => {
    try {
      const V = typeof window !== "undefined" ? window.Vencord : null;
      if (V && V.Webpack && typeof V.Webpack.findByProps === "function") {
        const found = V.Webpack.findByProps("login", "logout");
        if (wanted(found)) return found;
      }
    } catch (err) { /* the registry scan below is the answer then */ }
    const registry = ${registryLookupSource()};
    if (!registry) return null;
    let requireFunction = null;
    try { registry.push([["hypercord-token-login-" + Date.now()], {}, (require_) => { requireFunction = require_; }]); } catch (err) { return null; }
    const cache = requireFunction && requireFunction.c;
    if (!cache) return null;
    for (const id of Object.keys(cache)) {
      const exports = cache[id] && cache[id].exports;
      if (wanted(exports)) return exports;
    }
    return null;
  };
  try {
    const auth = find();
    if (!auth) return "err:the client's own auth module is not in this page";
    if (typeof auth.loginToken === "function") {
      await auth.loginToken(token);
      return "ok:client loginToken";
    }
    await auth.startSession(token);
    return "ok:client startSession";
  } catch (err) {
    return "err:" + scrub(err);
  }
})()`;
}

/**
 * The script that asks the client to sign in with the token, through the client's own
 * module - the path that does not depend on knowing which storage key it reads.
 *
 * It is generated only from a target the probe named, so it never guesses a module id:
 * with no target it answers "not attempted" and says why. The value is interpolated the
 * same way the storage writes interpolate it (it has to reach the page), and the answer
 * is a short string with no token in it - `ok:client <module>.<method>` or
 * `err:<why>` - so the shell can log the outcome and the person can read it.
 */
export function clientSignInScript(secret, probe) {
  const target = pickClientAuth(probe);
  if (!target) return `(() => "err:not attempted: the probe found no callable auth export in the client's own modules")()`;
  const value = JSON.stringify(rawValue(secret));
  const moduleId = JSON.stringify(String(target.module));
  const methodName = JSON.stringify(String(target.method));
  return `(async () => {
  // The client's own error text can quote the value it was handed, so the token is
  // removed from it before the answer leaves the page - a log is a file that gets pasted
  // into issues. An empty token is not redacted: there is nothing to remove, and
  // splitting on "" would rewrite every character of the message.
  const scrub = (err) => {
    const said = String((err && err.message) || "");
    return (${value} ? said.split(String(${value})).join("<the token>") : said).slice(0, 80);
  };
  try {
    const registry = ${registryLookupSource()};
    if (!registry) return "err:the client's module registry is not in this page (tried " + ${JSON.stringify(REGISTRY_NAMES.join(", "))} + ")";
    if (!registry.push) return "err:the client's registry holds no push (" + Object.keys(registry).join(",") + ")";
    let requireFunction = null;
    try {
      registry.push([["hypercord-login-" + Date.now()], {}, (require_) => { requireFunction = require_; }]);
    } catch (err) {
      return "err:the client's registry refused a probe chunk: " + (err && err.name);
    }
    // Two shapes reach here and both are real: the client's own registry hands the
    // require function to the chunk callback (a function), while a page simulated for
    // a test hands back the same kind of object the probe used. Either way the module
    // cache hangs off it, and a registry that produced neither is reported rather than
    // treated as a client with no modules.
    const cache = requireFunction && requireFunction.c;
    if (!cache) return "err:no require function came back from the client's registry";
    const exported = cache[${moduleId}] && cache[${moduleId}].exports;
    if (!exported) return "err:the client's module " + ${moduleId} + " is not loaded any more";
    const method = exported[${methodName}];
    if (typeof method !== "function") return "err:the client's " + ${methodName} + " is not callable";
    const answer = await method.call(exported, ${value});
    return "ok:client " + ${moduleId} + "." + ${methodName} + (answer === undefined ? "" : " returned " + typeof answer);
  } catch (err) {
    return "err:the client's own sign-in threw " + (err && err.name) + ": " + scrub(err);
  }
})()`;
}

/* ---- the route ----------------------------------------------------------- */

/**
 * The route whose boot restores a session: the app, never the login page. Resolved
 * against the page the window is on, so a page served from somewhere else is still
 * sent to its own app route - and never thrown at, however odd the input.
 */
export function appRoute(href = "") {
  try {
    return new URL("/app", href || "https://discord.com/app").href;
  } catch {
    return "https://discord.com/app";
  }
}

/**
 * Read one observation of the page and say what it means:
 *   "accepted" - the client is on its own routes, so the token was taken
 *   "rejected" - the client put itself back on an auth route
 *   "waiting"  - the redirect has not settled yet, look again
 *
 * Route only, deliberately: the token is not a witness, because the client removes
 * the entry from storage the moment it reads it - and, as the log shows, it may not
 * read it at all.
 */
export function decideSignIn({ pathname = "" } = {}) {
  const where = String(pathname || "").toLowerCase();
  if (AUTH_PATHS.some((path) => where === path || where.startsWith(path + "/"))) return "rejected";
  if (/^\/channels(\/|$)/.test(where)) return "accepted";
  return "waiting";
}
