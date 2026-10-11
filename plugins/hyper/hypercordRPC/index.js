// language: JavaScript, file: plugins/hyper/hypercordRPC/index.js
//
// Says what this client is: one hello to the control server when it starts (and
// again only when a caller asks), so the server can tell a Hypercord client from
// a browser. It is a claim, not a heartbeat - there is no timer here, and a
// server that does not implement the route yet is a 404 to be ignored, not an
// error to report.
export default {
  name: "hypercordRPC",
  description: "Publishes this client's identity to the control server",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "enabled", type: "boolean", default: true, description: "announce this client to the control server" },
  ],

  start(ctx) {
    const identity = { client: "Hypercord", version: "1.0.0", account: "", at: 0, error: "" };

    async function publish() {
      if (ctx.setting("enabled") === false) return { ...identity, skipped: true };
      if (!ctx.api) {
        identity.error = "no control server configured";
        return { ...identity, skipped: true };
      }
      const res = await ctx.api.request("/api/client/hello", {
        method: "POST",
        body: { client: identity.client, version: identity.version },
      });
      identity.at = Date.now();
      if (res.ok) {
        identity.error = "";
        if (res.json && res.json.account) identity.account = String(res.json.account);
      } else if (res.status !== 404 && res.error !== "no control server configured") {
        identity.error = String(res.error || "control answered " + res.status);
      }
      return { ...identity };
    }

    const helpers = { publish, state: () => ({ ...identity }) };
    // fire and forget, but never unhandled: a rejected promise in the main
    // process is a crash path
    publish().catch((err) => {
      identity.error = String((err && err.message) || err);
    });
    return helpers;
  },

  stop(ctx) {
    ctx.log("rpc stopped");
  },
};
