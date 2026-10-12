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
//   * NOT KNOWN: where the client actually reads a session from. It is not
//     `localStorage.token` on this build. `storageProbeScript()` below exists to
//     answer that from the live page - it reports which storages and which keys
//     exist, never a value - and `signInCandidates()` is ordered so a probe result
//     can reorder it without the rest of this file changing.
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
    const out = { page: {}, frame: null, cookies: [], indexeddb: [], notes: [] };
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
