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
  },
  themes: {
    list: () => call("themes:list"),
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
    use: (account) => call("tokens:use", String(account || "")),
    store: () => call("tokens:store"),
  },
  on,
});

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
 * Nothing is ever inserted into the middle of Discord's own markup - the entries are
 * siblings of their settings items, and a click goes to the shell like every other
 * button of ours. When that content column cannot be found the section is not opened
 * at all and the reason is reported on the document, because a panel dropped over
 * somebody's chat is the one outcome worth refusing.
 */

/**
 * The words a settings sidebar says. This is the signal that survives a release
 * renaming every wrapper: the labels inside are user-visible text, so they change
 * only when Discord renames a setting. Both languages the client is likely to be
 * in are listed, because the label is what somebody reads, not a key.
 */
const SETTINGS_WORDS =
  /my account|profiles?|privacy|notifications|appearance|voice|keybinds|language|advanced|authorized apps|connections|devices|mon compte|profil|confidentialit|apparence|voix|raccourcis|langue|avanc/i;

/**
 * Where to look for the settings sidebar, most specific first. Each candidate is
 * a shape Discord has used, and the first one that yields a sidebar wins:
 *
 *   1. the sidebar inside the modal layer - settings is rendered in
 *      `[class*="layers"]` and its list of sections is a `[class*="sidebar"]`;
 *   2. a sidebar that is itself a tab strip;
 *   3. any sidebar at all - Discord has shipped the settings list as a plain
 *      scroll container;
 *   4. any tab strip with several tabs in it: the previous guess, kept as the
 *      last resort so a rename of both wrappers still finds a home.
 */
function settingsHostCandidates() {
  return ['[class*="layers"] [class*="sidebar"]', '[class*="sidebar"][role="tablist"]', '[class*="sidebar"]', '[role="tablist"]'];
}

/**
 * Is this the settings sidebar, rather than some other list with tabs in it? It
 * has to hold several tab-like items, say something a settings screen says, and
 * be on screen - a collapsed or hidden strip is not where somebody is looking.
 * Deliberately no more than a few checks: this runs on each mutation batch.
 */
function looksLikeSettingsSidebar(node) {
  if (!node || typeof node.querySelectorAll !== "function") return false;
  if (node.querySelectorAll('[role="tab"], button, a[href]').length < 3) return false;
  const box = node.getBoundingClientRect();
  if (box.width < 120 || box.height < 60) return false;
  return SETTINGS_WORDS.test(String(node.textContent || "").slice(0, 4000));
}

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

/**
 * The entry, built to sit among Discord's own items rather than merely near them:
 * their element type, their role, and their class attribute, so their stylesheet
 * lays it out and it reads as one more settings section. Our own stylesheet only
 * adds to that. On the page it is marked with an attribute, not only with our id:
 * `data-hypercord-settings` on the document root says what happened, which is what
 * a check can read from the page's own world.
 */
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
  const layer = (host.closest && host.closest('[class*="layers"]')) || host.parentElement;
  if (!layer) return null;
  let best = null;
  for (const node of layer.querySelectorAll("div")) {
    if (node === host || node.contains(host)) continue;
    if (node.closest && node.closest("#hypercord-panes")) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 320 || rect.height < 240) continue;
    if (rect.left < box.right - 8) continue;
    if (rect.right > window.innerWidth + 2) continue;
    const area = rect.width * rect.height;
    if (best && area <= best.area) continue;
    best = { area: area, top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }
  return best;
}

/**
 * Put the sheet exactly where Discord's own settings content is, and say whether it
 * landed. The rectangle goes into CSS variables the stylesheet reads, so the layout
 * itself is still the stylesheet's business and a resize only rewrites four numbers.
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
  panes.setAttribute("data-seamless", "true");
  return true;
}

/**
 * Does the sheet close when Discord's own settings are used? Two things have to:
 * choosing one of Discord's own sections (so nothing of ours is left over another
 * page) and the settings layer closing altogether. Both are wired here, once per
 * host, and both only set an attribute - the shell keeps owning the open state.
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
 * replaces this table the moment it arrives.
 */
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
 * What the pane said it has, in its order. Empty until the announcement arrives.
 *
 * `beef` is in the table above and not in the fallback below on purpose: the pane in
 * this tree has seven sections, and an entry for a section the sheet does not have is
 * worse than no entry - it opens somebody else's page under the wrong name. When the
 * pane gains that section it says so, and the entry appears on its own.
 */
let SETTINGS_PANE_VIEWS = [];

function settingsViews() {
  if (SETTINGS_PANE_VIEWS.length) return SETTINGS_PANE_VIEWS.slice();
  return SETTINGS_SECTIONS.filter((section) => section.view !== "beef").map((section) => section.view);
}

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

/**
 * A decorative heading above our entries, so they read as Hypercord's own part of
 * settings rather than as unrelated sections that happen to sit at the bottom. It
 * carries no role and no tab behaviour: Discord's own entries keep their own count
 * and none of their nodes is touched.
 */
function settingsGroupLabel() {
  const group = document.createElement("div");
  group.id = "hypercord-settings-group";
  group.setAttribute("data-hypercord", "settings-group");
  group.setAttribute("aria-hidden", "true");
  group.textContent = "Hypercord";
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
function settingsEntryFor(host, view, first) {
  const sibling = [...host.children].find((node) => !node.hasAttribute("data-hypercord")) || null;
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
  entry.setAttribute("aria-label", "Hypercord " + settingsLabel(view) + " settings");
  // Measured before anything is shown: the sheet becomes the settings content column,
  // and when that column cannot be found it is not opened at all - the one thing this
  // must never do is put a panel over the client, and reporting "no-region" is how
  // that is said out loud instead of drawn.
  const open = () => {
    if (!placePanes(host)) {
      noteSettingsEntry("no-region", host);
      return;
    }
    call("panes:open", view).catch(() => {});
  };
  watchSettingsLeaving(host);
  entry.addEventListener("click", open);
  // a div with a role is not clickable by keyboard on its own
  entry.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
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
function ensureSettingsEntry() {
  if (OURS || !document.body) return false;
  const wanted = settingsViews();
  const current = [...document.querySelectorAll('[data-hypercord="settings"]')];
  const host = current.length && current[0].parentElement ? current[0].parentElement : null;
  const settled =
    Boolean(host) &&
    looksLikeSettingsSidebar(host) &&
    current.length === wanted.length &&
    current.every((node, index) => node.getAttribute("data-hypercord-view") === wanted[index]);
  if (settled) {
    noteSettingsEntry("added", host, wanted.length);
    return true;
  }
  // only our own nodes go first: a set that has to change is rebuilt whole, so no
  // entry can be left pointing at a section the sheet has since lost
  for (const node of [...document.querySelectorAll("[data-hypercord]")]) {
    const kind = node.getAttribute("data-hypercord");
    if (kind === "settings" || kind === "settings-separator" || kind === "settings-group") node.remove();
  }
  for (const found of settingsHosts()) {
    // A section of its own, not one more item in Discord's list: a heading and a
    // separator above the entries, so they read as Hypercord's own part of settings.
    const rule = document.createElement("div");
    rule.id = "hypercord-settings-separator";
    rule.setAttribute("data-hypercord", "settings-separator");
    rule.setAttribute("aria-hidden", "true");
    found.appendChild(rule);
    found.appendChild(settingsGroupLabel());
    wanted.forEach((view, index) => found.appendChild(settingsEntryFor(found, view, index === 0)));
    noteSettingsEntry("added", found, wanted.length);
    return true;
  }
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
  const present = ensureSettingsEntry();
  // Settings closes as a layer and Discord takes its sidebar with it. A sheet left
  // open would be a panel over the client with nothing under it, so it closes with
  // the layer that hosted it.
  if (!document.getElementById("hypercord-settings-entry")) {
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
