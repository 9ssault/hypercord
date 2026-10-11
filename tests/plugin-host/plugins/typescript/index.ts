// a fixture standing in for the vendored catalogue, which is TypeScript: node
// cannot import this, so the host must refuse it by name instead of throwing a
// parse error out of the loader
import { definePlugin } from "@utils/types";

export default definePlugin({
  name: "typescript",
  description: "a fixture entry node cannot import",
  authors: [],
  start() {},
  stop() {},
});
