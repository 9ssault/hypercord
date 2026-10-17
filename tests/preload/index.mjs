// language: JavaScript, file: tests/preload/index.mjs
//
// The injection path, in a real window: `src/preload.cjs` is loaded exactly as
// the client loads it (sandboxed, contextIsolated) into a page that stands in for
// Discord's, and the checks look at the document - one style element carrying the
// themes and what Hypercord injects, the token option placed under the login form,
// and Hypercord's own sections mounted inside Discord's settings, as pages in
// Discord's content column rather than in a window of their own. There is no rail
// and no settings sheet of our own left to test; that is the point of the suite
// now, so "there is no #hypercord-rail in the page" is asserted below.
//
// Two details of that stand-in page are deliberate:
//
//   * it is served over http with `Content-Security-Policy: script-src 'none'`.
//     Discord sends a strict script-src, and the manager sheet is our script, not
//     theirs: if the sheet only worked on a permissive page it would not work in
//     the client. A page that forbids every script is the honest test;
//   * it carries a login form with generated-looking class names, so the token
//     option has something to be placed against - the same way Discord's form is
//     found by measurement rather than by living inside their tree.
//
// Every channel the preload asks for is stubbed here, so this runs with no
// control server, no Discord and no network.
//
//   npx electron tests/preload
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "..", "src");
const read = (file) => fs.readFileSync(path.join(src, file), "utf8");

// the real policy, out of the real source: the preload asks for it synchronously,
// and the shell answers with this
const require_ = createRequire(import.meta.url);
const passkeys = require_(path.join(src, "passkeys.cjs"));
ipcMain.on("passkeys:policy", (event) => {
  event.returnValue = passkeys.POLICY;
});

// and the built runtime's script, which the preload asks for the same way and at the same
// moment: synchronously, while the document is still being created. This harness answers with
// nothing, because its pages are not Discord's and the preload injects the runtime into
// Discord's pages only - what is asserted here is that the *ask* happens (and that an
// unanswered channel is not a deadlock: without this handler the sync ask has no listener at
// all, which is why this suite used to hang here).
let runtimeAsks = 0;
ipcMain.on("hypercord:runtime-script", (event) => {
  runtimeAsks += 1;
  event.returnValue = "";
});

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}

// A test harness owns its own lifetime. Electron quits by default the moment its
// last window closes, and a suite that opens a second window after destroying the
// first would otherwise be creating that window while the app is already shutting
// down - every load then fails with ERR_FAILED and nothing about the page is
// actually being tested.
app.on("window-all-closed", () => {});

// The bound is liveness, not a limit on the work: this suite loads a dozen real windows and gives
// each of them time to settle, which on a cold dev box is close to a minute - a 60s watchdog is a
// coin flip between the suite finishing and being declared hung, and "hung" is what a run that
// simply needed two more seconds looked like.
const watchdog = setTimeout(() => {
  console.log("FAIL the suite hung: " + passed + " passed before it stopped");
  app.exit(2);
}, 150000);
watchdog.unref?.();

// The stand-in for Discord's login page: a login card with the same shape the
// preload looks for, and nothing else that could be mistaken for our own markup.
const PAGE = `<!doctype html><html><head><title>discord stands here</title></head><body>
<div id="app">
  <div class="authBox-1a2b">
    <h1>Welcome back!</h1>
    <form class="authForm-9f8e">
      <label for="email">Email or phone</label>
      <input id="email" type="text" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" />
      <button type="submit">Log in</button>
    </form>
  </div>
</div>
</body></html>`;

// The other page that matters: Discord's settings layer, whose sidebar is a tab
// strip with real tabs in it. Hypercord puts one entry of its own in there, and the
// page it opens becomes the content column below - so this page carries the two
// things that proves: a content column the sheet can be placed in, and Discord's
// own CSS custom properties and item classes for the entries and the page title to
// wear. Without them a test could only show that the nodes exist, not that they are
// laid out and coloured like the settings around them.
const SETTINGS_PAGE = `<!doctype html><html style="--header-primary: #f2f3f5; --text-normal: #dbdee1; --background-primary: #313338; --font-primary: &quot;gg sans&quot;;"><head><title>settings</title></head><body>
<div class="layers-1a2b" style="display:flex"><div class="sidebar-3c4d" role="tablist" style="width:220px;height:320px;display:flex;flex-direction:column">
  <button type="button" class="item-9f8e" role="tab">My Account</button>
  <button type="button" class="item-9f8e" role="tab">Profiles</button>
  <button type="button" class="item-9f8e" role="tab">Privacy &amp; Safety</button>
  <button type="button" class="item-9f8e" role="tab">Notifications</button>
</div><div class="content-1a2b" style="width:380px;height:300px"></div></div>
</body></html>`;

// The same layer in the shapes a release can serve instead: the sidebar is in the
// modal layer but its items are plain buttons with no tablist role anywhere, which
// is what the entry has to survive rather than the shape it was written against.
const SETTINGS_PLAIN_LIST = `<!doctype html><html><head><title>settings-plain</title></head><body>
<div class="layers-7f8g" style="display:flex"><div class="sidebar-9h0i" style="width:240px;height:340px;display:flex;flex-direction:column">
  <button type="button">My Account</button>
  <button type="button">Profiles</button>
  <button type="button">Appearance</button>
  <button type="button">Notifications</button>
</div><div class="content-1a2b" style="width:380px;height:300px"></div></div>
</body></html>`;

// And in the client's other language, with no modal wrapper and items that are not
// buttons: the labels are the only thing left to recognise the sidebar by, and a
// div has to be given the keyboard reach it does not come with.
const SETTINGS_FRENCH = `<!doctype html><html><head><title>settings-fr</title></head><body>
<div class="sidebar-lang" style="width:200px;height:300px;display:flex;flex-direction:column">
  <div role="tab">Mon compte</div>
  <div role="tab">Profil</div>
  <div role="tab">Apparence</div>
  <div role="tab">Notifications</div>
</div>
</body></html>`;

// Two sidebars on one page, which is the trap the old lookup walked into: the
// first one is the guild list and says nothing about settings.
const SETTINGS_TWO_LISTS = `<!doctype html><html><head><title>settings-two</title></head><body>
<div class="layers-guilds"><div class="sidebar-guilds" style="width:220px;height:320px;display:flex;flex-direction:column">
  <button type="button">Channels</button>
  <button type="button">Members</button>
  <button type="button">Threads</button>
  <button type="button">Events</button>
</div></div>
<div class="layers-5m6n" style="display:flex"><div class="sidebar-settings" style="width:220px;height:320px;display:flex;flex-direction:column">
  <button type="button">My Account</button>
  <button type="button">Appearance</button>
  <button type="button">Voice</button>
  <button type="button">Keybinds</button>
</div><div class="content-1a2b" style="width:380px;height:300px"></div></div>
</body></html>`;

// The bug these two fixtures exist for: Discord's server rail is also a sidebar-classed list
// full of buttons too, and one settings word in it was enough for the old lookup to
// accept it - so Hypercord's sections were added under the servers, where nobody looks
// for settings. The rail here says *two* settings labels (the labels are server names),
// so the count rule alone would let it through: what has to refuse it is the rail itself.
const SETTINGS_AFTER_RAIL = `<!doctype html><html><head><title>settings-rail</title></head><body>
<div class="guilds-wrapper-7x1"><div class="sidebar-guilds-rail" style="width:72px;height:320px;display:flex;flex-direction:column">
  <button type="button">Home</button>
  <button type="button">Appearance</button>
  <button type="button">Keybinds</button>
  <button type="button">voice</button>
</div></div>
<div class="layers-rail-8k9" style="display:flex"><div class="sidebar-settings-rail" style="width:220px;height:320px;display:flex;flex-direction:column">
  <button type="button">My Account</button>
  <button type="button">Appearance</button>
  <button type="button">Keybinds</button>
</div><div class="content-1a2b" style="width:380px;height:300px"></div></div>
</body></html>`;

// The same rail on a page that has no settings list anywhere: nothing of ours may be
// added to it, and the page has to say why.
const RAIL_ONLY = `<!doctype html><html><head><title>rail-only</title></head><body>
<div class="guilds-wrapper-7x1"><div class="sidebar-guilds-rail" style="width:72px;height:320px;display:flex;flex-direction:column">
  <button type="button">Home</button>
  <button type="button">Appearance</button>
  <button type="button">Keybinds</button>
  <button type="button">voice</button>
</div></div>
</body></html>`;

// And the shape the live client serves today, which is not a flat list at all: a nav
// holding a scroll container that holds a list of sections, each section a heading and a
// list of rows of its own. Two things about it decide whether our entries are usable at
// all. The scroll container clips what is not inside it, so an entry appended to the nav
// - the container's sibling - is drawn below the visible area and outside the part that
// scrolls: present in the document, unfindable on screen, unclickable. And the rows are
// the client's own markup - a li holding a div with a role, whose content holds the
// label - so an entry that merely borrows a class name is off their grid. The hidden
// heading is the one Discord reads out rather than draws, so a group that wants a
// visible name has to make its copy visible.
const SETTINGS_SECTIONS_PAGE = `<!doctype html><html style="--header-primary: #f2f3f5; --text-normal: #dbdee1; --background-primary: #313338;"><head><title>settings-sections</title><style>.hiddenVisually_b18fe2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }</style></head><body>
<div class="layers-sections" style="display:flex">
  <nav class="nav__409aa" style="width:240px;height:300px;display:flex;flex-direction:column">
    <div class="navScroller__409aa" style="flex:1 1 auto;min-height:0;overflow-y:scroll">
      <ul class="sublist__409aa" style="margin:0;padding:0;list-style:none">
        <li class="section__409aa" aria-labelledby="sec-general"><span class="hiddenVisually_b18fe2"><h3 class="heading-sm/medium_cf4812" id="sec-general" data-text-variant="heading-sm/medium">General</h3></span><ul class="sectionList__409aa" style="margin:0;padding:0;list-style:none">
          <li data-settings-sidebar-item="account" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___account" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">My Account</div></div></div><div class="subnavContainer_e4d939"></div></li>
          <li data-settings-sidebar-item="profiles" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___profiles" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">Profiles</div></div></div><div class="subnavContainer_e4d939"></div></li>
          <li data-settings-sidebar-item="privacy" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___privacy" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">Privacy &amp; Safety</div></div></div><div class="subnavContainer_e4d939"></div></li>
          <li data-settings-sidebar-item="notifications" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___notifications" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">Notifications</div></div></div><div class="subnavContainer_e4d939"></div></li>
        </ul></li>
        <li class="section__409aa" aria-labelledby="sec-billing"><div class="sectionLabel__409aa"><h3 class="heading-sm/medium_cf4812 label__409aa" id="sec-billing" data-text-variant="heading-sm/medium">Billing</h3></div><ul class="sectionList__409aa" style="margin:0;padding:0;list-style:none">
          <li data-settings-sidebar-item="nitro" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___nitro" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">Nitro</div></div></div><div class="subnavContainer_e4d939"></div></li>
          <li data-settings-sidebar-item="subscriptions" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___subscriptions" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">Subscriptions</div></div></div><div class="subnavContainer_e4d939"></div></li>
          <li data-settings-sidebar-item="gift" class="itemContainer_caf372"><div class="item_caf372" role="link" data-list-item-id="settings-sidebar___gift" tabindex="-1"><div class="itemContent_caf372"><svg class="icon_caf372" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4h1v16h-1z"></path></svg><div class="text-md/medium_cf4812" data-text-variant="text-md/medium">Gift Inventory</div></div></div><div class="subnavContainer_e4d939"></div></li>
        </ul></li>
      </ul>
      <div class="footer-1"><div class="clickable__081d7">stable 1.2.3</div></div>
    </div>
  </nav>
  <div class="content-1a2b" style="width:380px;height:300px"></div>
</div>
</body></html>`;

// The same sidebar with the vendored runtime's own section in it, which is the client this
// ships in: the pages belong *inside* that section, under the name the client already shows,
// with no group of ours beside it. A second section of ours next to it was a second place
// holding the same kind of thing, which is what the Hypercord group was. The runtime is
// branded Hypercord, and the same runtime under its older names draws Equicord or Vencord on
// that heading - which the client has to accept too, because the heading is the only part of
// the section that is the runtime's own name rather than a copy of Discord's vocabulary.
const SETTINGS_EQUICORD_PAGE = SETTINGS_SECTIONS_PAGE.replace(/Billing/g, "Hypercord Settings");
const SETTINGS_VENCORD_PAGE = SETTINGS_SECTIONS_PAGE.replace(/Billing/g, "Vencord");

// The shape the live client failed in, and the one thing the placement exists to get right: a
// settings layer whose host refuses pointer events and whose own panels opt back in. A page
// appended into that host inherits the refusal - drawn perfectly, clicked never - and the repair
// is one property on the page itself. The class on the column is the one the live client was
// measured with, so this fixture is a reproduction and not an invention.
const SETTINGS_SEALED = `<!doctype html><html style="--header-primary: #f2f3f5; --text-normal: #dbdee1; --background-primary: #313338;"><head><title>settings-sealed</title></head><body>
<div class="layers_c0ffee" style="display:flex;pointer-events:none">
  <div class="sidebar-sealed" style="width:240px;height:320px;display:flex;flex-direction:column;pointer-events:auto">
    <button type="button">My Account</button>
    <button type="button">Profiles</button>
    <button type="button">Appearance</button>
    <button type="button">Notifications</button>
  </div>
  <div class="stack_dbd263" style="width:420px;height:300px;pointer-events:auto"></div>
</div>
</body></html>`;

// A page that is not settings at all: the entry must not appear, and must not go
// looking for somewhere to appear either.
const PLAIN_PAGE = `<!doctype html><html><head><title>channels</title></head><body>
<div class="chat-1"><button type="button">Send</button><button type="button">Gift</button></div>
</body></html>`;

// every channel the preload and the manager sheet ask for, answered the way the
// shell answers - and recorded, because a call that never happens is the failure
// this suite exists to catch
const opened = [];
const calls = { plugins: 0, tokens: 0, uses: [], adds: [], forgets: 0, closes: 0, themeRows: 0, themeIndex: 0, themeIndexForces: [], beef: [], beefSections: 0, settings: [], toggles: [], themeInstalls: [], restarts: 0 };
let tokenRows = [];
// the plugins a switch has turned on in this run: a catalogue that never changed would
// answer the reload after a press with the state it started in, which is not what a shell
// does - and the page reads its cards from what the shell answers
const pluginOn = new Set();
// and the record the shell keeps for the plugins the built runtime runs: those switches are not
// the shell's to start or stop, they are *recorded* by it (the record is what the loader hands
// over at the next start, because the page's own store cannot keep anything on Discord's page).
// A stub answering this with a constant would hand the sheet a state nobody chose.
const runtimeRecorded = new Set();
// and the themes: which of them are on in this run
const themeOn = new Set(["midnight"]);

// What the shell's pageCss() hands over: the enabled themes, then the stylesheet of
// what Hypercord injects into Discord's page. The harness sending anything less
// would be testing a client that does not exist.
const THEME_CSS = ".theme-is-here { color: red; }";
const SHELL_CSS = THEME_CSS + "\n" + read("injected.css");

// The two channels the preload asks for, answered the way the shell answers them:
// nothing about a rail, because there is none - the settings pages are the whole
// surface, and `injected.css` is the stylesheet that dresses the two pieces of
// Hypercord that live in Discord's tree (the token option and the entries).
ipcMain.handle("ui:ready", () => ({ ok: true, account: "selftest" }));
ipcMain.handle("ui:assets", () => ({
  css: SHELL_CSS,
  promptHtml: read("prompt.html"),
  panesHtml: read("panes.html"),
  panesCss: read("panes.css"),
  panesJs: read("panes.js"),
}));
// The restart a plugin that patches Discord as it loads needs (and the one a change to
// Hypercord's own preload needs): the shell is what relaunches the process, and a page of
// ours is only allowed to ask. Recorded, because a button that never reaches the shell is
// exactly the failure this suite exists to catch.
ipcMain.handle("client:relaunch", () => {
  calls.restarts += 1;
  return { ok: true };
});
ipcMain.handle("panes:open", (_event, view) => {
  opened.push(String(view));
  // the shell opens the sheet by pushing the view back at the page, which is the
  // path a settings entry and the shell both take
  for (const target of BrowserWindow.getAllWindows()) {
    if (!target.isDestroyed()) target.webContents.send("push", "panes:open", String(view || "commands"));
  }
  return { ok: true };
});
ipcMain.handle("panes:close", () => {
  calls.closes += 1;
  // the shell pushes the close back, which is the whole reason Close goes through
  // it rather than hiding the sheet behind the shell's back
  const target = BrowserWindow.getAllWindows()[0];
  if (target && !target.isDestroyed()) target.webContents.send("push", "panes:close", true);
  return { ok: true };
});
ipcMain.handle("plugins:list", () => {
  calls.plugins += 1;
  // `source` is what splits our own plugins from the vendored catalogue: the
  // manifest marks ours "hypercord" and everything vendored "upstream"
  return [
    { id: "hyperPanes", name: "hyperPanes", description: "the settings pages", source: "hypercord", owner: "host", running: true, enabled: true, broken: "" },
    // a loaded plugin brings its declared settings with it, which is what the Plugins tab
    // builds its Settings form from (src/preload.cjs and plugins/hyper/hyperBeef)
    {
      id: "hyperBeef",
      name: "hyperBeef",
      description: "the beef section",
      source: "hypercord",
      running: true,
      enabled: true,
      broken: "",
      settings: [
        { key: "announce", type: "boolean", default: true, description: "Write generator changes to the log" },
        { key: "history", type: "number", default: 7, description: "Past beefs listed" },
      ],
    },
    { id: "hyperBridge", name: "hyperBridge", description: "the bridge", source: "hypercord", owner: "host", running: true, enabled: true, broken: "", tags: ["Hyper"] },
    // A vendored entry the shell cannot load: the reason here is one the host really produces
    // for an entry with no file behind it (src/plugin-host.js) - a fixture carrying a message
    // the client no longer has would be this suite documenting behaviour that is gone
    // The vendored shape, and the detail that matters: the catalogue's `id` is the *directory*
    // the plugin's source lives in ("spellCheck"), while the runtime keys its plugins by the
    // plugin's own name ("SpellCheck"). Every vendored entry is like this, so a catalogue whose
    // id is lower case and a runtime whose keys are not is the real arrangement, and the whole
    // built-in-runtime block below is only meaningful if this one resolves.
    { id: "spellCheck", name: "SpellCheck", description: "spellcheck", source: "upstream", owner: "runtime", running: false, enabled: runtimeRecorded.has("spellCheck"), broken: "the file is not here (not vendored): spellCheck/index.js", tags: ["Utility", "Chat"] },
    { id: "updater", name: "Updater", description: "updates", source: "hypercord", owner: "host", running: pluginOn.has("updater"), enabled: pluginOn.has("updater"), broken: "" },
  ];
});
ipcMain.handle("plugins:settings", (_event, id) => (String(id) === "hyperBeef" ? { announce: true, history: 7 } : {}));
ipcMain.handle("plugins:setSetting", (_event, id, key) => {
  calls.settings.push(String(id) + "." + String(key));
  return { ok: true };
});
ipcMain.handle("plugins:enable", (_event, id) => {
  calls.toggles.push("on:" + String(id));
  // the vendored one is recorded, not started: that is the whole difference the sheet is read
  // through, and it is what the real host does (chooseRuntime in src/plugin-host.js)
  if (String(id) === "spellCheck") runtimeRecorded.add("spellCheck");
  pluginOn.add(String(id));
  return { ok: true };
});
ipcMain.handle("plugins:disable", (_event, id) => {
  calls.toggles.push("off:" + String(id));
  if (String(id) === "spellCheck") runtimeRecorded.delete("spellCheck");
  pluginOn.delete(String(id));
  return { ok: true };
});
ipcMain.handle("plugins:status", () => null);
// The logs page reads this client's own lines when the shell has a reader for them:
// stub it, or every run of the logs page reports an unhandled channel in the test's
// own output, which is noise the page has already accounted for.
ipcMain.handle("logs:read", (_event, lines) => ["hypercord: one line from this run", "hypercord: and another"].slice(0, Number(lines) || 200));

// The Beef page is the one page whose contents another plugin owns: the stand-in
// describes a section the way the beef plugin does, and records what the page asks it
// to run, because a button that never reaches its plugin is the failure here.
// `beefRunning` is turned off further down to check what the page says when the plugin
// that describes it is not running at all.
let beefRunning = true;
const BEEF_SECTION = {
  id: "beef",
  title: "Beef",
  description: "The generator the beef path draws from, its reload and rollback, the line lab, and the last beef this account had.",
  settings: [
    { key: "announce", type: "boolean", label: "Write generator changes to the log" },
    { key: "showDropped", type: "boolean", label: "Show dropped categories" },
    { key: "history", type: "number", label: "Past beefs listed", min: 0, max: 20 },
  ],
  actions: [
    { id: "refresh", label: "Refresh", route: "GET /api/beef" },
    { id: "reload", label: "Reload generator", route: "POST /api/beef", needs: "control server" },
    { id: "inspect", label: "Read a line", route: "GET /api/inspect", needs: "control server", input: "text" },
    { id: "last", label: "Last beef", route: "GET /api/last-beef", needs: "control server" },
  ],
  state: {
    ready: false,
    categories: [],
    dropped: [],
    remapped: {},
    generations: 0,
    reloadMs: 0,
    source: "",
    lastError: "",
    backup: null,
    at: 0,
    reason: "no control server configured (beef runs on the control server's account bot)",
    droppedShown: true,
  },
};
ipcMain.handle("plugins:section", (_event, id) => {
  calls.beefSections += 1;
  if (!beefRunning) return { ok: false, error: "no running plugin in this run describes a section called " + String(id) };
  if (String(id) !== "hyperBeef") return { ok: false, error: "no running plugin in this run describes a section called " + String(id) };
  return { ok: true, section: BEEF_SECTION };
});
ipcMain.handle("plugins:sectionAction", (_event, id, action, input) => {
  calls.beef.push([String(id), String(action), input === undefined ? null : input]);
  if (String(action) === "last") {
    return { ok: true, beef: { id: "77", line: "a line of filler" }, history: [{ id: "76", line: "older" }], total: 2 };
  }
  if (String(action) === "inspect") return { ok: true, read: { droppable: false, categories: ["a"] } };
  return { ok: true, ready: true, categories: ["a", "b"], generations: 3 };
});
ipcMain.handle("api:request", (_event, endpoint) => ({ ok: true, status: 200, json: { route: String(endpoint) }, text: "log line for " + String(endpoint) }));
ipcMain.handle("themes:list", () => {
  calls.themeRows += 1;
  return [
    { id: "midnight", name: "Midnight", source: "local", enabled: themeOn.has("midnight") },
    { id: "soft", name: "Soft", source: "online", enabled: themeOn.has("soft") },
  ];
});
ipcMain.handle("themes:css", () => ".theme-is-here { color: red; }");
ipcMain.handle("themes:quickCss", () => ".quick { opacity: .5; }");
ipcMain.handle("themes:enable", (_event, id, on) => {
  calls.toggles.push("theme:" + String(id) + ":" + (on ? "on" : "off"));
  if (on) themeOn.add(String(id));
  else themeOn.delete(String(id));
  return { ok: true };
});
ipcMain.handle("themes:remove", () => ({ ok: true }));
ipcMain.handle("themes:quick", () => ({ ok: true }));
ipcMain.handle("themes:install", (_event, source, name) => {
  calls.themeInstalls.push([String(source), name === undefined ? "" : String(name)]);
  return { ok: true, id: "whatever" };
});
// the published theme library, as the shell hands it over: trimmed to what a card shows. Every
// read is counted and every read says whether it was forced, because *when* this one thing is
// fetched is part of the contract: the Themes tab's own draw reads it, the Load button reads it
// again by force, and nothing reads it for a tab nobody opened.
ipcMain.handle("themes:index", (_event, force) => {
  calls.themeIndex += 1;
  calls.themeIndexForces.push(force === true);
  return {
  ok: true,
  cached: false,
  fetchedAt: Date.now(),
  from: "https://api.themes.example/themes",
  themes: [
    {
      id: "47",
      name: "DTM-08",
      author: "XYZenix",
      description: "a glossy theme",
      tags: ["dark", "glossy"],
      downloads: 368,
      updated: "2021-05-06T12:27:37.177Z",
      download: "https://api.themes.example/download/47",
    },
    {
      id: "9",
      name: "Midnight Blue",
      author: "someone",
      description: "a blue theme",
      tags: ["dark"],
      downloads: 12,
      updated: "",
      download: "https://api.themes.example/download/9",
    },
  ],
  forced: Boolean(force),
  };
});
ipcMain.handle("account:current", () => ({ account: "selftest", accounts: ["selftest", "second"] }));
ipcMain.handle("account:switch", () => ({ ok: true }));
ipcMain.handle("update:state", () => ({ mode: "dev", supported: false, error: "" }));
ipcMain.handle("update:check", () => ({ ok: false, error: "dev" }));
ipcMain.handle("notify", () => ({ ok: true }));
ipcMain.handle("perf:metrics", () => []);
ipcMain.handle("tokens:list", () => {
  calls.tokens += 1;
  return tokenRows;
});
ipcMain.handle("tokens:store", () => ({ ok: true, file: "tokens.json", encrypted: true, count: tokenRows.length }));
ipcMain.handle("tokens:use", (_event, account) => {
  calls.uses.push(String(account));
  return { ok: true, account: String(account) };
});
ipcMain.handle("tokens:test", () => ({ ok: true, identity: { username: "selftest" } }));
ipcMain.handle("tokens:remove", () => ({ ok: true }));
ipcMain.handle("tokens:forgetAll", () => {
  calls.forgets += 1;
  return { ok: true, removed: tokenRows.length };
});
ipcMain.handle("tokens:add", (_event, value, label) => {
  calls.adds.push([String(value || ""), String(label || "")]);
  return { ok: true, account: "1", label: "added" };
});
ipcMain.handle("tokens:put", () => ({ ok: true, account: "1" }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run an expression in the page's own world and hand back its value. */
const page = (win, expression) => win.webContents.executeJavaScript(expression);

async function run() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Discord's own policy is strict; a page that forbids every script is the
      // honest place to prove that the sheet still mounts
      "content-security-policy": "script-src 'none'; object-src 'none'",
    });
    const pages = {
      "/settings": SETTINGS_PAGE,
      "/settings-plain": SETTINGS_PLAIN_LIST,
      "/settings-fr": SETTINGS_FRENCH,
      "/settings-two": SETTINGS_TWO_LISTS,
      "/settings-rail": SETTINGS_AFTER_RAIL,
      "/settings-sections": SETTINGS_SECTIONS_PAGE,
      "/settings-equicord": SETTINGS_EQUICORD_PAGE,
      "/settings-vencord": SETTINGS_VENCORD_PAGE,
      "/rail-only": RAIL_ONLY,
      "/settings-sealed": SETTINGS_SEALED,
      "/plain": PLAIN_PAGE,
    };
    res.end(pages[String(req.url || "").split("?")[0]] || PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port + "/";

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(src, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const consoleErrors = [];
  const consoleAll = [];
  win.webContents.on("console-message", (_e, level, message) => {
    consoleAll.push(level + ": " + String(message));
    if (level >= 3) consoleErrors.push(String(message));
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => consoleErrors.push("did-fail-load " + code + " " + desc + " " + url));

  await win.loadURL(origin);
  // the preload boots on DOMContentLoaded and asks main for the assets after
  await wait(600);
  // the shell answers ui:ready by pushing the page's CSS, so the stand-in does the
  // same thing here; the assertions below then read the page, not the stub
  win.webContents.send("push", "themes:css", SHELL_CSS);
  await wait(200);

  /* ---- the bridge, the injected css, the settings pages ---------------- */

  const seen = await page(
    win,
    `(() => {
    const style = document.getElementById("hypercord-theme");
    const host = document.getElementById("hypercord-panes");
    return {
      bridge: typeof window.hypercord,
      surfaces: window.hypercord ? Object.keys(window.hypercord).sort() : [],
      styleText: style ? style.textContent : null,
      styleCount: document.querySelectorAll("style").length,
      // the rail is gone: no node, no rule, no bridge method to drive one
      railNode: Boolean(document.getElementById("hypercord-rail")),
      railRules: style ? /#hypercord-rail|--hc-rail-width|--hc-tray-/.test(style.textContent) : false,
      appIntact: document.getElementById("app").textContent.includes("Welcome back!"),
      inputsIntact: Boolean(document.getElementById("email")) && Boolean(document.getElementById("password")),
      panesPresent: Boolean(host),
      panesOpen: host ? host.getAttribute("data-open") : null,
      panesSeamless: host ? host.getAttribute("data-seamless") : null,
      panesWidth: host ? Math.round(host.getBoundingClientRect().width) : -1,
    };
  })()`,
  );

  ok("the bridge is exposed to the page", seen.bridge === "object", seen.bridge);
  for (const surface of ["api", "panes", "plugins", "themes", "tokens", "account", "update", "notify", "on"]) {
    ok("the bridge carries " + surface, seen.surfaces.includes(surface), seen.surfaces.join(","));
  }
  ok("the bridge carries no rail: the settings pages are the whole surface", !seen.surfaces.includes("rail"), seen.surfaces.join(","));
  ok("no rail is mounted in the page", seen.railNode === false && seen.railRules === false, "node " + seen.railNode + " rules " + seen.railRules);
  ok(
    "the themes and our own injected css arrive as one element, with nothing of a rail in it",
    seen.styleText === SHELL_CSS && seen.styleText.includes("#hypercord-token-prompt") && seen.styleCount === 2,
    "our style elements " + seen.styleCount + ", chars " + (seen.styleText || "").length,
  );
  ok("the settings pages are mounted, and closed until a section is asked for", seen.panesPresent && seen.panesOpen === "false", "present " + seen.panesPresent + " open " + seen.panesOpen);
  // The login page has no settings layer, so there is nowhere to place them: they
  // claim no room at all rather than covering the client with a page of our own.
  ok("they claim no space at all until Discord's settings content column is found", seen.panesSeamless === null && seen.panesWidth === 0, "seamless " + seen.panesSeamless + " width " + seen.panesWidth);
  ok("discord's own markup is untouched", seen.appIntact && seen.inputsIntact);

  win.webContents.send("push", "themes:css", ".pushed { color: blue; }");
  await wait(150);
  ok("a pushed theme replaces the injected css", (await page(win, `document.getElementById("hypercord-theme").textContent`)) === ".pushed { color: blue; }");
  // back to the real sheet, because everything below reads its own styles
  win.webContents.send("push", "themes:css", SHELL_CSS);
  await wait(150);

  /* ---- the passkey policy, before anything else ------------------------- */

  // The Windows "choose a passkey" dialog is raised by the request a login page
  // makes by itself, and it is raised in the browser process - so the only place
  // to stop it is in the page, before Discord's own scripts. These checks assert
  // the policy: the uninvited request is refused, and the deliberate ones are not.
  const passkeys = await page(
    win,
    `(async () => {
    const out = { marker: window.__hypercordPasskeys || "(none)", credentials: typeof navigator.credentials };
    out.publicKeyCredential = typeof PublicKeyCredential;
    out.getIsOurs = Boolean(navigator.credentials && navigator.credentials.get && navigator.credentials.get.__hypercord);
    if (window.PublicKeyCredential && typeof PublicKeyCredential.isConditionalMediationAvailable === "function") {
      out.conditional = await PublicKeyCredential.isConditionalMediationAvailable();
    } else {
      out.conditional = "absent";
    }
    const attempt = async (options) => {
      try {
        await navigator.credentials.get(options);
        return "resolved";
      } catch (err) {
        return String((err && err.name) || "") + ": " + String((err && err.message) || err).slice(0, 60);
      }
    };
    out.conditionalGet = await attempt({ publicKey: {}, mediation: "conditional" });
    out.uninvitedGet = await attempt({ publicKey: {} });
    out.otherGet = await attempt({ password: true });
    // what it refused, kept so a "the dialog popped up again" can be answered from
    // the page: kinds and reasons only, never the challenge or the credential
    out.record = Array.isArray(window.__hypercordPasskeyCalls) ? [...window.__hypercordPasskeyCalls] : null;
    return out;
  })()`,
  );

  ok("the passkey policy was applied to the page", passkeys.marker === "on-demand", passkeys.marker);
  // The runtime's script is asked for the same way, and before the page's own scripts: the
  // preload the window loads is the one that puts the runtime in, because a runtime that
  // arrives after Discord's bundle can list every plugin and reach none of its modules.
  ok("the window asked for the built runtime before its page ran", runtimeAsks > 0, String(runtimeAsks) + " ask(s)");
  ok("the page cannot be asked for a conditional passkey", passkeys.conditional === false || passkeys.conditional === "absent", String(passkeys.conditional));
  ok("the conditional request a login page makes by itself is refused", /NotAllowedError: Hypercord/.test(passkeys.conditionalGet), passkeys.conditionalGet);
  ok("a passkey request with no click behind it is refused", /NotAllowedError: Hypercord/.test(passkeys.uninvitedGet), passkeys.uninvitedGet);
  ok("other uses of navigator.credentials are left alone", !/Hypercord/.test(passkeys.otherGet), passkeys.otherGet);
  ok("it keeps a bounded record of what it refused", Array.isArray(passkeys.record) && passkeys.record.length === 2 && passkeys.record.some((line) => /conditional/.test(line)) && passkeys.record.every((line) => !/[A-Za-z0-9_-]{20,}/.test(line)), JSON.stringify(passkeys.record));

  /* ---- the token option, beside the login form -------------------------- */

  const prompt = await page(
    win,
    `(() => {
    const box = document.getElementById("hypercord-token-prompt");
    const form = document.querySelector("form[class*=auth]");
    const boxRect = box ? box.getBoundingClientRect() : null;
    const formRect = form ? form.getBoundingClientRect() : null;
    return {
      mounted: Boolean(box),
      open: box ? box.getAttribute("data-open") : null,
      anchored: box ? box.getAttribute("data-anchored") : null,
      formHidden: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-form"]') || {}).hidden,
      storedHidden: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-stored"]') || {}).hidden,
      valueIsPassword: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-value"]') || {}).type === "password",
      clearsForm: boxRect && formRect ? Math.round(boxRect.top - formRect.bottom) : null,
      overlapsForm: boxRect && formRect ? boxRect.bottom > formRect.bottom && boxRect.top < formRect.bottom : null,
      inlineTop: box ? box.style.top : null,
      rectTop: boxRect ? Math.round(boxRect.top) : null,
      formBottom: formRect ? Math.round(formRect.bottom) : null,
      formTop: formRect ? Math.round(formRect.top) : null,
      position: box ? getComputedStyle(box).position : null,
    };
  })()`,
  );

  ok("the token option is in the page", prompt.mounted && prompt.open === "true", JSON.stringify(prompt));
  ok("with no token stored it offers the paste form, not the stored one", prompt.formHidden === false && prompt.storedHidden === true, JSON.stringify({ form: prompt.formHidden, stored: prompt.storedHidden }));
  ok("the token field is a password field", prompt.valueIsPassword === true);

  // Enter in the token field has to sign in: the form's submit is the one way in -
  // the button submits it too, and on a small screen the button can be out of reach
  // while Enter still lands. requestSubmit is the programmatic half of that Enter:
  // a synthetic keypress would not run the browser's implicit submission.
  await page(
    win,
    `(() => {
    const value = document.querySelector('#hypercord-token-prompt [data-hc="prompt-value"]');
    const form = document.querySelector('#hypercord-token-prompt [data-hc="prompt-form"]');
    if (!value || !form) return false;
    value.value = "selftest-token-value";
    form.requestSubmit();
    return true;
  })()`,
  );
  await wait(250);
  const pasted = await page(
    win,
    `((document.querySelector('#hypercord-token-prompt [data-hc="prompt-hint"]') || {}).textContent || "")`,
  );
  ok("submitting the paste form stores and signs in", calls.adds.length === 1 && calls.adds[0][0] === "selftest-token-value", JSON.stringify(calls.adds));
  ok("and says so beside the login form", /stored and signed in as added/.test(pasted), JSON.stringify(pasted));
  ok(
    "it is placed just under the login form, not over it",
    prompt.anchored === "true" && prompt.clearsForm !== null && prompt.clearsForm >= 0 && prompt.clearsForm <= 40,
    "gap " + prompt.clearsForm + "px, anchored " + prompt.anchored + ", inline top " + prompt.inlineTop + ", rect top " + prompt.rectTop + ", form " + prompt.formTop + ".." + prompt.formBottom + ", " + prompt.position,
  );
  ok("it does not cover the email and password fields", prompt.overlapsForm === false, String(prompt.overlapsForm));

  // a token appears in the store: the option turns into one button, and using it
  // is a real call to the shell
  tokenRows = [{ account: "412", label: "selftest", present: true, updatedAt: 1, fingerprint: "ab12", last4: "9c3d" }];
  win.webContents.send("push", "tokens:changed", tokenRows);
  await wait(250);
  const stored = await page(
    win,
    `(() => {
    const box = document.getElementById("hypercord-token-prompt");
    const form = document.querySelector('#hypercord-token-prompt [data-hc="prompt-form"]');
    const block = document.querySelector('#hypercord-token-prompt [data-hc="prompt-stored"]');
    return {
      open: box.getAttribute("data-open"),
      formHidden: form.hidden,
      storedHidden: block.hidden,
      who: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-who"]') || {}).textContent || "",
      leaksToken: box.textContent.includes("9c3d9c3d"),
    };
  })()`,
  );
  ok("a stored token turns the option into one sign-in button", stored.open === "true" && stored.formHidden === true && stored.storedHidden === false, JSON.stringify(stored));
  ok("it names the account and masks the token", stored.who.includes("selftest") && stored.who.includes("9c3d") && !stored.leaksToken, stored.who);

  await page(win, `document.querySelector('#hypercord-token-prompt [data-hc="prompt-use"]').click(); true`);
  await wait(250);
  const used = await page(win, `(document.querySelector('#hypercord-token-prompt [data-hc="prompt-stored-hint"]') || {}).textContent || ""`);
  ok("signing in with the stored token asks the shell for it", calls.uses.join(",") === "412", JSON.stringify(calls.uses));
  ok("and says so beside the login form", /signed in as selftest/.test(used), JSON.stringify(used));

  // and it can be put away for good: Discord's own login stays exactly as it was
  await page(win, `document.querySelector('#hypercord-token-prompt [data-hc="prompt-close"]').click(); true`);
  await wait(150);
  win.webContents.send("push", "tokens:changed", []);
  await wait(200);
  ok("Hide puts the token option away and it stays away", (await page(win, `document.getElementById("hypercord-token-prompt").getAttribute("data-open")`)) === "false");

  /* ---- the manager, built into the page --------------------------------- */

  const sheet = await page(
    win,
    `(() => {
    const host = document.getElementById("hypercord-panes");
    const style = document.getElementById("hypercord-panes-css");
    return {
      host: Boolean(host),
      mounted: host ? host.getAttribute("data-mounted") : null,
      open: host ? host.getAttribute("data-open") : null,
      css: style ? style.textContent.length : 0,
      // every selector in the sheet's stylesheet is scoped to it: comments off,
      // then each rule's selector must carry the prefix, so nothing of ours can
      // restyle Discord and nothing of Discord's can reach inside
      cssScoped: style
        ? style.textContent
            .split("/*")
            .map((part, index) => (index === 0 ? part : part.slice(part.indexOf("*/") + 2)))
            .join("")
            .split("}")
            .map((chunk) => chunk.split("{")[0])
            .filter((selector) => selector.trim())
            .every((selector) => selector.split(",").every((one) => one.includes("#hypercord-panes")))
        : false,
      api: typeof window.hypercordPanes,
      // no navigation of our own: the section list is Discord's settings sidebar
      nav: document.querySelectorAll("#hypercord-panes .nav, #hypercord-panes .nav-item").length,
      views: [...document.querySelectorAll("#hypercord-panes section.view")].map((b) => b.getAttribute("data-view")),
      sections: document.querySelectorAll("#hypercord-panes section.view").length,
      hpIds: ["hp-status", "hp-main", "hp-pluginList", "hp-runtimeThemes", "hp-tokenList"].every((id) => Boolean(document.getElementById(id))),
      inDiscord: Boolean(document.getElementById("app")),
    };
  })()`,
  );

  ok("the settings pages are mounted inside discord's own page", sheet.host && sheet.mounted === "true" && sheet.inDiscord, JSON.stringify(sheet));
  ok("and stay closed until a settings section opens one", sheet.open === "false", String(sheet.open));
  ok("they carry no navigation of their own, because Discord's sidebar is the list", sheet.nav === 0, "nav " + sheet.nav);
  ok("its stylesheet travels with it, scoped to the sheet", sheet.css > 500 && sheet.cssScoped, "chars " + sheet.css + " scoped " + sheet.cssScoped);
  ok("its script ran in the page's own world, under a page that forbids scripts", sheet.api === "object", String(sheet.api));
  ok(
    "it is one page per thing, access keys and our own plugins included",
    sheet.sections === 8 && ["commands", "plugins", "hyper", "beef", "themes", "logs", "accounts", "tokens"].every((v) => sheet.views.includes(v)),
    JSON.stringify(sheet.views),
  );
  ok("it uses hp- ids, so discord cannot collide with it", sheet.hpIds === true);

  // The shell opens a page by pushing, which is the path a settings entry takes - and
  // this page has no settings layer at all, so the sheet must refuse to appear. It used
  // to open right here, over the login card: a page of ours drawn over the client is the
  // one outcome these pages exist to avoid, and it is what happened before the preload
  // stopped accepting any old sidebar as Discord's settings list.
  win.webContents.send("push", "panes:open", "themes");
  await wait(400);
  const openedSheet = await page(
    win,
    `(() => {
    const host = document.getElementById("hypercord-panes");
    // on screen, not merely un-hidden: a closed sheet renders nothing at all, so a
    // section that kept no "hidden" class while its container is display:none is still
    // not something a person can see
    const visible = [...document.querySelectorAll("#hypercord-panes section.view")]
      .filter((n) => !n.classList.contains("hidden") && n.offsetParent !== null)
      .map((n) => n.getAttribute("data-view"));
    return {
      open: host.getAttribute("data-open"),
      visible,
      themeRows: document.querySelectorAll("#hypercord-panes #hp-themeList *").length,
      seamless: host.getAttribute("data-seamless"),
      status: (document.getElementById("hp-status") || {}).textContent || "",
      // with nowhere to be placed, the page stays where it was mounted and the
      // stylesheet's document-level z-index stays in charge of it
      parent: host.parentElement === document.documentElement ? "html" : String(host.parentElement.className),
      zIndex: getComputedStyle(host).zIndex,
    };
  })()`,
  );
  ok(
    "a pushed open with no settings layer on the page shows nothing, and says where the pages live",
    openedSheet.open === "false" && openedSheet.seamless === null && openedSheet.visible.length === 0 && /live in Discord's settings/.test(openedSheet.status),
    JSON.stringify(openedSheet),
  );
  ok(
    "and a page with nowhere to be placed is left mounted at document level, on the stylesheet's own z-index",
    openedSheet.parent === "html" && openedSheet.zIndex === "2147483000",
    JSON.stringify({ parent: openedSheet.parent, z: openedSheet.zIndex }),
  );
  // Nothing has read the theme library yet, and no tab drawn so far is the one that would: the
  // library is fetched by the Themes tab as it is drawn, never on its own, so a client nobody
  // has opened that tab in is not talking to anything.
  ok("no tab drawn so far has read the theme library", calls.themeIndex === 0, String(calls.themeIndex));
  // The page-rendering path is the page's own, and it is what every visit below relies
  // on: showing a section directly fills it, without asking the preload to place it.
  const shownThemes = await page(win, `window.hypercordPanes.show("themes")`);
  await wait(300);
  const themed = await page(
    win,
    `(() => ({
      rows: document.querySelectorAll("#hypercord-panes #hp-themeList *").length,
      shown: [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden")).map((n) => n.getAttribute("data-view")),
    }))()`,
  );
  ok("and showing a section directly still renders it, with the installed themes", shownThemes === "themes" && themed.rows > 0 && themed.shown[0] === "themes", JSON.stringify({ shown: shownThemes, rows: themed.rows }));
  ok(
    "drawing the Themes tab is what reads the library, once and unforced",
    calls.themeIndex === 1 && calls.themeIndexForces.join(",") === "false",
    JSON.stringify({ reads: calls.themeIndex, forced: calls.themeIndexForces }),
  );
  // the acceptance criterion, stated plainly: opening the manager must not create a
  // second window for it to live in
  ok("opening the manager created no second window", BrowserWindow.getAllWindows().length === 1, "windows " + BrowserWindow.getAllWindows().length);
  ok("opening a view logged no error", !/^\s*(error|failed)/i.test(openedSheet.status), JSON.stringify(openedSheet.status));

  // every page has to render when it is shown, with no polling involved. `show()` is
  // the sheet's own API and the one the preload drives; the user's way in - clicking
  // Discord's own settings entry - is what the settings window below exercises.
  const visited = [];
  for (const view of ["commands", "plugins", "hyper", "beef", "themes", "logs", "accounts", "tokens"]) {
    await page(win, `window.hypercordPanes.show(${JSON.stringify(view)}); true`);
    await wait(250);
    const shown = await page(
      win,
      `(() => {
      const visible = [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden"));
      return {
        shown: visible.map((n) => n.getAttribute("data-view")),
        status: (document.getElementById("hp-status") || {}).textContent || "",
        pluginRows: document.querySelectorAll("#hypercord-panes #hp-pluginList *").length,
        tokenRows: document.querySelectorAll("#hypercord-panes #hp-tokenList *").length,
      };
    })()`,
    );
    visited.push(view + ":" + JSON.stringify(shown.shown));
    ok("the " + view + " page shows exactly itself", shown.shown.length === 1 && shown.shown[0] === view, JSON.stringify(shown));
    ok("the " + view + " view logged no error", !/^\s*(error|failed)/i.test(shown.status), JSON.stringify(shown.status));
    if (view === "plugins") ok("the plugins view listed the catalogue", shown.pluginRows > 0, "nodes " + shown.pluginRows);
    if (view === "tokens") ok("the access keys view listed the stored token", shown.tokenRows > 0, "nodes " + shown.tokenRows);
  }
  ok("every view was visited", visited.length === 8, visited.join(" "));

  // The Beef page: the one page whose contents another plugin owns. The sheet has to
  // render the description it was handed - not a copy of the section kept in
  // src/panes.js - and every function it draws has to reach the plugin that declared
  // it, with the value that was typed. The stand-in's own record is what says so.
  await page(win, `window.hypercordPanes.show("beef"); true`);
  await wait(300);
  const beefPage = await page(
    win,
    `(() => {
    const textOf = (id) => (document.getElementById(id) || {}).textContent || "";
    return {
      shown: [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden")).map((n) => n.getAttribute("data-view")),
      title: (document.querySelector("#hypercord-panes section.view[data-view=beef] h2") || {}).textContent || "",
      intro: textOf("hp-beefIntro"),
      reason: textOf("hp-beefReason"),
      state: [...document.querySelectorAll("#hypercord-panes #hp-beefState .card-name")].map((n) => n.textContent),
      actions: [...document.querySelectorAll("#hypercord-panes #hp-beefActions button[data-beef-action]")].map((b) => b.getAttribute("data-beef-action")),
      fields: [...document.querySelectorAll("#hypercord-panes #hp-beefSettings .field")].map((f) => ({
        label: (f.querySelector("label") || {}).textContent || "",
        kind: (f.querySelector("input") || {}).type || "",
        checked: (f.querySelector('input[type="checkbox"]') || {}).checked,
        value: (f.querySelector('input[type="text"]') || {}).value || "",
      })),
    };
  })()`,
  );
  ok("the beef page shows exactly itself", beefPage.shown.length === 1 && beefPage.shown[0] === "beef", JSON.stringify(beefPage.shown));
  ok(
    "and it is described by the plugin, not by the sheet",
    beefPage.title === "Beef" && /generator the beef path draws from/.test(beefPage.intro) && calls.beefSections > 0,
    JSON.stringify({ title: beefPage.title, intro: beefPage.intro.slice(0, 50), asked: calls.beefSections }),
  );
  ok("the plugin's own words for why it is idle are shown", /no control server configured/.test(beefPage.reason), JSON.stringify(beefPage.reason));
  ok(
    "the generator table holds only what the section reported",
    beefPage.state.length === 1 && beefPage.state[0] === "Generator",
    JSON.stringify(beefPage.state),
  );
  ok(
    "every function the section declares is a button",
    ["refresh", "reload", "inspect", "last"].every((id) => beefPage.actions.includes(id)) && beefPage.actions.length === 4,
    JSON.stringify(beefPage.actions),
  );
  ok(
    "its settings are the section's own, with the values the host holds",
    beefPage.fields.length === 3 && beefPage.fields[0].label === "Write generator changes to the log" && beefPage.fields[0].kind === "checkbox" && beefPage.fields[0].checked === true && beefPage.fields[2].value === "7",
    JSON.stringify(beefPage.fields),
  );

  // a function that declares no input runs on one press, and its reply is the plugin's
  const beforeRefresh = calls.beef.length;
  await page(win, `document.querySelector('#hypercord-panes [data-beef-action="refresh"]').click(); true`);
  await wait(300);
  ok(
    "a function without an input runs in one press, through the bridge",
    calls.beef.length === beforeRefresh + 1 && calls.beef[calls.beef.length - 1][1] === "refresh",
    JSON.stringify(calls.beef.slice(-2)),
  );
  const beefOut = await page(win, `(document.getElementById("hp-beefOut") || {}).textContent || ""`);
  ok("and its reply is written into the page as text", /GET \/api\/beef/.test(beefOut) && /ready: true/.test(beefOut), JSON.stringify(beefOut.slice(0, 90)));

  // a function that declares an input asks for it first, and nothing is called until it
  // is given one - which is the difference between a field and a button that lied
  const beforeTyping = calls.beef.length;
  await page(win, `document.querySelector('#hypercord-panes [data-beef-action="inspect"]').click(); true`);
  await wait(250);
  const beefField = await page(
    win,
    `(() => {
    const row = document.getElementById("hp-beefInput");
    const control = row ? row.querySelector("[data-beef-value]") : null;
    return {
      open: row ? !row.classList.contains("hidden") : false,
      tag: control ? control.tagName : "",
      label: row && row.querySelector("label") ? row.querySelector("label").textContent : "",
    };
  })()`,
  );
  ok("a function that declares an input asks for it first", beefField.open && beefField.tag === "INPUT" && beefField.label === "text", JSON.stringify(beefField));
  ok("and the plugin was not called yet", calls.beef.length === beforeTyping, JSON.stringify(calls.beef.slice(-2)));
  await page(
    win,
    `(() => {
    const row = document.getElementById("hp-beefInput");
    row.querySelector("[data-beef-value]").value = "hello there";
    row.querySelector("button").click();
    return true;
  })()`,
  );
  await wait(300);
  ok(
    "running it passes what was typed to the plugin",
    calls.beef[calls.beef.length - 1][1] === "inspect" && calls.beef[calls.beef.length - 1][2] === "hello there",
    JSON.stringify(calls.beef.slice(-1)),
  );
  ok("and the field is put away once it has run", (await page(win, `document.getElementById("hp-beefInput").classList.contains("hidden")`)) === true);

  // the last beef and its history have a region of their own, filled from the reply
  await page(win, `document.querySelector('#hypercord-panes [data-beef-action="last"]').click(); true`);
  await wait(300);
  const beefLast = await page(win, `[...document.querySelectorAll("#hypercord-panes #hp-beefLast .card-name")].map((n) => n.textContent)`);
  ok(
    "the last beef and its history land in their own region",
    beefLast.includes("Last beef") && beefLast.some((one) => /history 1/.test(one)),
    JSON.stringify(beefLast),
  );

  // a section setting goes through the plugin host, which is what makes it persist
  const settingsBefore = calls.settings.length;
  await page(
    win,
    `(() => {
    const box = document.querySelector('#hypercord-panes #hp-beef-set-announce');
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    return true;
  })()`,
  );
  await wait(250);
  ok(
    "a setting on the page is saved through the plugin host",
    calls.settings.length === settingsBefore + 1 && calls.settings[calls.settings.length - 1] === "hyperBeef.announce",
    JSON.stringify(calls.settings.slice(-2)),
  );

  const browserSettingsAt = calls.settings.length;

  // The plugin browser. It is built the way the plugin browser people know from
  // Vencord is: a grid of cards, a switch on each card, and a plugin's own settings on
  // a page behind its name. Every one of those is checked here through the elements a
  // person actually presses, because a card that looks right and does nothing is the
  // failure this suite exists to catch.
  const browser = await page(
    win,
    `(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.hypercordPanes.show("plugins");
    await pause(300);
    const cards = () => [...document.querySelectorAll("#hp-pluginList .addon")];
    const cardOf = (id) => cards().find((one) => one.dataset.id === id);
    const switchOf = (id) => {
      const card = cardOf(id);
      return card ? card.querySelector('[role="switch"]') : null;
    };
    const read = (id) => {
      const box = switchOf(id);
      return box ? box.getAttribute("aria-checked") : null;
    };
    const state = {
      cards: cards().length,
      switches: document.querySelectorAll('#hp-pluginList .addon [role="switch"]').length,
    };
    // the updater is off in the catalogue this suite answers with, so its switch is the
    // one to press: on, then off again, which is what somebody trying one would do
    state.before = read("updater");
    if (switchOf("updater")) switchOf("updater").click();
    await pause(350);
    state.afterOn = read("updater");
    if (switchOf("updater")) switchOf("updater").click();
    await pause(350);
    state.afterOff = read("updater");

    // a plugin's name - and the cog beside it - opens that plugin's own page
    const open = cardOf("hyperBeef") ? cardOf("hyperBeef").querySelector('[data-action="settings"]') : null;
    if (open) open.click();
    await pause(350);
    const panel = document.getElementById("hp-pluginDetail");
    const fields = [...document.querySelectorAll("#hp-settingsForm [data-key]")];
    state.detail = {
      open: panel ? !panel.classList.contains("hidden") : false,
      title: (document.getElementById("hp-detailTitle") || {}).textContent,
      keys: fields.map((one) => one.dataset.key),
      badges: [...document.querySelectorAll("#hp-detailState .badge")].map((one) => one.textContent),
      gridHidden: document.getElementById("hp-pluginList").classList.contains("hidden"),
    };

    // a text field writes when it is left, and a switch writes when it is pressed:
    // there is no Save button, so there is nothing to forget to press
    const history = document.getElementById("hp-set-hyperBeef-history");
    if (history) {
      history.value = "9";
      history.dispatchEvent(new Event("change"));
    }
    await pause(250);
    const announce = document.querySelector('#hp-settingsForm [data-key="announce"] [role="switch"]');
    if (announce) announce.click();
    await pause(250);
    state.saved = (document.getElementById("hp-status") || {}).textContent || "";

    if (document.getElementById("hp-detailBack")) document.getElementById("hp-detailBack").click();
    await pause(350);
    state.detailClosed = document.getElementById("hp-pluginDetail").classList.contains("hidden");
    state.gridBack = !document.getElementById("hp-pluginList").classList.contains("hidden");
    state.afterBack = cards().length;

    // and the search box filters the grid rather than the list underneath it
    const search = document.getElementById("hp-pluginSearch");
    if (search) {
      search.value = "spell";
      search.dispatchEvent(new Event("input"));
    }
    await pause(250);
    state.filtered = cards().length;
    state.filteredName = cards().length ? cards()[0].dataset.id : "";
    state.summary = (document.getElementById("hp-pluginSummary") || {}).textContent || "";
    if (search) {
      search.value = "";
      search.dispatchEvent(new Event("input"));
    }
    await pause(200);
    state.restored = cards().length;
    return state;
  })()`,
  );
  ok(
    "every plugin card carries a switch, one card per plugin",
    browser.cards >= 5 && browser.switches === browser.cards,
    JSON.stringify({ cards: browser.cards, switches: browser.switches }),
  );
  ok(
    "pressing a card's switch enables and disables that plugin through the shell",
    browser.before === "false" &&
      browser.afterOn === "true" &&
      browser.afterOff === "false" &&
      calls.toggles.includes("on:updater") &&
      calls.toggles.includes("off:updater"),
    JSON.stringify({ before: browser.before, afterOn: browser.afterOn, afterOff: browser.afterOff, toggles: calls.toggles.slice(-2) }),
  );
  ok(
    "a plugin's name opens its own page, with the fields that plugin declares",
    browser.detail.open &&
      browser.detail.title === "hyperBeef" &&
      browser.detail.keys.includes("announce") &&
      browser.detail.keys.includes("history") &&
      browser.detail.badges.includes("running"),
    JSON.stringify(browser.detail),
  );
  ok("and the grid it was opened from steps aside while it is up", browser.detail.gridHidden === true, String(browser.detail.gridHidden));
  ok(
    "a field on that page is saved when it is edited, with no Save button to press",
    calls.settings.slice(browserSettingsAt).includes("hyperBeef.history") &&
      calls.settings.slice(browserSettingsAt).includes("hyperBeef.announce"),
    JSON.stringify(calls.settings.slice(browserSettingsAt)),
  );
  ok("and the page says what it wrote", /saved hyperBeef\./.test(browser.saved), JSON.stringify(browser.saved));
  ok(
    "Back puts the list back, whole",
    browser.detailClosed === true && browser.gridBack === true && browser.afterBack === browser.cards,
    JSON.stringify({ closed: browser.detailClosed, grid: browser.gridBack, cards: browser.afterBack }),
  );
  ok(
    "the search box filters the grid to what matches",
    browser.filtered === 1 && browser.filteredName === "spellCheck" && browser.restored === browser.cards && /of 5/.test(browser.summary),
    JSON.stringify({ filtered: browser.filtered, name: browser.filteredName, restored: browser.restored, summary: browser.summary }),
  );

  // The vendored catalogue is TypeScript source, so the built runtime owns those plugins'
  // switches - and its own settings are the only copy of "this plugin is on". This is that
  // page with a runtime in it (a stand-in, since the real one arrives from Discord's page in
  // a live client): what a switch writes, what it is allowed to claim, and where a built-in
  // plugin's own settings come from.
  const runtimeToggles = calls.toggles.length;
  const restartsBefore = calls.restarts;
  const builtIn = await page(
    win,
    `(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // keyed by the plugin's own name, the way the built runtime keys its plugin list and its
    // settings - while the catalogue calls the same plugin "spellCheck", which is the name of
    // the directory its source lives in
    const settings = { plugins: { SpellCheck: { enabled: false } } };
    const plugin = {
      name: "SpellCheck",
      description: "spellcheck",
      started: false,
      requiresRestart: true,
      patches: [{ find: "x" }],
      settings: { def: { fix: { type: "boolean", description: "fix" } }, store: {} },
    };
    const seen = { started: [], stopped: [], modals: [] };
    window.Vencord = {
      Settings: settings,
      Components: { openPluginModal: (p, onRestartNeeded) => seen.modals.push({ name: p.name, restart: typeof onRestartNeeded }) },
      Plugins: {
        plugins: { SpellCheck: plugin },
        startPlugin: (p) => {
          seen.started.push(p.name);
          p.started = true;
          return true;
        },
        stopPlugin: (p) => {
          seen.stopped.push(p.name);
          p.started = false;
          return true;
        },
        startDependenciesRecursive: () => ({ restartNeeded: false, failures: [] }),
        pluginRequiresRestart: (p) => p.requiresRestart === true,
        hasAnyVisibleSettings: (p) => Boolean(p.settings && p.settings.def && Object.keys(p.settings.def).length),
      },
    };
    window.hypercordPanes.show("plugins");
    await pause(400);
    const cardOf = (id) => [...document.querySelectorAll("#hp-pluginList .addon")].find((one) => one.dataset.id === id);
    const readCard = () => {
      const card = cardOf("spellCheck");
      if (!card) return null;
      const box = card.querySelector('[role="switch"]');
      return {
        checked: box ? box.getAttribute("aria-checked") : null,
        badges: [...card.querySelectorAll(".badge")].map((one) => one.textContent),
        cog: Boolean(card.querySelector('[data-action="settings"]')),
      };
    };
    // the Restart button, as a person reads it: offered or not, what it says it would apply,
    // and whether it can be pressed at all
    const restartButton = () => document.getElementById("hp-pluginRestart");
    const readRestart = () => {
      const b = restartButton();
      return b ? { disabled: b.disabled === true, label: String(b.textContent || "").trim(), title: String(b.title || "") } : null;
    };
    const state = { before: readCard(), waitingBefore: readRestart() };

    // a plugin that patches Discord while it loads cannot be switched in a page that is
    // already up: the flag the next start reads is written, and the page says so rather than
    // reporting a start that did not happen
    cardOf("spellCheck").querySelector('[role="switch"]').click();
    await pause(500);
    state.afterRestart = readCard();
    state.flag = settings.plugins.SpellCheck.enabled;
    state.started = seen.started.slice();
    state.status = (document.getElementById("hp-status") || {}).textContent || "";
    state.summary = (document.getElementById("hp-pluginSummary") || {}).textContent || "";
    state.waiting = readRestart();
    // the restart the page says is due, pressed while it is waiting: the shell is what restarts
    // the client, and the page names what that restart is applying
    if (state.waiting && state.waiting.disabled === false) restartButton().click();
    await pause(300);
    state.restartStatus = (document.getElementById("hp-status") || {}).textContent || "";

    // the same plugin with nothing that needs a restart: now it really starts, and the flag
    // is written for the start after this one
    plugin.requiresRestart = false;
    plugin.patches = [];
    settings.plugins.SpellCheck.enabled = false;
    window.hypercordPanes.show("plugins");
    await pause(400);
    cardOf("spellCheck").querySelector('[role="switch"]').click();
    await pause(500);
    state.afterLive = readCard();
    state.liveFlag = settings.plugins.SpellCheck.enabled;
    state.liveStarted = seen.started.slice();
    state.waitingAfterLive = readRestart();

    // the cog is the plugin's own settings window, drawn by the runtime that owns them
    cardOf("spellCheck").querySelector('[data-action="settings"]').click();
    await pause(300);
    state.modals = seen.modals.slice();

    // and a plugin with nothing to configure offers no cog, rather than a button that opens
    // an empty window
    plugin.settings = { def: {}, store: {} };
    window.hypercordPanes.show("plugins");
    await pause(400);
    state.withoutSettings = readCard();
    return state;
  })()`,
  );
  // The switch is the runtime's, and the *record* is the shell's: the runtime keeps its
  // settings in the page's storage, and Discord's own page has none (measured - localStorage
  // and sessionStorage are both removed there), so a choice written only in the page is
  // forgotten by the next start. The enable channel is therefore asked every time, and what
  // it writes is what the loader hands back at the next start (src/plugin-host.js, src/loader.cjs).
  ok(
    "a plugin the built runtime owns is switched in the runtime, and the choice is recorded where it survives",
    builtIn.flag === true &&
      builtIn.afterRestart.checked === "true" &&
      calls.toggles.slice(runtimeToggles).length === 2 &&
      calls.toggles.slice(runtimeToggles).every((one) => one === "on:spellCheck"),
    JSON.stringify({ flag: builtIn.flag, checked: builtIn.afterRestart.checked, toggled: calls.toggles.slice(runtimeToggles) }),
  );
  ok(
    "and one the runtime cannot switch live says so instead of claiming it is running",
    builtIn.started.length === 0 && builtIn.afterRestart.badges.includes("restart to apply") && !builtIn.afterRestart.badges.includes("running") && /next time Discord starts/.test(builtIn.status),
    JSON.stringify({ started: builtIn.started, badges: builtIn.afterRestart.badges, status: builtIn.status }),
  );
  ok(
    "one it can switch live starts, and the flag the next start reads is written with it",
    builtIn.liveStarted.includes("SpellCheck") && builtIn.liveFlag === true && builtIn.afterLive.badges.includes("running"),
    JSON.stringify({ started: builtIn.liveStarted, flag: builtIn.liveFlag, badges: builtIn.afterLive.badges }),
  );
  ok(
    "a built-in-runtime plugin's card opens that plugin's own settings",
    builtIn.afterLive.cog === true && builtIn.modals.length === 1 && builtIn.modals[0].name === "SpellCheck" && builtIn.modals[0].restart === "function",
    JSON.stringify({ cog: builtIn.afterLive.cog, modals: builtIn.modals }),
  );
  ok("and a plugin that declares none gets no cog rather than an empty one", builtIn.withoutSettings.cog === false, JSON.stringify(builtIn.withoutSettings));

  // The restart is offered only when something is actually waiting, it says what that is, and
  // it is the shell that restarts the client - a page of ours asks, and never exits one itself.
  ok(
    "a restart is not offered while nothing is waiting",
    builtIn.waitingBefore && builtIn.waitingBefore.disabled === true && builtIn.waitingBefore.label === "Restart" && /nothing is waiting/.test(builtIn.waitingBefore.title),
    JSON.stringify(builtIn.waitingBefore),
  );
  ok(
    "while a plugin waits it is offered, counted, and named",
    builtIn.waiting &&
      builtIn.waiting.disabled === false &&
      builtIn.waiting.label === "Restart \u00b7 1" &&
      /SpellCheck/.test(builtIn.waiting.title) &&
      /SpellCheck is waiting for a restart/.test(builtIn.summary),
    JSON.stringify({ button: builtIn.waiting, summary: builtIn.summary }),
  );
  ok(
    "pressing it asks the shell once, and says what the restart applies",
    calls.restarts === restartsBefore + 1 && /restarting the client: SpellCheck takes effect when it comes back/.test(builtIn.restartStatus),
    JSON.stringify({ restarts: calls.restarts - restartsBefore, status: builtIn.restartStatus }),
  );
  ok(
    "and with nothing left waiting it stops being offered",
    builtIn.waitingAfterLive && builtIn.waitingAfterLive.disabled === true && builtIn.waitingAfterLive.label === "Restart",
    JSON.stringify(builtIn.waitingAfterLive),
  );

  // A theme is a card in the same browser, and its switch turns that theme on where it
  // stands: the themes page is not a settings page with a button list any more.
  const themeCard = await page(
    win,
    `(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.hypercordPanes.show("themes");
    await pause(300);
    const cardOf = (id) => [...document.querySelectorAll("#hp-themeList .addon")].find((one) => one.dataset.id === id);
    const read = (id) => {
      const card = cardOf(id);
      const box = card ? card.querySelector('[role="switch"]') : null;
      return box ? box.getAttribute("aria-checked") : null;
    };
    const state = {
      cards: document.querySelectorAll("#hp-themeList .addon").length,
      remove: document.querySelectorAll('#hp-themeList .addon [data-action="remove"]').length,
      before: read("soft"),
    };
    const box = cardOf("soft") ? cardOf("soft").querySelector('[role="switch"]') : null;
    if (box) box.click();
    await pause(350);
    state.after = read("soft");
    return state;
  })()`,
  );
  ok("the themes are cards with a switch and a Remove each", themeCard.cards === 2 && themeCard.remove === 2, JSON.stringify(themeCard));
  ok(
    "and a theme's switch turns that theme on through the shell",
    themeCard.before === "false" && themeCard.after === "true" && calls.toggles.includes("theme:soft:on"),
    JSON.stringify(themeCard),
  );

  // The plugin categories: the tags the catalogue declares, as one row of chips, and a
  // press on one of them narrows the grid. This is the difference between a list of
  // hundreds and a list somebody can find a plugin in.
  const categories = await page(
    win,
    `(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.hypercordPanes.show("plugins");
    await pause(300);
    const chips = () => [...document.querySelectorAll("#hp-pluginCategories .chip")];
    const of = (value) => chips().find((one) => one.dataset.category === value) || null;
    const state = {
      chips: chips().map((one) => one.dataset.category + ":" + one.textContent.trim()),
      cards: document.querySelectorAll("#hp-pluginList .addon").length,
    };
    if (of("Hypercord")) of("Hypercord").click();
    await pause(300);
    state.afterOurs = [...document.querySelectorAll("#hp-pluginList .addon")].map((one) => one.dataset.id);
    state.summary = (document.getElementById("hp-pluginSummary") || {}).textContent || "";
    state.oursPressed = of("Hypercord") ? of("Hypercord").getAttribute("aria-pressed") : null;
    if (of("")) of("").click();
    await pause(300);
    state.restored = document.querySelectorAll("#hp-pluginList .addon").length;
    return state;
  })()`,
  );
  ok(
    "the categories are chips, All in front and ours beside it",
    categories.chips.length >= 2 && categories.chips[0].startsWith(":All") && categories.chips.some((one) => one.startsWith("Hypercord:")),
    JSON.stringify(categories.chips),
  );
  ok(
    "and pressing one narrows the grid to that category",
    categories.afterOurs.length > 0 &&
      categories.afterOurs.length < categories.cards &&
      // every plugin the catalogue marks ours, and nothing else: the vendored
      // spellCheck is the one that must not survive the chip
      !categories.afterOurs.includes("spellCheck") &&
      /in Hypercord/.test(categories.summary) &&
      categories.oursPressed === "true",
    JSON.stringify({ ours: categories.afterOurs, cards: categories.cards, summary: categories.summary }),
  );
  ok("and the All chip puts everything back", categories.restored === categories.cards, String(categories.restored));

  // The theme library: the one thing in this browser that is fetched. Drawing the tab is what
  // asks for it (and the two reads below are the only ones this suite ever sees: the draw, and
  // the forced press). A theme installed from it goes through the same store as a theme from a
  // pasted link, which is what makes it trustworthy - there is one install path.
  const library = await page(
    win,
    `(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    window.hypercordPanes.show("themes");
    await pause(300);
    const state = { before: document.querySelectorAll("#hp-themeLibrary .addon").length };
    const load = document.getElementById("hp-themeLibraryLoad");
    if (load) load.click();
    await pause(400);
    const rows = [...document.querySelectorAll("#hp-themeLibrary .addon")];
    state.cards = rows.length;
    state.first = rows[0] ? rows[0].querySelector(".addon-name").textContent : "";
    state.firstBadges = rows[0] ? [...rows[0].querySelectorAll(".badge")].map((one) => one.textContent) : [];
    state.note = (document.getElementById("hp-themeLibraryNote") || {}).textContent || "";
    const install = rows[0] ? rows[0].querySelector('[data-action="install"]') : null;
    if (install) install.click();
    await pause(400);
    return state;
  })()`,
  );
  ok(
    "the library is listed without pressing anything, and Load reads it once more by force",
    library.before === 2 &&
      library.cards === 2 &&
      library.first === "DTM-08" &&
      /library/.test(library.note) &&
      calls.themeIndex === 2 &&
      calls.themeIndexForces.join(",") === "false,true",
    JSON.stringify({ before: library.before, cards: library.cards, first: library.first, note: library.note, reads: calls.themeIndex, forced: calls.themeIndexForces }),
  );
  ok(
    "a library card carries the author and the tags the index gave it",
    library.firstBadges.includes("dark") && library.firstBadges.some((one) => /downloads/.test(one)),
    JSON.stringify(library.firstBadges),
  );
  ok(
    "and installing from it installs the theme's own file through the theme store",
    calls.themeInstalls.length === 1 &&
      /api\.themes\.example\/download\/47$/.test(calls.themeInstalls[0][0]) &&
      calls.themeInstalls[0][1] === "DTM-08",
    JSON.stringify(calls.themeInstalls),
  );

  // and a page whose plugin is not running says so, rather than showing an empty
  // generator that a person would read as a broken one
  beefRunning = false;
  await page(win, `window.hypercordPanes.show("beef"); true`);
  await wait(300);
  const beefStopped = await page(
    win,
    `(() => ({
    reason: (document.getElementById("hp-beefReason") || {}).textContent || "",
    state: (document.getElementById("hp-beefState") || {}).textContent || "",
    actions: document.querySelectorAll("#hypercord-panes #hp-beefActions button").length,
  }))()`,
  );
  ok(
    "a page whose plugin is not running says so instead of showing an empty generator",
    /not running/.test(beefStopped.reason) && /not running/.test(beefStopped.state) && beefStopped.actions === 0,
    JSON.stringify(beefStopped).slice(0, 200),
  );
  beefRunning = true;

  // the whole catalogue and our own plugins are two tabs over one catalogue, not
  // two catalogues: Hyper must hold ours and only ours
  // reading each list after its own load, because a view renders from a bridge
  // call: reading in the same script tick would read the previous view
  await page(win, `window.hypercordPanes.show("hyper"); true`);
  await wait(300);
  const oursText = await page(
    win,
    `(() => ({
    ours: [...document.querySelectorAll("#hypercord-panes #hp-hyperList *")].map((n) => n.textContent).join(" " ),
    hyperSummary: (document.getElementById("hp-hyperSummary") || {}).textContent || "",
  }))()`,
  );
  await page(win, `window.hypercordPanes.show("plugins"); true`);
  await wait(300);
  const allText = await page(
    win,
    `(() => ({
    all: [...document.querySelectorAll("#hypercord-panes #hp-pluginList *")].map((n) => n.textContent).join(" " ),
    summary: (document.getElementById("hp-pluginSummary") || {}).textContent || "",
  }))()`,
  );
  const split = { ours: oursText.ours, hyperSummary: oursText.hyperSummary, all: allText.all, catalogueSummary: allText.summary };
  ok("the Hyper page lists our own plugins", /hyperPanes/.test(split.ours) && /hyperBridge/.test(split.ours) && /hyperBeef/.test(split.ours), split.ours.slice(0, 120));
  ok("and not the vendored ones", !/SpellCheck/.test(split.ours) && /SpellCheck/.test(split.all), "hyper: " + /SpellCheck/.test(split.ours) + ", catalogue: " + /SpellCheck/.test(split.all));
  ok("the Hyper page says how many of the catalogue are ours", /2|3|our/i.test(split.hyperSummary), JSON.stringify(split.hyperSummary));
  ok("the whole catalogue page still holds everything", /of 5|5 /.test(split.catalogueSummary), JSON.stringify(split.catalogueSummary));

  // No Close button: leaving a page of ours is leaving Discord's settings, and
  // Discord's own settings close is the one that does it. The shell pushes the
  // close, which is what happens when that layer goes away.
  ok("the pages offer no close of their own", (await page(win, `document.querySelectorAll("#hypercord-panes .close, #hp-close").length`)) === 0);
  win.webContents.send("push", "panes:close", true);
  await wait(250);
  const closed = await page(win, `document.getElementById("hypercord-panes").getAttribute("data-open")`);
  ok("a pushed panes:close hides the page", closed === "false", "open " + closed);

  ok("nothing the page or the sheet did logged an error", consoleErrors.length === 0, (consoleErrors.join(" | ") + " || all: " + consoleAll.slice(0, 4).join(" | ")).slice(0, 300));

  /* ---- the way in from Discord's own settings --------------------------- */

  // Discord's settings layer is a sidebar of tabs, and that is where people look
  // for settings: Hypercord adds one entry of its own, next to theirs
  const settingsWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(src, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const settingsErrors = [];
  settingsWindow.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) settingsErrors.push(String(message));
  });
  await settingsWindow.loadURL(origin + "settings");
  await wait(700);
  const entry = await page(
    settingsWindow,
    `(() => {
    const button = document.getElementById("hypercord-settings-entry");
    const list = document.querySelector('[role="tablist"]');
    const ours = [...document.querySelectorAll('[data-hypercord="settings"]')];
    return {
      present: Boolean(button),
      group: (document.getElementById("hypercord-settings-group") || {}).textContent || "",
      last: list && list.lastElementChild ? list.lastElementChild.textContent : "",
      insideSidebar: Boolean(button && list && list.contains(button)),
      entries: ours.map((n) => n.getAttribute("data-hypercord-view")),
      labels: ours.map((n) => n.textContent),
      announced: document.documentElement.getAttribute("data-hypercord-settings-entries"),
      sheetViews: [...document.querySelectorAll("#hypercord-panes section.view")].map((n) => n.getAttribute("data-view")),
      discordsOwn: list ? [...list.querySelectorAll('[role="tab"]')].filter((n) => !n.hasAttribute("data-hypercord")).length : 0,
      // Discord's own class attribute on one of their items, and the one our entry
      // wears: the entry is built to sit among them, not merely near them
      ownClass: list && list.firstElementChild ? list.firstElementChild.className : "",
      entryClass: button ? button.className : "",
      sheet: Boolean(document.getElementById("hypercord-panes")),
    };
  })()`,
  );
  const sameViews = (a, b) => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  ok("Hypercord appears in Discord's own settings sidebar", entry.present && entry.insideSidebar, JSON.stringify(entry.entries));
  ok("as its own group of sections rather than one item", entry.group === "Hypercord" && entry.entries.length > 1, entry.group + " " + JSON.stringify(entry.labels));
  ok("one entry per section the sheet actually has", sameViews(entry.entries, entry.sheetViews) && String(entry.entries.length) === entry.announced, JSON.stringify(entry.entries) + " vs " + JSON.stringify(entry.sheetViews) + " announced " + entry.announced);
  ok("Discord's own settings entries are left alone", entry.discordsOwn === 4, "theirs " + entry.discordsOwn + ", last " + JSON.stringify(entry.last));
  ok("the settings pages are there to be opened from settings", entry.sheet === true);
  ok(
    "the entries wear Discord's own class attribute, so the client's stylesheet lays them out",
    entry.entryClass !== "" && entry.entryClass === entry.ownClass,
    JSON.stringify({ ours: entry.entryClass, theirs: entry.ownClass }),
  );

  // Each entry has to open ITS OWN section: that is the whole point of the change, so
  // two different entries are clicked and required to land on two different sections.
  // A set where every entry opened one view would still pass "it opens the manager".
  const clickEntry = async (target, view) => {
    const clicked = await page(
      target,
      `(() => {
      const node = document.querySelector('[data-hypercord="settings"][data-hypercord-view="' + ${JSON.stringify(view)} + '"]');
      if (!node) return false;
      node.click();
      return true;
    })()`,
    );
    await wait(250);
    const seen = await page(
      target,
      `(() => {
      const host = document.getElementById("hypercord-panes");
      const visible = [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden")).map((n) => n.getAttribute("data-view"));
      const shown = [...document.querySelectorAll("#hypercord-panes section.view")].find((n) => !n.classList.contains("hidden"));
      const heading = shown ? shown.querySelector("h2") : null;
      const content = document.querySelector(".content-1a2b");
      const box = host ? host.getBoundingClientRect() : null;
      return {
        open: host ? host.getAttribute("data-open") : null,
        visible,
        // where it landed, and what it looks like there: a page inside Discord's
        // settings is placed in Discord's own column and paints nothing of its own
        seamless: host ? host.getAttribute("data-seamless") : null,
        position: host ? getComputedStyle(host).position : null,
        background: host ? getComputedStyle(host).backgroundColor : null,
        width: box ? Math.round(box.width) : -1,
        contentWidth: content ? Math.round(content.getBoundingClientRect().width) : -1,
        // where in the tree it landed: a page of ours has to sit *inside* the layer
        // Discord draws this settings screen in - a sibling of the column it fills -
        // or every dropdown and modal the client opens over it is drawn behind it
        parent: host && host.parentElement ? (host.parentElement === document.documentElement ? "html" : String(host.parentElement.className)) : "",
        homed: Boolean(
          host &&
            host.parentElement &&
            host.parentElement !== document.documentElement &&
            content &&
            host.parentElement.contains(content) &&
            host.parentElement.contains(document.querySelector(".sidebar-3c4d")),
        ),
        zIndex: host ? getComputedStyle(host).zIndex : "",
        nav: document.querySelectorAll("#hypercord-panes .nav, #hypercord-panes .nav-item").length,
        title: heading ? heading.textContent : "",
        titleColour: heading ? getComputedStyle(heading).color : "",
        // what the page is typed in, read off the sheet itself: the client's own font
        // variable, not the browser's default, which is what a sheet hung off the
        // document element inherits unless it says otherwise
        font: host ? getComputedStyle(host).fontFamily : "",
      };
    })()`,
    );
    return { clicked, seen };
  };
  const firstEntry = entry.entries[0];
  const lastEntry = entry.entries[entry.entries.length - 1];
  const fromSettings = await clickEntry(settingsWindow, firstEntry);
  ok("clicking an entry opens the manager inside Discord", fromSettings.clicked && fromSettings.seen.open === "true" && fromSettings.seen.visible.length === 1, JSON.stringify(fromSettings.seen));
  ok("and it opens the section that entry names", fromSettings.seen.visible[0] === firstEntry, JSON.stringify(fromSettings.seen) + " for " + firstEntry);
  ok(
    "the page is placed in Discord's own settings content column, at its size",
    fromSettings.seen.seamless === "true" && fromSettings.seen.position === "fixed" && fromSettings.seen.width === fromSettings.seen.contentWidth && fromSettings.seen.width > 320,
    JSON.stringify({ seamless: fromSettings.seen.seamless, width: fromSettings.seen.width, column: fromSettings.seen.contentWidth }),
  );
  ok(
    "and it paints Discord's own settings surface, so nothing of Discord shows through the page",
    fromSettings.seen.background === "rgb(49, 51, 56)",
    String(fromSettings.seen.background),
  );
  // The bug this stands for: the page used to be mounted on the document element with a
  // z-index above everything, so it painted over Discord's whole layer stack - and the
  // client's own dropdowns, and the modal a plugin's settings open in, were drawn *behind*
  // it. Clicking a plugin's cog looked like a click that did nothing at all.
  ok(
    "and it is stacked inside Discord's own layer, above the settings screen it stands in",
    fromSettings.seen.homed === true && fromSettings.seen.zIndex === "1",
    JSON.stringify({ homed: fromSettings.seen.homed, parent: fromSettings.seen.parent, z: fromSettings.seen.zIndex }),
  );
  ok(
    "it has no tab row of ours: Discord's own sidebar is the navigation",
    fromSettings.seen.nav === 0,
    "nav " + fromSettings.seen.nav,
  );
  ok(
    "the page is typed in the client's own font, out of the client's own variable",
    fromSettings.seen.font.replace(/["']/g, "").trim() === "gg sans",
    JSON.stringify(fromSettings.seen.font),
  );
  ok(
    "it is titled like a settings page, in Discord's own heading colour",
    fromSettings.seen.title === "Commands" && fromSettings.seen.titleColour === "rgb(242, 243, 245)",
    JSON.stringify({ title: fromSettings.seen.title, colour: fromSettings.seen.titleColour }),
  );
  const fromLastEntry = await clickEntry(settingsWindow, lastEntry);
  ok("and a different entry opens a different section", fromLastEntry.clicked && fromLastEntry.seen.visible.length === 1 && fromLastEntry.seen.visible[0] === lastEntry, JSON.stringify(fromLastEntry.seen) + " for " + lastEntry);

  // Discord's own rows get their selected box from React, which does not know ours -
  // the preload marks the open entry itself. The click above opened `lastEntry`, so
  // that entry, and no other, has to read as the open one.
  const marked = await page(
    settingsWindow,
    `(() => {
    const ours = [...document.querySelectorAll('[data-hypercord="settings"]')];
    const faces = (n) => n.querySelector("[role]") || n;
    return {
      open: ours.filter((n) => n.getAttribute("data-hypercord-open") === "true").map((n) => n.getAttribute("data-hypercord-view")),
      current: ours.filter((n) => faces(n).hasAttribute("aria-current")).map((n) => n.getAttribute("data-hypercord-view")),
    };
  })()`,
  );
  ok(
    "the open entry is marked as the open one, and no other entry is",
    marked.open.length === 1 && marked.open[0] === lastEntry && marked.current.length === 1 && marked.current[0] === lastEntry,
    JSON.stringify(marked) + " for " + lastEntry,
  );
  // And choosing one of Discord's own sections hands the box back: no entry of ours
  // may still read as open once theirs is.
  await page(
    settingsWindow,
    `(() => {
    const native = [...document.querySelectorAll('[role="tab"]')].find((n) => !n.hasAttribute("data-hypercord"));
    if (native) native.click();
    return true;
  })()`,
  );
  const handedBack = await page(
    settingsWindow,
    `(() => {
    const ours = [...document.querySelectorAll('[data-hypercord="settings"]')];
    const faces = (n) => n.querySelector("[role]") || n;
    return {
      open: ours.filter((n) => n.getAttribute("data-hypercord-open") === "true").length,
      current: ours.filter((n) => faces(n).hasAttribute("aria-current")).length,
    };
  })()`,
  );
  ok("choosing one of Discord's own sections clears every entry of ours", handedBack.open === 0 && handedBack.current === 0, JSON.stringify(handedBack));
  // The token prompt belongs beside the login form and nowhere else: this page has
  // no login form on it, so even a token change must not raise the prompt here as
  // the centred modal it becomes without an anchor. A signed-in client manages its
  // keys in the Accounts and Access keys pages instead.
  settingsWindow.webContents.send("push", "tokens:changed", []);
  await wait(250);
  const promptHere = await page(
    settingsWindow,
    `((document.getElementById("hypercord-token-prompt") || {}).getAttribute ? document.getElementById("hypercord-token-prompt").getAttribute("data-open") : "missing")`,
  );
  ok("with no login form on the page the token prompt stays closed", promptHere !== "true", JSON.stringify(promptHere));
  // Leave the sheet as it was found: open on this section. Choosing Discord's row
  // closed our page, and a closed page is display:none - a field inside it cannot
  // take focus, which is exactly what the caret tests below measure. Reopening here
  // restores the conditions those tests were written against, rather than weakening
  // them to pass on a closed page.
  await clickEntry(settingsWindow, lastEntry);

  // Discord's own focus handling takes the caret back to the column it manages whenever
  // a click lands outside the tree it knows, and this sheet is attached outside that tree
  // on purpose. The fixture steals focus the same way - from the document, bubbling, so
  // before anything of ours on the window - and the page still has to be left with the
  // caret in its own field, or every control in every page is enabled, visible and
  // impossible to type into.
  const caret = await page(
    settingsWindow,
    `(() => {
    const shown = [...document.querySelectorAll("#hypercord-panes section.view")].find((n) => !n.classList.contains("hidden"));
    const field = shown ? shown.querySelector("input, textarea") : null;
    const thief = document.querySelector(".content-1a2b");
    if (!field || !thief) return { focusable: null, why: "no field or no column" };
    thief.setAttribute("tabindex", "0");
    // the client's side of it: whatever was clicked, focus goes back to its column
    document.addEventListener("click", () => thief.focus(), false);
    // a real press, in full: the page arms itself on pointerdown, which is the half of a
    // click the client's own handling answers to
    field.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    field.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { focusable: document.activeElement === field, active: document.activeElement ? document.activeElement.tagName : "none" };
  })()`,
  );
  ok(
    "a click into a field of ours keeps the caret there, although the client takes focus back to its own column",
    caret.focusable === true,
    JSON.stringify(caret),
  );

  // And the half no phase of the event can reach, because it happens after the click: the
  // client's focus manager parks focus on a node that cannot hold it - a div with no
  // tabindex - which is what it does to its own column. Measured in the live client: the
  // field had the caret and a moment later Discord's bundle had focused a div. The field
  // has to have it still.
  const parked = await page(
    settingsWindow,
    `(() => {
    const shown = [...document.querySelectorAll("#hypercord-panes section.view")].find((n) => !n.classList.contains("hidden"));
    const field = shown ? shown.querySelector("input, textarea") : null;
    const column = document.querySelector(".content-1a2b");
    if (!field || !column) return { kept: null, why: "no field or no column" };
    column.removeAttribute("tabindex");
    field.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    field.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    field.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const hadIt = document.activeElement === field;
    // and then the trap's move, exactly as the live client does it: one of its own rows
    // first (which is focusable), and then the column itself
    column.setAttribute("tabindex", "0");
    column.focus();
    column.setAttribute("tabindex", "-1");
    column.focus();
    return {
      hadIt: hadIt,
      kept: document.activeElement === field,
      active: document.activeElement ? document.activeElement.tagName : "none",
    };
  })()`,
  );
  ok(
    "and focus parked on a node that cannot hold it is answered by the field that had the caret",
    parked.hadIt === true && parked.kept === true,
    JSON.stringify(parked),
  );
  ok("the settings page logged no error", settingsErrors.length === 0, settingsErrors.join(" | ").slice(0, 200));

  // The entry is what the owner of the client could not find, because the lookup
  // guessed one shape - "the widest tab strip on screen" - and a simulated page
  // that matches the guess proves nothing about the live client. So it is checked
  // against the shapes a release actually serves: a sidebar that is not a tablist,
  // one in the client's other language whose items are not buttons, a page with two
  // sidebars where only one is settings, and a page with none.
  const openEntryPage = async (route) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(src, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const errors = [];
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 3) errors.push(String(message));
    });
    await win.loadURL(origin + route.replace(/^\//, ""));
    await wait(700);
    return { win, errors };
  };

  // A page of ours is drawn inside whatever layer Discord drew the screen in, and that layer is
  // not always a place a click can land: Discord's own layer hosts refuse pointer events and let
  // their panels opt back in, so a page appended to the host inherits the refusal and becomes a
  // page nobody can touch. The assertion is not the property that repairs it but the outcome the
  // browser acts on: where a point inside the page lands.
  const sealed = await openEntryPage("/settings-sealed");
  // The shell pushes the injected stylesheet to every window that reports itself ready, and this
  // fixture would otherwise be the one window in the suite that never got it - so the push the
  // shell sends is sent here too, before anything is clicked in it.
  sealed.win.webContents.send("push", "themes:css", SHELL_CSS);
  await wait(250);
  const sealedSeen = await page(
    sealed.win,
    `(async () => {
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const entry = document.querySelectorAll('[data-hypercord="settings"]')[0];
    if (entry) entry.click();
    await pause(400);
    // The token prompt is opened on every page and pinned to the top of the window above
    // everything, so leaving it up would measure its card instead of the page. It is dismissed
    // here through the client's own Hide, which is the state a settings page is looked at in.
    const closer = document.querySelector('#hypercord-token-prompt [data-hc="prompt-close"]');
    if (closer) closer.click();
    await pause(150);
    const panes = document.getElementById("hypercord-panes");
    const layer = panes ? panes.parentElement : null;
    const box = panes ? panes.getBoundingClientRect() : null;
    // the middle of the page, not its top edge: the top strip of the window is where the
    // client's own overlays live - the token prompt is pinned there on a page with no login form
    // and overlaps whatever is under it - and "a click inside the page" means a point in the body
    // of it. What is being checked is the page's reachability, not the prompt's geometry.
    const x = box ? Math.round(box.left + box.width / 2) : 0;
    const y = box ? Math.round(box.top + box.height / 2) : 0;
    const hit = box ? document.elementFromPoint(x, y) : null;
    return {
      entry: Boolean(entry),
      open: panes ? panes.getAttribute("data-open") : null,
      layerPointerEvents: layer ? getComputedStyle(layer).pointerEvents : "no-layer",
      pagePointerEvents: panes ? getComputedStyle(panes).pointerEvents : "no-page",
      reached: Boolean(hit && panes && (hit === panes || panes.contains(hit))),
      hit: hit ? hit.tagName + (hit.className ? "." + String(hit.className).split(" ")[0] : "") : "",
      // what that element belongs to, so a miss names its owner rather than its tag
      hitOwner: hit ? String((hit.closest("#hypercord-panes") && "panes") || (hit.closest("#hypercord-token-prompt") && "token prompt") || hit.parentElement.tagName) : "",
      hitRect: hit ? [Math.round(hit.getBoundingClientRect().left), Math.round(hit.getBoundingClientRect().top)].join(",") : "",
      pageRect: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)].join(",") : "",
      zIndex: panes ? getComputedStyle(panes).zIndex : "",
      width: box ? Math.round(box.width) : -1,
    };
  })()`,
  );
  ok(
    "a layer that refuses pointer events still gets a section in Discord's settings, and it opens",
    sealedSeen.entry && sealedSeen.open === "true" && sealedSeen.width > 320,
    JSON.stringify(sealedSeen),
  );
  ok(
    "and a point inside that page lands on the page, not on what is drawn behind it",
    sealedSeen.reached && sealedSeen.pagePointerEvents === "auto",
    JSON.stringify(sealedSeen),
  );
  ok(
    "with the client's own refusal left where it was, and nothing logged as an error",
    sealedSeen.layerPointerEvents === "none" && sealed.errors.length === 0,
    JSON.stringify({ layer: sealedSeen.layerPointerEvents, errors: sealed.errors }),
  );

  const plainList = await openEntryPage("/settings-plain");
  const plainSeen = await page(
    plainList.win,
    `(() => {
    const entry = document.getElementById("hypercord-settings-entry");
    const host = document.querySelector(".sidebar-9h0i");
    return {
      present: Boolean(entry),
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
      inSidebar: Boolean(entry && host && host.contains(entry)),
      tag: entry ? entry.tagName : "",
      role: entry ? entry.getAttribute("role") : "",
      focusable: entry ? entry.tabIndex >= 0 : false,
      entries: host ? host.querySelectorAll('[data-hypercord="settings"]').length : 0,
      discordsOwn: host ? [...host.children].filter((n) => !n.hasAttribute("data-hypercord")).length : 0,
    };
  })()`,
  );
  ok("a settings sidebar that is not a tablist still gets the entry", plainSeen.present && plainSeen.inSidebar, JSON.stringify(plainSeen));
  ok("the entry is one of theirs: their element, their role", plainSeen.tag === "BUTTON" && plainSeen.role === "tab", JSON.stringify(plainSeen));
  ok("Discord's own entries in that shape are left alone", plainSeen.discordsOwn === 4, String(plainSeen.discordsOwn));
  ok("and the entry is reachable by keyboard", plainSeen.focusable === true);
  ok("the page says where the entry went, so a check can read it", plainSeen.signal === "added", String(plainSeen.signal));

  // a change while the layer is up: one entry, never two
  await page(plainList.win, `(() => { document.querySelector(".sidebar-9h0i").appendChild(document.createElement("span")); return true; })()`);
  await wait(400);
  const settled = await page(
    plainList.win,
    `(() => ({
    count: document.querySelectorAll('[data-hypercord="settings"]').length,
    ids: document.querySelectorAll("#hypercord-settings-entry").length,
    signal: document.documentElement.getAttribute("data-hypercord-settings"),
  }))()`,
  );
  ok(
    "a change to the sidebar does not add a second set of entries",
    settled.count === plainSeen.entries && settled.ids === 1 && settled.signal === "added",
    JSON.stringify(settled) + " of " + plainSeen.entries,
  );

  // and a re-render that throws our node away, which React does to nodes it does
  // not know about: the entry has to come back on its own
  await page(
    plainList.win,
    `(() => {
    document.getElementById("hypercord-settings-entry").remove();
    document.querySelector(".sidebar-9h0i").appendChild(document.createElement("span"));
    return true;
  })()`,
  );
  await wait(400);
  const restored = await page(
    plainList.win,
    `(() => ({
    back: Boolean(document.getElementById("hypercord-settings-entry")),
    count: document.querySelectorAll('[data-hypercord="settings"]').length,
    ids: document.querySelectorAll("#hypercord-settings-entry").length,
    signal: document.documentElement.getAttribute("data-hypercord-settings"),
  }))()`,
  );
  ok(
    "a re-render that drops an entry puts the whole set back, exactly once",
    restored.back && restored.count === plainSeen.entries && restored.ids === 1 && restored.signal === "added",
    JSON.stringify(restored) + " of " + plainSeen.entries,
  );

  const openedBefore = opened.length;
  await page(plainList.win, `document.getElementById("hypercord-settings-entry").click(); true`);
  await wait(250);
  const openedHere = await page(
    plainList.win,
    `(() => {
    const host = document.getElementById("hypercord-panes");
    return {
      open: host ? host.getAttribute("data-open") : null,
      seamless: host ? host.getAttribute("data-seamless") : null,
      nav: document.querySelectorAll("#hypercord-panes .nav-item").length,
    };
  })()`,
  );
  ok(
    "clicking it opens Hypercord's pages in that very window, in Discord's content column",
    opened.length > openedBefore && openedHere.open === "true" && openedHere.seamless === "true" && openedHere.nav === 0,
    JSON.stringify(openedHere),
  );
  ok("that page logged no error", plainList.errors.length === 0, plainList.errors.join(" | ").slice(0, 200));

  const french = await openEntryPage("/settings-fr");
  const frenchSeen = await page(
    french.win,
    `(() => {
    const entry = document.getElementById("hypercord-settings-entry");
    const host = document.querySelector(".sidebar-lang");
    return {
      present: Boolean(entry && host && host.contains(entry)),
      tag: entry ? entry.tagName : "",
      tabindex: entry ? entry.getAttribute("tabindex") : "",
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
    };
  })()`,
  );
  ok("a sidebar in another language is recognised by its labels", frenchSeen.present && frenchSeen.signal === "added", JSON.stringify(frenchSeen));
  ok("an item that is not a button brings its own keyboard reach", frenchSeen.tag === "DIV" && frenchSeen.tabindex === "0", JSON.stringify(frenchSeen));
  ok("that page logged no error", french.errors.length === 0, french.errors.join(" | ").slice(0, 200));

  const two = await openEntryPage("/settings-two");
  const twoSeen = await page(
    two.win,
    `(() => {
    const entry = document.getElementById("hypercord-settings-entry");
    return {
      present: Boolean(entry),
      parent: entry && entry.parentElement ? entry.parentElement.className : "",
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
    };
  })()`,
  );
  ok("with two sidebars, the settings one is chosen rather than the first", twoSeen.present && twoSeen.parent === "sidebar-settings", JSON.stringify(twoSeen));

  const none = await openEntryPage("/plain");
  const noneSeen = await page(
    none.win,
    `(() => ({
    present: Boolean(document.getElementById("hypercord-settings-entry")),
    signal: document.documentElement.getAttribute("data-hypercord-settings"),
  }))()`,
  );
  ok("a page with no settings layer gets no entry and says why", noneSeen.present === false && noneSeen.signal === "no-host", JSON.stringify(noneSeen));

  // The regression pair for the rail bug: with both lists on the page, the sections go
  // into the settings list and never into the rail, and the rail's own items are left
  // untouched; with only the rail, nothing of ours is added at all.
  const railed = await openEntryPage("/settings-rail");
  const railedSeen = await page(
    railed.win,
    `(() => {
    const entries = [...document.querySelectorAll('[data-hypercord="settings"]')];
    const rail = document.querySelector(".sidebar-guilds-rail");
    return {
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
      recorded: document.documentElement.getAttribute("data-hypercord-settings-host"),
      entries: entries.length,
      inRail: entries.filter((n) => n.closest('[class*="guilds"]')).length,
      inSettings: entries.filter((n) => n.closest(".sidebar-settings-rail")).length,
      railItems: rail ? [...rail.children].filter((n) => !n.hasAttribute("data-hypercord")).length : -1,
    };
  })()`,
  );
  ok(
    "the server rail is not mistaken for Discord's settings list",
    railedSeen.signal === "added" && railedSeen.entries > 0 && railedSeen.inRail === 0 && railedSeen.inSettings === railedSeen.entries,
    JSON.stringify(railedSeen),
  );
  ok(
    "and the list it recorded is the settings one, with the rail's own items left alone",
    /sidebar-settings-rail/.test(String(railedSeen.recorded)) && railedSeen.railItems === 4,
    JSON.stringify(railedSeen),
  );

  const railOnly = await openEntryPage("/rail-only");
  const railOnlySeen = await page(
    railOnly.win,
    `(() => ({
    signal: document.documentElement.getAttribute("data-hypercord-settings"),
    entries: document.querySelectorAll('[data-hypercord="settings"]').length,
  }))()`,
  );
  ok("a page whose only list is the server rail gets no entry at all", railOnlySeen.entries === 0 && railOnlySeen.signal === "no-host", JSON.stringify(railOnlySeen));

  // The shape the live client serves, and the shape the entries were wrong in twice. The
  // checks are about what the owner of the client could not do: reach them (they were
  // outside the scrolling list, drawn below the visible area), click them, or recognise
  // them as part of the client (they wore the class of the nav's scroll container, so
  // their type and spacing were not Discord's at all).
  const sections = await openEntryPage("/settings-sections");
  const sectionsSeen = await page(
    sections.win,
    `(() => {
    const nav = document.querySelector("nav.nav__409aa");
    const scroller = document.querySelector(".navScroller__409aa");
    const list = document.querySelector("ul.sublist__409aa");
    const group = document.querySelector('[data-hypercord="settings-group"]');
    const entries = [...document.querySelectorAll('[data-hypercord="settings"]')];
    const model = document.querySelector('[data-settings-sidebar-item="account"]');
    const heading = group ? group.querySelector("h1, h2, h3, h4") : null;
    const first = entries[0] || null;
    const last = entries[entries.length - 1] || null;
    const box = (node) => (node ? node.getBoundingClientRect() : null);
    const item = first ? first.querySelector("[role]") : null;
    const label = first ? first.querySelector('[data-text-variant^="text"]') : null;
    const icon = first ? first.querySelector("svg") : null;
    const navBox = box(nav);
    return {
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
      entries: entries.length,
      sheetViews: [...document.querySelectorAll("#hypercord-panes section.view")].map((node) => node.getAttribute("data-view")),
      inScroller: scroller ? entries.filter((node) => scroller.contains(node)).length : -1,
      inNav: nav ? entries.filter((node) => nav.contains(node)).length : -1,
      groupParent: group && group.parentElement ? group.parentElement.className : "",
      groupFirst: Boolean(group && group.parentElement && group.parentElement.firstElementChild === group),
      onScreen: Boolean(navBox && box(first) && box(first).top >= navBox.top && box(first).bottom <= navBox.bottom),
      // Discord's own list is taller than the space it is given, so the tail of ours is
      // not on screen without scrolling either. What has to be true is that the tail is
      // inside what that list scrolls - measured in the list's own coordinates, from the
      // top of its content - because an entry that is not is one no amount of scrolling
      // can bring into view
      reachable: (() => {
        if (!scroller || !last) return false;
        const top = box(last).top - box(scroller).top + scroller.scrollTop;
        const bottom = box(last).bottom - box(scroller).top + scroller.scrollTop;
        return top >= -1 && bottom <= scroller.scrollHeight + 1;
      })(),
      headingTag: heading ? heading.tagName : "",
      headingText: heading ? heading.textContent : "",
      headingHeight: heading ? Math.round(box(heading).height) : -1,
      headingStillHidden: heading && heading.parentElement ? /hiddenVisually/i.test(String(heading.parentElement.className)) : null,
      entryTag: first ? first.tagName : "",
      entryClass: first ? first.className : "",
      modelClass: model ? model.className : "",
      itemRole: item ? item.getAttribute("role") : "",
      itemFocusable: item ? Number(item.tabIndex) >= 0 : false,
      label: label ? label.textContent : "",
      iconShown: icon ? getComputedStyle(icon).visibility : "none",
      // the mark our row wears: drawn with currentColor so the theme paints it, in Discord's own
      // svg box, and not the glyph of the row it was copied from
      iconStroke: icon && icon.querySelector("g") ? icon.querySelector("g").getAttribute("stroke") : "",
      iconShapes: icon ? icon.querySelectorAll("path, rect, circle").length : -1,
      iconBorrowed: icon ? /M12 4h1v16h-1z/.test(String(icon.innerHTML)) : null,
      subnavs: first ? first.querySelectorAll('[class*="subnavContainer"]').length : -1,
      markedWithTheirs: first ? first.getAttribute("data-settings-sidebar-item") : "missing",
      discordsRows: list ? [...list.querySelectorAll(".sectionList__409aa > li")].filter((node) => !node.hasAttribute("data-hypercord")).length : -1,
    };
  })()`,
  );
  ok(
    "the live shape is recognised as Discord's list of sections, and one entry is added per section of the sheet",
    sectionsSeen.signal === "added" && sectionsSeen.entries > 1 && sectionsSeen.entries === sectionsSeen.sheetViews.length,
    JSON.stringify(sectionsSeen).slice(0, 300),
  );
  ok(
    "the entries live inside the part of the list that scrolls, which is what makes them reachable",
    sectionsSeen.inScroller === sectionsSeen.entries && sectionsSeen.inNav === sectionsSeen.entries,
    JSON.stringify({ inScroller: sectionsSeen.inScroller, inNav: sectionsSeen.inNav, of: sectionsSeen.entries }),
  );
  ok(
    "and the group is the first section of that list, on screen without scrolling, with the rest of it reachable",
    sectionsSeen.groupFirst && sectionsSeen.groupParent === "sublist__409aa" && sectionsSeen.onScreen && sectionsSeen.reachable,
    JSON.stringify({ first: sectionsSeen.groupFirst, parent: sectionsSeen.groupParent, onScreen: sectionsSeen.onScreen, reachable: sectionsSeen.reachable }),
  );
  ok(
    "the group is named in Discord's own heading, drawn rather than only read out",
    sectionsSeen.headingTag === "H3" && sectionsSeen.headingText === "Hypercord" && sectionsSeen.headingHeight > 10 && sectionsSeen.headingStillHidden === false,
    JSON.stringify({ tag: sectionsSeen.headingTag, text: sectionsSeen.headingText, height: sectionsSeen.headingHeight, hidden: sectionsSeen.headingStillHidden }),
  );
  ok(
    "each entry is a copy of one of Discord's own rows, so their stylesheet lays it out and types it",
    sectionsSeen.entryTag === "LI" && sectionsSeen.entryClass !== "" && sectionsSeen.entryClass === sectionsSeen.modelClass && sectionsSeen.itemRole === "link" && sectionsSeen.label === "Commands",
    JSON.stringify({ tag: sectionsSeen.entryTag, ours: sectionsSeen.entryClass, theirs: sectionsSeen.modelClass, role: sectionsSeen.itemRole, label: sectionsSeen.label }),
  );
  ok("and the copy is reachable by keyboard", sectionsSeen.itemFocusable === true);
  ok(
    "nothing of the copied row lies: no icon of another section, no sub-navigation, no claim to be one of Discord's sections",
    sectionsSeen.iconBorrowed === false && sectionsSeen.subnavs === 0 && sectionsSeen.markedWithTheirs === null,
    JSON.stringify({ borrowed: sectionsSeen.iconBorrowed, subnavs: sectionsSeen.subnavs, marked: sectionsSeen.markedWithTheirs }),
  );
  // and the row is not left with an empty slot beside rows that have marks: an icon that is
  // part of the row, in the client's own colours, is what makes it read as a section of the
  // settings it lives in rather than as a row that failed to draw.
  ok(
    "every row of ours wears a mark of its own, in Discord's own icon slot",
    sectionsSeen.iconShown === "visible" && sectionsSeen.iconStroke === "currentColor" && sectionsSeen.iconShapes > 0,
    JSON.stringify({ visibility: sectionsSeen.iconShown, stroke: sectionsSeen.iconStroke, shapes: sectionsSeen.iconShapes }),
  );
  ok("Discord's own rows in that list are left alone", sectionsSeen.discordsRows === 7, String(sectionsSeen.discordsRows));

  const fromSections = await clickEntry(sections.win, "themes");
  ok(
    "clicking an entry in that shape opens the section it names, in Discord's content column",
    fromSections.clicked && fromSections.seen.open === "true" && fromSections.seen.visible.length === 1 && fromSections.seen.visible[0] === "themes" && fromSections.seen.seamless === "true",
    JSON.stringify(fromSections.seen).slice(0, 300),
  );

  // and one more node of Discord's own in the list, which is what a re-render looks like:
  // the set is left exactly as it is, in the same place, with one entry per section
  await page(sections.win, `(() => { document.querySelector("ul.sublist__409aa").appendChild(document.createElement("li")); return true; })()`);
  await wait(400);
  const sectionsSettled = await page(
    sections.win,
    `(() => ({
    count: document.querySelectorAll('[data-hypercord="settings"]').length,
    ids: document.querySelectorAll("#hypercord-settings-entry").length,
    groups: document.querySelectorAll('[data-hypercord="settings-group"]').length,
    firstSection: document.querySelector("ul.sublist__409aa").firstElementChild === document.querySelector('[data-hypercord="settings-group"]'),
    signal: document.documentElement.getAttribute("data-hypercord-settings"),
  }))()`,
  );
  ok(
    "a change to Discord's own list does not move the set or double it",
    sectionsSettled.count === sectionsSeen.entries && sectionsSettled.ids === 1 && sectionsSettled.groups === 1 && sectionsSettled.firstSection && sectionsSettled.signal === "added",
    JSON.stringify(sectionsSettled) + " of " + sectionsSeen.entries,
  );
  ok("that page logged no error", sections.errors.length === 0, sections.errors.join(" | ").slice(0, 200));

  // The merged shape: the vendored runtime's own section is in this sidebar, so the pages are
  // added to *it* and this client draws no group of its own at all.
  const merged = await openEntryPage("/settings-equicord");
  const mergedSeen = await page(
    merged.win,
    `(() => {
    const section = [...document.querySelectorAll("ul.sublist__409aa > li.section__409aa")].find((li) => /hypercord/i.test(String(li.textContent || "")));
    const list = section ? section.querySelector("ul.sectionList__409aa") : null;
    const entries = [...document.querySelectorAll('[data-hypercord="settings"]')];
    const theirs = list ? [...list.children].filter((node) => !node.hasAttribute("data-hypercord")) : [];
    const first = entries[0] || null;
    const item = first ? first.querySelector("[role]") : null;
    const label = first ? first.querySelector('[data-text-variant^="text"]') : null;
    return {
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
      groups: document.querySelectorAll('[data-hypercord="settings-group"]').length,
      separators: document.querySelectorAll('[data-hypercord="settings-separator"]').length,
      entries: entries.length,
      entryViews: entries.map((node) => node.getAttribute("data-hypercord-view")),
      inEquicordList: list ? entries.filter((node) => node.parentElement === list).length : -1,
      theirRows: theirs.length,
      firstLabel: label ? label.textContent : "",
      ariaBrand: item ? String(item.getAttribute("aria-label") || "").split(" ")[0] : "",
      sheetViews: [...document.querySelectorAll("#hypercord-panes section.view")].map((node) => node.getAttribute("data-view")),
    };
  })()`,
  );
  ok(
    "with the runtime's own section in the sidebar there is no group of ours beside it",
    mergedSeen.groups === 0 && mergedSeen.separators === 0 && mergedSeen.signal === "added",
    JSON.stringify({ groups: mergedSeen.groups, separators: mergedSeen.separators, signal: mergedSeen.signal }),
  );
  ok(
    "the pages are added to the runtime's own section, one row per page the sheet has",
    mergedSeen.inEquicordList === mergedSeen.entries && mergedSeen.entries === mergedSeen.sheetViews.length - 1 && mergedSeen.entries > 1,
    JSON.stringify({ inList: mergedSeen.inEquicordList, entries: mergedSeen.entries, views: mergedSeen.sheetViews.length }),
  );
  // Exactly one row is held back, and it is the plugin page: the runtime's own browser of its own
  // plugins is a row of the section the pages were merged into, a few rows above ours, so a row
  // of ours beside it would be a second way to the same page wearing the same name whichever way
  // ours were laid out.
  //
  // The theme page is NOT held back, and that is the point of this check now. The runtime's themes
  // tab is a list of local themes with a field to paste an online theme's URL - there is no browser
  // in it - while our theme page is where the library (search, filter, install), the theme folder
  // and the quick CSS live. Holding ours back because the runtime has a row called Themes left the
  // client with no way to browse a theme at all, which is what a user reported as "the full theme
  // browser isn't there". So: one omission, and it is not themes.
  const pluginRows = mergedSeen.entryViews.filter((view) => view === "plugins");
  ok(
    "the plugin page is not offered twice, and the theme page is still offered because ours is the browser",
    pluginRows.length === 0 &&
      mergedSeen.entryViews.filter((view) => view === "themes").length === 1 &&
      mergedSeen.sheetViews.includes("plugins") &&
      mergedSeen.sheetViews.includes("themes"),
    JSON.stringify({ entryViews: mergedSeen.entryViews, sheetViews: mergedSeen.sheetViews }),
  );
  // and the pages that are still offered are still all of them, in the sheet's own order, so
  // "one tab fewer" never turns into a row that opens nothing
  ok(
    "every row it does offer is still one of the sheet's own pages",
    mergedSeen.entryViews.every((view) => mergedSeen.sheetViews.includes(view)) && mergedSeen.entryViews.length === 7,
    JSON.stringify(mergedSeen.entryViews),
  );
  ok("and that section's own rows are left alone", mergedSeen.theirRows === 3, String(mergedSeen.theirRows));
  ok(
    "they wear the name of the section they were added to",
    mergedSeen.ariaBrand === "Hypercord" && mergedSeen.firstLabel === "Commands",
    JSON.stringify({ brand: mergedSeen.ariaBrand, label: mergedSeen.firstLabel }),
  );
  const fromMerged = await clickEntry(merged.win, mergedSeen.sheetViews[0]);
  ok(
    "an entry added to that section opens its page just the same",
    fromMerged.clicked && fromMerged.seen.open === "true" && fromMerged.seen.visible.length === 1 && fromMerged.seen.visible[0] === mergedSeen.sheetViews[0],
    JSON.stringify(fromMerged.seen).slice(0, 220),
  );
  ok("that page logged no error", merged.errors.length === 0, merged.errors.join(" | ").slice(0, 200));
  // Every row the merge offers, not just the first: each one is clicked and each one has
  // to land on the page it names, with exactly that page showing. A set where some rows
  // opened nothing - the highlight moving while the content stands still - reads on the
  // live client as the settings breaking past the runtime's own rows.
  for (const view of mergedSeen.entryViews) {
    const landed = await clickEntry(merged.win, view);
    ok(
      "merged entry opens its own page: " + view,
      landed.clicked && landed.seen.open === "true" && landed.seen.visible.length === 1 && landed.seen.visible[0] === view,
      JSON.stringify(landed.seen).slice(0, 220) + " for " + view,
    );
  }
  ok("clicking every merged entry logged no error", merged.errors.length === 0, merged.errors.join(" | ").slice(0, 200));

  // The same shape with the runtime's *older* name on the heading. Both spellings are in the
  // wild - a client that was patched before the rename still draws one of them - and a heading
  // the client no longer recognises would put the pages back outside that section, which is
  // the bug this whole shape exists to fix.
  const legacy = await openEntryPage("/settings-vencord");
  const legacySeen = await page(
    legacy.win,
    `(() => {
    const entries = [...document.querySelectorAll('[data-hypercord="settings"]')];
    const first = entries[0] || null;
    const item = first ? first.querySelector("[role]") : null;
    return {
      signal: document.documentElement.getAttribute("data-hypercord-settings"),
      groups: document.querySelectorAll('[data-hypercord="settings-group"]').length,
      entries: entries.length,
      sheetViews: [...document.querySelectorAll("#hypercord-panes section.view")].map((node) => node.getAttribute("data-view")),
      ariaBrand: item ? String(item.getAttribute("aria-label") || "").split(" ")[0] : "",
    };
  })()`,
  );
  ok(
    "a runtime that still draws its older name is recognised the same way, and the rows wear that name",
    legacySeen.signal === "added" && legacySeen.groups === 0 && legacySeen.entries === legacySeen.sheetViews.length - 1 && legacySeen.ariaBrand === "Vencord",
    JSON.stringify(legacySeen),
  );
  ok("that page logged no error", legacy.errors.length === 0, legacy.errors.join(" | ").slice(0, 200));

  for (const one of [sealed.win, plainList.win, french.win, two.win, none.win, railed.win, railOnly.win, sections.win, merged.win, legacy.win]) one.destroy();
  await wait(300);

  settingsWindow.destroy();
  await wait(200);
  ok("and closing it leaves the client with its one window", BrowserWindow.getAllWindows().length === 1, "windows " + BrowserWindow.getAllWindows().length);

  win.destroy();
  server.close();
  clearTimeout(watchdog);
  console.log("\npassed " + passed + "  failed " + failed);
  app.exit(failed === 0 ? 0 : 1);
}

// A rejected renderer script must report as a failed check with the whole run
// finished, not as an unhandled rejection that leaves the suite hanging.
app.whenReady().then(() =>
  run().catch((err) => {
    console.log("FAIL the suite threw: " + String((err && err.message) || err));
    console.log("\npassed " + passed + "  failed " + (failed + 1));
    app.exit(1);
  }),
);
