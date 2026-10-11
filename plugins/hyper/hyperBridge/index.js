// language: JavaScript, file: plugins/hyper/hyperBridge/index.js
//
// The link to the Hypercord control server, as a plugin rather than as a hard
// dependency of the shell: the client still opens Discord with no server
// configured, and this is what says whether it is reachable.
//
// No timer of any kind. One check when it starts, and another only when a caller
// asks for one, so an idle client is not talking to anything.
export default {
  name: "hyperBridge",
  description: "Keeps the link to the Hypercord control server and reports what state it is in",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "announce", type: "boolean", default: false, description: "write the link state to the log when it changes" },
  ],

  start(ctx) {
    const link = { state: "idle", at: 0, accounts: 0, reason: "" };

    function note(next, reason) {
      const changed = link.state !== next;
      link.state = next;
      link.reason = String(reason || "");
      if (changed && ctx.setting("announce")) ctx.log("control server: " + next + (link.reason ? " (" + link.reason + ")" : ""));
    }

    async function check() {
      if (!ctx.api) {
        note("unconfigured", "no control server configured");
        return { ...link };
      }
      const res = await ctx.api.request("/api/state");
      if (res.ok) {
        link.at = Date.now();
        link.accounts = res.json && Array.isArray(res.json.accounts) ? res.json.accounts.length : 0;
        note("up", "");
      } else {
        // "no control server configured" is a normal state, not a failure
        note(res.error === "no control server configured" ? "unconfigured" : "down", res.error || "control answered " + res.status);
      }
      return { ...link };
    }

    async function announce(reason) {
      if (!ctx.ui || typeof ctx.ui.notify !== "function") return false;
      const now = await check();
      ctx.ui.notify("Hypercord link", reason ? String(reason) : "control server: " + now.state);
      return true;
    }

    const helpers = { check, announce, state: () => ({ ...link }) };
    // fire and forget, but never unhandled: a rejected promise in the main
    // process is a crash path, so the first check reports its own failure
    check().catch((err) => note("down", String((err && err.message) || err)));
    return helpers;
  },

  stop(ctx) {
    ctx.log("bridge closed");
  },
};
