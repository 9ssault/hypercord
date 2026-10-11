// language: JavaScript, file: src/signin.js
//
// Signing in with a user token, as decisions small enough to test on their own:
// where to put the token, and whether it worked.
//
// Everything below was measured against the live Discord page inside this client,
// not read somewhere, and the measurements are the reason the code looks the way
// it does:
//
//   * the page's own world has NO storage. On discord.com `typeof localStorage` is
//     "undefined", it is not an own property of the window, and touching it throws
//     `ReferenceError` - `sessionStorage` with it. A write from the page's own world
//     therefore threw, and the older code never looked at the result, which is how
//     "token login did not work" came out as "signed in";
//   * a *same-origin frame* still has storage of its own: its own window, its own
//     `localStorage`. Appending an invisible same-origin iframe, writing through
//     `frame.contentWindow.localStorage` and removing it is the mechanism that
//     works today - measured, "ok:same-origin frame", with the value read back;
//   * the value has to be the RAW token. The JSON-quoted form older tools write is
//     read back *with* its quotes, so the client sent `"MTIz…"` in its own gateway
//     IDENTIFY frame and Discord's parser refused it - observed once per shape;
//   * writing is not signing in. The client reads the entry when the *app* boots, so
//     a sign-in sends the window to `/app` rather than reloading the login page, and
//     it removes the entry from storage as soon as it has read it - which is why an
//     empty store afterwards says nothing either way;
//   * only where the client ends up is a sign-in: on its own routes it worked, back
//     on an auth route it did not.

/** Routes that only an unauthenticated visitor sees. */
export const AUTH_PATHS = ["/login", "/register", "/verify", "/new-login", "/authorize"];

/**
 * Where to write the token, in the order to try it:
 *   "frame"   - through a same-origin frame's storage, which is the only storage the
 *               page offers today;
 *   "storage" - the page's own `localStorage`, for a page that still exposes one (an
 *               older build, a self-hosted one).
 *
 * Both write the raw token, because that is what the client puts in its IDENTIFY
 * frame; nothing else has to be written alongside it.
 */
export function signInForms(secret) {
  const value = String(secret === undefined || secret === null ? "" : secret);
  return [
    { name: "same-origin frame", how: "frame", value },
    { name: "storage", how: "storage", value },
  ];
}

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
 * the entry from storage the moment it reads it.
 */
export function decideSignIn({ pathname = "" } = {}) {
  const where = String(pathname || "").toLowerCase();
  if (AUTH_PATHS.some((path) => where === path || where.startsWith(path + "/"))) return "rejected";
  if (/^\/channels(\/|$)/.test(where)) return "accepted";
  return "waiting";
}

/**
 * The script that puts a token where the client will read it - the exact string the
 * shell evaluates in the page, kept here so it can be read and tested on its own.
 *
 * Both forms write the raw token and read it back before reporting success, because
 * a write that only *seems* to have happened is the bug this replaces. The answer is
 * a string, never a bare boolean: "ok:<where>" or "err:<name>: <why>", so a failure
 * carries its reason all the way to the person reading it.
 */
export function tokenWriteScript(form) {
  const value = JSON.stringify(String(form.value));
  const body =
    form.how === "frame"
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
      : `
    if (typeof localStorage === "undefined") return "err:this page has no localStorage of its own";
    localStorage.setItem("token", ${value});
    return localStorage.getItem("token") === ${value} ? "ok:this page's own storage" : "err:the page's storage kept something else";`;
  return `(() => {\n  try {${body}\n  } catch (err) {\n    return "err:" + (err && err.name) + ": " + (err && err.message);\n  }\n})()`;
}
