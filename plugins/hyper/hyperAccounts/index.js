// language: JavaScript, file: plugins/hyper/hyperAccounts/index.js
//
// Which accounts the control server knows about, and the handoff that logs this
// client in as one of them. The token never passes through here in clear: the
// session call returns it to whoever asked, and the shell is the only thing that
// touches it (straight into the page's storage, never into a log or this state).
//
// No polling: the list is read when the plugin starts and when a caller asks.
export default {
  name: "hyperAccounts",
  description: "The accounts the control server knows, and logging this client in as one of them",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "remember", type: "boolean", default: true, description: "remember which account was used last" },
  ],

  start(ctx) {
    const accounts = [];
    let current = String(ctx.setting("account") || "");
    let reason = "";

    async function refresh() {
      if (!ctx.api) {
        // No server is a normal state, not a failure. The accounts this client can
        // sign in as are the keys stored on the machine, and those live behind the
        // shell's token store: a plugin has no way to read a secret the UI is not
        // allowed to show, so this list stays empty and says why rather than
        // pretending the machine has no accounts at all.
        reason = "no control server configured (the keys stored on this machine are listed by the shell, not by this plugin)";
        return state();
      }
      const res = await ctx.api.request("/api/state");
      if (res.ok && res.json) {
        accounts.length = 0;
        for (const id of Array.isArray(res.json.accounts) ? res.json.accounts : []) accounts.push(String(id));
        if (!current && res.json.account) current = String(res.json.account);
        reason = "";
      } else if (res.error !== "no control server configured") {
        reason = String(res.error || "control answered " + res.status);
      }
      return state();
    }

    /**
     * Ask the control server for one account's token. The reply is handed
     * straight back to the caller and never logged, never stored here.
     */
    async function login(id) {
      if (!ctx.api || typeof ctx.api.session !== "function") return { ok: false, error: "no control server configured" };
      const res = await ctx.api.session(String(id || ""));
      if (res.ok && res.json && res.json.token) {
        current = String(id || "");
        if (ctx.setting("remember")) ctx.setSetting("account", current);
        reason = "";
        return { ok: true, account: current };
      }
      reason = res.status === 404 ? "the control server has no /api/client/session route yet" : String(res.error || "no token in the reply");
      return { ok: false, error: reason };
    }

    function state() {
      return { accounts: [...accounts], current, reason };
    }

    // fire and forget, but never unhandled: a rejected promise in the main
    // process is a crash path
    refresh().catch((err) => {
      reason = String((err && err.message) || err);
    });
    return { refresh, login, state };
  },

  stop(ctx) {
    ctx.log("accounts plugin stopped");
  },
};
