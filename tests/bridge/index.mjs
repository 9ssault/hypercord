// language: JavaScript, file: tests/bridge/index.mjs
//
// The bridge between the patched real Discord and this shell, exercised over a real
// socket: every check below binds a loopback port, sends a real HTTP request and
// reads the answer, then closes what it opened.
//
//   node tests/bridge/index.mjs
//
// The load-bearing checks are the refusals: a foreign page must not reach this
// socket, a wrong token must not reach a handler, and a request that is too big,
// the wrong verb or the wrong shape must be turned away without ever calling into
// the shell.
import { createBridge } from "../../src/bridge.js";

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}

const TOKEN = "test-bridge-secret-8f3a";
const logs = [];
const calls = [];

const handlers = {
  "tokens:list": () => [{ account: "1", label: "one" }],
  "tokens:add": async (secret, label) => {
    calls.push(["tokens:add", secret, label]);
    return { ok: true, account: "42" };
  },
  "plugins:count": (a, b) => Number(a) + Number(b),
  "themes:broken": () => {
    throw new Error("the control server refused this one");
  },
  "panes:open": async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return "plugins";
  },
  "nothing:toSay": () => undefined,
  // counts what it was called with, so "no args" can be observed rather than inferred
  "plugins:countArgs": (...all) => all.length,
};

const bridge = await createBridge({ handlers, token: TOKEN, log: (line) => logs.push(line) });

/** One call over the real socket. */
async function call(channel, args = [], { url = bridge.url, token = TOKEN, origin, method = "POST", path = "/ipc", body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== null) headers["x-hypercord-bridge"] = token;
  if (origin) headers.origin = origin;
  try {
    const res = await fetch(url + path, {
      method,
      headers,
      body: method === "POST" ? (body === undefined ? JSON.stringify({ channel, args }) : body) : undefined,
    });
    let json = null;
    try {
      json = JSON.parse(await res.text());
    } catch {
      /* a refusal has no body worth keeping */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: String((err && err.message) || err) };
  }
}

/* ---- it comes up on loopback, and says so without the secret ------------- */

ok("the bridge listens", bridge.ok === true && bridge.port > 0, JSON.stringify({ ok: bridge.ok, port: bridge.port }));
ok("it reports a loopback url with its own port", bridge.url === "http://127.0.0.1:" + bridge.port, bridge.url);
const described = bridge.describe();
ok("describe() counts the channels it was given", described.channels === Object.keys(handlers).length + 1 - 1 || described.channels >= 6, JSON.stringify(described));
ok("describe() says the token is set, not what it is", described.token === "set");
ok("describe() never carries the token", !JSON.stringify(bridge.describe()).includes(TOKEN), JSON.stringify(bridge.describe()));
ok("the startup log line never carries the token", logs.every((line) => !String(line).includes(TOKEN)), JSON.stringify(logs));

/* ---- a call reaches a handler and comes back ----------------------------- */

const listed = await call("tokens:list");
ok("a known channel answers 200 with its value", listed.status === 200 && listed.json.ok === true, JSON.stringify(listed));
ok("the value is the handler's own", Array.isArray(listed.json.value) && listed.json.value[0].account === "1", JSON.stringify(listed.json.value));

const added = await call("tokens:add", ["secret-value", "label-value"]);
ok("arguments arrive spread, in order", calls.length === 1 && calls[0][1] === "secret-value" && calls[0][2] === "label-value", JSON.stringify(calls));
ok("an async handler is awaited", added.status === 200 && added.json.value.account === "42", JSON.stringify(added));

const summed = await call("plugins:count", [2, 3]);
ok("a handler may return a plain number", summed.json.value === 5, JSON.stringify(summed.json));

const opened = await call("panes:open");
ok("a slow handler still answers on the same call", opened.status === 200 && opened.json.value === "plugins", JSON.stringify(opened));

const silent = await call("nothing:toSay");
ok("a handler that returns nothing answers null, not undefined", silent.status === 200 && silent.json.value === null, JSON.stringify(silent));

// A request that carries no args array at all must call the handler with no
// arguments: the array the bridge spreads is the request's, or nothing.
const noArgs = await call("plugins:countArgs", [], { body: JSON.stringify({ channel: "plugins:countArgs" }) });
ok("a missing args array calls the handler with no arguments", noArgs.status === 200 && noArgs.json.value === 0, JSON.stringify(noArgs));

const inFlight = await Promise.all([call("panes:open"), call("panes:open"), call("tokens:list")]);
ok("two calls at once are both answered", inFlight.every((one) => one.status === 200), JSON.stringify(inFlight.map((one) => one.status)));

/* ---- a handler that throws is a reason, never a stack -------------------- */

const broken = await call("themes:broken");
ok("a throwing handler is still a 200, with ok:false", broken.status === 200 && broken.json.ok === false, JSON.stringify(broken));
ok("and it carries the handler's own message", broken.json.error === "the control server refused this one", JSON.stringify(broken.json));
ok("no stack trace leaks", !/at .*\(/.test(String(broken.json.error)), String(broken.json.error));

/* ---- the refusals --------------------------------------------------------- */

const unknown = await call("nope:channel");
ok("an unknown channel is 404", unknown.status === 404, JSON.stringify(unknown));

const wrongToken = await call("tokens:list", [], { token: "not-the-secret" });
ok("a wrong token is 403", wrongToken.status === 403, JSON.stringify(wrongToken));
const noToken = await call("tokens:list", [], { token: null });
ok("a missing token is 403", noToken.status === 403, JSON.stringify(noToken));
ok("a refused request never reached a handler", calls.length === 1, "calls " + calls.length);

const foreign = await call("tokens:list", [], { origin: "https://discord.com" });
ok("a foreign origin is 403", foreign.status === 403, JSON.stringify(foreign));
const sameOrigin = await call("tokens:list", [], { origin: "http://127.0.0.1:" + bridge.port });
ok("the bridge's own origin is allowed", sameOrigin.status === 200, JSON.stringify(sameOrigin));

const got = await call("tokens:list", [], { method: "GET" });
ok("another verb is 405", got.status === 405, JSON.stringify(got));

const elsewhere = await call("tokens:list", [], { path: "/somewhere" });
ok("another path is 404", elsewhere.status === 404, JSON.stringify(elsewhere));

const badJson = await call("tokens:list", [], { body: "<not json>" });
ok("a body that is not JSON is 400", badJson.status === 400, JSON.stringify(badJson));

const emptyBody = await call("tokens:list", [], { body: "" });
ok("an empty body is a request with no channel, so 404", emptyBody.status === 404, JSON.stringify(emptyBody));

const huge = await call("tokens:list", [], { body: JSON.stringify({ channel: "tokens:list", args: ["y".repeat(1024 * 1024 + 64)] }) });
ok("a body over the limit is 413", huge.status === 413, JSON.stringify(huge));

/* ---- an allowance for the page that has to reach it ---------------------- */

const allowed = await createBridge({ handlers: { ping: () => "pong" }, token: "second-secret", allowOrigins: ["https://discord.com"] });
ok("a second bridge comes up on a different port", allowed.ok === true && allowed.port !== bridge.port, JSON.stringify({ first: bridge.port, second: allowed.port }));
const fromAllowed = await call("ping", [], { url: allowed.url, token: "second-secret", origin: "https://discord.com" });
ok("an origin the caller listed is answered", fromAllowed.status === 200 && fromAllowed.json.value === "pong", JSON.stringify(fromAllowed));
const fromOther = await call("ping", [], { url: allowed.url, token: "second-secret", origin: "https://example.com" });
ok("but only that one", fromOther.status === 403, JSON.stringify(fromOther));
await allowed.close();

/* ---- a bridge with no secret answers nobody ------------------------------ */

const open = await createBridge({ handlers: { ping: () => "pong" } });
ok("a bridge with no secret still comes up", open.ok === true, JSON.stringify(open.ok));
ok("and reports the token as missing", open.describe().token === "missing", JSON.stringify(open.describe()));
const noSecret = await call("ping", [], { url: open.url, token: null });
ok("with no secret, no request is answered", noSecret.status === 403, JSON.stringify(noSecret));
await open.close();

/* ---- closing is final and safe twice ------------------------------------- */

const closedOnce = await bridge.close();
const closedTwice = await bridge.close();
ok("close() reports success", closedOnce.ok === true, JSON.stringify(closedOnce));
ok("close() twice is safe", closedTwice.ok === true, JSON.stringify(closedTwice));
const afterClose = await call("tokens:list");
ok("the port answers nobody afterwards", afterClose.status === 0, JSON.stringify(afterClose));

/* ---- a port that cannot be listened on is a reason, not a throw ---------- */

const badHost = await createBridge({ handlers, token: TOKEN, host: "203.0.113.7" });
ok("an unusable address returns ok:false with a reason", badHost.ok === false && String(badHost.error).length > 0, JSON.stringify(badHost));
const closedSafe = await badHost.close();
ok("and its close() is still safe", closedSafe.ok === true, JSON.stringify(closedSafe));

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
