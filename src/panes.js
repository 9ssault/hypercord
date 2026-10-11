// language: JavaScript, file: src/panes.js
//
// The panes sheet: the plugin catalogue, our own Hyper plugins, the themes, the
// commands, the logs, the accounts and the access keys, all through the one bridge
// the preload exposes as window.hypercord. One section per thing, the way a
// settings screen is laid out.
//
// It is not a page. src/preload.cjs mounts panes.html inside the Discord window,
// in the container it owns (#hypercord-panes), and evaluates this file with the
// markup already in the document and the bridge already in scope. So three rules
// hold the whole file together:
//
//   * **it owns nothing but its own sheet.** Every query is inside
//     #hypercord-panes (or by an hp- id, which is why every id carries that
//     prefix: ids are document-wide and "status" is a name Discord already uses).
//     It never touches document.title, window.location or the body;
//   * **no timers, anywhere.** A view reads when it is opened, when the user
//     presses a button, or when the shell pushes a change. Nothing here runs
//     while nobody is looking at it;
//   * **every call can fail, and a failure is always visible text.** `guard()` is
//     the only way a bridge call is made, so no click can quietly do nothing, and
//     nothing here trusts a reply.
//
// window.hypercordPanes is what the preload drives: open(view), close(),
// isOpen(). The whole file is wrapped so that evaluating it twice in one document
// is harmless, which matters because the sheet is remounted after a navigation.
(() => {
  if (typeof window === "undefined" || window.hypercordPanes) return;

  const hc = window.hypercord || null;
  const $ = (id) => document.getElementById(id);
  const sheet = () => document.getElementById("hypercord-panes");
  const VIEWS = ["commands", "plugins", "hyper", "themes", "logs", "accounts", "tokens"];
  // Which entries are Hypercord's own rather than vendored. The catalogue marks
  // them; an older manifest that does not is still recognisable by id, because
  // every plugin of ours is named hyperSomething.
  const isOurs = (entry) => text(entry.source) === "hypercord" || (!entry.source && text(entry.id).startsWith("hyper"));
  let currentView = "commands";
  let catalogue = [];
  let settingsFor = "";
  let lastSettingsValues = {};
  let keys = [];
  // "Forget everything" cannot be undone, so it takes two clicks. A browser confirm
  // dialog is not used on purpose: it is modal, it can be suppressed, and the sheet
  // has a status line to say what is about to happen.
  let forgetArmed = false;

  /* ---- the one door out ---------------------------------------------------- */

  function text(value) {
    return String(value === undefined || value === null ? "" : value);
  }

  function why(err) {
    if (err && err.error) return text(err.error);
    return text((err && err.message) || err || "unknown error");
  }

  function say(message, kind = "") {
    const status = $("hp-status");
    if (!status) return;
    status.textContent = text(message);
    status.className = "status" + (kind ? " " + kind : "");
  }

  /**
   * Every bridge call goes through here: no bridge, a rejected invoke or a reply
   * with {ok:false} all become a visible line instead of a dead click.
   */
  async function guard(where, fn) {
    if (!hc) {
      say(where + ": the Hypercord bridge is not available in this window", "bad");
      return null;
    }
    try {
      const res = await fn();
      if (res && res.ok === false && res.error) {
        say(where + ": " + text(res.error), "bad");
        return res;
      }
      return res;
    } catch (err) {
      say(where + ": " + why(err), "bad");
      return null;
    }
  }

  /* ---- views --------------------------------------------------------------- */

  function setView(view, { tell = true } = {}) {
    const wanted = VIEWS.includes(String(view)) ? String(view) : "commands";
    const changed = wanted !== currentView;
    currentView = wanted;
    const root = sheet();
    if (root) {
      for (const item of root.querySelectorAll(".nav-item")) {
        item.classList.toggle("active", item.dataset.view === wanted);
      }
      for (const section of root.querySelectorAll(".view")) {
        section.classList.toggle("hidden", section.dataset.view !== wanted);
      }
    }
    if (tell && changed) {
      // only to keep the shell's record of the last view honest; the echo it sends
      // back lands on the same view and is a no-op
      guard("panes", () => hc.panes.open(wanted));
    }
    load(wanted);
    return wanted;
  }

  function load(view) {
    if (view === "plugins" || view === "hyper") return loadPlugins();
    if (view === "themes") return loadThemes();
    if (view === "logs") return loadLogs();
    if (view === "accounts") return loadAccounts();
    if (view === "tokens") return loadTokens();
    return Promise.resolve();
  }

  /* ---- a small row builder ------------------------------------------------- */

  function card({ name, title, description, meta, badges = [], actions = [] }) {
    const row = document.createElement("div");
    row.className = "card";
    row.setAttribute("role", "listitem");

    const main = document.createElement("div");
    main.className = "card-main";

    const head = document.createElement("div");
    head.className = "card-title";
    const label = document.createElement("span");
    label.className = "card-name";
    label.textContent = text(name || title);
    head.appendChild(label);
    for (const badge of badges) {
      if (!badge || !badge.text) continue;
      const pill = document.createElement("span");
      pill.className = "badge" + (badge.kind ? " " + badge.kind : "");
      pill.textContent = text(badge.text);
      if (badge.title) pill.title = text(badge.title);
      head.appendChild(pill);
    }
    main.appendChild(head);

    if (description) {
      const desc = document.createElement("div");
      desc.className = "card-desc";
      desc.textContent = text(description);
      main.appendChild(desc);
    }
    if (meta) {
      const line = document.createElement("div");
      line.className = "card-meta";
      line.textContent = text(meta);
      main.appendChild(line);
    }
    row.appendChild(main);

    if (actions.length) {
      const box = document.createElement("div");
      box.className = "card-actions";
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text(action.label);
        if (action.kind) button.className = action.kind;
        if (action.disabled) button.disabled = true;
        if (action.title) button.title = text(action.title);
        button.addEventListener("click", () => {
          Promise.resolve(action.run()).catch((err) => say(action.label + ": " + why(err), "bad"));
        });
        box.appendChild(button);
      }
      row.appendChild(box);
    }
    return row;
  }

  function empty(container, message) {
    if (!container) return;
    container.replaceChildren();
    const line = document.createElement("div");
    line.className = "empty";
    line.textContent = text(message);
    container.appendChild(line);
  }

  /* ---- commands ------------------------------------------------------------ */

  function runCommand() {
    const line = $("hp-cmdInput") ? $("hp-cmdInput").value.trim() : "";
    if (!line) {
      say("type a command first", "bad");
      return Promise.resolve();
    }
    const parts = line.split(/\s+/);
    return guard("run " + parts[0], () =>
      hc.api.request("/api/run", { method: "POST", body: { command: parts[0].replace(/^\$/, ""), args: parts.slice(1) } }),
    ).then((res) => {
      if (!res) return;
      const out = $("hp-cmdOut");
      if (out) out.textContent = text(res.text) || (res.json ? JSON.stringify(res.json, null, 1) : "");
      say("ran " + parts[0] + " (control answered " + text(res.status) + ")", "good");
    });
  }

  /* ---- plugins ------------------------------------------------------------- */

  async function loadPlugins() {
    const list = await guard("plugins", () => hc.plugins.list());
    if (!Array.isArray(list)) {
      empty($("hp-pluginList"), "the plugin catalogue could not be read");
      return;
    }
    catalogue = list;
    renderPlugins();
    renderHyper();
  }

  /**
   * One row renderer for both plugin tabs: the same catalogue, filtered. The
   * Plugins view shows everything and marks which entries are ours; the Hyper
   * plugins view shows only ours. Two tabs, one catalogue - not two catalogues.
   */
  function renderPluginList({ containerId, summaryId, rows, total, what, query }) {
    const running = rows.filter((entry) => entry.running).length;
    const enabled = rows.filter((entry) => entry.enabled).length;
    const summary = $(summaryId);
    if (summary) {
      summary.textContent =
        rows.length + (query ? " of " + total : "") + " " + what + " \u00b7 " + enabled + " enabled \u00b7 " + running + " running";
    }

    const container = $(containerId);
    if (!container) return;
    if (!rows.length) {
      empty(container, total ? (query ? "nothing matches that filter" : "nothing to show here") : "the catalogue is empty");
      return;
    }
    container.replaceChildren();
    for (const entry of rows) {
      const badges = [];
      if (entry.enabled) badges.push({ text: "enabled", kind: "on" });
      if (entry.running) badges.push({ text: "running", kind: "on" });
      if (entry.broken) badges.push({ text: "broken", kind: "bad", title: text(entry.broken) });
      if (isOurs(entry)) badges.push({ text: "Hypercord", kind: "own" });
      else if (entry.source) badges.push({ text: text(entry.source) });
      if (entry.defaultOn) badges.push({ text: "Hyper set", kind: "own", title: text(entry.defaultSet) });

      const authors = Array.isArray(entry.authors) && entry.authors.length ? entry.authors.join(", ") : "unknown author";
      const meta = authors + (entry.version ? " \u00b7 v" + text(entry.version) : "") + (entry.broken ? " \u00b7 " + text(entry.broken) : "");

      container.appendChild(
        card({
          name: entry.name || entry.id,
          description: entry.description,
          meta,
          badges,
          actions: [
            entry.enabled
              ? { label: "Disable", kind: "ghost", run: () => togglePlugin(entry.id, false) }
              : { label: "Enable", run: () => togglePlugin(entry.id, true) },
            { label: "Settings", kind: "ghost", run: () => openSettings(entry.id) },
          ],
        }),
      );
    }
  }

  function matching(entries, query) {
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        text(entry.id).toLowerCase().includes(query) ||
        text(entry.name).toLowerCase().includes(query) ||
        text(entry.description).toLowerCase().includes(query),
    );
  }

  function renderPlugins() {
    const search = $("hp-pluginSearch");
    const query = text(search ? search.value : "").trim().toLowerCase();
    renderPluginList({
      containerId: "hp-pluginList",
      summaryId: "hp-pluginSummary",
      rows: matching(catalogue, query),
      total: catalogue.length,
      what: "in the catalogue",
      query,
    });
  }

  function renderHyper() {
    const ours = catalogue.filter(isOurs);
    renderPluginList({
      containerId: "hp-hyperList",
      summaryId: "hp-hyperSummary",
      rows: ours,
      total: ours.length,
      what: "of ours in the catalogue",
      query: "",
    });
  }

  async function togglePlugin(id, on) {
    const res = await guard((on ? "enable " : "disable ") + id, () => (on ? hc.plugins.enable(id) : hc.plugins.disable(id)));
    if (res && res.ok) say((on ? "enabled " : "disabled ") + id, "good");
    await loadPlugins();
    if (settingsFor === id) await openSettings(id);
  }

  async function openSettings(id) {
    const panel = $("hp-pluginSettings");
    const form = $("hp-settingsForm");
    if (!panel || !form) return;
    settingsFor = id;
    lastSettingsValues = {};
    panel.classList.remove("hidden");
    const title = $("hp-settingsTitle");
    if (title) title.textContent = "Settings \u00b7 " + id;
    form.replaceChildren();

    const saved = await guard("settings for " + id, () => hc.plugins.settings(id));
    const values = saved && typeof saved === "object" ? saved : {};
    const entry = catalogue.find((item) => item.id === id) || {};
    // the catalogue carries the declared settings when the host reports them; if it
    // does not, the saved values are still editable, which is better than a form
    // that cannot exist
    const schema = Array.isArray(entry.settings) ? entry.settings : [];
    const settingKeys = [...schema.map((item) => text(item.key)).filter(Boolean)];
    for (const key of Object.keys(values)) if (!settingKeys.includes(key)) settingKeys.push(key);

    if (!settingKeys.length) {
      const none = document.createElement("div");
      none.className = "field";
      none.textContent = "this plugin has no settings";
      form.appendChild(none);
      return;
    }

    for (const key of settingKeys) {
      const declared = schema.find((item) => text(item.key) === key) || {};
      const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : declared.default;
      lastSettingsValues[key] = value;
      const field = document.createElement("div");
      field.className = "field";

      const label = document.createElement("label");
      label.textContent = key;
      if (declared.description) label.title = text(declared.description);
      field.appendChild(label);

      let input;
      if (declared.type === "boolean" || typeof value === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = value === true;
      } else if (declared.type === "number" || typeof value === "number") {
        input = document.createElement("input");
        input.type = "text";
        input.inputMode = "decimal";
        input.value = value === undefined || value === null ? "" : String(value);
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = value === undefined || value === null ? "" : String(value);
      }
      input.dataset.key = key;
      input.dataset.kind = input.type === "checkbox" ? "boolean" : declared.type === "number" || typeof value === "number" ? "number" : "string";
      input.id = "hp-set-" + id + "-" + key;
      label.setAttribute("for", input.id);
      field.appendChild(input);

      if (declared.description) {
        const note = document.createElement("span");
        note.className = "note";
        note.textContent = text(declared.description);
        field.appendChild(note);
      }
      form.appendChild(field);
    }
  }

  async function saveSettings() {
    if (!settingsFor) {
      say("no plugin settings are open", "bad");
      return;
    }
    const id = settingsFor;
    const form = $("hp-settingsForm");
    if (!form) return;
    let saved = 0;
    for (const input of form.querySelectorAll("[data-key]")) {
      let value;
      if (input.dataset.kind === "boolean") value = input.checked;
      else if (input.dataset.kind === "number") value = Number(input.value);
      else value = String(input.value);
      if (input.dataset.kind === "number" && !Number.isFinite(value)) {
        say("not a number: " + input.dataset.key, "bad");
        return;
      }
      const res = await guard("save " + input.dataset.key, () => hc.plugins.setSetting(id, input.dataset.key, value));
      if (res) saved += 1;
    }
    say("saved " + saved + " setting(s) for " + id, "good");
  }

  function closeSettings() {
    settingsFor = "";
    const panel = $("hp-pluginSettings");
    if (panel) panel.classList.add("hidden");
  }

  function refreshCatalogue() {
    guard("plugins", () => hc.plugins.list()).then((list) => {
      if (Array.isArray(list)) {
        catalogue = list;
        renderPlugins();
        renderHyper();
        say("catalogue refreshed: " + list.length + " plugins, " + list.filter(isOurs).length + " of them ours", "good");
      }
    });
  }

  /* ---- themes -------------------------------------------------------------- */

  async function loadThemes() {
    const list = await guard("themes", () => hc.themes.list());
    const quick = await guard("quick css", () => hc.themes.quickCss());
    const box = $("hp-quickCss");
    if (box) box.value = typeof quick === "string" ? quick : "";
    renderThemes(Array.isArray(list) ? list : []);
  }

  function renderThemes(list) {
    const container = $("hp-themeList");
    if (!container) return;
    if (!list.length) {
      empty(container, "no themes installed. A .theme.css file, or an https:// url, can be installed above.");
      return;
    }
    container.replaceChildren();
    for (const theme of list) {
      const badges = [{ text: text(theme.source || "local") }];
      if (theme.enabled) badges.push({ text: "on", kind: "on" });
      const meta = theme.url ? text(theme.url) : text(theme.id);
      container.appendChild(
        card({
          name: theme.name || theme.id,
          meta,
          badges,
          actions: [
            theme.enabled
              ? { label: "Turn off", kind: "ghost", run: () => toggleTheme(theme.id, false) }
              : { label: "Turn on", run: () => toggleTheme(theme.id, true) },
            { label: "Remove", kind: "danger", run: () => removeTheme(theme.id) },
          ],
        }),
      );
    }
  }

  async function toggleTheme(id, on) {
    const res = await guard((on ? "turn on " : "turn off ") + id, () => hc.themes.enable(id, on));
    if (res && res.ok) say((on ? "enabled " : "disabled ") + id, "good");
    await loadThemes();
  }

  async function removeTheme(id) {
    const res = await guard("remove " + id, () => hc.themes.remove(id));
    if (res && res.ok) say("removed " + id, "good");
    await loadThemes();
  }

  async function installTheme() {
    const sourceBox = $("hp-themeSource");
    const nameBox = $("hp-themeName");
    const source = text(sourceBox ? sourceBox.value : "").trim();
    if (!source) {
      say("give a theme file or an https url", "bad");
      return;
    }
    const name = text(nameBox ? nameBox.value : "").trim();
    const res = await guard("install " + source, () => hc.themes.install(source, name || undefined));
    if (res && res.ok) {
      say("installed " + text(res.id || name || source), "good");
      if (sourceBox) sourceBox.value = "";
      if (nameBox) nameBox.value = "";
      await loadThemes();
    }
  }

  async function saveQuickCss() {
    const box = $("hp-quickCss");
    const css = text(box ? box.value : "");
    const res = await guard("save quick css", () => hc.themes.quick(css));
    if (res && res.ok) say("quick css saved (" + css.length + " bytes)", "good");
  }

  /* ---- logs ---------------------------------------------------------------- */

  async function loadLogs() {
    const out = $("hp-logsOut");
    if (out) out.textContent = "reading\u2026";
    const res = await guard("logs", () => hc.api.request("/api/logs?lines=200"));
    if (!out) return;
    if (!res) {
      out.textContent = "no logs to show";
      return;
    }
    out.textContent = text(res.text) || (res.json ? JSON.stringify(res.json, null, 1) : "the log is empty");
    out.scrollTop = out.scrollHeight;
  }

  /* ---- accounts and updates ------------------------------------------------ */

  async function loadAccounts() {
    const seen = await guard("accounts", () => hc.account.current());
    const container = $("hp-accountList");
    const accounts = seen && Array.isArray(seen.accounts) ? seen.accounts : [];
    const current = seen ? text(seen.account) : "";
    if (!container) return;
    if (!accounts.length) {
      empty(container, "the control server reported no accounts" + (current ? " (this client is on " + current + ")" : ""));
    } else {
      container.replaceChildren();
      for (const id of accounts) {
        container.appendChild(
          card({
            name: id,
            meta: id === current ? "this client is logged in as " + id : "switch to this account",
            badges: id === current ? [{ text: "current", kind: "on" }] : [],
            actions: id === current ? [] : [{ label: "Switch", run: () => switchAccount(id) }],
          }),
        );
      }
    }
    await loadUpdates();
  }

  async function switchAccount(id) {
    const res = await guard("switch to " + id, () => hc.account.switch(id));
    if (res && res.ok) say("switched to " + id, "good");
    await loadAccounts();
  }

  async function loadUpdates() {
    const state = await guard("update state", () => hc.update.state());
    const row = $("hp-updateRow");
    if (!row) return;
    if (!state) {
      row.textContent = "update state is unavailable";
      return;
    }
    const bits = ["mode: " + text(state.mode || "unknown")];
    bits.push(state.supported ? "automatic updates are on" : "not updating in this run");
    if (state.downloaded) bits.push("downloaded " + text(state.downloaded) + ", installs on quit");
    if (state.error) bits.push("last error: " + text(state.error));
    row.textContent = bits.join(" \u00b7 ");
    row.className = "hint" + (state.error ? " status bad" : "");
  }

  async function checkUpdates() {
    const res = await guard("check for updates", () => hc.update.check());
    if (res && res.ok) say("the feed reports " + text(res.version || "the current version"), "good");
    await loadUpdates();
  }

  /* ---- access keys --------------------------------------------------------- */

  async function loadTokens() {
    const list = await guard("access keys", () => hc.tokens.list());
    keys = Array.isArray(list) ? list : [];
    renderTokens();
  }

  /** The masked shape only: a stored key is never read back into this page. */
  function keyMeta(entry) {
    const bits = [];
    if (entry.fingerprint) bits.push("fingerprint " + text(entry.fingerprint));
    if (entry.last4) bits.push("ends " + text(entry.last4));
    if (entry.updatedAt) bits.push("stored " + new Date(entry.updatedAt).toLocaleString());
    return bits.join(" \u00b7 ") || "stored";
  }

  function renderTokens() {
    const container = $("hp-tokenList");
    const banner = $("hp-tokenBanner");
    if (banner) banner.classList.toggle("hidden", keys.length > 0);
    if (!container) return;
    if (!keys.length) {
      empty(container, "no access key is stored on this machine. Paste one above to sign this client in as that account.");
      return;
    }
    container.replaceChildren();
    for (const entry of keys) {
      const account = text(entry.account);
      // `row` is assigned by card() below and read by the Replace click later; the
      // closure captures the binding, not the value, so this is not a use-before-set
      let row;
      row = card({
        name: entry.label ? text(entry.label) : account,
        meta: (entry.label ? account + " \u00b7 " : "") + keyMeta(entry),
        badges: entry.present === false ? [{ text: "empty", kind: "bad" }] : [{ text: "stored", kind: "on" }],
        actions: [
          { label: "Use in this client", run: () => useKey(account) },
          { label: "Test", kind: "ghost", run: () => testKey(account) },
          { label: "Replace", kind: "ghost", run: () => revealReplace(row, entry) },
          { label: "Remove", kind: "danger", run: () => removeKey(account) },
        ],
      });
      container.appendChild(row);
    }
  }

  /**
   * Replacing a key means typing a new one, so this adds one password input to the
   * row it belongs to. A password field is used rather than text so the value is
   * not shown on screen, and it is cleared the moment it is stored.
   */
  function revealReplace(row, entry) {
    const existing = row.querySelector(".token-replace");
    if (existing) {
      existing.remove();
      return;
    }
    const box = document.createElement("div");
    box.className = "token-replace";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "new-password";
    input.placeholder = "new token for " + text(entry.account);
    input.id = "hp-replace-" + text(entry.account);
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Store";
    save.addEventListener("click", async () => {
      const value = input.value;
      if (!value) {
        say("paste the new token first", "bad");
        return;
      }
      await storeKey(text(entry.account), value, text(entry.label));
      input.value = "";
      box.remove();
    });
    box.appendChild(input);
    box.appendChild(save);
    row.appendChild(box);
    input.focus();
  }

  async function storeKey(account, token, label) {
    if (!account) {
      say("name the account this key belongs to", "bad");
      return false;
    }
    const res = await guard("store key for " + account, () => hc.tokens.put(account, token, label || ""));
    if (!res || res.ok !== true) return false;
    // the reply, not the value: only the mask is ever repeated back
    const shown = text(res.last4 || "") || text(res.fingerprint || "");
    say("key stored for " + account + (shown ? " (" + shown + ")" : ""), "good");
    await loadTokens();
    return true;
  }

  async function useKey(account) {
    const res = await guard("sign in as " + account, () => hc.tokens.use(account));
    if (res && res.ok) say("signed this client in as " + account, "good");
  }

  async function testKey(account) {
    const res = await guard("test the key for " + account, () => hc.tokens.test(account));
    if (!res) return;
    if (res.ok) say("the key for " + account + " works" + (res.identity ? " as " + text(res.identity) : ""), "good");
    else say("that key does not work: " + text(res.error || "the account refused it"), "bad");
  }

  async function removeKey(account) {
    const res = await guard("remove the key for " + account, () => hc.tokens.remove(account));
    if (res && res.ok) say("removed the key for " + account, "good");
    await loadTokens();
  }

  async function submitKey() {
    const accountBox = $("hp-tokenAccount");
    const valueBox = $("hp-tokenValue");
    const labelBox = $("hp-tokenLabel");
    const account = text(accountBox ? accountBox.value : "").trim();
    const value = text(valueBox ? valueBox.value : "");
    const label = text(labelBox ? labelBox.value : "").trim();
    if (!account || !value) {
      say("an account and a token are both needed", "bad");
      return;
    }
    const stored = await storeKey(account, value, label);
    if (stored) {
      if (accountBox) accountBox.value = "";
      if (valueBox) valueBox.value = "";
      if (labelBox) labelBox.value = "";
    }
  }

  async function forgetKeys() {
    const button = $("hp-tokenForget");
    if (!forgetArmed) {
      forgetArmed = true;
      if (button) button.textContent = "Click again to forget every key";
      say("this drops every stored key from this machine and cannot be undone", "bad");
      return;
    }
    forgetArmed = false;
    if (button) button.textContent = "Forget everything";
    const res = await guard("forget every key", () => hc.tokens.forgetAll());
    if (res && res.ok) say("forgot " + text(res.removed === undefined ? "every" : res.removed) + " key(s)", "good");
    await loadTokens();
  }

  /* ---- what the preload drives --------------------------------------------- */

  function isOpen() {
    const root = sheet();
    return Boolean(root && root.getAttribute("data-open") === "true");
  }

  function close() {
    const root = sheet();
    if (root) root.setAttribute("data-open", "false");
    return true;
  }

  /**
   * Open the sheet, on `view` when one is named. With nothing named the sheet
   * opens where it makes sense to start: with no key stored there is nothing to
   * sign in with, so it lands on Access keys, and otherwise on Commands.
   */
  async function open(view) {
    const root = sheet();
    if (root) root.setAttribute("data-open", "true");
    let wanted = VIEWS.includes(text(view)) ? text(view) : "";
    if (!wanted) {
      const stored = hc && hc.tokens && typeof hc.tokens.list === "function" ? await guard("access keys", () => hc.tokens.list()) : null;
      wanted = Array.isArray(stored) && stored.length === 0 ? "tokens" : "commands";
    }
    if (wanted !== currentView) setView(wanted, { tell: false });
    return wanted;
  }

  window.hypercordPanes = { open, close, isOpen };

  /* ---- wiring, once -------------------------------------------------------- */

  function wire() {
    const root = sheet();
    if (!root || !$("hp-main")) {
      // mounted without markup: nothing can be wired, and saying so beats a
      // half-dead sheet
      say("the panes markup is not mounted in this page", "bad");
      return false;
    }

    for (const item of root.querySelectorAll(".nav-item")) {
      item.addEventListener("click", () => setView(item.dataset.view));
    }

    const closeButton = $("hp-close");
    if (closeButton) {
      closeButton.addEventListener("click", () => {
        // the shell owns the sheet's open state, so it is told first; if the
        // method is not there, closing locally is still the right thing to do
        if (hc && hc.panes && typeof hc.panes.close === "function") guard("close panes", () => hc.panes.close());
        else close();
      });
    }

    const commandForm = $("hp-cmdForm");
    if (commandForm) {
      commandForm.addEventListener("submit", (event) => {
        event.preventDefault();
        runCommand();
      });
    }
    const settingsForm = $("hp-settingsForm");
    if (settingsForm) settingsForm.addEventListener("submit", (event) => event.preventDefault());
    const themeForm = $("hp-themeForm");
    if (themeForm) {
      themeForm.addEventListener("submit", (event) => {
        event.preventDefault();
        installTheme();
      });
    }
    const tokenForm = $("hp-tokenForm");
    if (tokenForm) {
      tokenForm.addEventListener("submit", (event) => {
        event.preventDefault();
        submitKey();
      });
    }

    const on = (id, event, fn) => {
      const node = $(id);
      if (node) node.addEventListener(event, fn);
    };
    on("hp-settingsSave", "click", () => saveSettings());
    on("hp-settingsClose", "click", () => closeSettings());
    on("hp-pluginSearch", "input", () => renderPlugins());
    on("hp-pluginRefresh", "click", () => refreshCatalogue());
    on("hp-quickSave", "click", () => saveQuickCss());
    on("hp-logsRefresh", "click", () => loadLogs());
    on("hp-updateCheck", "click", () => checkUpdates());
    on("hp-tokenForget", "click", () => forgetKeys());
    return true;
  }

  /* ---- the shell's pushes -------------------------------------------------- */

  function boot() {
    const wired = wire();
    if (wired) setView(currentView, { tell: false });
    if (!hc) {
      say("the Hypercord bridge is not available in this window", "bad");
      return;
    }
    // the shell drives the sheet: it opens it on a view, reopens the current one,
    // and closes it
    hc.on("panes:open", (view) => open(view));
    hc.on("panes:view", (view) => {
      // the echo of our own "tell the shell" call must not reload the view
      if (VIEWS.includes(text(view)) && text(view) !== currentView) setView(view, { tell: false });
    });
    hc.on("panes:close", () => close());
    // a change made elsewhere is followed by the view that shows it, and only
    // while that view is the visible one
    hc.on("plugins:changed", () => {
      // both plugin tabs read the same catalogue, so both stay in step
      if (currentView === "plugins" || currentView === "hyper") loadPlugins();
    });
    hc.on("themes:css", () => {
      if (currentView === "themes") loadThemes();
    });
    hc.on("tokens:changed", () => {
      if (currentView === "tokens") loadTokens();
    });
  }

  boot();
})();
