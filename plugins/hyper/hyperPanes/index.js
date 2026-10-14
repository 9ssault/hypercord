// language: JavaScript, file: plugins/hyper/hyperPanes/index.js
//
// Hypercord's settings pages, built into Discord's own settings: this plugin owns the
// one thing the pages cannot own themselves - the list of them, and which one is
// showing. A page is opened from Hypercord's entries in Discord's settings sidebar, or
// by a push from the shell, and it is part of the page whether or not it is open.
//
// The list is announced (`panes:views`), and src/preload.cjs turns it into one entry
// per section in Discord's sidebar, so a page added here appears there on its own.
export default {
  name: "hyperPanes",
  description: "Hypercord's settings pages, inside Discord's own settings: commands, plugins, Hyper plugins, beef, themes, logs, accounts, access keys",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "lastView", type: "string", default: "commands", description: "which view the manager sheet opens on" },
  ],

  start(ctx) {
    // beef sits beside our own plugins: both are the control server's own functions
    // rather than pieces of this client's setup
    const views = ["commands", "plugins", "hyper", "beef", "themes", "logs", "accounts", "tokens"];
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
