// language: JavaScript, file: src/api.js
//
// The control server, from the client's side. One place that knows the base URL
// and the token, so no other file ever handles either: the token lives in memory
// (and on disk only through Electron's safeStorage) and never reaches a log.
export function createApi({ baseUrl, token, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  let active = String(token || "");

  function setToken(next) {
    active = String(next || "");
  }

  async function request(path, { method = "GET", body, headers = {}, timeout = timeoutMs } = {}) {
    if (!base) return { ok: false, status: 0, error: "no control server configured" };
    const url = base + (String(path).startsWith("/") ? path : "/" + path);
    const init = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(Math.max(1000, Number(timeout) || timeoutMs)),
    };
    if (active) init.headers.authorization = "Bearer " + active;
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      const res = await fetchImpl(url, init);
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not json: the caller gets the text */
      }
      return { ok: res.ok, status: res.status, json, text, error: res.ok ? "" : "control answered " + res.status };
    } catch (err) {
      // an error string, never the request: a failed login must not print a token
      return { ok: false, status: 0, error: String((err && err.message) || err).slice(0, 160) };
    }
  }

  return {
    get base() {
      return base;
    },
    get authenticated() {
      return Boolean(base && active);
    },
    setToken,
    request,
    /** who is logged in, and whether the token is any good */
    me: () => request("/api/state"),
    /** run a bot command exactly as the command box would */
    run: (command, args = []) => request("/api/run", { method: "POST", body: { command, args } }),
    /** what the account can see: channels and users the bot knows */
    channels: () => request("/api/channels"),
    users: () => request("/api/users"),
    /** read the room, or say something as the account */
    chat: (payload = {}) => request("/api/chat", { method: "POST", body: payload }),
    say: (payload = {}) => request("/api/say", { method: "POST", body: payload }),
    /** start a beef from the client, exactly like $b @user */
    beef: (payload = {}) => request("/api/beef/start", { method: "POST", body: payload }),
    /** the watchdog: events, their severity, and the rule that decides a mention */
    watchdog: () => request("/api/watchdog"),
    logs: (lines = 200) => request("/api/logs?lines=" + Math.max(1, Math.min(2000, Number(lines) || 200))),
    /**
     * The account's own token, for logging this client in as that account.
     * The route is deliberately separate and needs a client-scoped token, and
     * the reply is never logged, cached to disk in clear, or shown in the UI.
     */
    session: (accountId) => request("/api/client/session", { method: "POST", body: { account: String(accountId || "") }, timeout: 15000 }),
  };
}
