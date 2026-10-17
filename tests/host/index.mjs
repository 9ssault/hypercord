// language: JavaScript, file: tests/host/index.mjs
//
// The host is the once-only place the settings pages get their data from, and the
// one thing that must never drift: the renderer asks for a channel, the host has
// registered it. A missing handler is not a small bug - it is a page whose every
// control is a dead click - so the invariant here is read off the preload's own
// source rather than off a list somebody has to remember to update.
//
// Plain node, no Electron: the host takes the Electron surface it uses as an
// argument, so a stub is enough and no window ever opens.
//
//   node tests/host/index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "src");

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-host-"));
const userData = path.join(tmp, "userData");

/* ---- the stub Electron -------------------------------------------------- */

// Every channel the preload can reach, as the host registered it. A Map rather
// than a list, because the check is "this channel is there", not "some channel".
const registered = new Map();
const pushed = [];
const logs = [];
const notes = [];
// a restart asked for from a page of ours, in the order it happened: a stub that only
// counted them would not catch an exit that happened before (or without) a relaunch,
// which is the one order that closes the client and opens nothing
const restarts = [];

const electron = {
  app: {
    // the host is handed its own userData, but nothing here may be tempted to
    // read the real one, so the stub answers with the temp directory either way
    getPath: (name) => (String(name) === "userData" ? userData : path.join(tmp, String(name))),
    getVersion: () => "0.0.0-test",
    getAppMetrics: () => [],
    isPackaged: false,
    setName: () => {},
    on: () => {},
    once: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: () => restarts.push("relaunch"),
    exit: () => restarts.push("exit"),
  },
  ipcMain: {
    handle: (channel, fn) => registered.set(String(channel), fn),
    removeHandler: (channel) => registered.delete(String(channel)),
    on: (channel, fn) => registered.set("on:" + String(channel), fn),
    removeListener: (channel) => registered.delete("on:" + String(channel)),
  },
  // a machine with no keychain and no notification daemon is a real state, and
  // the host has to survive it rather than assume both are there
  Notification: { isSupported: () => false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(""),
    decryptString: () => "",
  },
};

/* ---- 1. what the renderer asks for, read off the renderer's own file ----- */

const preloadText = fs.readFileSync(path.join(src, "preload.cjs"), "utf8");
const asked = [...preloadText.matchAll(/call\(\s*"([a-z:]+)"/g)].map((match) => match[1]);
const channels = [...new Set(asked)];

// A parse that silently found nothing would make every check below vacuous, so
// the inventory is asserted before it is used.
ok("the preload's own calls are readable", channels.length >= 20, "channels " + channels.length);
ok("and they include the pages' data channels", channels.includes("ui:assets") && channels.includes("plugins:list") && channels.includes("plugins:section"), JSON.stringify(channels.slice(0, 8)));

/* ---- 1b. every method the sheet calls is one the preload exposes --------- */

// The channels above are half of the contract; the other half is the object the sheet
// actually holds, `window.hypercord`. The sheet calls `hc.client.info()`, `hc.support.bundle()`,
// `hc.themes.thumbnail(url)` - and a name that is not there is a TypeError in the window, on a
// click, in a page no node suite ever loads. That was fine when the only thing checking the
// sheet was the Electron suite; it is not fine now, because this file runs on every push and
// the Electron suite does not.
//
// So the api is read off the preload's own source - the one place it is defined - by walking the
// object literal `exposeInMainWorld("hypercord", { ... })` by its indentation, which is how that
// file is written (two spaces per level: a group at two, its members at four, a nested group's
// members at six). A parse that finds nothing would make the check below vacuous, so the
// inventory is asserted before it is used, the same way the channel list is.
const apiStart = preloadText.indexOf('exposeInMainWorld("hypercord", {');
const apiLines = apiStart > -1 ? preloadText.slice(apiStart).split("\n").slice(1) : [];
const exposed = new Map(); // group -> Set(member), groups and members at the top level only
const nested = new Map(); // "group.member" -> Set(member), for the one object with a depth of three
let currentGroup = "";
let currentNested = "";
for (const line of apiLines) {
  if (/^\}\);\s*$/.test(line)) break; // the end of the exposed object
  const group = /^  ([A-Za-z_$][\w$]*): \{\s*$/.exec(line);
  if (group) {
    currentGroup = group[1];
    currentNested = "";
    if (!exposed.has(currentGroup)) exposed.set(currentGroup, new Set());
    continue;
  }
  const nestedGroup = /^    ([A-Za-z_$][\w$]*): \{\s*$/.exec(line);
  if (nestedGroup && currentGroup) {
    currentNested = currentGroup + "." + nestedGroup[1];
    if (!nested.has(currentNested)) nested.set(currentNested, new Set());
    exposed.get(currentGroup).add(nestedGroup[1]);
    continue;
  }
  const member = /^ {4,6}([A-Za-z_$][\w$]*)\s*[:(]/.exec(line);
  if (!member) continue;
  if (currentNested && /^      /.test(line)) nested.get(currentNested).add(member[1]);
  else if (currentGroup && /^    /.test(line)) exposed.get(currentGroup).add(member[1]);
}

const exposedGroups = [...exposed.keys()];
const exposedMembers = exposedGroups.reduce((total, group) => total + exposed.get(group).size, 0);
ok(
  "the preload's exposed api is readable",
  exposedGroups.length >= 8 && exposedMembers >= 20,
  JSON.stringify({ groups: exposedGroups.length, members: exposedMembers, names: exposedGroups }),
);
ok(
  "and it includes the groups the sheet's pages call",
  ["panes", "client", "support", "themes", "plugins", "tokens", "logs", "update", "account", "api"].every((group) => exposed.has(group)),
  JSON.stringify(["panes", "client", "support", "themes", "plugins", "tokens", "logs", "update", "account", "api"].filter((group) => !exposed.has(group))),
);

const panesText = fs.readFileSync(path.join(src, "panes.js"), "utf8");
const sheetCalls = [...new Set([...panesText.matchAll(/\bhc\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1] + "." + match[2]))];
ok("the sheet's own calls are readable", sheetCalls.length >= 15, JSON.stringify(sheetCalls.slice(0, 6)));
const unknownGroups = sheetCalls.filter((call) => !exposed.has(call.split(".")[0]));
ok("every group the sheet calls is exposed", unknownGroups.length === 0, JSON.stringify(unknownGroups));
const unknownMembers = sheetCalls.filter((call) => {
  const [group, member] = call.split(".");
  if (!exposed.has(group)) return false; // already reported as a missing group
  return !exposed.get(group).has(member) && !nested.has(call);
});
ok(
  "and every method it calls is one the preload exposes",
  unknownMembers.length === 0,
  "called but not exposed: " + JSON.stringify(unknownMembers),
);
// The other direction, so the check above cannot pass by the sheet having stopped calling
// anything: the two blocks this release added are called by name.
ok(
  "including the ones this release added, by name",
  ["client.info", "client.reapply", "support.bundle", "themes.thumbnail", "themes.index"].every((call) => sheetCalls.includes(call)),
  JSON.stringify(["client.info", "client.reapply", "support.bundle", "themes.thumbnail", "themes.index"].filter((call) => !sheetCalls.includes(call))),
);

/* ---- 2. the host comes up and registers them all ------------------------- */

// The host must not require Electron itself: it is given it, which is what makes
// this file runnable with no window and no display.
const { createHost } = await import(pathToFileURL(path.join(src, "host.js")).href);

let host = null;
try {
  host = createHost({
    electron,
    dir: src,
    userData,
    log: (line) => logs.push(String(line)),
    notify: (title, body) => {
      notes.push([title, body]);
      return true;
    },
    push: (kind, payload) => pushed.push([kind, payload]),
    reloadWindow: () => {},
    windowFor: () => null,
  });
} catch (err) {
  ok("createHost() builds a host", false, String((err && err.message) || err));
}

if (host) {
  try {
    await host.start();
  } catch (err) {
    ok("the host starts", false, String((err && err.stack) || err));
  }

  const missing = channels.filter((channel) => !registered.has(channel));
  ok("every channel the preload calls is registered", missing.length === 0, "missing " + JSON.stringify(missing));
  ok("and nothing was registered twice into a different meaning", registered.size >= channels.length, "registered " + registered.size + " asked " + channels.length);

  /* ---- 3. the assets the pages need are the files on disk ---------------- */

  const assets = host.assets();
  ok(
    "the host hands the renderer the five assets",
    Boolean(assets) && ["css", "promptHtml", "panesHtml", "panesCss", "panesJs"].every((key) => typeof assets[key] === "string" && assets[key].length > 0),
    JSON.stringify(Object.keys(assets || {}).map((key) => key + ":" + String((assets || {})[key] || "").length)),
  );
  // The Beef page is the one page a plugin owns, so it is the one markup that
  // proves the host is serving the sheet the pages actually render.
  ok("the panes markup is the sheet's own", String(assets.panesHtml).includes('data-view="beef"'), String(assets.panesHtml).slice(0, 80));
  const views = ["commands", "plugins", "hyper", "beef", "themes", "logs", "accounts", "tokens"];
  ok("and it carries every section as its own page", views.every((view) => String(assets.panesHtml).includes('data-view="' + view + '"')), JSON.stringify(views.filter((view) => !String(assets.panesHtml).includes('data-view="' + view + '"'))));
  ok("css() is the one style string", typeof host.css() === "string" && host.css().length > 0, String(typeof host.css()));

  // A sheet is one script and one fragment, and the script finds its controls by id. An id the
  // script looks up that the markup does not carry is a control that is never wired - a page
  // with a button that does nothing, or a block that stays blank forever - and nothing else in
  // this suite would notice. So every id is accounted for: it is in the markup, or the script
  // builds it itself (the account switcher's strip), or it is a prefix for a row the script
  // makes (ending in "-").
  const lookedUp = new Set();
  for (const found of String(assets.panesJs).matchAll(/\$\("([^"]+)"\)/g)) lookedUp.add(found[1]);
  // `on(id, event, fn)` is how every control is wired, and it looks the element up by that
  // id - so the ids passed to it are part of the same invariant
  for (const found of String(assets.panesJs).matchAll(/\bon\("([^"]+)",\s*"[a-z]+"/g)) lookedUp.add(found[1]);
  const markup = String(assets.panesHtml);
  const builtByScript = new Set();
  for (const found of String(assets.panesJs).matchAll(/\.id\s*=\s*"([^"]+)"/g)) builtByScript.add(found[1].replace(/\s*\+.*$/, ""));
  const unaccounted = [...lookedUp].filter((id) => {
    if (!id.startsWith("hp-")) return false; // only the sheet's own tree is this sheet's business
    if (markup.includes('id="' + id + '"')) return false;
    if (builtByScript.has(id)) return false;
    return !id.endsWith("-");
  });
  ok(
    "every id the sheet's script looks up is in the markup or built by the script itself",
    unaccounted.length === 0,
    "unaccounted: " + JSON.stringify(unaccounted),
  );
  // and the two blocks this release added are wired to the channels that answer them
  ok(
    "the About block and the library's filters are all in the markup",
    ["hp-clientAbout", "hp-clientNote", "hp-supportBundle", "hp-clientReapply", "hp-themeLibrary", "hp-themeLibraryKind", "hp-themeLibrarySort", "hp-themeLibraryPreview"].every((id) => markup.includes('id="' + id + '"')),
    JSON.stringify(["hp-clientAbout", "hp-clientNote", "hp-supportBundle", "hp-clientReapply", "hp-themeLibrary", "hp-themeLibraryKind", "hp-themeLibrarySort", "hp-themeLibraryPreview"].filter((id) => !markup.includes('id="' + id + '"'))),
  );

  /* ---- 4. opening a page is a push, through the plugin that owns it ------- */

  pushed.length = 0;
  const opened = host.openPanes("themes");
  ok("openPanes asks the pane plugin for the view", opened === "themes", String(opened));
  ok("and pushes panes:open", pushed.some(([kind, payload]) => kind === "panes:open" && payload === "themes"), JSON.stringify(pushed));

  const unknown = host.openPanes("no-such-section");
  ok("a section that does not exist is refused rather than invented", unknown !== "no-such-section", String(unknown));

  /* ---- 5. the handlers answer, and refuse in shapes --------------------- */

  const call = async (channel, ...args) => {
    const fn = registered.get(channel);
    if (!fn) return { ok: false, error: "no handler for " + channel };
    return fn(null, ...args);
  };

  const section = await call("plugins:section", "nobodyDescribesThis");
  ok("a section no running plugin describes is a refusal, not a throw", section && section.ok === false && typeof section.error === "string" && section.error.length > 0, JSON.stringify(section));
  const action = await call("plugins:sectionAction", "nobodyDescribesThis", "refresh", null);
  ok("and so is an action on it", action && action.ok === false && typeof action.error === "string", JSON.stringify(action));

  const assetCall = await call("ui:assets");
  ok("ui:assets answers with the same five strings", assetCall && typeof assetCall.panesHtml === "string" && assetCall.panesHtml.includes('data-view="beef"') && typeof assetCall.css === "string", JSON.stringify(Object.keys(assetCall || {})));

  const lines = await call("logs:read", 50);
  ok("logs:read answers with a bounded ring", lines && Array.isArray(lines.lines) && typeof lines.total === "number" && typeof lines.limit === "number", JSON.stringify(lines && lines.total));

  const listed = await call("plugins:list");
  ok("plugins:list is the catalogue's metadata", Array.isArray(listed) && listed.length > 0 && listed.every((entry) => entry && entry.id && entry.name), "entries " + (Array.isArray(listed) ? listed.length : -1));

  const themes = await call("themes:list");
  ok("themes:list is a list, empty or not", Array.isArray(themes), JSON.stringify(themes));

  const state = await call("update:state");
  ok("update:state describes this run rather than throwing", Boolean(state) && typeof state === "object", JSON.stringify(state));

  const keys = await call("tokens:list");
  ok("tokens:list is the store's own list", Array.isArray(keys), JSON.stringify(keys));
  // The Accounts page needs all four of these: the list (with each account's identity),
  // a check that says whether a key still works, a rename of the label, and the switch.
  // A missing channel is a dead button, so they are asserted by name rather than in bulk.
  ok("the account switcher's channels are all registered", ["tokens:list", "tokens:test", "tokens:rename", "tokens:use", "tokens:add", "tokens:remove"].every((channel) => registered.has(channel)), JSON.stringify(["tokens:list", "tokens:test", "tokens:rename", "tokens:use", "tokens:add", "tokens:remove"].filter((channel) => !registered.has(channel))));
  const renamed = await call("tokens:rename", "nobody", "a name");
  ok("renaming an account that is not stored is a refusal, not a throw", renamed && renamed.ok === false && typeof renamed.error === "string", JSON.stringify(renamed));
  const untested = await call("tokens:test", "nobody");
  ok("testing a key that is not stored says so without asking Discord", untested && untested.ok === false && /no token/.test(untested.error), JSON.stringify(untested));

  /* ---- 5b. the Beef section answers with no control server --------------- */

  // This is the one end-to-end reading of the local engine: the real catalogue is loaded,
  // the real plugin is running, the call goes through the same channel the settings page
  // uses, and the api it was handed has no base URL - the machine the engine exists for.
  const engine = host.beef ? host.beef.state() : null;
  ok("the host builds the client's own beef engine", Boolean(engine) && engine.banks >= 9 && Array.isArray(engine.categories), JSON.stringify(engine && { banks: engine.banks, source: engine.source }));
  const beefSection = await call("plugins:section", "hyperBeef");
  ok("the Beef section is described by its plugin", Boolean(beefSection) && beefSection.ok === true && beefSection.section && Array.isArray(beefSection.section.actions), JSON.stringify(beefSection && beefSection.error));
  ok("and it says the local engine is what answers", beefSection.section.state.answers === "local engine", JSON.stringify(beefSection.section.state.answers));
  const refreshed = await call("plugins:sectionAction", "hyperBeef", "refresh", null);
  ok("refreshing it reads the engine, not a server", refreshed && refreshed.ok === true && refreshed.source === "builtin banks" && refreshed.categories.length > 0, JSON.stringify(refreshed && { ok: refreshed.ok, source: refreshed.source, categories: refreshed.categories && refreshed.categories.length }));
  const readLine = await call("plugins:sectionAction", "hyperBeef", "inspect", "<@1> you are trash, kys");
  ok("and the line lab answers in this process", readLine && readLine.ok === true && readLine.read && readLine.read.route === "beef", JSON.stringify(readLine && readLine.error));

  /* ---- 5b2. which client this is, and the file a person can send --------- */

  // The About block and the support bundle are the two things that make a bug report
  // possible at all: which process the host is inside, which Discord it stands in front of,
  // and whether the patch took. All three answer with no control server and no network.
  const info = await call("client:info");
  ok("client:info answers without a control server", Boolean(info) && typeof info === "object" && typeof info.title === "string" && info.title.length > 0, JSON.stringify(info && info.title));
  ok("and says which process this host is inside", typeof info.host === "string" && ["patched", "window", "other"].includes(info.mode), JSON.stringify({ host: info.host, mode: info.mode }));
  ok("with no shell having decided anything, the decision is absent rather than invented", info.policy === null, JSON.stringify(info.policy));
  ok("and every install it found is described by its patch state", Array.isArray(info.installs) && info.installs.every((one) => typeof one.patch.state === "string"), JSON.stringify(info.installs));
  const recorded = host.setClient({ attach: true, reason: "a Discord install is here and it is the client", state: "patched", channel: "stable", version: "1.0.0" });
  ok("a shell's own verdict is recorded", Boolean(recorded) && recorded.attach === true, JSON.stringify(recorded));
  const withPolicy = await call("client:info");
  ok(
    "and read back as plain values, so the page can say who decided this window",
    Boolean(withPolicy.policy) && withPolicy.policy.attach === true && withPolicy.policy.reason.includes("Discord install"),
    JSON.stringify(withPolicy.policy),
  );
  ok("a verdict that is nonsense is dropped rather than half-kept", host.setClient("not an object") === null);

  const reapplyAsked = await call("client:reapply");
  ok(
    "asking for a patch refresh records the request and says when it applies",
    Boolean(reapplyAsked) && reapplyAsked.ok === true && reapplyAsked.queued === true && /next time it starts/.test(String(reapplyAsked.note)),
    JSON.stringify(reapplyAsked),
  );
  ok("and the request is on disk where the shell looks for it", fs.existsSync(path.join(userData, "repatch.request")));

  const bundled = await call("support:bundle");
  ok(
    "a support bundle is written somewhere a person can find",
    Boolean(bundled) && bundled.ok === true && typeof bundled.path === "string" && bundled.path.endsWith(".txt"),
    JSON.stringify(bundled && { ok: bundled.ok, path: bundled.path, error: bundled.error }),
  );
  ok("the file on disk is exactly the text it reported", fs.readFileSync(bundled.path, "utf8") === bundled.text && bundled.bytes > 200, String(bundled.bytes));
  ok(
    "it carries every section a reader needs",
    [
      "== this process ==",
      "== the Discord in front of it ==",
      "== the patch ==",
      "== updates ==",
      "== plugins ==",
      "== themes, keys and beef ==",
      "== log (this host's own lines, newest last) ==",
      "== not in this file ==",
    ].every((section) => bundled.text.includes(section)),
    bundled.text.slice(0, 200),
  );
  ok("and it says what it deliberately leaves out", /token values, passkeys, cookies/.test(bundled.text));
  ok("a timestamp in a Windows file name is legal", !/[:]/.test(path.basename(bundled.path)), path.basename(bundled.path));

  // The one assertion that matters most here: this file is made to leave the machine, so a
  // stored key must not be in it, in any form a reader could recover. This machine has no
  // keychain (the stub says so), which is exactly the state the store keeps a key in memory
  // for - and `tokens:put` refuses without a cipher on purpose, so the store is asked
  // directly here rather than through a channel that would rightly say no.
  // Deliberately *not* shaped like a Discord token. An earlier version of this fixture was
  // (three dot-separated base64url parts, the first of which matched `[MN][A-Za-z0-9]{23}`),
  // which is a string that reads as a live credential to every secret scanner on the way into
  // a repository - GitHub's push protection refused the commit that carried it. What the
  // assertions below need is a long, valid-shaped secret (the store validates it), never a
  // real-looking one, so this is a token by the store's rules and by nothing else's.
  const secret = "hypercord-test-token-not-a-real-one-0123456789abcdef";
  const stored = host.tokens.put("4242", secret, { label: "a key for this test", memoryOnly: true });
  ok("the store holds a key for the bundle to have to hide", Boolean(stored) && stored.ok === true, JSON.stringify(stored));
  const withSecret = await call("support:bundle");
  ok("a stored key is never in the bundle", !withSecret.text.includes(secret) && !withSecret.text.includes(secret.slice(0, 12)), "present: " + String(withSecret.text.includes(secret) || withSecret.text.includes(secret.slice(0, 12))));
  ok("and the key is still named by its mask, so the file is useful", withSecret.text.includes("4242") && /ends [A-Za-z0-9]{1,4}/.test(withSecret.text), withSecret.text.split("\n").filter((line) => line.includes("4242")).join(" | "));
  await call("tokens:remove", "4242");

  /* ---- 5b3. a theme preview is fetched by the shell, not the page -------- */

  // The page cannot be the one asking: the image policy it lives under is Discord's, and one
  // row of the real library keeps its thumbnail on a third party's host. So the address goes
  // to the shell and a data URL comes back - and the refusals happen here, before any request,
  // which is why this is asserted with no network stub at all.
  ok("the preview channel is registered", registered.has("themes:thumbnail"));
  const noAddress = await call("themes:thumbnail", "not an address");
  ok("a preview address that is not an address is refused without a request", noAddress && noAddress.ok === false && /not an address/.test(noAddress.error), JSON.stringify(noAddress));
  const httpPreview = await call("themes:thumbnail", "http://themes.equicord.org/thumbnails/x.png");
  ok("and one that is not https is refused too", httpPreview && httpPreview.ok === false && /only fetched over https/.test(httpPreview.error), JSON.stringify(httpPreview));
  const strangerPreview = await call("themes:thumbnail", "https://evil.example/x.png");
  ok(
    "and one on a host this client does not fetch names the host rather than fetching it",
    strangerPreview && strangerPreview.ok === false && /evil\.example/.test(strangerPreview.error),
    JSON.stringify(strangerPreview),
  );

  /* ---- 5c. the restart a patch-based plugin needs ------------------------ */

  restarts.length = 0;
  const restarted = await call("client:relaunch");
  ok("a page of ours can ask for the client to restart", restarted && restarted.ok === true, JSON.stringify(restarted));
  ok("and the new process is arranged before this one ends", JSON.stringify(restarts) === '["relaunch","exit"]', JSON.stringify(restarts));

  // A run with no app to relaunch - a headless reader of these pages, or the next reader of
  // this file - is a refusal rather than a process taken down: exiting is the one thing here
  // that cannot be undone, so it only happens after the relaunch was arranged.
  const hadRelaunch = electron.app.relaunch;
  delete electron.app.relaunch;
  restarts.length = 0;
  const nowhere = await call("client:relaunch");
  ok(
    "with no app to restart it says so, and nothing is exited",
    nowhere && nowhere.ok === false && typeof nowhere.error === "string" && restarts.length === 0,
    JSON.stringify({ answer: nowhere, restarts }),
  );
  electron.app.relaunch = hadRelaunch;

  /* ---- 5d. the runtime's cloud requests, made by the shell -------------- */

  // The runtime's cloud tab, and every settings sync it does, used to fetch from the page - where
  // Discord's content-security policy refuses an origin it does not name, which is why that tab
  // reported "Setup failed (couldn't retrieve OAuth configuration)" for a backend that answers
  // perfectly well everywhere else. The request is made here now, and what this asserts is the
  // boundary rather than the network: who may be asked, in which shape an answer comes back, and
  // that a body crosses the IPC boundary as bytes.
  const sent = [];
  const replies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), method: (init && init.method) || "", headers: (init && init.headers) || {}, body: init && init.body });
    const next = replies.shift();
    if (!next) throw new Error("this check did not say what the shell should be answered with");
    return next;
  };

  const notAUrl = await call("runtime:request", "nonsense");
  ok("a request that is not a URL is refused by name", notAUrl && notAUrl.ok === false && /not a URL/.test(notAUrl.error), JSON.stringify(notAUrl));

  const insecure = await call("runtime:request", "http://cloud.equicord.org/v1/oauth/settings");
  ok("and only https is served here, whatever the host is", insecure && insecure.ok === false && /only https/.test(insecure.error), JSON.stringify(insecure));

  const elsewhere = await call("runtime:request", "https://example.com/v1/oauth/settings");
  ok("a request to an origin that is not the client's cloud backend is refused", elsewhere && elsewhere.ok === false, JSON.stringify(elsewhere));
  ok("and the refusal names the backends it would have served", /cloud[.]equicord[.]org/.test(elsewhere.error || "") && /api[.]vencord[.]dev/.test(elsewhere.error || ""), elsewhere.error);
  ok("a refused request never reached the network", sent.length === 0, JSON.stringify(sent));

  // The backend the runtime's own Cloud tab is set to comes out of its settings file, read on
  // every request: a client switched to a self-hosted cloud has to reach *that* one, not only the
  // two defaults - the tab writes that file and expects the next sync to go there.
  const runtimeSettings = path.join(userData, "runtime.settings.json");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(runtimeSettings, JSON.stringify({ cloud: { url: "https://self.hosted.test/" } }));
  replies.push(new Response(JSON.stringify({ clientId: "1234", redirectUri: "https://self.hosted.test/callback" }), { status: 200, headers: { "content-type": "application/json" } }));
  const oauth = await call("runtime:request", "https://self.hosted.test/v1/oauth/settings", { method: "GET", headers: { Accept: "application/json" } });
  ok("the configured backend is served, and its answer is the text a caller parses", oauth && oauth.ok === true && oauth.status === 200 && /redirectUri/.test(String(oauth.text || "")), JSON.stringify(oauth));
  ok(
    "and what went out is that origin, with the caller's own method and headers",
    sent[0] && sent[0].url === "https://self.hosted.test/v1/oauth/settings" && sent[0].method === "GET" && sent[0].headers.Accept === "application/json",
    JSON.stringify(sent[0]),
  );

  // A body crosses the boundary as bytes and a binary answer comes back as bytes: the synced
  // settings are deflated before they are uploaded and inflated after they are fetched, so a body
  // that travelled as a string would arrive corrupted and fail as "settings could not be imported".
  replies.push(new Response(new Uint8Array([0x78, 0x9c, 0x00, 0xff]), { status: 200, headers: { "content-type": "application/octet-stream" } }));
  const uploaded = await call("runtime:request", "https://self.hosted.test/v2/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    bodyBase64: Buffer.from("deflated").toString("base64"),
  });
  ok(
    "the client's own body is handed to the request as the bytes it was",
    sent[1] && Buffer.isBuffer(sent[1].body) && sent[1].body.toString("utf8") === "deflated" && sent[1].method === "POST",
    JSON.stringify({ method: sent[1] && sent[1].method, body: sent[1] && String(sent[1].body) }),
  );
  ok(
    "and an answer that is not text comes back as bytes, not as a mangled string",
    uploaded && uploaded.ok === true && typeof uploaded.bodyBase64 === "string" && uploaded.text === undefined && Buffer.from(uploaded.bodyBase64, "base64").length === 4,
    JSON.stringify(uploaded),
  );

  // and the settings file is what decides: remove it and the self-hosted backend goes with it
  fs.rmSync(runtimeSettings);
  const afterRemoval = await call("runtime:request", "https://self.hosted.test/v1/settings");
  ok("the settings file going away takes the self-hosted backend with it", afterRemoval && afterRemoval.ok === false, JSON.stringify(afterRemoval));
  globalThis.fetch = realFetch;

  /* ---- 6. stopping leaves nothing registered, and nothing running -------- */

  const stopped = await host.stop();
  ok(
    "stop() stops the running plugins and names them",
    stopped && stopped.ok === true && stopped.already === false && stopped.plugins && stopped.plugins.stopped.includes("hyperBeef"),
    JSON.stringify(stopped && stopped.plugins),
  );
  ok("a real plugin's own stop() hook ran on the way out", logs.some((line) => /beef section closed/.test(String(line))), JSON.stringify(logs.slice(-3)));
  ok("and the host releases the stores it was holding", host.beef === null && host.plugins === null && host.themes === null && host.tokens === null, "held on");
  const twice = await host.stop();
  ok("stopping twice is a no-op rather than a second teardown", twice && twice.already === true && twice.plugins === null, JSON.stringify(twice));
  ok("stop() unregisters every channel it registered", registered.size === 0, "left " + registered.size);
  ok("and nothing was written into a real user data directory", !fs.existsSync(path.join(os.homedir(), ".hypercord-host-test")), userData);
}

/* ---- 7. the pages' own files are read when a page asks for them ---------- */

// A page of ours is a file on disk, and the host reads the five files *again* whenever a page
// asks for them (ui:assets). That is what makes a change to the sheet's own script, markup or
// stylesheet need a reload of the window instead of a whole new Discord process. Checked on a
// copy in a temp directory, so nothing here touches the tree it copied from.
const assetsDir = path.join(tmp, "assets");
fs.mkdirSync(assetsDir, { recursive: true });
for (const file of ["injected.css", "prompt.html", "panes.html", "panes.css", "panes.js"]) {
  fs.copyFileSync(path.join(src, file), path.join(assetsDir, file));
}

const freshRegistered = new Map();
const fresh = createHost({
  electron: {
    ...electron,
    ipcMain: {
      handle: (channel, fn) => freshRegistered.set(String(channel), fn),
      removeHandler: (channel) => freshRegistered.delete(String(channel)),
      on: (channel, fn) => freshRegistered.set("on:" + String(channel), fn),
      removeListener: (channel) => freshRegistered.delete("on:" + String(channel)),
    },
  },
  dir: assetsDir,
  userData: path.join(tmp, "userData-again"),
  log: () => {},
  push: () => {},
  windowFor: () => null,
  reloadWindow: () => {},
});
await fresh.start();
const ask = () => freshRegistered.get("ui:assets")(null);

const asRead = await ask();
ok("a second host serves the files in its own directory", String(asRead.panesJs).includes("hypercordPanes"), String(asRead.panesJs).slice(0, 60));

// the sheet's script and the stylesheet it is injected with, changed on disk after the host
// came up: what the page asks for is what is on disk now, not what was there at start
fs.writeFileSync(path.join(assetsDir, "panes.js"), fs.readFileSync(path.join(assetsDir, "panes.js"), "utf8") + "\n// hypercord: changed while the client was running\n");
fs.writeFileSync(path.join(assetsDir, "injected.css"), fs.readFileSync(path.join(assetsDir, "injected.css"), "utf8") + "\n.hypercord-test-marker { color: red; }\n");
const afterEdit = await ask();
ok("a change to the sheet's own script is what the next page gets", String(afterEdit.panesJs).includes("changed while the client was running"), String(afterEdit.panesJs).slice(-90));
ok("and so is a change to the stylesheet it is injected with", String(afterEdit.css).includes("hypercord-test-marker"), String(afterEdit.css).slice(-90));

// a file that is not there keeps the copy already held, so a half-finished edit cannot blank a
// page that was working
const beforeDelete = String(afterEdit.panesCss).length;
fs.rmSync(path.join(assetsDir, "panes.css"));
const afterDelete = await ask();
ok("a file that has gone missing keeps the copy the host already had", beforeDelete > 0 && String(afterDelete.panesCss).length === beforeDelete, JSON.stringify({ before: beforeDelete, after: String(afterDelete.panesCss).length }));
const closed = await fresh.stop();
ok("and that host stops cleanly too", Boolean(closed) && closed.ok === true, JSON.stringify(closed));

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
