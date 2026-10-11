// language: JavaScript, file: src/signin.js
//
// Signing in with a user token, as two decisions small enough to test on their
// own: what to write, and whether it worked.
//
// The token goes into the page's own storage and the page is reloaded, because
// that is where Discord's client reads it at boot. What is *not* documented is
// the shape of the value. Two are in use in the wild - the bare token, and the
// token as a JSON string (which is what the token-login tools write) - and until
// now this client wrote the bare one and then told the user it had signed in
// without ever looking. When the shape was wrong, the client stayed on the login
// screen and the message said the opposite, which is the worst version of this
// bug: nothing to fix, because nothing looks broken.
//
// So: try one shape, look at where the client ended up, and try the other if the
// first was refused. `decideSignIn` is what "look" means, and it is deliberately
// dumb - Discord puts an unauthenticated visitor on /login, and a signed-in one
// on /channels/<something>.

/** Routes that only an unauthenticated visitor sees. */
export const AUTH_PATHS = ["/login", "/register", "/verify", "/new-login", "/authorize"];

/**
 * The shapes to try, in order. The bare value first, because it is what this
 * client shipped and what an already-working client would have; the JSON string
 * second, because that is what the tools that work in the wild write.
 */
export function signInForms(secret) {
  const value = String(secret === undefined || secret === null ? "" : secret);
  return [
    { name: "plain", value },
    { name: "json", value: JSON.stringify(value) },
  ];
}

/**
 * Read one observation of the page and say what it means:
 *   "accepted" - the client kept the token and is on the app's own routes
 *   "rejected" - the client put us back on an auth route, or dropped the token
 *   "waiting"  - the redirect has not settled yet, look again
 */
export function decideSignIn({ pathname = "", tokenPresent = false } = {}) {
  const where = String(pathname || "").toLowerCase();
  const onAuthRoute = AUTH_PATHS.some((path) => where === path || where.startsWith(path + "/"));
  if (onAuthRoute) return "rejected";
  const onAppRoute = /^\/channels(\/|$)/.test(where);
  if (onAppRoute) return tokenPresent ? "accepted" : "rejected";
  return "waiting";
}
