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
    // Closed by default, and that is deliberate: the rail is an overlay, and an
    // overlay that starts open sits on top of a column Discord drew itself (the
    // server tray). The manager is reached from Discord's own settings; the rail is
    // the shortcut, not the door.
    // The key is deliberately NEW (`openOnLaunch`, not `open`): every profile that
    // ran an earlier build has `open: true` written into its plugin settings, and
    // reading that key again would open the overlay over Discord's server tray no
    // matter what the default says. A new key starts from its default once.
    { key: "openOnLaunch", type: "boolean", default: false, description: "start with the rail open (off: the manager is in Discord's settings)" },
    { key: "side", type: "string", default: "right", description: "which edge the rail sits on" },
  ],

  start(ctx) {
    let open = ctx.setting("openOnLaunch") === true;
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
        ctx.setSetting("openOnLaunch", open);
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
