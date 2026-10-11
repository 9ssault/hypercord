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
//   * **the rail, with a tab per thing.** Everything Hypercord adds lives in its
//     own tab inside the Discord window: user tokens, plugins, themes, accounts,
//     commands. Markup is mounted here and wired here, because markup inserted
//     with innerHTML never runs its own script;
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
  if (key === "rail:visible" && !OURS) {
    const host = ensureRail();
    if (host) host.setAttribute("data-open", payload ? "true" : "false");
  }
  if (key === "rail:side" && !OURS) {
    const host = ensureRail();
    if (host) host.setAttribute("data-side", String(payload) === "left" ? "left" : "right");
  }
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
  // the rail talks to the control server through main, never with a token of its own
  api: {
    request: (path, opts = {}) => call("api:request", String(path), opts),
  },
  rail: {
    toggle: (open) => call("rail:toggle", open === undefined ? null : Boolean(open)),
    assets: () => call("rail:assets"),
    mount: (html) => mountRail(html),
  },
  // the manager sheet lives in this page: opening a view is a push, and Close is
  // the shell's to confirm
  panes: {
    open: (view) => call("panes:open", String(view || "commands")),
    close: () => call("panes:close"),
  },
  notify: (title, body) => call("notify", String(title || ""), String(body || "")),
  metrics: () => call("perf:metrics"),
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

/* ---- the rail ------------------------------------------------------------ */

function ensureRail() {
  if (!document.documentElement) return null;
  let host = document.getElementById("hypercord-rail");
  if (!host) {
    host = document.createElement("div");
    host.id = "hypercord-rail";
    host.setAttribute("data-hypercord", "rail");
    document.documentElement.appendChild(host);
  }
  return host;
}

function mountRail(html) {
  const host = ensureRail();
  if (!host) return false;
  if (typeof html === "string" && html.trim() && host.innerHTML !== html) {
    host.innerHTML = html;
    wireRail(host);
  }
  return true;
}

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

/** Text, never markup: every value on the rail comes from somewhere else. */
function fill(node, text) {
  if (!node) return;
  node.textContent = String(text === undefined || text === null ? "" : text);
}

function row(text, tag, kind) {
  const line = document.createElement("div");
  line.className = "hc-row";
  const name = document.createElement("span");
  name.className = "hc-name";
  name.textContent = String(text);
  line.appendChild(name);
  if (tag) {
    const pill = document.createElement("span");
    pill.className = "hc-tag";
    if (kind) pill.setAttribute("data-state", kind);
    pill.textContent = String(tag);
    line.appendChild(pill);
  }
  return line;
}

function empty(box, text) {
  if (!box) return;
  const line = document.createElement("div");
  line.className = "hc-empty";
  line.textContent = String(text);
  box.replaceChildren(line);
}

function showPanel(host, wanted) {
  for (const button of host.querySelectorAll(".hc-tab")) {
    button.classList.toggle("hc-active", button.getAttribute("data-tab") === wanted);
  }
  for (const panel of host.querySelectorAll(".hc-panel")) {
    panel.classList.toggle("hc-shown", panel.getAttribute("data-panel") === wanted);
  }
  const load = { tokens: renderTokens, plugins: renderPlugins, themes: renderThemes, accounts: renderAccounts };
  if (load[wanted]) load[wanted]();
}

function wireRail(host) {
  for (const button of host.querySelectorAll(".hc-tab")) {
    button.addEventListener("click", () => showPanel(host, button.getAttribute("data-tab")));
  }
  for (const button of host.querySelectorAll(".hc-actions [data-hc]")) {
    const action = button.getAttribute("data-hc");
    button.addEventListener("click", () => {
      if (action === "panes") call("panes:open", "plugins").catch(() => {});
      if (action === "themes" || action === "themes-open") call("panes:open", "themes").catch(() => {});
      if (action === "token-forget") forgetAllTokens();
    });
  }
  const close = $(host, '[data-hc="close"]');
  if (close) {
    close.addEventListener("click", () => {
      host.setAttribute("data-open", "false");
      call("rail:toggle", false).catch(() => {});
    });
  }

  const tokenForm = $(host, '[data-hc="token-form"]');
  if (tokenForm) tokenForm.addEventListener("submit", (event) => event.preventDefault());
  const tokenSave = $(host, '[data-hc="token-save"]');
  if (tokenSave) {
    tokenSave.addEventListener("click", () =>
      addToken($(host, '[data-hc="token-value"]'), $(host, '[data-hc="token-label"]'), $(host, '[data-hc="token-hint"]')),
    );
  }

  const search = $(host, '[data-hc="plugin-search"]');
  if (search) search.addEventListener("input", () => renderPlugins());

  const commandForm = $(host, '[data-hc="command-form"]');
  if (commandForm) commandForm.addEventListener("submit", (event) => event.preventDefault());
  for (const button of host.querySelectorAll('[data-hc="command-form"] button')) {
    button.addEventListener("click", () => runCommand($(host, '[data-hc="command-input"]'), $(host, '[data-hc="command-out"]')));
  }

  // a plugin toggled in the manager, a theme installed, a token stored: the rail
  // follows those events instead of asking on a clock
  const follow = () => {
    if ($(host, '.hc-panel[data-panel="plugins"].hc-shown')) renderPlugins();
    else if ($(host, '.hc-panel[data-panel="themea"].hc-shown')) renderThemes();
  };
  const followPlugins = listeners.get("plugins:changed") || [];
  followPlugins.push(() => {
    if ($(host, '.hc-panel[data-panel="plugins"].hc-shown')) renderPlugins();
    else if ($(host, '.hc-panel[data-panel="themes"].hc-shown')) renderThemes();
  });
  listeners.set("plugins:changed", followPlugins);
  void follow;

  showPanel(host, "tokens");
}

let catalogue = [];
let lastPlugins = [];

async function renderPlugins() {
  const host = document.getElementById("hypercord-rail");
  if (!host) return;
  const box = $(host, '[data-hc="plugins"]');
  let list = [];
  try {
    list = await call("plugins:list");
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  lastPlugins = list;
  catalogue = list;
  const query = String(($(host, '[data-hc="plugin-search"]') || {}).value || "").trim().toLowerCase();
  const rows = query
    ? list.filter((p) => String(p.id).toLowerCase().includes(query) || String(p.name).toLowerCase().includes(query))
    : list.filter((p) => p.running || p.broken || p.defaultOn);
  fill($(host, '[data-hc="plugin-summary"]'), list.filter((p) => p.running).length + " running of " + list.length + " in the catalogue" + (query ? " | " + rows.length + " match" : ""));
  if (!box) return;
  if (!rows.length) {
    empty(box, query ? "nothing matches that search" : "no plugins loaded");
    return;
  }
  box.replaceChildren();
  for (const plugin of rows) {
    const tag = plugin.broken ? "broken" : plugin.running ? "on" : plugin.enabled ? "off (broken?)" : plugin.defaultOn ? "Hyper set" : "off";
    box.appendChild(row(plugin.name || plugin.id, tag, plugin.broken ? "broken" : plugin.running ? "on" : ""));
  }
}

async function renderThemes() {
  const host = document.getElementById("hypercord-rail");
  const box = host && $(host, '[data-hc="themes"]');
  if (!box) return;
  let list = [];
  try {
    list = await call("themes:list");
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) {
    empty(box, "no themes installed");
    return;
  }
  box.replaceChildren();
  for (const theme of list) box.appendChild(row(theme.name || theme.id, theme.enabled ? "on" : "off", theme.enabled ? "on" : ""));
}

async function renderAccounts() {
  const host = document.getElementById("hypercord-rail");
  const box = host && $(host, '[data-hc="accounts"]');
  if (!box) return;
  let info = null;
  try {
    info = await call("account:current");
  } catch {
    info = null;
  }
  const accounts = (info && Array.isArray(info.accounts) ? info.accounts : []).map(String);
  if (!accounts.length) {
    empty(box, "the control server reports no accounts");
    return;
  }
  box.replaceChildren();
  for (const id of accounts) box.appendChild(row(id, info && String(info.account) === id ? "current" : "", info && String(info.account) === id ? "on" : ""));
}

async function renderTokens() {
  const host = document.getElementById("hypercord-rail");
  const box = host && $(host, '[data-hc="tokens"]');
  if (!box) return;
  let list = [];
  let store = null;
  try {
    list = await call("tokens:list");
    store = await call("tokens:store");
  } catch {
    list = [];
  }
  const rows = Array.isArray(list) ? list : [];
  fill(
    $(host, '[data-hc="token-hint"]'),
    store && store.encrypted === false
      ? "this machine has no usable keychain: a token stays in memory for the run only"
      : rows.length
        ? rows.length + " token(s) stored"
        : "no user token yet - paste one to skip Discord's login",
  );
  if (!rows.length) {
    empty(box, "no user token stored");
    return;
  }
  box.replaceChildren();
  for (const entry of rows) {
    const line = row(entry.label || entry.account, "\u2026" + String(entry.last4 || ""), "on");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Use";
    button.addEventListener("click", async () => {
      const res = await call("tokens:use", entry.account).catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
      fill($(host, '[data-hc="token-hint"]'), res && res.ok ? "signed in as " + (entry.label || entry.account) : "could not use it: " + ((res && res.error) || "unknown"));
    });
    line.appendChild(button);
    box.appendChild(line);
  }
}

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
    renderTokens();
    call("notify", "Hypercord", "Signed in with a stored user token").catch(() => {});
  }
  return res;
}

async function forgetAllTokens() {
  const host = document.getElementById("hypercord-rail");
  let res;
  try {
    res = await call("tokens:forgetAll");
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  fill(host && $(host, '[data-hc="token-hint"]'), res && res.ok ? "every stored user token was removed" : "could not forget them: " + ((res && res.error) || "unknown"));
  renderTokens();
}

/* ---- the way in from Discord's own settings ------------------------------ */

/**
 * Hypercord, as a section inside Discord's settings.
 *
 * The manager is where everything Hypercord adds is configured - plugins, the
 * Hyper plugins, themes, access keys, commands, logs, accounts, one tab each - and
 * the place people look for settings is Discord's own settings. So when the
 * settings layer is open, this adds one item to its sidebar, next to the real
 * ones, and it opens the manager on the last view.
 *
 * Discord's class names are generated and its tree is rebuilt as it likes, so
 * this is deliberately loose and unbothered by a miss: it looks for a tab strip
 * with real tabs in it, adds one button of our own, and if it finds nothing the
 * rail's Manager button and Ctrl+Shift+H are still there. Nothing is ever
 * inserted into the middle of Discord's own markup - the button is a sibling of
 * their settings entries, and its click goes to the shell like every other
 * button of ours.
 */
function settingsHosts() {
  const hosts = [];
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    if (list.querySelectorAll('[role="tab"]').length >= 3) hosts.push(list);
  }
  // Discord's settings sidebar is the widest tab strip on screen; picking it out
  // by shape rather than by class name survives their rebuilds
  return hosts;
}

function ensureSettingsEntry() {
  if (OURS || !document.body) return false;
  if (document.getElementById("hypercord-settings-entry")) return true;
  let host = null;
  for (const candidate of settingsHosts()) {
    const box = candidate.getBoundingClientRect();
    if (box.width >= 140 && box.height >= 80) host = candidate;
  }
  if (!host) return false;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "hypercord-settings-entry";
  button.setAttribute("data-hypercord", "settings");
  button.setAttribute("role", "tab");
  button.textContent = "Hypercord";
  button.addEventListener("click", () => {
    call("panes:open", "plugins").catch(() => {});
  });
  host.appendChild(button);
  return true;
}

/**
 * Settings open and close as a layer, and Discord rewrites its sidebar while it
 * settles, so the entry is re-added whenever the document changes - the same
 * single observer the rest of this file uses, with a lookup that costs one
 * querySelectorAll per mutation batch and writes nothing when it is already
 * there.
 */
function followSettings() {
  if (document.getElementById("hypercord-settings-entry")) return;
  ensureSettingsEntry();
}

/* ---- the user-token prompt ---------------------------------------------- */

function ensurePrompt() {
  if (!document.documentElement) return null;
  let prompt = document.getElementById("hypercord-token-prompt");
  if (!prompt) {
    // the rail's markup carries it; if the rail has not been mounted yet, this is
    // where it arrives from
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

async function runCommand(input, out) {
  const line = input ? String(input.value || "").trim() : "";
  if (!line) return;
  const parts = line.replace(/^\$/, "").split(/\s+/);
  let res;
  try {
    res = await call("api:request", "/api/run", { method: "POST", body: { command: parts[0], args: parts.slice(1) } });
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  if (out) {
    out.textContent = res && res.ok ? String(res.text || "").slice(0, 4000) : "failed: " + ((res && res.error) || "the control server did not answer");
  }
}

async function boot() {
  if (OURS) return; // Hypercord's own pages get the bridge and nothing else
  mountRail("");
  try {
    await call("rail:ready");
  } catch {
    /* the shell is not there yet */
  }
  try {
    const assets = await call("rail:assets");
    applyCss((assets && assets.css) || "");
    mountRail((assets && assets.html) || "");
    if (assets && assets.side) {
      const host = ensureRail();
      if (host) host.setAttribute("data-side", assets.side === "left" ? "left" : "right");
    }
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
