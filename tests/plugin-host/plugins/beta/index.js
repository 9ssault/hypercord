// a fixture plugin that depends on alpha, and records whether alpha started first
const trace = () => (globalThis.__pluginTrace || (globalThis.__pluginTrace = []));

export default {
  name: "beta",
  description: "a fixture plugin that must not start before alpha",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: false,
  settings: [],

  start() {
    trace().push(trace().includes("alpha:start") ? "beta:start-after-alpha" : "beta:start-alone");
  },

  stop() {
    trace().push("beta:stop");
  },
};
