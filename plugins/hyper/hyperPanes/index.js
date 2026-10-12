// language: JavaScript, file: plugins/hyper/hyperPanes/index.js
//
// The manager sheet, built into the Discord window: there is no second window, so
// this plugin owns the one thing left for it to own - which view the sheet is
// showing. It is opened on demand from Hypercord's own entries in Discord's
// settings sidebar, or by a push from the shell, and the sheet is part of the
// page whether or not it is open.
export default {
  name: "hyperPanes",
  description: "The Hypercord manager, built into the Discord window: user tokens, commands, plugins, themes, logs, accounts",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "lastView", type: "string", default: "commands", description: "which view the manager sheet opens on" },
  ],

  start(ctx) {
    const views = ["commands", "plugins", "hyper", "themes", "logs", "accounts", "tokens"];
    let last = views.includes(String(ctx.setting("lastView"))) ? String(ctx.setting("lastView")) : "commands";

    function available() {
      if (ctx.ui && typeof ctx.ui.send === "function") ctx.ui.send("panes:views", [...views]);
      return [...views];
    }

    function open(view) {
      if (view !== undefined && view !== null) {
        const wanted = String(view);
        if (views.includes(wanted)) last = wanted;
      }
      ctx.setSetting("lastView", last);
      if (ctx.ui && typeof ctx.ui.send === "function") ctx.ui.send("panes:view", last);
      return last;
    }

    available();
    return { open, available, last: () => last };
  },

  stop(ctx) {
    ctx.log("panes plugin stopped");
  },
};
