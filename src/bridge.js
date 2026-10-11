// language: JavaScript, file: src/bridge.js
//
// The way back from the patched client to the shell.
//
// With `--attach`, the real Discord loads `src/loader.cjs` inside *its* main
// process. A preload can hand a page one bridge object, but that page's calls have
// nowhere to go: the handlers - the token store, the plugin host, the control
// server - live in Hypercord's own process. So the shell opens this: one loopback
// socket, one endpoint, and a shared secret handed to the loader at patch time.
//
// What it is not: a service. It listens on a loopback address only, on a port the
// OS picks, it is reachable only with a token that never reaches a log or a page,
// a foreign `Origin` is refused (a page can reach a local socket, so a request from
// somebody else's page must not be answered), it takes one small JSON body per
// call, and `close()` ends it - no timers, no polling, nothing left running.
//
// `createBridge` is async because only the listen callback knows whether the socket
// was actually obtained; a bridge that cannot listen returns `{ ok: false, error }`
// instead of pretending to be up.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";

/** Constant-time-ish comparison that never throws on a length mismatch. */
function sameSecret(given, wanted) {
  const left = Buffer.from(String(given === undefined || given === null ? "" : given));
  const right = Buffer.from(String(wanted === undefined || wanted === null ? "" : wanted));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** An error string fit for a caller, never a stack and never a secret. */
function reason(err) {
  return String((err && err.message) || err).slice(0, 200);
}

export async function createBridge({
  handlers = {},
  token = "",
  host = "127.0.0.1",
  allowOrigins = [],
  maxBody = 1024 * 1024,
  log = () => {},
} = {}) {
  const secret = String(token || "");
  const channels = new Map(Object.entries(handlers).filter(([, fn]) => typeof fn === "function"));
  const allowed = new Set((Array.isArray(allowOrigins) ? allowOrigins : [allowOrigins]).map((one) => String(one || "")).filter(Boolean));

  let server = null;
  let port = 0;
  let closed = false;
  const sockets = new Set();

  const answer = (res, status, payload) => {
    if (res.writableEnded) return;
    const body = payload === undefined ? "" : JSON.stringify(payload);
    try {
      res.writeHead(status, {
        "content-type": "application/json",
        // a local bridge answer is nobody's cache entry
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    } catch {
      /* the caller hung up: there is nobody left to tell */
    }
  };

  /** What a request has to look like before a handler is ever consulted. */
  function refusal(req, path) {
    if (req.method !== "POST") return { status: 405, error: "the bridge takes POST" };
    if (!sameSecret(req.headers["x-hypercord-bridge"], secret)) return { status: 403, error: "forbidden" };
    const origin = String(req.headers.origin || "");
    // Our own page is served from the loopback origin the bridge listens on, so that
    // one is always acceptable; every other origin has to be listed explicitly, which
    // is what keeps a page on the open web from reaching this socket. The shared
    // token is still required either way.
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    if (origin && !loopback && !allowed.has(origin)) return { status: 403, error: "forbidden" };
    if (path !== "/ipc") return { status: 404, error: "no such endpoint" };
    return null;
  }

  async function readBody(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > maxBody) {
        req.resume(); // drain rather than reset, so the caller can read the 413
        return { ok: false, status: 413, error: "the body is larger than this bridge accepts" };
      }
    }
    try {
      return { ok: true, body: raw ? JSON.parse(raw) : {} };
    } catch {
      return { ok: false, status: 400, error: "the body is not JSON" };
    }
  }

  async function onRequest(req, res) {
    let path = "/";
    try {
      path = new URL(req.url || "/", "http://" + host + ":" + port).pathname;
    } catch {
      /* a url this malformed is not worth explaining */
    }
    const refused = refusal(req, path);
    if (refused) return answer(res, refused.status, { ok: false, error: refused.error });

    const body = await readBody(req);
    if (!body.ok) return answer(res, body.status, { ok: false, error: body.error });

    const payload = body.body && typeof body.body === "object" ? body.body : {};
    const channel = String(payload.channel || "");
    const handler = channels.get(channel);
    if (!handler) return answer(res, 404, { ok: false, error: "no such channel" });

    const args = Array.isArray(payload.args) ? payload.args : [];
    try {
      // handlers are the shell's own, so a promise is expected; anything else is
      // simply the value
      const value = await handler(...args);
      return answer(res, 200, { ok: true, value: value === undefined ? null : value });
    } catch (err) {
      // HTTP 200 with ok:false: the call reached the shell and the shell said why
      return answer(res, 200, { ok: false, error: reason(err) });
    }
  }

  server = http.createServer((req, res) => {
    Promise.resolve(onRequest(req, res)).catch((err) => answer(res, 500, { ok: false, error: reason(err) }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // keep-alive connections otherwise hold the port open after close()
  server.keepAliveTimeout = 5000;

  const listening = await new Promise((resolve) => {
    const failed = (err) => resolve({ ok: false, error: reason(err) });
    server.once("error", failed);
    server.listen(0, host, () => {
      server.off("error", failed);
      resolve({ ok: true });
    });
  });
  if (!listening.ok) {
    try {
      server.close();
    } catch {
      /* never listened */
    }
    // Nothing was ever bound, so closing it is a success that did nothing - the same
    // answer the real close() gives the second time, which is what makes `close()`
    // safe to call without first asking whether the bridge came up.
    return {
      ok: false,
      error: listening.error,
      port: 0,
      token: "missing",
      url: "",
      close: async () => ({ ok: true, closed: false, already: true }),
      describe: () => ({ url: "", channels: channels.size, token: "missing" }),
    };
  }

  port = server.address().port;
  const url = "http://" + host + ":" + port;
  log("[hypercord] bridge on " + url + " for " + channels.size + " channel(s)");

  return {
    ok: true,
    port,
    token: "set",
    url,
    /** What a log line may say: never the token itself. */
    describe: () => ({ port, url, channels: channels.size, token: secret ? "set" : "missing" }),
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve({ ok: true, already: true });
        closed = true;
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            /* it may already be gone */
          }
        }
        sockets.clear();
        server.close(() => resolve({ ok: true }));
        // a server with no listener left resolves immediately; the callback above
        // is what makes the second close() a no-op
      }),
  };
}
