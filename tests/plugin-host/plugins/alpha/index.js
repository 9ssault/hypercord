// a fixture plugin: it records what happened in a global the test can read, so
// the test can see start() and stop() actually ran
const trace = () => (globalThis.__pluginTrace || (globalThis.__pluginTrace = []));

export default {
  name: "alpha",
  description: "a fixture plugin that starts and stops cleanly",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [{ key: "greeting", type: "string", default: "hi", description: "what it says" }],

  start(ctx) {
    trace().push("alpha:start");
    globalThis.__alphaCtx = ctx;
    return { said: ctx.setting("greeting"), id: ctx.id };
  },

  stop() {
    trace().push("alpha:stop");
  },
};
