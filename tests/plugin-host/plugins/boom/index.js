// a fixture plugin that throws on purpose, so the test can prove one bad plugin
// does not take the whole host (or the window) down with it
export default {
  name: "boom",
  description: "a fixture plugin whose start() throws",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: false,
  settings: [],

  start() {
    throw new Error("boom: refused to start");
  },

  stop() {},
};
