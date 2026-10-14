// language: JavaScript, file: src/attach-preload.cjs
//
// The preload the *real* Discord's windows get once Hypercord has patched the client
// (`npm start -- --attach`, or the patcher in src/patcher.js). Until this file existed
// the patched client was themed and nothing else: the loader injected one <style>
// element, so Discord's own settings had no Hypercord section in them and the pages in
// src/panes.html could only be reached from Hypercord's own window.
//
// It is deliberately two loads, in this order:
//
//   1. **Discord's own preload.** Our patch takes the path out of the window's
//      webPreferences and puts its own in (src/loader.cjs, installWindowPreload), so
//      Discord's window would otherwise lose the preload Discord shipped and would not
//      work. Its path travels here in HYPERCORD_DISCORD_PRELOAD, and it is required
//      first, in this same preload context, which is where Discord expects it to run.
//      This is the order Vencord uses for the same reason.
//   2. **Hypercord's own preload** (src/preload.cjs): the bridge, the passkey policy,
//      the token option beside Discord's login fields, and Discord's settings with
//      Hypercord's pages in them.
//
// Either load can fail without taking the other with it: a Discord that will not start
// is worse than a client without our pages, and a missing one of the two is reported
// rather than silently halved.
const path = require("node:path");

function load(what, file) {
  if (!file) return false;
  try {
    require(file);
    return true;
  } catch (err) {
    // console.error, not a throw: the loader's own message is the one a person reads,
    // and this is the line that says which half of the window is missing
    console.error("[hypercord] " + what + " did not load: " + String((err && err.stack) || err));
    return false;
  }
}

const discordPreload = String(process.env.HYPERCORD_DISCORD_PRELOAD || "");
load("Discord's own preload", discordPreload);

// A way back to a plain Discord without unpatching: the client is still patched, the
// window just loads Discord alone. Set HYPERCORD_ATTACH_SKIP=1.
const skipped = String(process.env.HYPERCORD_ATTACH_SKIP || "") === "1";
if (!skipped) {
  const ours = load("Hypercord's preload", path.join(__dirname, "preload.cjs"));
  if (!ours) console.error("[hypercord] the client runs as plain Discord this time: Hypercord's preload is not in this window");
}
