// language: JavaScript, file: plugins/hyper/hyperRail/index.js
//
// The rail: the one piece of Hypercord's own UI in the window. This plugin owns
// the visibility state and pushes it at the page; the shell only relays it. The
// rail is DOM and CSS injected at one point, so a closed rail costs nothing.
export default {
  name: "hyperRail",
  description: "The Hypercord rail, on the edge of the window, with the plugin list on it",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "open", type: "boolean", default: true, description: "start with the rail open" },
    { key: "side", type: "string", default: "right", description: "which edge the rail sits on" },
  ],

  start(ctx) {
    let open = ctx.setting("open") !== false;
    let side = ctx.setting("side") === "left" ? "left" : "right";

    function push() {
      if (ctx.ui && typeof ctx.ui.send === "function") ctx.ui.send("rail:visible", open);
      if (ctx.ui && typeof ctx.ui.send === "function") ctx.ui.send("rail:side", side);
      return open;
    }

    const helpers = {
      isOpen: () => open,
      side: () => side,
      toggle(next) {
        open = next === null || next === undefined ? !open : Boolean(next);
        ctx.setSetting("open", open);
        return push();
      },
      setSide(next) {
        side = String(next) === "left" ? "left" : "right";
        ctx.setSetting("side", side);
        return push();
      },
      sync: push,
    };

    push();
    return helpers;
  },

  stop(ctx) {
    if (ctx.ui && typeof ctx.ui.send === "function") ctx.ui.send("rail:visible", false);
    ctx.log("rail dropped");
  },
};
