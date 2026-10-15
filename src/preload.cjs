// language: JavaScript, file: src/preload.cjs
//
// Runs before Discord's own bundle, in the same document, in its own world:
// contextIsolation stays on and the renderer stays sandboxed, so the only way
// out is the small surface below. Three jobs:
//
//   * **no uninvited passkey prompt.** On Windows, Discord's login page asks for
//     a passkey by itself and Chromium answers with the operating system's
//     "choose a passkey" dialog. policies live in src/passkeys.cjs, and the
//     injection below is deliberately at the top of this file: it has to be in
//     the page's world before the page's own scripts, and DOMContentLoaded (where
//     this used to happen) is already too late - Discord's bundle has run by
//     then. Measured, not assumed: see the ordering checks in tests/preload;
//   * **Hypercord's settings, as pages inside Discord's own settings.** The plugin
//     catalogue, our own Hyper plugins, the themes, the access keys, the commands,
//     the logs and the accounts are one section each in Discord's settings sidebar,
//     and the sheet that renders them is placed over Discord's own content column.
//     There is no Hypercord window to find, raise or close: settings is the one
//     place somebody looks for settings, so that is where these live;
//   * **the user-token option, beside Discord's own fields.** It is an extra way
//     in, not a replacement: the email and password form stays exactly as it is.
//
// Nothing here reads a token back out of the page, and no value from anywhere is
// written as markup - a plugin description or a token label is always text.
const { contextBridge, ipcRenderer, webFrame } = require("electron");

/* ---- the page's own world ------------------------------------------------ */

/**
 * The passkey policy, fetched from the shell.
 *
 * It is one synchronous round trip, deliberately: this file runs sandboxed, so
 * it cannot read src/passkeys.cjs off the disk itself, and the policy has to be
 * in the page's world *before* the page's own scripts run. Waiting for an async
 * reply - or for DOMContentLoaded - is exactly the mistake that let Discord's
 * login page raise the Windows passkey dialog while the rest of this file was
 * still being built. A sync call here costs one handshake at document start and
 * buys the ordering, and the shell keeps the single copy of the policy.
 */
function holdBackPasskeyPrompts() {
  let policy = "";
  try {
    policy = String(ipcRenderer.sendSync("passkeys:policy") || "");
  } catch {
    return; // no shell to ask: the app still works, Discord may ask for a passkey
  }
  if (!policy) return;
  try {
    // runs in the main world, so it lands before Discord's bundle and cannot be
    // undone by it
    webFrame.executeJavaScript(policy);
  } catch {
    /* an old runtime without webFrame: the app still works, Discord may ask */
  }
}

/* ---- the bridge ---------------------------------------------------------- */

const OURS = (() => {
  try {
    return String(location.protocol) === "file:";
  } catch {
    return false;
  }
})();

const listeners = new Map();
ipcRenderer.on("push", (_event, kind, payload) => {
  const key = String(kind);
  if (key === "themes:css" && !OURS) applyCss(payload);
  // The pane tells us which sections it actually has, so an entry can never point at
  // one it has lost since this page was built.
  if (key === "panes:views" && !OURS) adoptSettingsViews(payload);
  if (key === "tokens:changed" && !OURS) refreshPrompt();
  for (const cb of listeners.get(key) || []) {
    try {
      cb(payload);
    } catch {
      /* a bad listener is the listener's problem */
    }
  }
});

function on(kind, cb) {
  const key = String(kind);
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key).push(cb);
  return () => {
    const list = listeners.get(key) || [];
    listeners.set(
      key,
      list.filter((fn) => fn !== cb),
    );
  };
}

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("hypercord", {
  shell: "hypercord",
  // the control server is spoken to through main, never with a token of its own
  api: {
    request: (path, opts = {}) => call("api:request", String(path), opts),
  },
  // the sheet lives in this page: opening a view is a push, and Close is the
  // shell's to confirm
  panes: {
    open: (view) => call("panes:open", String(view || "commands")),
    close: () => call("panes:close"),
  },
  // the client's own process: the one thing a page cannot do for itself, and the only
  // answer to a plugin that patches Discord as it loads (see the channel in src/host.js)
  client: {
    relaunch: () => call("client:relaunch"),
  },
  // The built runtime's settings. The page it runs in has no storage of its own - Discord
  // removes `localStorage` and `sessionStorage` there - so the runtime keeps them in
  // Hypercord's data directory through the shell instead of forgetting them at every start.
  // Synchronous on purpose: the runtime reads its settings while it is being imported, so an
  // asynchronous answer would arrive after its store had already been built and would leave a
  // plugin switched on with "restart to apply" off again. Both ends are bounded and parsed
  // (see `runtimeStore` in src/loader.cjs), and a page with no shell behind it gets `{}`.
  runtime: {
    settings: {
      read: () => {
        try {
          return String(ipcRenderer.sendSync("hypercord:runtime-settings", "read") || "{}");
        } catch {
          return "{}";
        }
      },
      write: (text) => {
        try {
          return ipcRenderer.sendSync("hypercord:runtime-settings", "write", String(text)) === true;
        } catch {
          return false;
        }
      },
    },
    // The runtime's cloud requests, made by the shell rather than by the page: Discord's page
    // refuses a request to an origin its content-security policy does not name, which is what
    // made the cloud tab report "couldn't retrieve OAuth configuration" for a backend that
    // answers everywhere else. The bridge serves the cloud backend this client is set to and
    // nothing else - see the channel in src/host.js for how that is decided.
    request: (url, options) => call("runtime:request", String(url || ""), options || {}),
  },
  notify: (title, body) => call("notify", String(title || ""), String(body || "")),
  metrics: () => call("perf:metrics"),
  // this client's own log, never the control server's: the pane says which one it
  // is reading, and a build that keeps no log answers null rather than an empty box
  logs: {
    read: (lines) => call("logs:read", Number(lines) || 200),
  },
  update: {
    check: () => call("update:check"),
    install: () => call("update:install"),
    state: () => call("update:state"),
  },
  account: {
    current: () => call("account:current"),
    switch: (id) => call("account:switch", String(id || "")),
  },
  plugins: {
    list: () => call("plugins:list"),
    status: () => call("plugins:status"),
    enable: (id) => call("plugins:enable", String(id || "")),
    disable: (id) => call("plugins:disable", String(id || "")),
    settings: (id) => call("plugins:settings", String(id || "")),
    setSetting: (id, key, value) => call("plugins:setSetting", String(id || ""), String(key || ""), value),
    // a page whose contents a plugin owns: the plugin describes its own section as
    // data and declares which of its functions a page may call, so the sheet renders
    // what it is handed and never reaches into a plugin's internals
    section: (id) => call("plugins:section", String(id || "")),
    sectionAction: (id, action, input) =>
      call("plugins:sectionAction", String(id || ""), String(action || ""), input === undefined ? null : input),
  },
  themes: {
    list: () => call("themes:list"),
    // the public theme library, read when the page asks for it: `force` is the Load
    // button, and everything else is answered from what the shell already read
    index: (force) => call("themes:index", Boolean(force)),
    css: () => call("themes:css"),
    install: (source, name) => call("themes:install", String(source || ""), name === undefined ? undefined : String(name)),
    remove: (id) => call("themes:remove", String(id || "")),
    enable: (id, on) => call("themes:enable", String(id || ""), Boolean(on)),
    quick: (css) => call("themes:quick", String(css === undefined ? "" : css)),
    quickCss: () => call("themes:quickCss"),
  },
  // the user tokens. There is no reader for a stored secret here on purpose:
  // main holds them, uses them, and reports only a mask back.
  tokens: {
    list: () => call("tokens:list"),
    add: (secret, label) => call("tokens:add", String(secret || ""), label === undefined ? "" : String(label)),
    put: (account, secret, label) => call("tokens:put", String(account || ""), String(secret || ""), label === undefined ? "" : String(label)),
    remove: (account) => call("tokens:remove", String(account || "")),
    forgetAll: () => call("tokens:forgetAll"),
    test: (account) => call("tokens:test", String(account || "")),
    rename: (account, label) => call("tokens:rename", String(account || ""), label === undefined ? "" : String(label)),
    use: (account) => call("tokens:use", String(account || "")),
    store: () => call("tokens:store"),
  },
  on,
});

/* ---- the built plugin runtime, before Discord's own bundle --------------- */

/**
 * The vendored catalogue's runtime, in the page *before* Discord's own bundle.
 *
 * This is the one moment that matters, and it is a measured fact rather than a preference:
 * the runtime works by patching Discord's webpack as Discord defines its module factories, so
 * it has to be in the page while that is still happening. Injected later - which is what the
 * loader's own `did-finish-load` pass does, and the only thing it can do for a window with no
 * preload of ours - it came up reporting all 372 plugins and reaching none of them: no plugin
 * could find a Discord module, its patches applied to nothing, and the runtime's own plugin
 * settings window threw before it could draw (`Cannot read properties of undefined (reading
 * 'm')`, from `findModuleId` over an uninitialised webpack require). A client whose switch
 * says "on" while nothing the plugin does happens is exactly what that looks like from the
 * outside.
 *
 * So the script is fetched from the shell synchronously - like the passkey policy above, and
 * for the same reason: this file runs while the document is being created, and an
 * asynchronous answer would arrive after Discord's bundle - and evaluated in the page's own
 * world, where `window.hypercord` (and therefore the runtime's settings bridge) already is.
 * The loader still injects its own copy per window; the two are one script with a marker, so
 * whichever arrives first wins and the second is a no-op.
 */
function installRuntime() {
  let script = "";
  try {
    script = String(ipcRenderer.sendSync("hypercord:runtime-script") || "");
  } catch {
    return; // no shell to ask: nothing to inject, and nothing to report to either
  }
  if (!script) return; // `HYPERCORD_RUNTIME=off`, or a tree whose bundle was never built
  let url = "";
  try {
    url = String(location.href || "");
  } catch {
    return;
  }
  // Discord's own page and nothing else: the runtime patches Discord's webpack and reads its
  // modules, so any other window gets nothing from it but the cost of evaluating it.
  if (!/^https:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com(?:\/|$)/i.test(url)) return;
  try {
    // the page's own world, synchronously, before the document's own scripts
    webFrame.executeJavaScript(script);
  } catch {
    /* no webFrame in this world: the loader's own pass still tries, later */
  }
}

// here, and not later: this is still before the page's own scripts, and the runtime reads
// `window.hypercord.runtime.settings` while it is importing - so the bridge above has to be
// in place first, which is why this is after it and not at the top of the file
if (!OURS) installRuntime();

/* ---- what Hypercord mounts in Discord's page ---------------------------- */

/**
 * The manager sheet, mounted inside the Discord window.
 *
 * A host element we own, the one stylesheet, the markup, and the script last so
 * it finds everything it needs. The script runs in the page's own world
 * (`webFrame.executeJavaScript`), which is where `window.hypercord` lives, and
 * that is deliberate: Discord ships a strict script-src, and the sheet is our
 * code, not theirs - it must not be at the mercy of their policy header.
 * Evaluating it twice in one document is harmless: panes.js returns early when
 * the sheet is already there.
 */
function mountPanes(assets) {
  if (!document.documentElement || !assets) return false;
  let host = document.getElementById("hypercord-panes");
  if (!host) {
    host = document.createElement("div");
    host.id = "hypercord-panes";
    host.setAttribute("data-hypercord", "panes");
    host.setAttribute("data-open", "false");
    document.documentElement.appendChild(host);
  }
  if (assets.panesCss) {
    let style = document.getElementById("hypercord-panes-css");
    if (!style) {
      style = document.createElement("style");
      style.id = "hypercord-panes-css";
      style.setAttribute("data-hypercord", "panes");
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = String(assets.panesCss);
  }
  if (assets.panesHtml && host.getAttribute("data-mounted") !== "true") {
    // our own bundle's markup, from src/panes.html: nothing here comes from the
    // network, from a plugin or from the control server
    host.innerHTML = String(assets.panesHtml);
    host.setAttribute("data-mounted", "true");
  }
  if (assets.panesJs) {
    try {
      const done = webFrame.executeJavaScript(String(assets.panesJs));
      if (done && typeof done.catch === "function") done.catch((err) => console.log("hypercord: the manager sheet threw " + String((err && err.message) || err)));
    } catch (err) {
      console.log("hypercord: the manager sheet could not be mounted " + String((err && err.message) || err));
    }
  }
  return true;
}

/**
 * The assets the shell handed over at boot, kept because a page Discord took away with the
 * settings layer has to be mounted again: markup, stylesheet and script are all that is
 * needed to build it a second time.
 */
let PANES_ASSETS = null;

const $ = (root, selector) => (root ? root.querySelector(selector) : null);

/** Text, never markup: every value shown here comes from somewhere else. */
function fill(node, text) {
  if (!node) return;
  node.textContent = String(text === undefined || text === null ? "" : text);
}

/**
 * Store a user token, from the prompt that sits beside Discord's login form - that
 * prompt is this function's only caller. The shell checks the token with Discord
 * before anything is written, and the token itself is never repeated back: what is
 * echoed is the label or the account it belongs to.
 */
async function addToken(valueInput, labelInput, hint) {
  const value = valueInput ? String(valueInput.value || "") : "";
  if (!value.trim()) {
    fill(hint, "paste a user token first");
    return { ok: false, error: "empty" };
  }
  fill(hint, "checking with Discord\u2026");
  let res;
  try {
    res = await call("tokens:add", value, labelInput ? String(labelInput.value || "") : "");
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  if (valueInput) valueInput.value = "";
  if (labelInput) labelInput.value = "";
  fill(hint, res && res.ok ? "stored and signed in as " + (res.label || res.account) : "refused: " + ((res && res.error) || "unknown"));
  if (res && res.ok) {
    hidePrompt();
    call("notify", "Hypercord", "Signed in with a stored user token").catch(() => {});
  }
  return res;
}

/* ---- Hypercord's sections in Discord's own settings ---------------------- */

/**
 * Hypercord, as sections inside Discord's settings.
 *
 * Everything Hypercord adds is configured in the sheet - plugins, our own Hyper
 * plugins, themes, access keys, commands, logs, accounts, one section each - and the
 * place people look for settings is Discord's own settings. So when the settings
 * layer is open, one entry per section is added to its sidebar, beside the real
 * ones, and the sheet is placed over Discord's own settings content column rather
 * than over the client: a section reads as a page of settings because it stands
 * exactly where one stands.
 *
 * The entries are Discord's own markup, copied rather than imitated: their row, their
 * section, their heading, inside their list of sections. An element of ours wearing a
 * borrowed class was tried first and was wrong - the client's rows are a shape, not a
 * class, so a hand-built entry sat off their grid, in the wrong type, unclickable, and
 * below the list it was meant to join. A copy is on their grid by definition, and it
 * survives a theme, because a theme is written against the same classes.
 *
 * What stays ours is the behaviour: a click on a copied entry goes to the shell like
 * every other button of ours, and when the settings content column cannot be found the
 * section is not opened at all and the reason is reported on the document, because a
 * panel dropped over somebody's chat is the one outcome worth refusing.
 */

/**
 * The labels a settings list says. This is the signal that survives a release
 * renaming every wrapper: the labels inside are user-visible text, so they change
 * only when Discord renames a setting. Both languages the client is likely to be
 * in are listed, because the label is what somebody reads, not a key.
 *
 * A *count* of these, never a single one, is what decides - see the note on
 * looksLikeSettingsSidebar below, where one word turned out to be enough for
 * Discord's server rail to be mistaken for the settings list.
 */
const SETTINGS_LABELS =
  /(my account|account info|password & security|family center|data & privacy|messaging permissions|notifications|clips|billing|server boost|subscriptions|gift inventory|appearance|accessibility|voice & video|screen share|keybinds|language|english|advanced|authorized apps|connections|devices|friend requests|mon compte|confidentialit|apparence|raccourcis|langue|appareils|connexions|amis|facturation)/gi;

/** How many different settings labels this text says, and which ones. */
function settingsLabelHits(text) {
  const seen = new Set();
  const found = String(text || "");
  for (const match of found.matchAll(SETTINGS_LABELS)) seen.add(String(match[0]).toLowerCase());
  return seen;
}

/**
 * Where to look for the settings sidebar, most specific first. Each candidate is a shape
 * Discord has used, and the first one that yields a list wins:
 *
 *   1. the nav inside the settings layer - since the settings rework the list of
 *      sections is a `<nav class="nav__…">` in a scroll container
 *      (`navScroller__…`), and this is the shape that is actually on screen today;
 *   2. the older shape: a `[class*="sidebar"]` inside `[class*="layers"]`;
 *   3. a sidebar that is itself a tab strip;
 *   4. any sidebar or tab strip at all - the last resort, so a rename of both
 *      wrappers still finds a home.
 *
 * The nav candidates come first for a reason worth remembering: the app's own
 * sidebar is a `[class*="sidebar"]` too, and with `sidebar` first the server rail
 * won and our entries were added under the servers.
 */
function settingsHostCandidates() {
  return [
    '[class*="layers"] nav[class*="nav"]',
    'nav[class*="navScroller"]',
    '[class*="layers"] [class*="sidebar"]',
    '[class*="sidebar"][role="tablist"]',
    '[class*="sidebar"]',
    '[role="tablist"]',
  ];
}

/**
 * Is this the settings sidebar, rather than some other list with items in it?
 *
 * Three things have to be true, and the middle one is the fix for a bug worth
 * naming: Discord's **server rail** (the guild list on the far left) is also a
 * `[class*="sidebar"]` full of buttons, and one loose settings word in it - a
 * server or channel somebody happened to name that way - was enough to accept it.
 * Entries added there sat under the servers, which is not where anybody looks for
 * settings and is exactly what they saw.
 *
 *   1. several items, and on screen - a collapsed strip is not where somebody looks.
 *      Items are counted generously: Discord's settings rows are divs with an
 *      `item__…` class and only some of them carry a role, so counting roles alone
 *      found two items in a list of fifteen;
 *   2. at least TWO different settings labels. One word can be a server or channel
 *      name; two of Discord's own setting names in one list are not an accident;
 *   3. not the guild list: the node is not the server rail and does not hold it. The
 *      check is deliberately only about the node and what is inside it - walking up
 *      with `closest` rejects every settings list too, because the settings layer is
 *      rendered inside the app that also holds the rail.
 */
function looksLikeSettingsSidebar(node) {
  if (!node || typeof node.querySelectorAll !== "function") return false;
  const items = node.querySelectorAll('[role="tab"], [role="button"], button, a[href], [class*="item"]').length;
  if (items < 3) return false;
  const box = node.getBoundingClientRect();
  if (box.width < 120 || box.height < 60) return false;
  const text = String(node.textContent || "").slice(0, 4000);
  if (settingsLabelHits(text).size < 2) return false;
  if (node.querySelector('[class*="guilds"]')) return false;
  if (typeof node.matches === "function" && node.matches('[class*="guild"]')) return false;
  return true;
}

/**
 * Every settings sidebar on the page, in the shape order above, or an empty list.
 *
 * The node handed back is Discord's own sidebar or nav - not the list inside it. Where
 * our group goes within that node is a separate question, because the answer is not
 * the same in every release: see settingsPlace below.
 */
function settingsHosts() {
  for (const selector of settingsHostCandidates()) {
    const found = [];
    for (const node of document.querySelectorAll(selector)) {
      // our own nodes must not make a wrapper look like a settings sidebar, and must
      // not be picked as the place to put one - there is more than one of them now, so
      // they are matched by attribute rather than by the first entry's id
      if (node.closest && node.closest("[data-hypercord]")) continue;
      if (looksLikeSettingsSidebar(node)) found.push(node);
    }
    if (found.length) return found;
  }
  return [];
}

/** One of Discord's own elements, as opposed to one of ours. */
function isDiscordNode(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.hasAttribute("data-hypercord")) return false;
  return !(node.closest && node.closest("[data-hypercord]"));
}

/** Does this element read as one of Discord's settings rows, rather than a section? */
function settingsRowLike(node) {
  if (!isDiscordNode(node)) return false;
  if (node.getAttribute("role") || node.tagName === "BUTTON" || node.tagName === "A") return true;
  return /item/i.test(String(node.className || ""));
}

/** Is this element one of Discord's sections: a heading, and rows of its own below it? */
function settingsSectionLike(node) {
  if (!isDiscordNode(node)) return false;
  if (!node.querySelector("h1, h2, h3, h4, [class*='sectionLabel']")) return false;
  const list = node.querySelector("ul, ol, [role='list']");
  if (!list) return false;
  return [...list.children].some((child) => settingsRowLike(child));
}

/**
 * Discord's list of settings sections, as the client draws it today: a scroll
 * container holding a list whose children are sections, each one a heading and its
 * own list of rows.
 *
 * The deepest match is the list itself, and the difference is the whole point of this
 * function. The nav above it and the scroll container it lives in answer to the same
 * description, and entries appended to the *nav* - which is a sibling of the scroll
 * container, not inside it - are drawn below the visible area, outside the part of the
 * list that scrolls: present in the document, unfindable and unclickable on screen.
 * That is exactly what the owner of this client reported, twice, so the list of
 * sections is what is returned here and never its wrapper.
 */
function settingsSectionList(sidebar) {
  let found = null;
  for (const node of sidebar.querySelectorAll("ul, ol, div, nav")) {
    const children = [...node.children];
    if (children.length < 2) continue;
    // one query before the shape tests: this runs on every mutation batch, and most of
    // what is walked has no nested list at all
    if (!node.querySelector("ul, ol, [role='list']")) continue;
    const real = children.filter((child) => isDiscordNode(child));
    const sections = real.filter((child) => settingsSectionLike(child));
    // At least two sections, and the majority of what is there: a release that adds one
    // more node of its own to the list must not send the entries off to a worse home,
    // while a list of rows - the shape below - is not a list of sections at all.
    if (sections.length < 2 || sections.length * 2 < real.length) continue;
    // document order: the last match is the innermost list of sections
    found = node;
  }
  return found;
}

/**
 * The section to copy: one of Discord's, with a heading and at least one row.
 *
 * Both parts are needed and neither is assumed: the heading is what names our group,
 * the list is what holds our entries, and the row is the model every entry is built
 * from. A section missing any of the three is passed over, and when no section of the
 * list has all three there is nothing to copy - which is reported as such rather than
 * used to add an unnamed group with no rows under it.
 */
function settingsSectionModel(sections) {
  for (const section of sections.children) {
    if (!isDiscordNode(section)) continue;
    if (!section.querySelector("h1, h2, h3, h4, [class*='sectionLabel']")) continue;
    const list = section.querySelector("ul, ol, [role='list']");
    if (!list) continue;
    const row = [...list.children].find((child) => settingsRowLike(child));
    if (row) return { section: section, list: list, row: row };
  }
  return null;
}

/**
 * Discord's rows in a sidebar that holds them itself - the older shape, and the one a
 * release can fall back to. Returns the element the set belongs in, or null.
 *
 * The rows are what the list is made of, so a list whose children are mostly rows is
 * the list, and anything of Discord's that is not a row (a stray wrapper, a heading)
 * is allowed to sit among them. A hidden screen-reader node, though, is why this is not
 * simply "the sidebar": an entry built beside one of those was given
 * `hiddenVisually` and was invisible while being present, so a sidebar that holds
 * anything else beside its rows has the rows in a list of their own to be found here.
 */
function settingsRowList(sidebar) {
  const nodes = [sidebar, ...sidebar.querySelectorAll("ul, ol, div, nav, section, aside")];
  let found = null;
  for (const node of nodes) {
    const children = [...node.children];
    if (!children.length) continue;
    const real = children.filter((child) => isDiscordNode(child));
    const rows = real.filter((child) => settingsRowLike(child));
    if (rows.length < 3 || rows.length * 2 < real.length) continue;
    found = node;
  }
  return found;
}

/**
 * Where our group goes in this sidebar, or null when nowhere in it fits.
 *
 *   * "sections" - the current client. Entries are copies of Discord's own rows, put
 *     in a copy of one of their sections, inside their list of sections: the same
 *     element, the same classes, so Discord's stylesheet types, spaces and highlights
 *     them, and inside the scroll container, so they are on screen when settings
 *     opens;
 *   * "flat" - the sidebar holds the rows directly. The group label and the entries
 *     are children of it, each entry wearing the class of the row it was built beside.
 */
/**
 * The vendored runtime's own section of Discord's settings, when this client has one.
 *
 * These pages belong in there now. This client ships that runtime, the runtime draws its own
 * settings screen inside Discord's own settings, and a second section of ours beside it was a
 * second place holding the same kind of thing - which is what the Hypercord group was. Our rows
 * are added to that section's own list instead, so the way in to these pages wears the name the
 * client already shows, and a client whose runtime is there has no Hypercord group at all.
 *
 * The section is recognised by its heading, because that is the only part of it that is the
 * runtime's own name rather than a copy of Discord's own vocabulary: this client's runtime is
 * branded Hypercord, and the same runtime under its older names draws Equicord or Vencord
 * there, so all three are accepted. The heading is also where the name our rows wear comes
 * from, so a release that renames the section renames ours with it instead of leaving two
 * names for one thing on screen. Our own nodes cannot be mistaken for it: isDiscordNode
 * refuses anything of ours, group included.
 */
const SETTINGS_RUNTIME_NAMES = /^(hypercord|equicord|vencord)\b/i;
function settingsEquicordSection(sections) {
  for (const section of sections.children) {
    if (!isDiscordNode(section)) continue;
    const heading = section.querySelector("h1, h2, h3, h4, [class*='sectionLabel']");
    if (!heading) continue;
    const title = String(heading.textContent || "").trim();
    if (!SETTINGS_RUNTIME_NAMES.test(title)) continue;
    const list = section.querySelector("ul, ol, [role='list']");
    if (!list) continue;
    const row = [...list.children].find((child) => settingsRowLike(child));
    if (!row) continue;
    // the runtime's own first word, not a constant: "Hypercord Settings" and "Vencord" both
    // brand the rows with the name the client is already showing there
    return { section: section, list: list, row: row, brand: title.split(/\s+/)[0] || SETTINGS_GROUP_LABEL };
  }
  return null;
}

function settingsPlace(sidebar) {
  const sections = settingsSectionList(sidebar);
  if (sections) {
    // merged first: the runtime's own section is where these pages belong in a client that
    // ships one, and it is a section of Discord's own - same list, same rows, nothing copied
    const equicord = settingsEquicordSection(sections);
    if (equicord) {
      return {
        kind: "merged",
        brand: equicord.brand,
        nav: sidebar,
        list: equicord.list,
        model: { section: equicord.section, list: equicord.list, row: equicord.row },
      };
    }
    const model = settingsSectionModel(sections);
    if (model) return { kind: "sections", brand: SETTINGS_GROUP_LABEL, nav: sidebar, list: sections, model: model };
  }
  const rows = settingsRowList(sidebar);
  if (rows) return { kind: "flat", brand: SETTINGS_GROUP_LABEL, nav: sidebar, list: rows };
  return null;
}

/**
 * The rectangle of Discord's settings *content* column, or null.
 *
 * The manager must be that column, not a panel over the client. Class names here are
 * hashed, so this is shape and not names: inside the same layer as the sidebar, to
 * its right, and large enough to be a pane. A page that does not match yields null,
 * which means the manager is not opened at all - never drawn over somebody's chat.
 */
function settingsContentRegion(host) {
  if (!host || typeof window === "undefined") return null;
  const box = host.getBoundingClientRect();
  if (box.width < 120 || box.height < 60) return null;
  // The panel to search is the smallest ancestor that is *wider than the list itself*:
  // the content column is a sibling of the settings list, so searching inside the list
  // finds nothing at all - which is what happened the moment the list became the host.
  let panel = host.parentElement;
  while (panel && panel.parentElement && panel.getBoundingClientRect().width <= box.width + 40) panel = panel.parentElement;
  if (!panel) return null;
  const viewport = Number(window.innerHeight) || 0;
  let best = null;
  for (const node of panel.querySelectorAll("div, main, section")) {
    if (node === host || node.contains(host)) continue;
    if (node.closest && node.closest("#hypercord-panes")) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 320) continue;
    // what can be seen, not what the element measures: Discord's settings content is a
    // scroll container taller than the window, and a page pinned to its full height
    // would run off the bottom of the screen
    const top = Math.max(rect.top, 0);
    const bottom = viewport ? Math.min(rect.bottom, viewport) : rect.bottom;
    const height = bottom - top;
    if (height < 240) continue;
    if (rect.left < box.right - 8) continue;
    if (rect.right > window.innerWidth + 2) continue;
    const area = rect.width * height;
    if (best && area <= best.area) continue;
    // the element travels with the rectangle: what stands beside the list is also where a
    // page of ours has to be stacked, and that is a question about the tree, not the box
    best = { area: area, top: top, left: rect.left, width: rect.width, height: height, node: node };
  }
  return best;
}

/**
 * Where a page of ours could live in Discord's settings, best first - each one inside the layer
 * this settings screen is drawn in, so that anything the client opens over the page - a filter
 * dropdown, and the modal a plugin's settings open in - is drawn over it rather than behind it.
 *
 * This is the fix for one of the few bugs where the geometry was exactly right and the page was
 * still unusable. The sheet used to be appended to the document element with a z-index above
 * everything, so it painted over Discord's *whole layer stack*: a plugin's settings modal was
 * drawn underneath it, so clicking a plugin's cog looked like a click that did nothing, after
 * which Escape closed the modal nobody could see was there.
 *
 * There are two candidates rather than one because the first is a class name and the second is a
 * shape, and because neither is necessarily usable: a layer can sit under a transform, which
 * turns a `fixed` page into one measured against that ancestor instead of the window. That is
 * why the choice between them is made by measuring, in `homePanes`, rather than by preference.
 */
function panesLayerCandidates(host, region) {
  const found = [];
  const add = (node) => {
    if (node && node !== document.body && node !== document.documentElement && !found.includes(node)) found.push(node);
  };
  // the layer Discord marks as one, which is what it stacks its own popouts and modals against
  if (host && typeof host.closest === "function") add(host.closest('[class*="layer_"], [class*="layer-"]'));
  // and, for a release whose class names this does not match, the lowest element that holds
  // both the section list and the column beside it: whatever that is, it is inside the layer,
  // because holding the two of them is what a layer does, and it is never above it
  const content = region && region.node ? region.node : null;
  if (host && content && content.parentElement) {
    let node = content.parentElement;
    while (node && node !== document.body && !node.contains(host)) node = node.parentElement;
    if (node && node !== document.body && node.contains(host)) add(node);
  }
  return found;
}

/**
 * Is this element's own coordinate system the window's? A transform, a filter or a `contain`
 * on the way up makes a `fixed` element position itself against that ancestor instead, and a
 * page placed in viewport pixels under one of those lands somewhere else entirely - which is
 * worse than a page drawn over the client, because it is a page drawn over the wrong part of
 * it. Asked with a probe rather than read off the styles, because the answer is about the
 * result, and because this is the one question in this file that has to be asked while the
 * sheet itself is hidden.
 */
function layerMeasuresViewport(layer) {
  let probe = null;
  try {
    probe = document.createElement("div");
    probe.setAttribute("data-hypercord", "probe");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden;";
    layer.appendChild(probe);
    const box = probe.getBoundingClientRect();
    return Math.abs(box.left) < 1.5 && Math.abs(box.top) < 1.5;
  } catch {
    return false;
  } finally {
    if (probe && probe.parentElement) probe.remove();
  }
}

/**
 * Move the sheet into the layer, so it stacks the way a page of Discord's own does, and say
 * whether it ended up there - with the reason when it did not, because the two reasons are
 * different shapes of client and the log is where that difference has to survive.
 */
function zIndexOf(node) {
  let value = "auto";
  try {
    value = getComputedStyle(node).zIndex;
  } catch {
    return 0;
  }
  const number = value === "auto" || value === "" ? 0 : Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * What is drawn over the page, if anything is.
 *
 * This exists because of a failure with no error in it: a page that is *there* and *dead*. Its
 * rectangle is right, its markup is right, and every click lands on something else - because a
 * sibling inside the same layer is painted in front of it, which is how a themed settings column
 * and a page of ours can both be visible while only one of them is reached. Nothing in the DOM
 * says so; the only way to ask is to ask where a point lands.
 */
/**
 * What makes the page unclickable, named exactly - and repaired when the repair is safe.
 *
 * The failure this exists for has no error in it and no wrong pixel either: the page is drawn,
 * in the right place, in the right layer, and every click goes somewhere else. The cause is
 * hit-testing rather than paint order: `pointer-events` (and `inert`) are inherited, so a page
 * mounted into a wrapper that is not meant to be clicked - a layer's backdrop host, an overlay
 * container - is a page that cannot be reached, however positioned it is. `elementFromPoint`
 * skips such an element whole, which is why the first version of this check blamed whatever was
 * behind the page instead (measured: "DIV.stack_... position static, z-index auto sits in front
 * of it", which is not a thing a static element can do to a positioned one).
 *
 * The repair for the inherited case is one property on the page itself: `pointer-events: auto`
 * re-enables hit-testing for a subtree under a `none`, which is exactly this page's situation and
 * nothing else's. `inert` is different - it is an explicit refusal, and un-inerting somebody
 * else's subtree is not ours to do - so that one is reported with the node that carries it.
 */
function panesReachability(panes) {
  const blocked = [];
  // the page itself is walked first, not its parent: a stylesheet of a theme - or a release
  // that puts `pointer-events: none` on a layer of its own and lets the layer's children opt
  // back in - can leave the refusal on the sheet's own element, and a walk that starts one
  // step up would report nothing while every click went elsewhere.
  let node = panes;
  while (node && node !== document.documentElement) {
    let style = null;
    try {
      style = getComputedStyle(node);
    } catch {
      style = null;
    }
    if (node.inert === true || (style && style.pointerEvents === "none")) {
      blocked.push(node);
      if (node.inert !== true) {
        // the inherited case, and the one repair that is ours to make
        panes.style.pointerEvents = "auto";
      }
    }
    node = node.parentElement;
  }
  if (!blocked.length) return "";
  const worst = blocked[0];
  const kind = worst.inert === true ? "inert" : "pointer-events: none";
  const who = worst === panes ? "the page itself" : "an ancestor of the page, " + describeNode(worst);
  return (
    who +
    ", is " +
    kind +
    (worst.inert === true
      ? " (only the client can lift that)"
      : ", which this client re-enabled on the page itself so clicks and scrolling reach it")
  );
}

/** One node, in the words the log uses for it: the same shape in every line of this file. */
function describeNode(node) {
  if (!node) return "nothing";
  let style = null;
  try {
    style = getComputedStyle(node);
  } catch {
    style = null;
  }
  return (
    String(node.tagName || "node") +
    (node.className ? "." + String(node.className).split(" ")[0] : "") +
    (style
      ? " (position " + String(style.position) + ", z-index " + String(style.zIndex) + ", pointer-events " + String(style.pointerEvents) + ")"
      : " (no styles readable)")
  );
}

/**
 * Where a point inside the page actually lands - and the question is asked of the document,
 * not of the page, because the page cannot know.
 *
 * This is the check the whole placement exists to pass, and the reason it is asked after the
 * repair rather than instead of it: everything above this point is an argument about *why* a
 * page might not be reached (paint order, hit-testing, a layer under a transform). This is
 * the outcome. It is also the only check that survives a client whose DOM this repository has
 * never seen: a page can be in the right column, at the right size, in the right layer, and
 * still be the element that answers for nothing.
 */
function panesHitTest(panes) {
  let box = null;
  try {
    box = panes.getBoundingClientRect();
  } catch (err) {
    return null;
  }
  if (!box || box.width < 60 || box.height < 60) return null;
  const x = Math.round(box.left + Math.min(box.width - 12, 240));
  const y = Math.round(box.top + 24);
  let hit = null;
  try {
    hit = document.elementFromPoint(x, y);
  } catch (err) {
    return null;
  }
  return { x: x, y: y, hit: hit, reached: Boolean(hit && (hit === panes || panes.contains(hit))) };
}

/** The chain from the page up to the document, so a report can name every layer it sits in. */
function panesChain(panes) {
  const names = [];
  let node = panes.parentElement;
  while (node && node !== document.documentElement && names.length < 5) {
    names.push(describeNode(node));
    node = node.parentElement;
  }
  return names.length ? names.join(" in ") : "the document element directly";
}

/** Which section is on screen, by the name the shell gave it - for the report's own words. */
function panesView(panes) {
  let shown = null;
  try {
    shown = panes.querySelector("section.view:not(.hidden)");
  } catch (err) {
    shown = null;
  }
  return (shown && shown.getAttribute("data-view")) || panes.getAttribute("data-view") || "page";
}

/**
 * Say what the placement came to, once per shape it can come to.
 *
 * The report is deliberately as loud about success as about failure. A page that is placed
 * and reached used to say nothing at all, which left "no page was opened" and "the page works"
 * as the same line of the log - and that is exactly how a fix that worked reads as a bug that
 * is still there. One line per (view, layer, outcome) shape, so a mutation batch that changes
 * nothing stays quiet, and the answer to "is it fixed" is in the log rather than in a guess.
 */
function reportPanesPlacement(panes, layer, relative, highest) {
  const view = panesView(panes);
  const layerName = describeNode(layer);
  const unreachable = panesReachability(panes);
  if (unreachable) {
    reportOnce(
      "reachability-" + unreachable.slice(0, 60),
      "a Hypercord page is drawn but not reached: " + unreachable + ". Anywhere a click still lands on the client instead of the page is this, not the page being behind something",
    );
  }
  if (!relative) {
    const cover = coverOverPanes(panes, layer);
    if (cover) {
      // the value is computed from what the *layer* has, never from what the page has now:
      // a z-index written from the page's own current value grows by one on every batch, and
      // every write is another mutation - which is a client that never draws anything again
      panes.style.zIndex = String(Math.max(zIndexOf(cover), Number(highest) || 0) + 1);
      const still = coverOverPanes(panes, layer);
      if (still) {
        reportOnce(
          "covered-" + String(still.className || still.tagName || "node").slice(0, 60),
          "a Hypercord page is drawn but not reached: " +
            describeNode(still) +
            " is the element that answers for a point inside it, so clicks land on the client instead of on the page",
        );
      }
    }
  }
  // a page nobody has opened has no rectangle and is not supposed to: the point test is about
  // the page somebody is looking at, so it is asked only while the page is shown. Reporting
  // "drawn nowhere" about a closed sheet would be true and useless, on every batch.
  if (panes.getAttribute("data-open") !== "true") return;
  const hit = panesHitTest(panes);
  const where = "the " + view + " page is in " + layerName + (relative ? " (which moves a fixed page)" : "") + " at z-index " + String(zIndexOf(panes));
  if (!hit) {
    // no rectangle worth asking about: the page is not drawn, and saying so is the honest
    // answer - a page with no size is one nobody can click either
    reportOnce(
      "placed-nowhere-" + view + "-" + layerName.slice(0, 40),
      "panes: " + where + ", but it has no drawn rectangle to ask about, so nothing of it is reached",
    );
    return;
  }
  if (hit.reached) {
    reportOnce(
      "reached-" + view + "-" + layerName.slice(0, 40),
      "panes: " + where + ", and a point inside it (" + hit.x + "," + hit.y + ") lands on the page itself - clicks and typing reach it",
    );
    return;
  }
  reportOnce(
    "missed-" + view + "-" + layerName.slice(0, 40),
    "panes: " + where + ", but a point inside it (" +
      hit.x +
      "," +
      hit.y +
      ") lands on " +
      describeNode(hit.hit) +
      " instead - the page is drawn and not reached, and it sits in " +
      panesChain(panes),
  );
}

function coverOverPanes(panes, layer) {
  let box = null;
  try {
    box = panes.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!box || box.width < 60 || box.height < 60) return null;
  const x = Math.round(box.left + Math.min(box.width - 12, 240));
  const y = Math.round(box.top + 24);
  let hit = null;
  try {
    hit = document.elementFromPoint(x, y);
  } catch {
    return null;
  }
  if (!hit || hit === panes || panes.contains(hit) || (hit.contains && hit.contains(panes))) return null;
  // another layer is where the client keeps its popouts and modals: a page above *those* is the
  // bug this whole placement exists to avoid, so only a sibling in this same layer counts
  if (!layer || !layer.contains(hit)) return null;
  return hit;
}

/**
 * Move the sheet into the layer, so it stacks the way a page of Discord's own does, and say
 * where it ended up - with the reason when it did not, because the two reasons are
 * different shapes of client and the log is where that difference has to survive.
 *
 * The height of the page inside the layer is measured, not guessed. Discord's own settings
 * content is a positioned child of this same layer, so a page with a lower z-index than that
 * child is drawn behind it: on screen it looks like our page and nothing inside it answers.
 * A fixed number was the first version of this and it was wrong the moment a theme or a
 * release gave the column a value of its own; what is right is one more than the highest the
 * layer actually has, which keeps the page below the client's other layers (modals, popouts)
 * and above the screen it stands in.
 */
function homePanes(panes, host, region) {
  const nowhere = { layer: null, relative: false, why: "" };
  if (!panes) return { layer: null, relative: false, why: "there is no page to place" };
  const candidates = panesLayerCandidates(host, region);
  if (!candidates.length) {
    return { layer: null, relative: false, why: "the layer this settings screen is drawn in could not be found from it" };
  }
  let refused = "";
  let moved = null; // a layer that moves a fixed page: usable, but in its own coordinates
  for (const layer of candidates) {
    if (panes.parentElement !== layer && !layerMeasuresViewport(layer)) {
      moved = layer;
      continue;
    }
    if (panes.parentElement !== layer) {
      try {
        layer.appendChild(panes);
      } catch (err) {
        refused = "the page could not be moved into that layer: " + String((err && err.message) || err).slice(0, 80);
        continue;
      }
    }
    // above everything this layer already has, and then above whatever is measured in front of
    // the page in case that one is positioned out of the flow (a fixed header, an overlay the
    // theme added) rather than being one of the layer's own children
    const siblings = [...layer.children].filter((node) => node !== panes && !node.hasAttribute("data-hypercord"));
    const highest = siblings.reduce((top, node) => Math.max(top, zIndexOf(node)), 0);
    panes.style.zIndex = String(highest + 1);
    // hit-testing first: it is inherited, it is repaired here, and it is the cause a paint-order
    // report would get wrong - and then the point that decides it, asked of the document
    reportPanesPlacement(panes, layer, false, highest);
    return { layer: layer, relative: false, why: "" };
  }
  // A layer under a transform moves a fixed page: the page is placed inside it anyway, in that
  // layer's own coordinates (placePanes subtracts its box), because the alternative is a page
  // at document level - above the client's modals, so a plugin's own settings open behind it and
  // cannot be closed. Not being stacked inside the layer was the worse of the two failures.
  if (moved) {
    try {
      moved.appendChild(panes);
      const siblings = [...moved.children].filter((node) => node !== panes && !node.hasAttribute("data-hypercord"));
      panes.style.zIndex = String(siblings.reduce((top, node) => Math.max(top, zIndexOf(node)), 0) + 1);
      reportPanesPlacement(
        panes,
        moved,
        true,
        siblings.reduce((top, node) => Math.max(top, zIndexOf(node)), 0),
      );
      return { layer: moved, relative: true, why: "" };
    } catch (err) {
      refused = "the page could not be moved into that layer: " + String((err && err.message) || err).slice(0, 80);
    }
  }
  return { layer: nowhere.layer, relative: false, why: refused || "the page is not in any layer this settings screen is drawn in" };
}

/**
 * The placement the sheet has already been given, so the question this file asks on every
 * mutation batch - "is the page still where it was put?" - is a comparison.
 *
 * The second half of that is not an optimisation. A placement that could not be made has to be
 * remembered as one: a page that could not be homed would otherwise be measured again, and its
 * probe written into the tree again, on every mutation - and a write is another mutation, so
 * the client never got to draw anything else. What that looked like was Discord's settings
 * hanging on its loading spinner, with the log filling up as fast as it could be written.
 */
let panesHome = null;
let panesPlacedFor = null;

/**
 * Put the sheet exactly where Discord's own settings content is, and say whether it landed.
 * The rectangle goes into CSS variables the stylesheet reads, so the layout itself is still
 * the stylesheet's business and a resize only rewrites four numbers - and the page is stacked
 * where Discord stacks its own pages, or the client's own popouts and modals end up behind it.
 */
function placePanes(host) {
  const panes = document.getElementById("hypercord-panes");
  if (!panes) return false;
  const region = settingsContentRegion(host);
  if (!region) return false;
  try {
    panes.style.setProperty("--hc-panes-top", Math.round(region.top) + "px");
    panes.style.setProperty("--hc-panes-left", Math.round(region.left) + "px");
    panes.style.setProperty("--hc-panes-width", Math.round(region.width) + "px");
    panes.style.setProperty("--hc-panes-height", Math.round(region.height) + "px");
  } catch {
    return false;
  }
  const homed = homePanes(panes, host, region);
  if (homed.relative && homed.layer) {
    // The layer moves a fixed page, so the numbers have to be in that layer's own coordinates:
    // `fixed` under a transform is measured against the ancestor, not the window. Subtracting
    // the layer's own box from the region is what keeps the page where Discord's content is -
    // without it, a page placed in viewport pixels under a transformed ancestor lands somewhere
    // else entirely.
    let box = null;
    try {
      box = homed.layer.getBoundingClientRect();
    } catch {
      box = null;
    }
    if (box) {
      try {
        panes.style.setProperty("--hc-panes-top", Math.round(region.top - box.top) + "px");
        panes.style.setProperty("--hc-panes-left", Math.round(region.left - box.left) + "px");
      } catch {
        /* the numbers stay as measured: a page in the right column is better than none */
      }
    }
  }
  if (homed.why) {
    reportOnce(
      "not-homed-" + homed.why,
      "a Hypercord page was placed in Discord's settings but not stacked inside its layer (" +
        homed.why +
        "), so anything the client opens over it - a dropdown, a plugin's settings - may be drawn behind it",
    );
  }
  // remembered, whether it was homed or not: this runs on every mutation batch, and the
  // answer only changes when the page is mounted again or a different screen is shown
  panesHome = panes.parentElement;
  panesPlacedFor = host;
  panes.setAttribute("data-seamless", "true");
  return true;
}

/**
 * Put the sheet back where it belongs, without touching it when it is already there.
 *
 * This is called on every mutation batch, so the whole decision is one `closest` and one
 * comparison until something has actually changed - and then, and only then, the column is
 * measured again and the page is homed into the layer it was lost with. That is the shape of
 * the case it exists for: Discord tears the settings layer down when settings closes, taking
 * our page with it, and the page is mounted again by `followSettings`.
 */
function keepSheetHomed(host) {
  const panes = document.getElementById("hypercord-panes");
  if (!panes) return false;
  if (panesPlacedFor === host && panes.parentElement === panesHome) return false;
  return placePanes(host);
}

/**
 * Does the sheet close when Discord's own settings are used? Three things have to:
 * choosing one of Discord's own sections (so nothing of ours is left over another
 * page), the open entry handing its selected box back, and the settings layer
 * closing altogether. All are wired here, once per host, and all only set an
 * attribute - the shell keeps owning the open state.
 */
function watchSettingsLeaving(host) {
  if (!host || host.getAttribute("data-hypercord-watched") === "true") return;
  host.setAttribute("data-hypercord-watched", "true");
  const closeOurs = () => {
    const panes = document.getElementById("hypercord-panes");
    if (panes && panes.getAttribute("data-seamless") === "true") panes.setAttribute("data-open", "false");
  };
  host.addEventListener(
    "click",
    (event) => {
      // a click on anything of ours keeps the sheet open: every entry is ours now, and
      // matching them by one id would close the sheet the click had just opened
      const ours = event.target && event.target.closest ? event.target.closest("[data-hypercord]") : null;
      if (ours) return;
      closeOurs();
      // Discord's React marks its own row in its own time; ours is cleared here, where
      // the click lands, so the open box is never left on a page that just closed.
      if (SETTINGS_OPEN_VIEW) markSettingsEntrySelected(host, "");
    },
    true,
  );
  window.addEventListener("resize", () => {
    const panes = document.getElementById("hypercord-panes");
    if (panes && panes.getAttribute("data-open") === "true" && panes.getAttribute("data-seamless") === "true") placePanes(host);
  });
}

/* ---- Hypercord's own sections in Discord's settings --------------------- */

/**
 * The sections this client adds to Discord's settings sidebar, one entry each.
 *
 * The view names and the labels are the sheet's own (`src/panes.html` and the list
 * `plugins/hyper/hyperPanes/index.js` announces): an entry that opens a section the
 * sheet does not have would be a tab that lies, which is why the pane's announcement
 * replaces this table the moment it arrives. The table is the fallback for a client
 * whose plugin host has not answered yet, so it has to agree with the sheet; the
 * plugin is what makes it true, which is why the two are read together.
 */
/**
 * The mark every row of ours wears, drawn in Discord's own icon slot.
 *
 * The first cut of these rows hid the icon of the row they were copied from instead of
 * borrowing a glyph, and that was right about one thing and wrong about another: their icon is
 * their section's and must not be worn by ours, but a row with an *empty* slot beside rows with
 * marks in them reads as a row that failed to draw - which is what it looked like. So each row
 * gets a mark of its own, in the slot Discord already sizes, aligns and colours.
 *
 * Line art rather than a logo, on purpose: it is drawn with `stroke="currentColor"` at
 * Discord's own 24-unit box, so the theme paints it and the row's hover and selected states
 * apply to it exactly as they do to the marks beside it. Glyphs, not brand: "Hyper" is a
 * package, beef is a spark, the access keys are a key, and none of them is a picture of
 * somebody else's product.
 */
const SETTINGS_ICON_ART = {
  commands: '<path d="M5 7l5 5-5 5"/><path d="M13 17h6"/>',
  plugins: '<path d="M9 3v4M15 3v4"/><rect x="6" y="7" width="12" height="8" rx="2"/><path d="M12 15v6"/>',
  hyper: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/>',
  beef: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8"/>',
  themes: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9.5" r="1.2"/><circle cx="15" cy="9.5" r="1.2"/><circle cx="12" cy="15" r="1.2"/>',
  logs: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  accounts: '<circle cx="12" cy="9" r="3.2"/><path d="M5.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5"/>',
  tokens: '<circle cx="9" cy="12" r="3.5"/><path d="M12.5 12H21M18 12v3M15.5 12v2.5"/>',
};

/** The markup of one row's mark, in Discord's own 24-unit box. */
function settingsIconMarkup(view) {
  const art = SETTINGS_ICON_ART[String(view)];
  if (!art) return "";
  return '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + art + "</g>";
}

const SETTINGS_SECTIONS = [
  { view: "commands", label: "Commands" },
  { view: "plugins", label: "Plugins" },
  { view: "hyper", label: "Hyper plugins" },
  { view: "beef", label: "Beef" },
  { view: "themes", label: "Themes" },
  { view: "logs", label: "Logs" },
  { view: "accounts", label: "Accounts" },
  { view: "tokens", label: "Access keys" },
];

/**
 * What the pane said it has, in its order. Empty until the announcement arrives, and
 * only then is the table above what an entry is built from: a section the sheet does
 * not have would be an entry that opens somebody else's page under the wrong name, so
 * the sheet - through the plugin that owns the list - is what decides which sections
 * exist. Until it answers, the table is used, and every view in it is one the sheet
 * has (`src/panes.html`).
 */
let SETTINGS_PANE_VIEWS = [];

function settingsViews() {
  if (SETTINGS_PANE_VIEWS.length) return SETTINGS_PANE_VIEWS.slice();
  return SETTINGS_SECTIONS.map((section) => section.view);
}

/**
 * The pages that are not offered as an entry once they have been merged into the runtime's own
 * section, because that section already offers the same page.
 *
 * One plugin tab, and it is the runtime's: its own browser of its own plugins is a row of that
 * section a few rows above ours, so an entry of ours beside it would be a second way to the same
 * page - which is the shape this whole merge exists to remove. The page itself stays: the shell
 * still opens it by name, and it is still the page that carries what the runtime's row does not
 * (the catalogue with its switches, in our own row layout).
 *
 * Themes are deliberately *not* in this list, and that is a correction rather than an oversight.
 * The runtime's themes tab is local themes plus a field to paste an online theme's URL - it has
 * no browser in it - while the page of ours beside it carries the theme library: the index that
 * is searched, filtered and installed from, plus the folder and the quick CSS. Omitting ours
 * left the client with no way to browse a theme at all, which is what "where is the theme
 * browser" was about. Two rows that open two different pages are not the duplication this merge
 * exists to remove; two rows that open the same page are.
 */
const SETTINGS_MERGED_OMITS = ["plugins"];

/**
 * Adopt the pane's own section list: announced when the plugin starts and whenever it
 * is asked what it has, so a section that is removed takes its entry with it.
 */
function adoptSettingsViews(payload) {
  const list = Array.isArray(payload) ? payload.map((one) => String(one)).filter(Boolean) : [];
  if (!list.length) return;
  if (list.length === SETTINGS_PANE_VIEWS.length && list.every((one, index) => one === SETTINGS_PANE_VIEWS[index])) return;
  SETTINGS_PANE_VIEWS = list;
  ensureSettingsEntry();
}

/** The label an entry wears: the sheet's own name for the section, never a key. */
function settingsLabel(view) {
  const known = SETTINGS_SECTIONS.find((section) => section.view === view);
  if (known) return known.label;
  const text = String(view || "");
  return text ? text[0].toUpperCase() + text.slice(1) : "Settings";
}

/** The name our group wears, in Discord's own heading where there is one to copy. */
const SETTINGS_GROUP_LABEL = "Hypercord";

/**
 * A decorative heading above our entries, for a sidebar that holds its rows itself,
 * so they read as Hypercord's own part of settings rather than as unrelated sections.
 * It carries no role and no tab behaviour: Discord's own entries keep their own count
 * and none of their nodes is touched.
 */
function settingsGroupLabel() {
  const group = document.createElement("div");
  group.id = "hypercord-settings-group";
  group.setAttribute("data-hypercord", "settings-group");
  group.setAttribute("aria-hidden", "true");
  group.textContent = SETTINGS_GROUP_LABEL;
  return group;
}

/** The rule above our group, for the shape where there is no section to separate us. */
function settingsSeparator() {
  const rule = document.createElement("div");
  rule.id = "hypercord-settings-separator";
  rule.setAttribute("data-hypercord", "settings-separator");
  rule.setAttribute("aria-hidden", "true");
  return rule;
}

/**
 * The element inside a copied row that shows its name. Discord's own rows mark it with
 * `data-text-variant`, and a release that stops doing so still has the name as the
 * deepest text inside the row's content - both are tried, because the alternative is a
 * row that keeps the name of the row it was copied from.
 */
function settingsLabelNode(row) {
  const marked = row.querySelector('[data-text-variant^="text"]');
  if (marked) return marked;
  const content = row.querySelector('[class*="itemContent"], [class*="content"]') || row;
  const candidates = [...content.querySelectorAll("*")].filter((node) => String(node.textContent || "").trim());
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * A click opens the section the entry names, wherever it is opened from.
 *
 * The sheet is measured against Discord's own content column *before* anything is
 * shown: when that column cannot be found the section is not opened at all, and the
 * reason is recorded, because a panel dropped over somebody's chat is the one outcome
 * worth refusing.
 */
function wireEntry(host, view, open) {
  const show = () => {
    if (!placePanes(host)) {
      noteSettingsEntry("no-region", host);
      // The quiet failure, named: the click landed, and there is no column to put a page in -
      // and this is the one path where the reason cannot be shown in the sheet itself, because
      // the sheet is the thing that could not be placed. So it is said to the shell instead,
      // where it reaches the log both clients keep.
      report("a Hypercord section was clicked and Discord's settings content column was not found, so nothing was opened (this client will not draw a panel over the client)");
      return;
    }
    if (typeof open === "function") open();
    // Discord's own rows get their selected box from React, which does not know ours:
    // the open entry is marked here, where the click lands, or no entry of ours ever
    // reads as the open one.
    markSettingsEntrySelected(host, view);
    call("panes:open", view).catch(() => {});
  };
  watchSettingsLeaving(host);
  return show;
}

/**
 * The open entry's selected box, worn by hand.
 *
 * Discord's selected row wears generated classes React applies, and React never
 * touches our rows - they are DOM we inserted, not components it rendered. So the
 * preload does it: it learns what "selected" looks like from a natively selected
 * row (the extra classes over an unselected sibling, and the `aria-current` value),
 * copies them onto the open entry, and clears every other row first, native or
 * ours, so exactly one row reads as open. The learning is the point: the class
 * names are generated per release and must never be assumed. Each entry also wears
 * `data-hypercord-open` while it is the open one - the shape-independent hook the
 * stylesheet's fallback rule and the suite both read.
 */
let SETTINGS_SELECTED_CLASSES = [];
let SETTINGS_SELECTED_ARIA = "page";
let SETTINGS_OPEN_VIEW = "";

/** A natively selected row in this sidebar, if one wears its selection now. */
function settingsSelectedNative(scope) {
  if (!scope || !scope.querySelectorAll) return null;
  // our own marked row is skipped, not learned from: it wears exactly what the last
  // lesson taught, so learning from it would be copying our own homework
  const marked = [...scope.querySelectorAll('[aria-current="page"], [aria-current="true"]')].find(
    (node) => !(node.closest && node.closest("[data-hypercord]"))
  );
  if (marked) return marked;
  const items = [...scope.querySelectorAll("[class]")];
  return (
    items.find(
      (node) =>
        !(node.closest && node.closest("[data-hypercord]")) &&
        [...node.classList].some((name) => /active|selected/i.test(name) && !/inactive/i.test(name)),
    ) || null
  );
}

/** Learn the selected look from a native row; a miss keeps the last lesson. */
function learnSettingsSelection(scope) {
  const selected = settingsSelectedNative(scope);
  if (!selected) return false;
  const plain = [...scope.querySelectorAll("[class]")].find(
    (node) =>
      node !== selected &&
      node.tagName === selected.tagName &&
      !(node.closest && node.closest("[data-hypercord]")) &&
      ![...node.classList].some((name) => /active|selected/i.test(name)),
  );
  let extra = [];
  if (plain) {
    const base = new Set([...plain.classList]);
    extra = [...selected.classList].filter((name) => !base.has(name));
  } else {
    extra = [...selected.classList].filter((name) => /active|selected/i.test(name) && !/inactive/i.test(name));
  }
  if (!extra.length) return false;
  SETTINGS_SELECTED_CLASSES = extra;
  const aria = selected.getAttribute && selected.getAttribute("aria-current");
  if (aria) SETTINGS_SELECTED_ARIA = aria;
  return true;
}

/**
 * Exactly one selected row in this sidebar: ours for `view`, or none at all.
 *
 * The clearing is what makes this a selection and not a coat of paint: native
 * rows keep a stale box otherwise, because nothing about opening our page tells
 * React its section is no longer the open one.
 */
function markSettingsEntrySelected(scope, view) {
  SETTINGS_OPEN_VIEW = String(view || "");
  if (!scope || !scope.querySelectorAll) return;
  learnSettingsSelection(scope);
  for (const node of scope.querySelectorAll("[class]")) {
    for (const name of SETTINGS_SELECTED_CLASSES) node.classList.remove(name);
  }
  for (const node of scope.querySelectorAll("[aria-current]")) node.removeAttribute("aria-current");
  for (const node of scope.querySelectorAll("[data-hypercord-open]")) node.removeAttribute("data-hypercord-open");
  if (!SETTINGS_OPEN_VIEW) return;
  const rows = [...scope.querySelectorAll('[data-hypercord="settings"]')];
  const row = rows.find((node) => node.getAttribute("data-hypercord-view") === SETTINGS_OPEN_VIEW) || null;
  if (!row) return;
  // the clickable face: the inner item on the copied-row shape, the entry itself
  // on the plain-button shape
  const target = (row.querySelector && (row.querySelector("[role]") || row)) || row;
  for (const name of SETTINGS_SELECTED_CLASSES) target.classList.add(name);
  if (target.setAttribute) target.setAttribute("aria-current", SETTINGS_SELECTED_ARIA || "page");
  row.setAttribute("data-hypercord-open", "true");
}

/**
 * One entry in the section shape: a copy of one of Discord's own rows.
 *
 * The copy is the point, and it is the fix for a bug worth naming. An element of our
 * own carrying a borrowed class was not enough: the row Discord draws is a li holding a
 * div whose own child is the content, and a node without that shape sits off the
 * client's grid - a different type size, a different row height, no hover, no focus
 * ring. Cloning their row keeps all of it, and survives a theme, because the theme is
 * written against the same classes.
 *
 * The icon is the one part that must not be copied: it belongs to the row it came from, so
 * every entry would wear the same wrong glyph. It stays in place as the slot - so the label
 * is where Discord puts it instead of the whole row shifting left - and the glyph inside it is
 * replaced with this page's own mark (SETTINGS_ICON_ART), because an empty slot beside rows
 * that have marks reads as a row that failed to draw.
 */
function settingsNativeEntry(place, view, first) {
  const row = place.model.row.cloneNode(true);
  row.setAttribute("data-hypercord", "settings");
  row.setAttribute("data-hypercord-view", view);
  row.removeAttribute("data-settings-sidebar-item");
  if (first) row.id = "hypercord-settings-entry";
  const item = row.querySelector("[role], [class*='item'], [class*='Item']") || row.firstElementChild;
  if (item) {
    // their row knows which section is open; ours never is
    item.removeAttribute("aria-current");
    for (const name of [...item.classList]) if (/active/i.test(name)) item.classList.remove(name);
    item.setAttribute("role", "link");
    item.setAttribute("tabindex", "0");
    if (item.hasAttribute("data-list-item-id")) item.setAttribute("data-list-item-id", "settings-sidebar__hypercord-" + view);
    // the name these pages wear: the section they were added to in a merged client, and this
    // client's own name where there was no such section to merge into
    item.setAttribute("aria-label", (place.brand || SETTINGS_GROUP_LABEL) + " " + settingsLabel(view) + " settings");
  }
  const label = settingsLabelNode(row);
  if (label) label.textContent = settingsLabel(view);
  const icon = row.querySelector("svg");
  if (icon) {
    const markup = settingsIconMarkup(view);
    if (markup) {
      icon.innerHTML = markup;
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("aria-hidden", "true");
    } else {
      // a page with no mark of its own keeps the slot empty rather than wearing another
      // section's glyph
      icon.style.visibility = "hidden";
    }
  }
  // the nested list a section can carry is Discord's sub-navigation for whichever
  // section is open - it does not belong to a section that only opens a page of ours
  const subnav = row.querySelector('[class*="subnavContainer"]');
  if (subnav) subnav.remove();
  const show = wireEntry(place.nav, view);
  row.addEventListener("click", show);
  // a row Discord would drive by keyboard is one we have to drive: theirs listens on
  // the element with the role, ours on the row
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    show();
  });
  return row;
}

/**
 * Our own section in Discord's list: a copy of one of theirs, renamed.
 *
 * Copying a section keeps the heading's type, the space above it and the list's own
 * margins exactly as the sections around it, and it is put *first*: the way into
 * Hypercord's pages is then on screen the moment settings opens, rather than at the
 * bottom of a list somebody has to think of scrolling. A section whose heading Discord
 * only reads out is made visible, because the heading is how the group is named.
 */
function settingsNativeGroup(place, wanted) {
  const group = place.model.section.cloneNode(true);
  group.setAttribute("data-hypercord", "settings-group");
  group.removeAttribute("id");
  group.removeAttribute("aria-labelledby");
  const heading = group.querySelector("h1, h2, h3, h4");
  if (heading) {
    heading.id = "hypercord-settings-group-heading";
    heading.textContent = SETTINGS_GROUP_LABEL;
    group.setAttribute("aria-labelledby", heading.id);
    const wrapper = heading.parentElement;
    if (wrapper && wrapper !== group) {
      for (const name of [...wrapper.classList]) if (/hiddenVisually/i.test(name)) wrapper.classList.remove(name);
    }
  }
  // a section always holds a list of its own - settingsSectionLike says so - but a copy
  // that somehow has none is refused rather than inserted empty, because an inserted
  // group with no entries under it would be rebuilt on every change for ever
  const list = group.querySelector("ul, ol, [role='list']");
  if (!list) return null;
  list.textContent = "";
  wanted.forEach((view, index) => list.appendChild(settingsNativeEntry(place, view, index === 0)));
  return group;
}

/**
 * One entry, built to sit among Discord's own items rather than merely near them:
 * their element type, their role and their class attribute, so their stylesheet lays
 * it out and it reads as one more settings section.
 *
 * The model element is taken from one of DISCORD's children, never from one of ours:
 * copying our own first entry would hand every entry after it our id and our data
 * attributes, and a set of entries that share one view is exactly the bug this shape
 * avoids. Only the first keeps `hypercord-settings-entry`; the rest are found by
 * their `data-hypercord-view`.
 */
function settingsEntryFor(place, view, first) {
  const host = place.list;
  // The entry is built beside one of Discord's own rows and wears its class, so the
  // sibling has to be a row somebody can see: the first child of a settings sidebar is
  // one of Discord's screen-reader-only nodes, and copying its class made the entry
  // invisible (see settingsRowList above).
  const rendered = (node) => {
    if (!node || !isDiscordNode(node)) return false;
    if (/hiddenVisually/i.test(String(node.className || ""))) return false;
    const box = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    return !box || (box.width > 0 && box.height > 0);
  };
  const sibling =
    [...host.children].find((node) => rendered(node) && settingsRowLike(node)) ||
    // a sidebar whose rows are not shaped like rows still has a first visible child, and
    // one of Discord's rows is a better model than none at all
    (place.model ? place.model.row : null) ||
    [...host.children].find(rendered) ||
    null;
  const likeButton = !sibling || sibling.tagName === "BUTTON";
  const entry = document.createElement(likeButton ? "button" : "div");
  if (first) entry.id = "hypercord-settings-entry";
  entry.setAttribute("data-hypercord", "settings");
  entry.setAttribute("data-hypercord-view", view);
  entry.setAttribute("role", (sibling && sibling.getAttribute("role")) || "tab");
  if (likeButton) entry.type = "button";
  else entry.setAttribute("tabindex", "0"); // a div has to bring its own keyboard reach
  if (sibling && sibling.className) entry.className = sibling.className;
  entry.textContent = settingsLabel(view);
  entry.setAttribute("aria-label", (place.brand || SETTINGS_GROUP_LABEL) + " " + settingsLabel(view) + " settings");
  const show = wireEntry(place.nav, view);
  entry.addEventListener("click", show);
  // a div with a role is not clickable by keyboard on its own
  entry.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    show();
  });
  return entry;
}

/**
 * What the page can be asked about afterwards: "added" when the entry is in a
 * settings sidebar, "no-host" when nothing on the page looked like one. Kept on
 * the document (the page's own world can see attributes; it cannot see anything
 * the preload's world holds) and mirrored on the preload's window for our own
 * debugging.
 */
/**
 * Tell the shell something about these pages, so a failure has a reason a person can find.
 *
 * Everything this file decides about Discord's settings is otherwise recorded as an attribute
 * on the document, which is readable only with a debugger attached - and the failure it records
 * is the quietest one there is: the entries are in Discord's sidebar, they are clicked, and
 * nothing opens. So a decision that matters is said out loud as well (the shell puts it where a
 * GUI process's output can be read; see the `note` channel in src/host.js).
 */
function report(line) {
  try {
    call("note", String(line)).catch(() => {});
  } catch {
    /* no shell to tell: nothing about the page changes because of that */
  }
}

/** The reasons already said out loud, once each: this runs on every mutation batch. */
const reportedReasons = new Set();
const REPORTED_LIMIT = 32;
function reportOnce(key, line) {
  if (reportedReasons.has(key)) return;
  // a bound rather than none: the keys are a handful of shapes, and a client that keeps
  // producing new ones must not grow this list for as long as it runs
  if (reportedReasons.size >= REPORTED_LIMIT) reportedReasons.clear();
  reportedReasons.add(key);
  report(line);
}

function noteSettingsEntry(what, host, entries) {
  try {
    document.documentElement.setAttribute("data-hypercord-settings", what);
    if (host) document.documentElement.setAttribute("data-hypercord-settings-host", String(host.className || host.getAttribute("role") || host.tagName).slice(0, 80));
    if (typeof entries === "number") document.documentElement.setAttribute("data-hypercord-settings-entries", String(entries));
    window.__hypercordSettingsEntry = what;
  } catch {
    /* a document that refuses attributes is not a reason to stop */
  }
}

/**
 * One entry per section, reconciled rather than merely added.
 *
 * The set is rebuilt whenever it does not match the pane's sections, and only nodes
 * carrying our own attributes are ever removed - Discord's entries are not ours to
 * touch. That is what keeps "one entry per section" true through a React re-render
 * (which throws away nodes it does not know), a section list that changes, and a
 * sidebar rebuilt while settings is open; it is also why a second set cannot appear.
 */
/** Take our own nodes out of the page, and nothing else. */
function clearSettingsSet() {
  for (const node of [...document.querySelectorAll("[data-hypercord]")]) {
    const kind = node.getAttribute("data-hypercord");
    if (kind === "settings" || kind === "settings-separator" || kind === "settings-group") node.remove();
  }
}

/**
 * Add the set where this sidebar wants it: a copied section of Discord's when there is
 * one to copy, and our label above plain entries when the sidebar holds the rows itself.
 */
function addSettingsSet(place, wanted) {
  if (place.kind === "merged") {
    // No group and no heading of ours: these are rows *of* the runtime's own section, added
    // to its own list, and the section's own heading is what names them. They are copies of
    // one of its own rows, which is the same shape Discord's settings rows have - the li, the
    // div with the role, the content with the label - so the client's stylesheet lays them
    // out and hovers them exactly as the rows they were added beside.
    wanted.forEach((view, index) => place.list.appendChild(settingsNativeEntry(place, view, index === 0)));
  } else {
    const group = place.kind === "sections" ? settingsNativeGroup(place, wanted) : null;
    if (group) {
      // first, so the way in is on screen the moment settings opens
      place.list.insertBefore(group, place.list.firstElementChild);
    } else {
      place.list.appendChild(settingsSeparator());
      place.list.appendChild(settingsGroupLabel());
      wanted.forEach((view, index) => place.list.appendChild(settingsEntryFor(place, view, index === 0)));
    }
  }
  // what was actually added, not what was asked for: an entry that never landed must
  // not be reported as one somebody can open
  const added = document.querySelectorAll('[data-hypercord="settings"]').length;
  noteSettingsEntry(added === wanted.length ? "added" : "no-host", added === wanted.length ? place.nav : null, added);
  // a rebuild throws away the marked nodes with the rest: the open page has not
  // changed, so its entry is marked again on the new nodes
  if (added === wanted.length && SETTINGS_OPEN_VIEW) markSettingsEntrySelected(place.nav, SETTINGS_OPEN_VIEW);
  return added === wanted.length;
}

function ensureSettingsEntry() {
  if (OURS || !document.body) return false;
  const hosts = settingsHosts();
  if (!hosts.length) {
    clearSettingsSet();
    noteSettingsEntry("no-host", null, 0);
    return false;
  }
  const place = settingsPlace(hosts[0]);
  if (!place) {
    clearSettingsSet();
    noteSettingsEntry("no-host", null, 0);
    reportOnce("no-place", "Discord's settings sidebar was found but is not a shape this client can add an entry to, so no Hypercord section is offered there");
    return false;
  }
  const wanted = settingsViews().filter((view) => !(place.kind === "merged" && SETTINGS_MERGED_OMITS.includes(view)));
  const group = document.querySelector('[data-hypercord="settings-group"]');
  const current = [...document.querySelectorAll('[data-hypercord="settings"]')];
  // Settled means: our group is where this sidebar wants it, and the entries are the
  // pane's sections, in its order, in the place that shape keeps them - inside the group
  // when the group is a copied section, beside its label when the label is the group.
  // Anything else is rebuilt whole, so an entry can never be left pointing at a section
  // the sheet has since lost, and a set that is already right is touched not at all -
  // which is also what keeps this from rebuilding on the change it made itself.
  const settled =
    current.length === wanted.length &&
    current.every((node, index) => node.getAttribute("data-hypercord-view") === wanted[index]) &&
    (place.kind === "merged"
      ? // merged: the entries are rows of the runtime's own section, and there is no group.
        // The group is checked as well as the rows, and that is the whole of a bug worth
        // remembering: the runtime's own section is added to the sidebar by the runtime, which
        // starts *after* this preload does, so on the first pass there was nowhere to merge into
        // and a group of ours was built instead. Once a group exists, "the rows are where I put
        // them" was true of it for ever - so the client went on showing two places holding the
        // same pages (ours above, the runtime's below) and the merge could never happen. A group
        // that is now unnecessary is not settled: it is taken down and the rows move in.
        !group &&
        current.every((node) => node.parentElement === place.list)
      : Boolean(group) &&
        group.parentElement === place.list &&
        current.every((node) => (place.kind === "sections" ? group.contains(node) : node.parentElement === place.list)));
  if (settled) {
    noteSettingsEntry("added", place.nav, wanted.length);
    reportOnce(
      "added-" + place.kind + "-" + wanted.join(","),
      place.kind === "merged"
        ? "Hypercord's pages are in the runtime's own settings section (" + wanted.length + ": " + wanted.join(", ") + ")"
        : "Hypercord's sections are in Discord's settings (" + wanted.length + ": " + wanted.join(", ") + ")",
    );
    // a page mounted after the set was already in place - which is what a settings screen
    // opened a second time looks like, because the layer took the page with it - is measured
    // and homed here, so the next click has a page to show rather than one to build first
    keepSheetHomed(place.nav);
    return true;
  }
  // only our own nodes go first: a set that has to change is rebuilt whole
  clearSettingsSet();
  // the list is looked at again with our nodes gone, so a copy is taken of Discord's
  // section and never of the copy we made of it
  const fresh = settingsPlace(hosts[0]);
  if (fresh) return addSettingsSet(fresh, wanted);
  noteSettingsEntry("no-host", null, 0);
  return false;
}

/**
 * Settings open and close as a layer, and Discord rewrites its sidebar - React
 * throws away nodes it does not know about - so the entries are put back whenever
 * the document changes, through the same single observer the rest of this file
 * uses. It is one querySelectorAll per mutation batch, nothing on a timer, and
 * nothing written at all while the set already matches the pane's sections.
 */
function followSettings() {
  // The sheet lives inside Discord's settings layer now, and Discord takes that layer - and
  // everything in it - when settings closes. So the one thing that has to be put back is the
  // page itself: a client with no sheet and assets to mount one from gets its pages again
  // here, and the placement is repeated on the next settings screen (see keepSheetHomed).
  if (PANES_ASSETS && !document.getElementById("hypercord-panes")) mountPanes(PANES_ASSETS);
  const present = ensureSettingsEntry();
  // Settings closes as a layer and Discord takes its sidebar with it. A sheet left
  // open would be a panel over the client with nothing under it, so it closes with
  // the layer that hosted it.
  if (!document.getElementById("hypercord-settings-entry")) {
    // settings closed with the layer: reopening lands on one of Discord's own
    // sections, so no entry of ours may still read as open
    SETTINGS_OPEN_VIEW = "";
    const panes = document.getElementById("hypercord-panes");
    if (panes && panes.getAttribute("data-seamless") === "true") panes.setAttribute("data-open", "false");
  }
  return present;
}

/* ---- the user-token prompt ---------------------------------------------- */

function ensurePrompt() {
  if (!document.documentElement) return null;
  let prompt = document.getElementById("hypercord-token-prompt");
  if (!prompt) {
    // the shell hands the prompt's markup over with the rest of Hypercord's assets;
    // this is the host element it is written into
    prompt = document.createElement("div");
    prompt.id = "hypercord-token-prompt";
    prompt.setAttribute("data-hypercord", "token-prompt");
    prompt.setAttribute("data-open", "false");
    document.documentElement.appendChild(prompt);
  }
  return prompt;
}

/**
 * Put the prompt under Discord's email and password fields.
 *
 * It is placed by measurement rather than by living inside Discord's own tree:
 * Discord's login card is re-rendered by React, which throws away nodes it does
 * not know about, and a stray node in there can also upset the form's layout. So
 * the prompt stays a child of the document and is positioned against the form's
 * box, directly beneath it, at the same width - it reads as part of the card
 * without being part of Discord's tree. Discord's class names are generated and
 * change between releases, so a miss is not an error: the prompt then keeps the
 * position it was mounted at.
 */
function promptAnchor() {
  const selectors = ['form[class*="auth"]', '[class*="authBox"] form', '[class*="loginForm"] form', 'main form', 'form'];
  for (const selector of selectors) {
    const found = document.querySelector(selector);
    // an off-screen or collapsed form is not where somebody is looking
    if (found && found.getBoundingClientRect().width >= 80) return found;
  }
  return null;
}

function positionPrompt(prompt) {
  const anchor = promptAnchor();
  if (!prompt) return false;
  if (!anchor) {
    prompt.setAttribute("data-anchored", "false");
    return false;
  }
  const box = anchor.getBoundingClientRect();
  const place = { left: Math.round(box.left), width: Math.round(box.width), top: Math.round(box.bottom + 14) };
  // written only when it actually moved: the form settles over the page's first
  // few frames, and setting the same numbers again would be churn for nothing
  const want = "left " + place.left + " width " + place.width + " top " + place.top;
  if (prompt.getAttribute("data-placed") !== want) {
    prompt.style.left = place.left + "px";
    prompt.style.width = place.width + "px";
    prompt.style.top = place.top + "px";
    prompt.setAttribute("data-placed", want);
  }
  prompt.setAttribute("data-anchored", "true");
  return true;
}

/** The prompt is level with the form: it follows the window, with no timer. */
function followPrompt() {
  const prompt = document.getElementById("hypercord-token-prompt");
  if (!prompt || prompt.getAttribute("data-open") !== "true") return;
  positionPrompt(prompt);
}

let promptFollowing = false;
function followOnce() {
  if (promptFollowing) return;
  promptFollowing = true;
  window.addEventListener("resize", followPrompt, { passive: true });
  window.addEventListener("scroll", followPrompt, { passive: true, capture: true });
  if (typeof ResizeObserver === "function") {
    try {
      new ResizeObserver(followPrompt).observe(document.documentElement);
    } catch {
      /* an older engine: resize still follows it */
    }
  }
}

function hidePrompt() {
  const prompt = document.getElementById("hypercord-token-prompt");
  if (prompt) prompt.setAttribute("data-open", "false");
}

let promptWired = false;
let promptMode = "auto"; // "auto" follows the store, "form" is somebody pasting another one
let promptDismissed = false;
let promptToken = null;

/**
 * Which of the two states is showing, and what it says. A stored token gets one
 * button; no stored token gets the paste form. Nothing here writes a token into
 * the document: the label and the last four characters are all that is shown.
 */
async function refreshPrompt() {
  if (OURS || !document.documentElement) return;
  const prompt = ensurePrompt();
  if (!prompt || promptDismissed) return;
  let list = [];
  try {
    list = await call("tokens:list");
  } catch {
    return;
  }
  const rows = Array.isArray(list) ? list : [];
  const current = rows[0] || null;
  promptToken = current;
  wirePrompt(prompt);
  const pasting = !current || promptMode === "form";
  const stored = $(prompt, '[data-hc="prompt-stored"]');
  const form = $(prompt, '[data-hc="prompt-form"]');
  if (stored) stored.hidden = pasting;
  if (form) form.hidden = !pasting;
  if (current) {
    const mask = current.last4 ? "\u2026" + String(current.last4) : String(current.account);
    fill($(prompt, '[data-hc="prompt-who"]'), (current.label || current.account) + " (" + mask + ")");
  }
  prompt.setAttribute("data-open", "true");
  followOnce();
  positionPrompt(prompt);
}

/** Sign in with the stored token, from the prompt next to the login form. */
async function useStoredToken(inner) {
  if (!promptToken) return;
  const hint = $(inner, '[data-hc="prompt-stored-hint"]');
  fill(hint, "signing in\u2026");
  let res;
  try {
    res = await call("tokens:use", promptToken.account);
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  fill(hint, res && res.ok ? "signed in as " + (promptToken.label || promptToken.account) : "could not use it: " + ((res && res.error) || "unknown"));
}

function wirePrompt(prompt) {
  const inner = document.getElementById("hypercord-token-prompt");
  if (!inner || promptWired) return;
  promptWired = true;
  const form = $(inner, '[data-hc="prompt-form"]');
  if (form) form.addEventListener("submit", (event) => event.preventDefault());
  const save = $(inner, '[data-hc="prompt-save"]');
  if (save) {
    save.addEventListener("click", () =>
      addToken($(inner, '[data-hc="prompt-value"]'), $(inner, '[data-hc="prompt-label"]'), $(inner, '[data-hc="prompt-hint"]')),
    );
  }
  const use = $(inner, '[data-hc="prompt-use"]');
  if (use) use.addEventListener("click", () => useStoredToken(inner));
  const another = $(inner, '[data-hc="prompt-another"]');
  if (another) {
    another.addEventListener("click", () => {
      promptMode = "form";
      refreshPrompt();
    });
  }
  const later = $(inner, '[data-hc="prompt-close"]');
  if (later) {
    later.addEventListener("click", () => {
      // Hide means hide: this client keeps Discord's own login, and nothing pops
      // it back up for the rest of the session
      promptDismissed = true;
      hidePrompt();
      fill($(inner, '[data-hc="prompt-hint"]'), "");
    });
  }
}

/* ---- themes, in one place ---------------------------------------------- */

function applyCss(css) {
  if (!document.head && !document.documentElement) return false;
  let style = document.getElementById("hypercord-theme");
  if (!style) {
    style = document.createElement("style");
    style.id = "hypercord-theme";
    style.setAttribute("data-hypercord", "themes");
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = typeof css === "string" ? css : "";
  return true;
}

async function boot() {
  if (OURS) return; // Hypercord's own pages get the bridge and nothing else
  try {
    await call("ui:ready");
  } catch {
    /* the shell is not there yet */
  }
  try {
    const assets = await call("ui:assets");
    if (assets) PANES_ASSETS = assets;
    applyCss((assets && assets.css) || "");
    const prompt = ensurePrompt();
    if (prompt && assets && assets.promptHtml) prompt.innerHTML = String(assets.promptHtml);
    wirePrompt(ensurePrompt());
    mountPanes(assets);
  } catch {
    /* nothing to inject */
  }
  await refreshPrompt();
  // once now, so a page that never mutates again still gets the way in, and then
  // on every change while settings come and go
  followSettings();
  // Discord's own DOM arrives late and settles over the first few frames, so the
  // prompt is levelled with the login form again whenever that tree changes -
  // no timer, and nothing outside the prompt is written. Re-measuring is a
  // rect read; the style is only touched when it actually moved.
  const observer = new MutationObserver(() => {
    const prompt = document.getElementById("hypercord-token-prompt");
    if (prompt && prompt.getAttribute("data-open") === "true") positionPrompt(prompt);
    followSettings();
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* an unusually strict document: the prompt stays where it is */
  }
}

if (!OURS) holdBackPasskeyPrompts(); // before anything else, and before the page

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
