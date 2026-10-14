// language: JavaScript, file: src/panes.js
//
// Hypercord's settings pages: the commands, the plugin catalogue, our own Hyper
// plugins, beef, the themes, the logs, the accounts and the access keys, all through
// the one bridge the preload exposes as window.hypercord. One page per section, and
// the sections are entries in Discord's own settings sidebar: src/preload.cjs adds
// them, the shell says which one to show, and this file shows it.
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
  const VIEWS = ["commands", "plugins", "hyper", "beef", "themes", "logs", "accounts", "tokens"];
  // Which entries are Hypercord's own rather than vendored. The catalogue marks
  // them; an older manifest that does not is still recognisable by id, because
  // every plugin of ours is named hyperSomething.
  const isOurs = (entry) => text(entry.source) === "hypercord" || (!entry.source && text(entry.id).startsWith("hyper"));
  let currentView = "commands";
  let catalogue = [];
  let keys = [];
  // the installed themes, as the page last read them, and the library as it was last
  // fetched: two lists that are shown side by side, so both are kept
  let installedThemes = [];
  let libraryThemes = [];
  let libraryFrom = "";
  let libraryQuery = "";
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
    // A plugin's page belongs to the two plugin pages. Leaving them leaves it too,
    // because a page of settings over the commands page is a page for a plugin the
    // person is no longer looking at.
    if (settingsFor && wanted !== "plugins" && wanted !== "hyper") closeSettings();
    const root = sheet();
    if (root) {
      // One page at a time. There is no in-page navigation to keep in step: which
      // section is showing is the shell's business (it is the entry that was clicked)
      // and the only thing this file owns is which page is visible.
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
    if (view === "beef") return loadBeef();
    if (view === "themes") return loadThemes();
    if (view === "logs") return loadLogs();
    if (view === "accounts") return loadAccounts();
    if (view === "tokens") return loadTokens();
    return Promise.resolve();
  }

  /* ---- a small row builder ------------------------------------------------- */

  function card({ name, title, description, meta, badges = [], actions = [], avatar = "" }) {
    const row = document.createElement("div");
    row.className = "card";
    row.setAttribute("role", "listitem");

    // A picture the browser fetches, never this sheet: the row is in the document before
    // anything could come back, and one that never loads simply leaves the row as it was.
    // `referrerpolicy` keeps a CDN request from carrying the page's own url with it.
    const face = text(avatar).trim();
    if (face) {
      const img = document.createElement("img");
      img.className = "card-avatar";
      img.src = face;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      // An avatar is a URL somebody else serves, and a URL can fail: the server can be gone, and
      // inside Discord's page a picture from outside it can be refused by the page's own image
      // policy before it is even asked for. Either way the browser draws its broken-image
      // placeholder, and one of those in a row next to a name reads as a broken page rather than
      // as a picture that is missing - so a picture that does not arrive is put away, and the
      // card is left as the name it was always carrying.
      img.addEventListener("error", () => img.classList.add("card-avatar-gone"));
      img.addEventListener("load", () => img.classList.remove("card-avatar-gone"));
      row.appendChild(img);
    }

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

  // The catalogue, the way a plugin browser reads: a grid of cards, one plugin
  // each, the switch on the card, and that plugin's own settings on a page behind
  // its name. Three rules hold this page together:
  //
  //   * **the card is the plugin's whole state.** On is the switch, running and
  //     broken are badges, and the name is the way into its settings - so nothing
  //     about a plugin is a menu away, and a plugin that has settings cannot be
  //     mistaken for one that has none;
  //   * **the switch acts rather than promising.** It enables or disables through
  //     the bridge and the catalogue is read back, so what a card shows is what the
  //     host answered and not what was asked for;
  //   * **a settings page writes as it is edited.** A switch that has to be saved is
  //     a switch somebody will leave in the wrong position, so every control here
  //     saves on change and the status line names what was written. There is no Save
  //     button, and therefore no Save button that can be left un-pressed.
  let pluginQuery = "";
  let pluginFilter = "all"; // all, enabled, disabled, ours
  let pluginCategory = ""; // "" is every category; a category name, or "Hypercord", is one of them

  /**
   * The catalogue in the order it is shown: ours first, then everything else by
   * name. Alphabetical is what makes a list of hundreds usable, and our own
   * plugins first is what keeps the handful somebody is looking for off the
   * fourth screen of somebody else's plugins.
   */
  function sortedCatalogue(entries) {
    const byName = (a, b) => text(a.name || a.id).localeCompare(text(b.name || b.id));
    const ours = entries.filter(isOurs).sort(byName);
    const rest = entries.filter((entry) => !isOurs(entry)).sort(byName);
    return [...ours, ...rest];
  }

  /**
   * The categories the catalogue declares, counted. The count is the point: a chip that
   * says how many plugins are behind it is a chip somebody can decide to press, and the
   * categories come from the plugins themselves - the ones upstream declared - rather
   * than from a list this page invented for them.
   */
  function categoryCounts() {
    const counts = new Map();
    for (const entry of catalogue) {
      for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
        const name = text(tag);
        if (name) counts.set(name, (counts.get(name) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  /**
   * One chip per category, the busiest first, with All in front and ours beside it.
   * Pressing the chip that is already on clears it, so the row is never a trap: the way
   * back to everything is the same press that narrowed it.
   */
  function renderCategoryChips() {
    const row = $("hp-pluginCategories");
    if (!row) return;
    if (!catalogue.length) {
      row.replaceChildren();
      return;
    }
    const wanted = [["", "All", catalogue.length]];
    const ours = catalogue.filter(isOurs).length;
    if (ours) wanted.push(["Hypercord", "Hypercord", ours]);
    for (const [tag, count] of categoryCounts()) if (tag !== "Hypercord") wanted.push([tag, tag, count]);
    row.replaceChildren(
      ...wanted.map(([value, label, count]) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (pluginCategory === value ? " on" : "");
        chip.dataset.category = value;
        chip.setAttribute("aria-pressed", pluginCategory === value ? "true" : "false");
        chip.title = label + ": " + count + " plugin(s)";
        chip.textContent = label + " " + count;
        chip.addEventListener("click", () => {
          pluginCategory = pluginCategory === value ? "" : value;
          renderPlugins();
        });
        return chip;
      }),
    );
  }

  /** Does this entry survive the search box, the status filter and the category chip? */
  function matchesBrowser(entry) {
    if (pluginFilter === "enabled" && !isOn(entry)) return false;
    if (pluginFilter === "disabled" && isOn(entry)) return false;
    if (pluginFilter === "ours" && !isOurs(entry)) return false;
    if (pluginCategory === "Hypercord") {
      if (!isOurs(entry)) return false;
    } else if (pluginCategory) {
      const tags = (Array.isArray(entry.tags) ? entry.tags : []).map(text);
      if (!tags.includes(pluginCategory)) return false;
    }
    if (!pluginQuery) return true;
    const haystack = [
      text(entry.id),
      text(entry.name),
      text(entry.description),
      Array.isArray(entry.authors) ? entry.authors.join(" ") : text(entry.authors),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(pluginQuery);
  }

  /** One badge, as the client draws one: a small pill, coloured by what it says. */
  function pill(badge) {
    const node = document.createElement("span");
    node.className = "badge" + (badge.kind ? " " + badge.kind : "");
    node.textContent = text(badge.text);
    if (badge.title) node.title = text(badge.title);
    return node;
  }

  /**
   * The switch, as the client draws one: a pill with a knob in it, green when it is
   * on. A button with `role="switch"` rather than a checkbox, because it acts the
   * moment it is pressed - there is nothing to submit - and `aria-checked` is then
   * the state a screen reader reads out.
   */
  function switchControl({ checked, label, disabled = false, onToggle }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "switch" + (checked ? " on" : "");
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", checked ? "true" : "false");
    button.setAttribute("aria-label", text(label));
    button.title = text(label);
    button.disabled = disabled === true;
    const knob = document.createElement("span");
    knob.className = "knob";
    button.appendChild(knob);
    button.addEventListener("click", (event) => {
      // the card behind the switch is not what was pressed
      event.stopPropagation();
      if (button.disabled) return;
      Promise.resolve(onToggle(!checked)).catch((err) => say(text(label) + ": " + why(err), "bad"));
    });
    return button;
  }

  /**
   * One card: the plugin's name, what it is, and the switch that turns it on.
   *
   * `onOpen` is optional on purpose. A plugin's name is the way into its settings, so
   * it is a button; a theme has no settings page, so a theme's name is a label rather
   * than a button that goes nowhere when it is pressed.
   */
  function addonCard({ id, name, meta, note, enabled, badges = [], actions = [], onToggle, onOpen }) {
    const card = document.createElement("div");
    card.className = "addon" + (enabled ? " on" : "");
    card.setAttribute("role", "listitem");
    card.setAttribute("data-id", text(id));

    const head = document.createElement("div");
    head.className = "addon-head";
    const who = document.createElement("div");
    who.className = "addon-who";

    const nameRow = document.createElement("div");
    nameRow.className = "addon-name-row";
    const title = document.createElement(onOpen ? "button" : "span");
    title.className = "addon-name";
    title.textContent = text(name || id);
    if (onOpen) {
      title.type = "button";
      title.title = "settings of " + text(name || id);
      title.addEventListener("click", () => {
        Promise.resolve(onOpen()).catch((err) => say(text(name || id) + ": " + why(err), "bad"));
      });
    }
    nameRow.appendChild(title);
    for (const badge of badges) {
      if (!badge || !badge.text) continue;
      nameRow.appendChild(pill(badge));
    }
    who.appendChild(nameRow);

    if (meta) {
      const line = document.createElement("div");
      line.className = "addon-meta";
      line.textContent = text(meta);
      who.appendChild(line);
    }
    head.appendChild(who);

    if (actions.length) {
      const tools = document.createElement("div");
      tools.className = "addon-tools";
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "icon-button" + (action.kind ? " " + action.kind : "");
        button.textContent = text(action.label);
        button.dataset.action = text(action.id || action.label);
        button.title = text(action.title || action.label);
        button.setAttribute("aria-label", text(action.title || action.label));
        button.addEventListener("click", () => {
          Promise.resolve(action.run()).catch((err) => say(text(action.label) + ": " + why(err), "bad"));
        });
        tools.appendChild(button);
      }
      head.appendChild(tools);
    }

    if (onToggle) {
      head.appendChild(
        switchControl({
          checked: enabled === true,
          // the label names the action the press will take, not the state it is in
          label: (enabled ? "disable " : "enable ") + text(name || id),
          onToggle,
        }),
      );
    }
    card.appendChild(head);

    if (note) {
      const line = document.createElement("p");
      line.className = "addon-note";
      line.textContent = text(note);
      card.appendChild(line);
    }
    return card;
  }

  /** The cards, or the sentence that says why there is nothing to show. */
  function fillGrid(containerId, cards, message) {
    const container = $(containerId);
    if (!container) return;
    if (!cards.length) {
      empty(container, message);
      return;
    }
    container.replaceChildren(...cards);
  }

  /**
   * The built runtime's own switch for one plugin - the one owner of "is this plugin on".
   *
   * The vendored catalogue is TypeScript source, so our own host cannot load it; the built
   * runtime can, and it keeps its own settings for every plugin it knows. `enabled` there is
   * the flag the runtime starts from on the next start, the flag its own plugin page writes,
   * and the flag the rest of the runtime reads (`isPluginEnabled`). So it is the only copy of
   * this that exists: this page reads it, writes it through the same store - which saves
   * itself - and keeps no second copy anywhere, which is why the card, the badge and the
   * runtime cannot disagree about a plugin again.
   *
   * Read live on every call rather than cached: the runtime arrives per window and a window
   * can be reloaded under a page that is already open.
   */
  const runtimeSwitch = {
    /** Whether the built runtime is in this window at all, which is not the same as it knowing one plugin. */
    present() {
      const V = window.Vencord;
      return Boolean(V && V.Plugins && typeof V.Plugins.startPlugin === "function");
    },

    /** What the runtime says about one id, or null when it has no such plugin. */
    of(id) {
      const V = window.Vencord;
      const box = V && V.Plugins && V.Plugins.plugins ? V.Plugins.plugins : null;
      if (!box) return null;
      const wanted = text(id);
      const known = catalogue.find((entry) => entry.id === wanted) || {};
      const key = runtimeKeyFor(box, known, wanted);
      const plugin = key ? box[key] : null;
      if (!plugin) return null;
      const settings = V.Settings && V.Settings.plugins ? V.Settings.plugins[key] : null;
      // a plugin that is required, or that another plugin depends on, is on because the
      // runtime says so: the same three answers its own isPluginEnabled gives
      const forced = plugin.required === true || plugin.isDependency === true;
      return {
        V,
        plugin,
        settings,
        enabled: forced || Boolean(settings && settings.enabled === true),
        running: plugin.started === true,
        // Whether the runtime can honor a switch here at all. A plugin whose patches have to
        // be applied while Discord loads cannot be turned on in a page that is already up -
        // upstream's own switch refuses for that reason - so it is written down and said
        // out loud rather than started and pretended.
        restart: typeof V.Plugins.pluginRequiresRestart === "function" ? V.Plugins.pluginRequiresRestart(plugin) === true : false,
        /** Whether the runtime has settings to show for it, which is when a cog is offered. */
        hasSettings: typeof V.Plugins.hasAnyVisibleSettings === "function" ? V.Plugins.hasAnyVisibleSettings(plugin) === true : false,
      };
    },

    /**
     * Turn a plugin on or off, the way the runtime's own plugin page does it.
     *
     * The flag is written last and only after the runtime agreed, because the flag is what
     * the next start reads: a plugin that failed to start must not be recorded as on. The
     * write persists by itself - the runtime's settings store saves every change through
     * its own storage - which is what makes the choice survive a restart of Discord.
     */
    set(id, on) {
      const found = this.of(id);
      if (!found) return { ok: false, error: "the built-in runtime has no plugin called " + id };
      const { V, plugin, settings } = found;
      if (!settings) return { ok: false, error: "the runtime keeps no settings for " + id + ", so a switch here could not be remembered" };
      if (found.enabled === Boolean(on)) return { ok: true, already: true, restart: false };
      try {
        // a plugin that patches Discord as it loads is only ever switched by being written
        // down: starting it here would add patches to modules that have already loaded
        if (found.restart) {
          settings.enabled = Boolean(on);
          return { ok: true, restart: true };
        }
        if (on) {
          const deps = typeof V.Plugins.startDependenciesRecursive === "function" ? V.Plugins.startDependenciesRecursive(plugin) : null;
          if (deps && Array.isArray(deps.failures) && deps.failures.length) {
            return { ok: false, error: "its dependencies could not start: " + deps.failures.join(", ") };
          }
          if (deps && deps.restartNeeded) {
            settings.enabled = true;
            return { ok: true, restart: true };
          }
        }
        const result = on ? V.Plugins.startPlugin(plugin) : V.Plugins.stopPlugin(plugin);
        if (result === false) {
          settings.enabled = false;
          return { ok: false, error: "the built-in runtime could not " + (on ? "start " : "stop ") + text(plugin.name || id) };
        }
        settings.enabled = Boolean(on);
        return { ok: true, restart: false };
      } catch (err) {
        return { ok: false, error: why(err) };
      }
    },

    /**
     * Open the plugin's own settings, drawn by the runtime that owns them.
     *
     * The fields a plugin declares are the plugin's, and half of them (the ones it computes)
     * could not be built anywhere else; a form assembled here would be a second copy of
     * settings this page does not own. What the plugin's settings window writes goes to the
     * same store the switch above reads, so the two cannot drift apart.
     */
    openSettings(id) {
      const found = this.of(id);
      const name = text((found && found.plugin.name) || id);
      if (!found) return { ok: false, error: "the built-in runtime no longer has " + id };
      if (!found.hasSettings) return { ok: false, error: name + " declares no settings" };
      const open = found.V.Components && found.V.Components.openPluginModal;
      if (typeof open !== "function") return { ok: false, error: "this build of the runtime has no settings window for its plugins" };
      open(found.plugin, (changed) => say(text(changed || name) + " changes take effect the next time Discord starts", "good"));
      // Whether the values in that window can be kept. The runtime saves its settings
      // through the page's storage, and Discord's own page has none (it removes
      // localStorage and sessionStorage), so on the real client the fields are for this
      // session only - which is worth saying, because a form that silently forgets is
      // worse than one that says it will. Which plugins are on is unaffected: that is
      // recorded by Hypercord and handed over at every start (src/loader.cjs).
      return { ok: true, kept: storageAvailable() };
    },
  };

  /**
   * The runtime's own plugin and theme browser, drawn by the runtime itself.
   *
   * These two pages are not ours to draw. The vendored runtime ships its own ones - the same
   * PluginsTab and ThemesTab that every other client of this platform shows, with its own
   * search, its own filters, its own cards, switches, badges, cogs and its own theme library -
   * and a second copy of them written here is a copy that can disagree with the thing it
   * describes. The way it disagreed was the worst possible one: a window carrying all 372
   * vendored plugins told its own user it had no runtime in it.
   *
   * So when the runtime is in this window and it has these components, its tab *is* the page.
   * The catalogue grid below is kept rather than deleted, and it is what a window with no
   * runtime gets - which is the only browser such a window can have, and the honest one.
   */
  const runtimeBrowser = {
    /** Whether the runtime in this window can draw its own browser at all. */
    available() {
      const V = window.Vencord;
      const components = V && V.Components;
      const common = V && V.Webpack && V.Webpack.Common;
      if (!components || !common) return false;
      return (
        typeof components.PluginsTab === "function" &&
        typeof components.ThemesTab === "function" &&
        typeof components.wrapTab === "function" &&
        Boolean(common.React) &&
        typeof common.createRoot === "function"
      );
    },

    /**
     * Put the runtime's tab for one page into the container that page owns, once.
     *
     * Once, and never again: the tab reads the runtime live - its own plugin list, its own
     * stores, its own settings - so re-rendering it would only throw away what the person
     * has typed into its search box. A tab that is already mounted is left exactly as it is,
     * which is what makes searching, switching, and coming back to the page work.
     */
    mount(which, hostId) {
      const host = $(hostId);
      if (!host || !this.available()) return false;
      if (host.getAttribute("data-mounted") === "true") return true;
      const V = window.Vencord;
      const themes = which === "themes";
      try {
        const tab = themes ? V.Components.ThemesTab : V.Components.PluginsTab;
        const wrapped = V.Components.wrapTab(tab, themes ? "Themes" : "Plugins");
        V.Webpack.Common.createRoot(host).render(V.Webpack.Common.React.createElement(wrapped, {}));
      } catch (err) {
        say("the runtime's own " + which + " page could not be drawn in this window: " + why(err), "bad");
        return false;
      }
      host.setAttribute("data-mounted", "true");
      return true;
    },
  };

  /**
   * Show one page as the runtime's own, or leave the hand-rolled browser standing.
   *
   * `fallbackId` is the block that browser lives in: hidden while the runtime draws the page,
   * shown again - and drawn - when it does not. Nothing is removed either way, so a runtime
   * that goes away underneath an open page falls back to the grid rather than to a blank one.
   */
  function useRuntimeBrowser(which, hostId, fallbackId) {
    const mounted = runtimeBrowser.mount(which, hostId);
    const host = $(hostId);
    if (host) host.classList.toggle("hidden", !mounted);
    const fallback = $(fallbackId);
    if (fallback) fallback.classList.toggle("hidden", mounted);
    return mounted;
  }

  /**
   * The runtime's own key for a catalogue entry, or "" when it has none.
   *
   * The runtime keys its plugins by the plugin's own name ("AccountPanelServerProfile"); the
   * catalogue keys them by the directory that plugin's source lives in, which is the same name in
   * lower case ("accountPanelServerProfile"). Matching on the catalogue's id alone made every
   * vendored plugin look absent from a window that had all 372 of them: the cards said no runtime,
   * the switches were refused with a sentence about the window, and the record was handed to the
   * runtime under a name it never reads. So the catalogue's own name goes first - it *is* the
   * plugin's name - then the id, then the runtime's keys matched without case, which is the answer
   * for a plugin whose upstream name and folder disagree beyond that. The scan is the expensive
   * one, so it is only run for a plugin the runtime is supposed to be running: ours are not in
   * that list at all.
   */
  function runtimeKeyFor(box, entry, id) {
    const named = text(entry && entry.name);
    if (named && box[named]) return named;
    if (box[id]) return id;
    if (!entry || entry.owner !== "runtime") return "";
    // without case, and from the id: the catalogue's id is the directory the plugin's source lives
    // in, which is the plugin's own name in lower case - and for a few entries it is the reliable
    // half, because the catalogue's `name` for them is a label rather than the plugin's name
    // ("Picture library" for betterImageEditor, "Clyde" for voiceJoinMessages). Some ids also carry
    // the platform the plugin belongs to on the end ("clipUpload.desktop"), which no runtime key has.
    const bare = (one) => text(one).split(".")[0].toLowerCase();
    const wanted = [bare(id), bare(named)].filter(Boolean);
    return Object.keys(box).find((key) => wanted.includes(key.toLowerCase())) || "";
  }

  /**
   * Whether a plugin is on, from whichever side owns it: the runtime, or our host.
   *
   * For a plugin the built runtime runs, the owner of "on" is the *record* Hypercord keeps -
   * `owner: "runtime"` in the host's own listing, `plugins.state.json` on disk - and not the
   * runtime's in-page flag. The flag is seeded from that record at every start and the record
   * is what the next start reads, so the record is the one that answers "will this be on"; the
   * runtime's flag is the second opinion, used only where there is no record to read (a
   * vendored entry in a window the runtime is not in, and the plugin's own live surface).
   */
  function isOn(entry) {
    if (entry.owner === "runtime") return entry.enabled === true;
    const built = runtimeSwitch.of(entry.id);
    return built ? built.enabled : entry.enabled === true;
  }

  /** And whether it is actually up: for a runtime plugin, started in this page. */
  function isRunning(entry) {
    const built = runtimeSwitch.of(entry.id);
    return built ? built.running : entry.running === true;
  }

  /**
   * What is waiting for the next start, for one plugin, or null when nothing is.
   *
   * Two facts decide it, and both are read rather than remembered: the runtime says it cannot
   * apply a switch in a page that is already up (`pluginRequiresRestart` - the plugin patches
   * Discord while it loads), and what the record wants (`entry.enabled`) is not what this page
   * is doing with it (`built.running`). A plugin that is on and running is not waiting for
   * anything, whoever recorded it; one written down as on that this page could not start is.
   * Nothing here is a copy of anyone's state - it is a reading of the two owners - which is why
   * the badge, the button and the names under it cannot disagree with them.
   */
  function pendingRestartFor(entry) {
    const built = runtimeSwitch.of(entry.id);
    // no runtime in this window: a restart of this process would apply nothing to a plugin the
    // runtime is not here to run, so it is not waiting for one - its card says where it is run
    if (!built || built.restart !== true) return null;
    const wanted = entry.enabled === true;
    if (wanted === built.running) return null;
    return { id: entry.id, name: entry.name || entry.id, wanted, running: built.running };
  }

  /** Everything waiting for the next start, in the order the catalogue lists it. */
  function pendingRestarts() {
    return catalogue.map(pendingRestartFor).filter(Boolean);
  }

  /** How a set of waiting plugins reads out loud: one name, two names, or a count. */
  function pendingNames(waiting) {
    const names = waiting.map((one) => text(one.name));
    if (names.length <= 2) return names.join(" and ");
    return names.slice(0, 2).join(", ") + " and " + (names.length - 2) + " more";
  }

  /**
   * The Restart button: offered when something is actually waiting, and it says what.
   *
   * A restart is blunt - it closes the client and opens it again - so it is not something to
   * ask for every time this page is drawn. It is offered exactly when the reading above found
   * something the next start will change: the label carries how many, the tooltip names them,
   * and with nothing waiting the button is disabled and says so rather than offering a press
   * that would apply nothing.
   */
  function paintRestart() {
    const waiting = pendingRestarts();
    const button = $("hp-pluginRestart");
    if (button) {
      button.disabled = waiting.length === 0;
      button.textContent = waiting.length ? "Restart \u00b7 " + waiting.length : "Restart";
      button.title = waiting.length
        ? "restart the client: " + pendingNames(waiting) + (waiting.length === 1 ? " needs" : " need") + " a start to take effect"
        : "nothing is waiting for a restart: every switch on this page is already applied in this window";
    }
    return waiting;
  }

  /**
   * What the catalogue says about a plugin, as badges: one state, then where it came from.
   *
   * A plugin the runtime is serving is not broken, whatever our own loader said about it:
   * the runtime is the thing running it, and it owns its switch and its settings store. And
   * a plugin the runtime cannot switch live says that instead of claiming to be running -
   * "enabled, restart to apply" is a different thing from "running", and the badge is where
   * the difference has to be visible.
   */
  function pluginBadges(entry) {
    const badges = [];
    const built = runtimeSwitch.of(entry.id);
    if (built) {
      // the same reading the Restart button offers: the badge and the button say the same
      // thing about the same plugin, so "restart to apply" cannot appear on a card while
      // nothing is waiting for the client to start again
      const waiting = pendingRestartFor(entry);
      if (built.running) badges.push({ text: "running", kind: "on" });
      else if (waiting && waiting.wanted) badges.push({ text: "restart to apply", kind: "own", title: "this plugin patches Discord while it loads, so the runtime cannot start it in a page that is already up" });
      else if (built.enabled) badges.push({ text: "enabled", kind: "on" });
      badges.push({ text: "built-in runtime", kind: "own", title: "equicord's runtime runs this plugin, in this page" });
    } else if (entry.owner === "runtime") {
      // A plugin the runtime owns and this window cannot offer, for one of two reasons that look
      // alike and are not: there may be no runtime here at all, or there may be one that does not
      // ship this plugin (26 of the catalogue's 371 are platform variants - ".desktop", ".dev",
      // ".equibop" - and plugins the browser build leaves out). The second is not the window's
      // fault and is not the plugin being broken, so it is named for what it is.
      badges.push(
        runtimeSwitch.present()
          ? { text: "not in this build", kind: "own", title: "the catalogue lists this plugin and the built runtime in this window does not ship it" }
          : { text: "no runtime", kind: "bad", title: "the built-in runtime is not in this window, so the vendored catalogue cannot be switched here" },
      );
    } else if (entry.broken) badges.push({ text: "broken", kind: "bad", title: text(entry.broken) });
    else if (entry.enabled && entry.running) badges.push({ text: "running", kind: "on" });
    else if (entry.enabled) badges.push({ text: "enabled", kind: "on" });
    if (isOurs(entry)) badges.push({ text: "Hypercord", kind: "own" });
    else if (entry.source) badges.push({ text: text(entry.source) });
    if (entry.defaultOn) badges.push({ text: "Hyper set", kind: "own", title: text(entry.defaultSet) });
    return badges;
  }

  function pluginMeta(entry) {
    const authors = Array.isArray(entry.authors) && entry.authors.length ? entry.authors.join(", ") : "unknown author";
    return "by " + authors + (entry.version ? " \u00b7 v" + text(entry.version) : "");
  }

  function pluginCard(entry) {
    const built = runtimeSwitch.of(entry.id);
    if (built) {
      // The runtime owns this plugin's switch *and* its settings, and it draws its own
      // settings window for them: the cog opens that, so what the card offers is the plugin's
      // real form rather than a copy of it. A plugin with nothing to configure gets no cog -
      // a button that opens an empty window is worse than no button - and its meta line says
      // so instead.
      return addonCard({
        id: entry.id,
        name: entry.name || entry.id,
        meta: pluginMeta(entry) + " \u00b7 " + (built.hasSettings ? "settings: built-in runtime" : "no settings"),
        note: text(built.plugin.description || entry.description || ""),
        enabled: built.enabled,
        badges: pluginBadges(entry),
        actions: built.hasSettings
          ? [
              {
                id: "settings",
                label: "\u2699",
                kind: "cog",
                title: "settings of " + text(entry.name || entry.id) + ", as the built-in runtime draws them",
                run: () => openRuntimeSettings(entry.id),
              },
            ]
          : [],
        onToggle: (on) => toggleRuntimePlugin(entry.id, on),
      });
    }
    return addonCard({
      id: entry.id,
      name: entry.name || entry.id,
      meta: pluginMeta(entry),
      // a plugin that could not start says why on its card: the reason is the useful
      // thing about it, and the description is already known
      note: entry.broken ? text(entry.broken) : text(entry.description),
      enabled: entry.enabled === true,
      badges: pluginBadges(entry),
      actions: [
        {
          id: "settings",
          label: "\u2699",
          kind: "cog",
          title: "settings of " + text(entry.name || entry.id),
          run: () => openSettings(entry.id),
        },
      ],
      onToggle: (on) => togglePlugin(entry.id, on),
      onOpen: () => openSettings(entry.id),
    });
  }

  /** Whether this page can keep anything at all: Discord's own page removes both storages. */
  /**
   * Whether the values written in the runtime's own settings window will still be there next time.
   *
   * This used to be "does this page have localStorage", and on Discord's page that was always
   * false - so the sheet told the person their plugin options were for this session only. That
   * answer is out of date twice over: the page still has none, and it no longer matters. The
   * preload hands the page a settings store backed by a file in Hypercord's data directory
   * (see `runtimeStore` in src/loader.cjs), read and written synchronously through the shell, so
   * the honest test is whether that store answers and takes the answer back - which is what the
   * round trip below asks, without changing anything it holds.
   */
  function storageAvailable() {
    try {
      const box = window.hypercord && window.hypercord.runtime ? window.hypercord.runtime.settings : null;
      if (box && typeof box.read === "function" && typeof box.write === "function") {
        const held = box.read();
        return typeof held === "string" && box.write(held) === true;
      }
    } catch {
      /* no bridge to ask: fall through to what the page itself has */
    }
    try {
      return typeof window.localStorage === "object" && window.localStorage !== null;
    } catch {
      return false;
    }
  }

  /** The plugin's own settings, or the reason there are none to show. */
  function openRuntimeSettings(id) {
    const res = runtimeSwitch.openSettings(id);
    if (res && res.ok === false) say(text(res.error), "bad");
    else if (res && res.ok === true && res.kept === false) showSettingsUnstored();
    return res;
  }

  /**
   * Say once that the runtime's own settings cannot be saved here, rather than every time.
   *
   * Said in the sheet's status line, where every other answer lands: a window whose fields
   * are forgotten on the next start is a fact about this page, not a failure of the press.
   */
  let saidUnstored = false;
  function showSettingsUnstored() {
    if (saidUnstored) return;
    saidUnstored = true;
    say("changes in that window last for this session only: Discord's page has no storage for the runtime to save them in. Which plugins are on is kept by Hypercord", "bad");
  }

  /**
   * Turn a plugin the built runtime serves on or off, in the runtime.
   *
   * The whole change is one call into the owner above. Nothing goes through our host and
   * nothing is written to our own plugin state: the runtime's settings are where "this plugin
   * is on" lives, and the flag the switch writes is the same one the runtime starts from on
   * the next start - which is the difference between a plugin that comes back and one that
   * quietly does not. A switch the runtime cannot honor live is said out loud rather than
   * reported as done, and a refusal lands in the sheet's status line the way a host refusal
   * does, so a failure is never a dead click and a runtime that has gone away underneath an
   * open page says so rather than throwing.
   */
  async function toggleRuntimePlugin(id, on) {
    const found = runtimeSwitch.of(id);
    const name = text((found && found.plugin.name) || id);
    // The record first, because the record is the owner: the runtime is handed it at every
    // start, and the page cannot keep it (Discord's page has no storage to keep a switch in -
    // see src/loader.cjs and the `runtime` field in src/plugin-host.js). Recording first also
    // means a plugin that cannot start right now is still on at the next start, which is the
    // honest order for a patch-based plugin: its work happens while Discord loads.
    const kept = await guard((on ? "enable " : "disable ") + id, () => (on ? hc.plugins.enable(id) : hc.plugins.disable(id)));
    if (!kept || kept.ok !== true) {
      say((on ? "could not enable " : "could not disable ") + name + ": " + text((kept && kept.error) || "the shell did not record it"), "bad");
      await loadPlugins();
      return;
    }
    // no runtime in this window: the choice is kept and honored where a runtime can honor it
    if (!found) {
      say(name + " will be " + (on ? "on" : "off") + " the next time Discord starts: this window has no built-in runtime for it", "good");
      await loadPlugins();
      return;
    }
    const res = runtimeSwitch.set(id, on);
    if (!res || res.ok !== true) {
      // recorded, not rolled back: the next start is where a refusal can still be undone by
      // the runtime trying again, and saying what happened is the whole point here
      say(name + " is recorded as " + (on ? "on" : "off") + ", but the built-in runtime would not " + (on ? "start" : "stop") + " it in this page: " + text((res && res.error) || "it refused"), "bad");
      await loadPlugins();
      return;
    }
    if (res.restart) say(name + " is " + (on ? "on" : "off") + " and takes effect the next time Discord starts: it patches Discord as it loads, so it cannot be switched in a page that is already up (Restart, above, is that start)", "good");
    else if (res.already) say(name + " is already " + (on ? "on" : "off"), "good");
    else say((on ? "started " : "stopped ") + name + " in the built-in runtime", "good");
    await loadPlugins();
  }

  /**
   * Restart the client, from here.
   *
   * One thing cannot be applied to a process that is already running: the main-process half -
   * the loader and the host it starts - and every plugin that patches Discord while it loads.
   * The cards say so ("restart to apply"), and this is the restart they mean, asked
   * for from the page that says it is due rather than from Discord's tray icon. The shell does
   * the work; a client with no way to restart itself is said out loud rather than left as a
   * button that does nothing, and so is a refusal.
   */
  async function restartClient() {
    // Asked for only when something is waiting. A restart closes the client, and a button that
    // restarts it for a request that would apply nothing is one people learn not to press - so
    // the reading decides, and a press that arrives with nothing waiting says so instead.
    const waiting = pendingRestarts();
    if (!waiting.length) {
      say("nothing is waiting for a restart: every switch on this page is already applied in this window", "good");
      return { ok: false, error: "nothing is waiting for a restart" };
    }
    if (!hc || !hc.client || typeof hc.client.relaunch !== "function") {
      say("this client has no way to restart itself: close it and open it again", "bad");
      return { ok: false, error: "no client to restart" };
    }
    const res = await guard("restart", () => hc.client.relaunch());
    if (res && res.ok) say("restarting the client: " + pendingNames(waiting) + (waiting.length === 1 ? " takes" : " take") + " effect when it comes back", "good");
    else say("the client would not restart: " + text((res && res.error) || "no answer from the shell") + " - close it and open it again", "bad");
    return res;
  }

  async function loadPlugins() {
    const list = await guard("plugins", () => hc.plugins.list());
    if (!Array.isArray(list)) {
      empty($("hp-pluginList"), "the plugin catalogue could not be read");
      empty($("hp-hyperList"), "the plugin catalogue could not be read");
      return;
    }
    catalogue = list;
    renderPlugins();
    renderHyper();
  }

  function renderPlugins() {
    // the runtime's own plugin browser when this window has one - see runtimeBrowser
    if (useRuntimeBrowser("plugins", "hp-runtimePlugins", "hp-pluginFallback")) return;
    const search = $("hp-pluginSearch");
    pluginQuery = text(search ? search.value : "")
      .trim()
      .toLowerCase();
    const rows = sortedCatalogue(catalogue).filter(matchesBrowser);
    renderCategoryChips();
    // every draw of this page also says what a restart would apply, if anything: the button
    // is only offered when something is waiting, and the summary names it - the whole
    // catalogue is read rather than the filtered rows, because a restart applies all of it
    const waiting = paintRestart();
    const summary = $("hp-pluginSummary");
    if (summary) {
      summary.textContent =
        rows.length +
        (pluginQuery || pluginFilter !== "all" || pluginCategory ? " of " + catalogue.length : "") +
        (pluginCategory ? " in " + pluginCategory : "") +
        " plugins \u00b7 " +
        catalogue.filter(isOurs).length +
        " ours \u00b7 " +
        // counted from whichever side owns each plugin: a runtime plugin that is on must
        // not be counted as off because our own state file has never heard of it
        rows.filter(isOn).length +
        " enabled \u00b7 " +
        rows.filter(isRunning).length +
        " running" +
        (waiting.length ? " \u00b7 " + pendingNames(waiting) + (waiting.length === 1 ? " is" : " are") + " waiting for a restart" : "");
    }
    fillGrid("hp-pluginList", rows.map(pluginCard), catalogue.length ? "nothing matches that search" : "the catalogue is empty");
  }

  function renderHyper() {
    const ours = sortedCatalogue(catalogue.filter(isOurs));
    const summary = $("hp-hyperSummary");
    if (summary) {
      summary.textContent =
        ours.length + " of ours in the catalogue \u00b7 " + ours.filter(isRunning).length + " running";
    }
    fillGrid("hp-hyperList", ours.map(pluginCard), "no Hypercord plugins in the catalogue");
  }

  async function togglePlugin(id, on) {
    const known = catalogue.find((entry) => entry.id === id) || {};
    // A plugin the built runtime owns is not this host's to switch, so this is said out loud
    // rather than recorded for a runtime this window does not have - the operator would read
    // "enabled" for a plugin nothing here can start. Two reasons look the same from the outside
    // and only one of them is about the window: there may be no runtime here at all, or there may
    // be one that does not know this plugin (a catalogue older than the build). The sentence used
    // to assert the first whatever the truth was, which is how a client with all 372 plugins in
    // it told its own user that the window had no runtime in it.
    if (known.owner === "runtime") {
      say(
        runtimeSwitch.present()
          ? text(known.name || id) + " is not in the built-in runtime's plugin list in this window, so there is nothing here to switch: the catalogue lists it as " + text(id)
          : text(known.name || id) + " is switched by the built-in runtime, and this window has no runtime in it: " + text(known.broken || "the vendored catalogue needs the built runtime"),
        "bad",
      );
      await loadPlugins();
      return;
    }
    const res = await guard((on ? "enable " : "disable ") + id, () => (on ? hc.plugins.enable(id) : hc.plugins.disable(id)));
    if (res && res.ok) say((on ? "enabled " : "disabled ") + id, "good");
    await loadPlugins();
    // an open page follows the plugin it is about, without being rebuilt: rebuilding
    // it would throw away a field somebody is in the middle of typing into
    if (settingsFor === id) paintDetailState(catalogue.find((entry) => entry.id === id) || { id });
  }

  /* ---- one plugin's own page ------------------------------------------------ */

  /**
   * Is a plugin's page up, and is this the list it was opened from?
   *
   * The page belongs to the sheet rather than to the catalogue, because both plugin
   * pages open it - and while it is up the grid it came from steps aside, the way one
   * of Discord's own settings subpages covers the page it was opened from.
   */
  let settingsFor = "";

  function showDetail(on) {
    const panel = $("hp-pluginDetail");
    if (panel) panel.classList.toggle("hidden", !on);
    for (const id of ["hp-pluginFilters", "hp-pluginSummary", "hp-pluginList", "hp-hyperSummary", "hp-hyperList"]) {
      const node = $(id);
      if (node) node.classList.toggle("hidden", on);
    }
    // The two browsers are not shown and hidden by this: which of them this window has is
    // decided in one place (useRuntimeBrowser), so closing a plugin's page asks that question
    // again rather than answering it here - otherwise a window with the runtime's own browser
    // would get the hand-rolled grid stacked underneath it the moment a page was closed.
    const runtime = runtimeBrowser.mount("plugins", "hp-runtimePlugins");
    for (const [id, visible] of [
      ["hp-runtimePlugins", runtime],
      ["hp-pluginFallback", !runtime],
    ]) {
      const node = $(id);
      if (node) node.classList.toggle("hidden", on || !visible);
    }
    if (!on) settingsFor = "";
  }

  /** The plugin's state beside its name, in the same badges its card wears. */
  function paintDetailState(entry) {
    const box = $("hp-detailState");
    if (!box) return;
    box.replaceChildren(...pluginBadges(entry).map(pill));
  }

  /** The id of a control, so a label can point at it: ids are document-wide, hence hp-. */
  function settingId(id, key) {
    return "hp-set-" + id + "-" + key;
  }

  /** Which control a setting gets: the declared type first, the saved value second. */
  function settingKind(declared, value) {
    if (declared.type === "boolean" || typeof value === "boolean") return "boolean";
    if (declared.type === "number" || typeof value === "number") return "number";
    return "string";
  }

  /**
   * One setting, as a row: what it is called on one side, what it does under that, and
   * the control on the other - the shape the client uses for its own settings, and the
   * reason a page of plugin settings can be read at a glance.
   *
   * The control saves when it changes, through `saveSetting`, so a refusal from the
   * host lands in the status line instead of being swallowed by a form nobody submits.
   */
  function settingRow(id, key, declared, value) {
    const row = document.createElement("div");
    row.className = "setting";
    row.dataset.key = key;

    const main = document.createElement("div");
    main.className = "setting-main";
    const label = document.createElement("label");
    label.className = "setting-label";
    // the label is what the setting is called, and the key is only a fallback: a
    // plugin that describes its settings in words gets those words on the page
    label.textContent = text(declared.label || key);
    label.setAttribute("for", settingId(id, key));
    main.appendChild(label);
    if (declared.description) {
      const note = document.createElement("div");
      note.className = "setting-note";
      note.textContent = text(declared.description);
      main.appendChild(note);
    }
    row.appendChild(main);

    const control = document.createElement("div");
    control.className = "setting-control";
    const kind = settingKind(declared, value);

    if (kind === "boolean") {
      control.appendChild(
        switchControl({
          checked: value === true,
          label: text(declared.label || key),
          onToggle: (next) => saveSetting(id, key, next),
        }),
      );
    } else if (kind === "number" && declared.min !== undefined && declared.max !== undefined) {
      // a number with a range is a slider, and it says its own value beside it: a
      // number that could be dragged has no business being typed
      const wrap = document.createElement("div");
      wrap.className = "slider";
      const range = document.createElement("input");
      range.type = "range";
      range.id = settingId(id, key);
      range.min = text(declared.min);
      range.max = text(declared.max);
      range.step = text(declared.step || 1);
      range.value = text(value === undefined || value === null ? (declared.default === undefined ? declared.min : declared.default) : value);
      const out = document.createElement("span");
      out.className = "slider-value";
      out.textContent = range.value;
      range.addEventListener("input", () => {
        out.textContent = range.value;
      });
      range.addEventListener("change", () => saveSetting(id, key, Number(range.value)));
      wrap.appendChild(range);
      wrap.appendChild(out);
      control.appendChild(wrap);
    } else if (Array.isArray(declared.options) && declared.options.length) {
      const select = document.createElement("select");
      select.className = "select";
      select.id = settingId(id, key);
      for (const option of declared.options) {
        const one = document.createElement("option");
        const named = option && typeof option === "object";
        one.value = text(named ? option.value : option);
        one.textContent = text(named ? (option.label === undefined ? option.value : option.label) : option);
        select.appendChild(one);
      }
      select.value = text(value === undefined || value === null ? declared.default : value);
      select.addEventListener("change", () => saveSetting(id, key, select.value));
      control.appendChild(select);
    } else {
      const input = document.createElement("input");
      input.type = "text";
      input.id = settingId(id, key);
      input.spellcheck = false;
      if (kind === "number") input.inputMode = "decimal";
      input.value = value === undefined || value === null ? "" : String(value);
      // a text field saves when it is left or Enter is pressed: saving on every
      // keystroke would write a half-typed word to disk
      input.addEventListener("change", () => {
        if (kind !== "number") return saveSetting(id, key, input.value);
        const number = Number(input.value);
        if (!Number.isFinite(number)) {
          say("not a number: " + key, "bad");
          input.value = value === undefined || value === null ? "" : String(value);
          return undefined;
        }
        return saveSetting(id, key, number);
      });
      control.appendChild(input);
    }
    row.appendChild(control);
    return row;
  }

  async function saveSetting(id, key, value) {
    const res = await guard("save " + key, () => hc.plugins.setSetting(id, key, value));
    if (res && res.ok) {
      const shown = typeof value === "boolean" ? (value ? "on" : "off") : text(value);
      say("saved " + id + "." + key + " = " + shown, "good");
    }
    return res;
  }

  /**
   * One plugin's page: its name, what it is, its state, and the fields it declares.
   *
   * Nothing is cached between opens - the settings are read when the page is shown -
   * and the reply is checked against the plugin that is open when it arrives: a page
   * left while its own settings were still in flight must not be filled afterwards.
   */
  async function openSettings(id) {
    const panel = $("hp-pluginDetail");
    const form = $("hp-settingsForm");
    if (!panel || !form) return;
    const wanted = text(id);
    const entry = catalogue.find((item) => item.id === wanted) || { id: wanted };
    settingsFor = wanted;
    showDetail(true);
    const title = $("hp-detailTitle");
    if (title) title.textContent = text(entry.name || wanted);
    const note = $("hp-detailNote");
    if (note) note.textContent = entry.broken ? text(entry.broken) : text(entry.description);
    paintDetailState(entry);
    form.replaceChildren();
    // the page opens at its own top, not at wherever the grid was scrolled to
    panel.scrollTop = 0;

    const saved = await guard("settings for " + wanted, () => hc.plugins.settings(wanted));
    if (settingsFor !== wanted) return; // the page was left while the reply was in flight
    const values = saved && typeof saved === "object" ? saved : {};
    const schema = Array.isArray(entry.settings) ? entry.settings : [];
    const settingKeys = [...schema.map((item) => text(item.key)).filter(Boolean)];
    for (const key of Object.keys(values)) if (!settingKeys.includes(key)) settingKeys.push(key);

    if (!settingKeys.length) {
      // A plugin declares its settings in its own module, and that module is only read
      // when the plugin starts: so "no settings here" has three different meanings and
      // saying which one it is is the difference between a page that looks broken and a
      // page that says what to do next.
      const none = document.createElement("div");
      none.className = "setting";
      const mine = catalogue.find((item) => item.id === wanted) || {};
      if (mine.broken) none.textContent = "this plugin could not start, so it has no settings to show: " + text(mine.broken);
      else if (!mine.enabled) none.textContent = "this plugin is not enabled, and a plugin declares its settings when it starts: enable it and this page will have its fields";
      else if (!mine.running) none.textContent = "this plugin is enabled but not running, and a plugin declares its settings when it starts";
      else none.textContent = "this plugin declares no settings";
      form.appendChild(none);
      return;
    }

    for (const key of settingKeys) {
      const declared = schema.find((item) => text(item.key) === key) || {};
      const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : declared.default;
      form.appendChild(settingRow(wanted, key, declared, value));
    }
  }

  /**
   * Back to the list. The page is emptied and the grids are drawn again from the
   * catalogue, so coming back lands on the list as it was rather than on an empty
   * page where the grid used to be.
   */
  function closeSettings() {
    showDetail(false);
    const form = $("hp-settingsForm");
    if (form) form.replaceChildren();
    renderPlugins();
    renderHyper();
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

  /* ---- beef ---------------------------------------------------------------- */

  // The one page whose contents another plugin owns. `hyperBeef` describes its own
  // section as data - its description, what it holds, which of its functions may be
  // called - and this renders that description rather than knowing anything about
  // generators. Every value is written as text, and a call that fails says so in the
  // sheet's own status line: nothing here is built from markup.
  const BEEF_PLUGIN = "hyperBeef";

  /** Rows of `name: value`, which is what a generator's state is. */
  function beefRows(container, pairs, message) {
    if (!container) return;
    container.replaceChildren();
    const rows = pairs.filter(([, value]) => text(value).trim() !== "");
    if (!rows.length) {
      empty(container, text(message || "nothing to show yet"));
      return;
    }
    for (const [name, value] of rows) container.appendChild(card({ name, description: text(value) }));
  }

  /**
   * An object the server sent, as its own fields. The page does not know the shape of
   * what the control server reports, so it names each field it was given instead of
   * inventing a summary that could be wrong.
   */
  function beefObjectRows(prefix, value) {
    if (!value || typeof value !== "object") return [];
    const rows = [];
    for (const [key, field] of Object.entries(value)) {
      if (field === null || field === undefined || (typeof field === "object" && !Array.isArray(field))) continue;
      rows.push([prefix ? prefix + " \u00b7 " + key : key, Array.isArray(field) ? field.map(text).join(", ") : text(field)]);
    }
    return rows;
  }

  /** The rollback target, named by whichever fields the server sent. */
  function beefBackupText(backup) {
    if (!backup || typeof backup !== "object") return "the copy the last accepted push replaced";
    const parts = Object.entries(backup)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => key + " " + text(value === true ? "yes" : value === false ? "no" : value));
    return parts.join(" \u00b7 ") || "the copy the last accepted push replaced";
  }

  /** What the section says about the generator, as rows - only what it reported. */
  function beefStatePairs(state) {
    const pairs = [];
    if (!state || typeof state !== "object") return pairs;
    // Which path is answering, first: "the control server" and "this client's own engine"
    // are two very different machines to be looking at, and the rest of the rows only make
    // sense once that is on the page.
    if (text(state.answers).trim() !== "") pairs.push(["Answered by", text(state.answers)]);
    pairs.push(["Generator", state.ready ? "ready" : "not ready"]);
    if (Number(state.banks) > 0) pairs.push(["Built-in kinds", text(state.banks) + " (used when the generator has no category for one)"]);
    const categories = Array.isArray(state.categories) ? state.categories : [];
    if (categories.length) pairs.push(["Categories", categories.length + " \u00b7 " + categories.map(text).join(", ")]);
    if (state.droppedShown !== false && Array.isArray(state.dropped) && state.dropped.length) {
      const remapped = state.remapped && typeof state.remapped === "object" ? state.remapped : {};
      pairs.push([
        "Dropped",
        state.dropped.map((name) => text(name) + (remapped[name] ? " \u2192 " + text(remapped[name]) : "")).join(", "),
      ]);
    }
    if (Number(state.generations) > 0) pairs.push(["Generations", text(state.generations)]);
    if (Number(state.reloadMs) > 0) pairs.push(["Last reload", text(state.reloadMs) + " ms"]);
    if (state.source) pairs.push(["Source", text(state.source)]);
    if (state.backup) pairs.push(["Rollback target", beefBackupText(state.backup)]);
    if (state.lastError) pairs.push(["Last error", text(state.lastError)]);
    if (state.at) pairs.push(["Read at", new Date(state.at).toLocaleString()]);
    return pairs;
  }

  /**
   * The functions the section declares, as buttons. A function that declares an input
   * opens the field it needs when it is pressed; one that does not runs immediately.
   * The route each one calls is the button's tooltip, so what a click will do is
   * readable before it is clicked.
   */
  function renderBeefActions(section) {
    const row = $("hp-beefActions");
    if (!row) return;
    row.replaceChildren();
    const actions = Array.isArray(section.actions) ? section.actions : [];
    if (!actions.length) {
      const none = document.createElement("span");
      none.className = "hint";
      none.textContent = "this section declares no functions";
      row.appendChild(none);
      return;
    }
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text(action.label || action.id);
      button.title = text(action.route) + (action.needs ? " \u00b7 needs " + text(action.needs) : "");
      button.setAttribute("data-beef-action", text(action.id));
      if (action.input) button.className = "ghost";
      button.addEventListener("click", () => {
        if (!action.input) {
          runBeef(action, null);
          return;
        }
        const value = revealBeefInput(action);
        if (value !== null) runBeef(action, value);
      });
      row.appendChild(button);
    }
  }

  /** Put the field away: the page shows one at a time, and only while it is being filled in. */
  function closeBeefInput() {
    const row = $("hp-beefInput");
    if (!row) return;
    row.replaceChildren();
    row.classList.add("hidden");
    row.removeAttribute("data-beef-for");
  }

  /**
   * The field a function declared it needs, revealed under the buttons. Pressing the
   * function again with something typed into its field runs it, and pressing it with the
   * field empty (or putting it away and pressing it again) closes it - so the way out of
   * a field someone opened by mistake is one more press, never a lost page.
   */
  function revealBeefInput(action) {
    const row = $("hp-beefInput");
    if (!row) return null;
    const id = text(action.id);
    const open = row.getAttribute("data-beef-for") === id;
    const held = open ? row.querySelector("[data-beef-value]") : null;
    if (open) {
      const value = held ? text(held.value) : "";
      closeBeefInput();
      return value.trim() === "" ? null : value;
    }
    row.replaceChildren();
    row.setAttribute("data-beef-for", id);
    row.classList.remove("hidden");
    const label = document.createElement("label");
    label.className = "hint";
    label.textContent = text(action.input);
    // a generator is a file, so its answer is given room; the rest are one line
    const control = /source/i.test(text(action.input)) ? document.createElement("textarea") : document.createElement("input");
    if (control.tagName === "TEXTAREA") control.rows = 6;
    else control.type = "text";
    control.setAttribute("data-beef-value", "");
    control.setAttribute("aria-label", text(action.input));
    control.spellcheck = false;
    const run = document.createElement("button");
    run.type = "button";
    run.textContent = "Run " + text(action.label || id);
    run.addEventListener("click", () => runBeef(action, text(control.value)));
    row.appendChild(label);
    row.appendChild(control);
    row.appendChild(run);
    control.focus();
    return null;
  }

  /**
   * Run one of a section's functions and show what came back. The reply is the plugin's
   * own - it is never interpreted into a claim the plugin did not make - and the page
   * re-reads the section afterwards, because the plugin's state is what it displays.
   */
  async function runBeef(action, value) {
    const id = text(action.id);
    const res = await guard(text(action.label || id), () => hc.plugins.sectionAction(BEEF_PLUGIN, id, value));
    if (!res) return;
    if (res.ok === false) {
      say(text(action.label || id) + ": " + text(res.error || "the plugin refused"), "bad");
      return;
    }
    showBeefAnswer(action, res);
    say(text(action.label || id) + ": done", "good");
    closeBeefInput();
    await loadBeef();
  }

  /** The reply, in the one region that fits it. */
  function showBeefAnswer(action, res) {
    const out = $("hp-beefOut");
    const id = text(action.id);
    if (id === "last") {
      renderLastBeef(res);
      if (out) out.textContent = "";
      return;
    }
    if (id === "inspect") {
      const read = res.read;
      if (out) out.textContent = read && typeof read === "object" ? JSON.stringify(read, null, 1) : text(read);
      return;
    }
    if (id === "start") {
      const lines = [res.via ? "started via " + text(res.via) : "started"];
      if (res.note) lines.push(text(res.note));
      if (res.json) lines.push(JSON.stringify(res.json, null, 1));
      if (out) out.textContent = lines.join("\n");
      return;
    }
    // reload, rollback, install: the values the plugin's reply carries, and the state
    // table above is the generator's own
    const fields = Object.entries(res)
      .filter(([, held]) => ["string", "number", "boolean"].includes(typeof held))
      .map(([key, held]) => key + ": " + text(held));
    if (out) out.textContent = [text(action.route || id)].concat(fields).join("\n");
  }

  /** The last beef and the history the server keeps, field by field. */
  function renderLastBeef(res) {
    const beef = res && res.beef && typeof res.beef === "object" ? res.beef : null;
    const history = res && Array.isArray(res.history) ? res.history : [];
    const pairs = beefObjectRows("beef", beef);
    if (beef) pairs.unshift(["Last beef", "reported"]);
    if (res && Number(res.total) > 0) pairs.push(["History", history.length + " shown of " + text(res.total) + " kept"]);
    history.forEach((entry, index) => pairs.push(...beefObjectRows("history " + (index + 1), entry)));
    // the same page answers from either path, so the empty case does not name one
    beefRows($("hp-beefLast"), pairs, "no beef has been recorded yet");
  }

  /**
   * The section's settings, from what the host has saved and the plugin's own defaults.
   * The values come from the plugin host, not from the state above: "which settings are
   * on" and "what the generator is doing" are two different things, and only one of
   * them is a form.
   */
  function renderBeefSettings(section, saved) {
    const form = $("hp-beefSettings");
    if (!form) return;
    form.replaceChildren();
    const settings = Array.isArray(section.settings) ? section.settings : [];
    if (!settings.length) {
      const none = document.createElement("div");
      none.className = "field";
      none.textContent = "this section has no settings";
      form.appendChild(none);
      return;
    }
    const values = saved && typeof saved === "object" ? saved : {};
    for (const declared of settings) {
      const key = text(declared.key);
      if (!key) continue;
      const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : declared.default;
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      label.textContent = text(declared.label || key);
      if (declared.description) label.title = text(declared.description);
      const input = document.createElement("input");
      if (declared.type === "boolean") {
        input.type = "checkbox";
        input.checked = value === true;
        input.dataset.kind = "boolean";
      } else {
        input.type = "text";
        input.inputMode = declared.type === "number" ? "numeric" : "text";
        input.value = value === undefined || value === null ? "" : text(value);
        input.dataset.kind = declared.type === "number" ? "number" : "string";
      }
      input.id = "hp-beef-set-" + key;
      input.dataset.key = key;
      label.setAttribute("for", input.id);
      input.addEventListener("change", () => saveBeefSetting(key, input));
      field.appendChild(label);
      field.appendChild(input);
      form.appendChild(field);
    }
  }

  async function saveBeefSetting(key, input) {
    let value;
    if (input.dataset.kind === "boolean") value = input.checked;
    else if (input.dataset.kind === "number") value = Number(input.value);
    else value = String(input.value);
    if (input.dataset.kind === "number" && !Number.isFinite(value)) {
      say("not a number: " + key, "bad");
      return;
    }
    const res = await guard("save " + key, () => hc.plugins.setSetting(BEEF_PLUGIN, key, value));
    if (res && res.ok) {
      say("saved " + key, "good");
      await loadBeef();
    }
  }

  /**
   * The Beef page. Nothing is cached across opens: the section is asked for when the
   * page is shown, which is when a plugin that is not running says so instead of the
   * page showing an empty generator that looks like a broken one.
   */
  async function loadBeef() {
    const res = await guard("beef", () => hc.plugins.section(BEEF_PLUGIN));
    const section = res && res.ok !== false && res.section ? res.section : null;
    const intro = $("hp-beefIntro");
    const reason = $("hp-beefReason");
    if (!section) {
      // A page whose plugin is not running is the ordinary case rather than an error
      // to report: this page is the plugin's own section, so it says that plainly, and
      // keeps the host's own words when the failure was something else.
      const detail = text((res && res.error) || "");
      const stopped = "the beef plugin is not running, so this page has nothing to describe";
      const why = /running/i.test(detail) ? stopped : detail || stopped;
      if (intro) {
        intro.textContent =
          "Beef: the generator the beef path draws its filler from, its reload and rollback, the line lab that says what the bot would do with a line, and the last beef that ran. It is answered by the control server when one is configured, and by this client's own engine when one is not, so this page works either way. It is the plugin's own section and appears while the plugin is running.";
      }
      if (reason) reason.textContent = why;
      beefRows($("hp-beefState"), [], why);
      renderBeefActions({ actions: [] });
      renderBeefSettings({ settings: [] }, {});
      renderLastBeef(null);
      const out = $("hp-beefOut");
      if (out) out.textContent = "";
      closeBeefInput();
      return;
    }
    if (intro) intro.textContent = text(section.description);
    const state = section.state && typeof section.state === "object" ? section.state : {};
    if (reason) reason.textContent = text(state.reason);
    beefRows($("hp-beefState"), beefStatePairs(state), "the section reported nothing about the generator yet");
    renderBeefActions(section);
    const saved = await guard("beef settings", () => hc.plugins.settings(BEEF_PLUGIN));
    renderBeefSettings(section, saved && typeof saved === "object" ? saved : {});
  }

  /* ---- themes -------------------------------------------------------------- */

  async function loadThemes() {
    const list = await guard("themes", () => hc.themes.list());
    const quick = await guard("quick css", () => hc.themes.quickCss());
    const box = $("hp-quickCss");
    if (box) box.value = typeof quick === "string" ? quick : "";
    renderThemes(Array.isArray(list) ? list : []);
  }

  /**
   * The installed themes, as the same cards the plugins wear: the switch turns one on
   * where the card is, and Remove is the one action a theme has. A theme has no
   * settings page, so its name is a label rather than a button - a theme card that
   * opened an empty page would be worse than one that opens nothing.
   */
  function renderThemes(list) {
    installedThemes = list;
    // the runtime's own theme browser when this window has one - see runtimeBrowser
    if (useRuntimeBrowser("themes", "hp-runtimeThemes", "hp-themeFallback")) return;
    fillGrid(
      "hp-themeList",
      list.map((theme) => {
        const badges = [{ text: text(theme.source || "local") }];
        if (theme.builtin) badges.push({ text: "built-in", kind: "own" });
        if (theme.missing) badges.push({ text: "file gone", kind: "bad" });
        return addonCard({
          id: theme.id,
          name: theme.name || theme.id,
          meta: theme.url ? text(theme.url) : text(theme.id),
          note: theme.builtin ? "the theme Hypercord installs on a first run; switching it off is allowed" : "",
          enabled: theme.enabled === true,
          badges,
          actions: [{ id: "remove", label: "Remove", kind: "ghost", title: "remove " + text(theme.name || theme.id), run: () => removeTheme(theme.id) }],
          onToggle: (on) => toggleTheme(theme.id, on),
        });
      }),
      "no themes installed. A .theme.css file, or an https:// url, can be installed above.",
    );
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

  /* ---- the theme library --------------------------------------------------- */

  // A browser of published themes. It is read when somebody presses Load and not before -
  // nothing here is fetched on its own, so an idle client is not talking to anything - and
  // a theme installed from it goes through the same store as one installed from a link:
  // fetched once, at the moment of install, then a file on disk.

  async function loadThemeLibrary(force = false) {
    const note = $("hp-themeLibraryNote");
    if (note) note.textContent = "reading the library\u2026";
    const res = await guard("theme library", () => hc.themes.index(force === true));
    if (!res || res.ok === false) {
      libraryThemes = [];
      fillGrid("hp-themeLibrary", [], "the theme library could not be read");
      return;
    }
    libraryThemes = Array.isArray(res.themes) ? res.themes : [];
    libraryFrom = text(res.from || "");
    renderThemeLibrary(res.cached === true);
  }

  function renderThemeLibrary(cached = false) {
    const rows = libraryQuery
      ? libraryThemes.filter((entry) =>
          [text(entry.name), text(entry.author), text(entry.description), (Array.isArray(entry.tags) ? entry.tags : []).join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(libraryQuery),
        )
      : libraryThemes;
    const note = $("hp-themeLibraryNote");
    if (note) {
      note.textContent =
        rows.length +
        (libraryQuery ? " of " + libraryThemes.length : "") +
        " theme(s) in the library" +
        (libraryFrom ? " \u00b7 " + libraryFrom : "") +
        (cached ? " \u00b7 read a moment ago" : "");
    }
    fillGrid("hp-themeLibrary", rows.map(libraryCard), libraryThemes.length ? "nothing in the library matches that search" : "the library is empty");
  }

  function libraryCard(entry) {
    const badges = (Array.isArray(entry.tags) ? entry.tags : []).slice(0, 3).map((tag) => ({ text: text(tag) }));
    if (Number(entry.downloads) > 0) badges.push({ text: text(entry.downloads) + " downloads" });
    // a theme that is already installed is marked rather than offered again: installing
    // twice would be two files with the same contents and two switches to keep in step
    const already = installedThemes.some((one) => text(one.url) === text(entry.download));
    if (already) badges.unshift({ text: "installed", kind: "on" });
    return addonCard({
      id: "library-" + text(entry.id),
      name: entry.name,
      meta:
        (entry.author ? "by " + text(entry.author) : "author not stated") +
        (entry.updated && !Number.isNaN(Date.parse(entry.updated)) ? " \u00b7 " + new Date(entry.updated).toLocaleDateString() : ""),
      note: text(entry.description),
      enabled: already,
      badges,
      actions: [
        {
          id: "install",
          label: already ? "Installed" : "Install",
          title: already ? text(entry.name) + " is already installed" : "install " + text(entry.name),
          disabled: already,
          run: () => installFromLibrary(entry),
        },
      ],
    });
  }

  async function installFromLibrary(entry) {
    const name = text(entry.name);
    const res = await guard("install " + name, () => hc.themes.install(text(entry.download), name));
    if (res && res.ok) {
      say("installed " + name + " - switch it on in the themes above", "good");
      await loadThemes();
      renderThemeLibrary();
    }
  }

  /* ---- logs ---------------------------------------------------------------- */

  /**
   * This client's own log lines, when the shell has a log reader to give them.
   * `null` means there is no reader in this build - not that the log is empty, and
   * not an error: the pane below falls back to the state the shell does hold.
   */
  async function readOwnLog() {
    const reader = hc && hc.logs && typeof hc.logs.read === "function" ? hc.logs : null;
    if (!reader) return null;
    const res = await guard("client log", () => reader.read(200));
    if (res === undefined || res === null) return null;
    if (Array.isArray(res)) return res.map(text);
    if (res && Array.isArray(res.lines)) return res.lines.map(text);
    return res && res.text ? [text(res.text)] : [];
  }

  /**
   * What this client can say about itself right now, read back from the shell: the
   * plugin host's own counts, any plugin that broke and why, and what the key store
   * holds. Every line comes from a channel that answers without a control server.
   */
  async function ownStateReport() {
    const lines = [];
    const status = await guard("plugin state", () => hc.plugins.status());
    if (status) {
      const broken = status.broken && typeof status.broken === "object" ? Object.keys(status.broken) : [];
      const running = Array.isArray(status.running) ? status.running.length : 0;
      lines.push("plugins: " + text(status.catalogue || 0) + " in the catalogue, " + text(status.enabled || 0) + " enabled, " + running + " running");
      for (const id of broken) lines.push("  broken: " + id + " - " + text(status.broken[id]));
    } else {
      lines.push("plugins: the shell did not report plugin state");
    }
    const keys = await guard("access keys", () => hc.tokens.list());
    lines.push("keys: " + (Array.isArray(keys) ? keys.length + " stored on this machine" : "the shell did not report the key store"));
    const update = await guard("update state", () => hc.update.state());
    lines.push("updates: " + (update ? text(update.supported ? "on" : "not updating in this run") + (update.note ? " - " + text(update.note) : "") + (update.version ? " (" + text(update.version) + ")" : "") + (update.error ? " - last error: " + text(update.error) : "") : "the shell did not report update state"));
    return {
      note: "No log file is read in this run, so this is the state this client holds right now; the lines it writes go to the terminal Hypercord was started from. A build that keeps a log shows its own lines here instead.",
      lines,
    };
  }

  /**
   * The Logs view.
   *
   * Deliberately not a proxy for the control server's log: a client pointed at
   * Discord and nothing else has no server to ask, and asking anyway is what put
   * "no control server configured" in this pane's header and left the body empty.
   * The shell decides the source - its own log reader when this build has one, and
   * otherwise the state above - and the pane always has something true to show.
   */
  async function loadLogs() {
    const out = $("hp-logsOut");
    const note = $("hp-logsNote");
    if (out) out.textContent = "reading\u2026";
    // Whether a reader exists is asked first and separately, because "this build
    // keeps no log" and "the log is empty" are different answers and only one of
    // them is about a missing reader.
    const hasReader = Boolean(hc && hc.logs && typeof hc.logs.read === "function");
    const lines = hasReader ? await readOwnLog() : null;
    if (!out) return;
    if (hasReader && lines && lines.length) {
      if (note) note.textContent = "the client's own log, newest last";
      out.textContent = lines.join("\n");
    } else if (hasReader) {
      if (note) note.textContent = "the client keeps a log in this run and has written nothing to it yet.";
      out.textContent = "the log is empty so far";
    } else {
      const report = await ownStateReport();
      if (note) note.textContent = report.note;
      out.textContent = report.lines.join("\n");
    }
    out.scrollTop = out.scrollHeight;
  }

  /* ---- accounts and updates ------------------------------------------------ */

  /**
   * The Accounts view: which accounts this client can be.
   *
   * The token store is the source of truth, not the control server. Every account a
   * key is stored for is an account this client can sign in as, with or without a
   * server, so a machine with no control server is not a machine with no accounts -
   * which is what this pane used to say by describing the server's absence as the
   * client's emptiness. Both lists are merged when both exist, the server's absence
   * is said plainly, and a row only offers the switch its own account can perform:
   * a stored key signs this window in, while an account the server holds is handed
   * its own session.
   */
  async function loadAccounts() {
    const stored = await guard("access keys", () => hc.tokens.list());
    const seen = await guard("accounts", () => hc.account.current());
    const container = $("hp-accountList");
    const note = $("hp-accountNote");
    if (!container) return;
    const local = Array.isArray(stored) ? stored : [];
    const onServer = seen && Array.isArray(seen.accounts) ? seen.accounts.map(text) : [];
    const current = seen ? text(seen.account) : "";
    const held = new Set(local.map((entry) => text(entry.account)));
    if (!local.length && !onServer.length) {
      empty(container, "nothing to switch to yet: store a key under Access keys, and this client can sign in as that account.");
    } else {
      container.replaceChildren();
      for (const entry of local) {
        const account = text(entry.account);
        const isCurrent = account === current;
        // What the key store knows about this account, when it knows anything: the store
        // remembers what a check against Discord answered, so the name and the avatar are
        // there on the next visit without asking anything. A key nothing has checked has
        // no identity, and says so instead of showing the account id as if it were a name.
        const identity = entry.identity && typeof entry.identity === "object" ? entry.identity : null;
        const known = identityName(identity);
        const label = text(entry.label);
        const badges = isCurrent ? [{ text: "current", kind: "on" }] : [{ text: "key stored", kind: "on" }];
        if (identity) badges.push({ text: "checked", kind: "on", title: "this key was checked against Discord" });
        const bits = [label && known ? label : "", account, keyMeta(entry)].filter((one) => text(one).trim() !== "");
        let row;
        row = card({
          name: known || label || account,
          avatar: identity ? text(identity.avatar) : "",
          meta: bits.join(" \u00b7 "),
          description: identity
            ? (text(identity.username) ? "@" + text(identity.username) : "") + (identity.id ? (text(identity.username) ? " \u00b7 " : "") + "id " + text(identity.id) : "")
            : "not checked against Discord yet, so only its mask is known - Test key asks who this is",
          badges,
          actions: [
            ...(isCurrent ? [] : [{ label: "Switch to this account", run: () => useKey(account) }]),
            { label: "Test key", kind: "ghost", run: () => testStoredKey(account) },
            { label: "Rename", kind: "ghost", run: () => revealRename(row, entry) },
            { label: "Forget", kind: "danger", run: () => removeKey(account) },
          ],
        });
        container.appendChild(row);
      }
      for (const id of onServer) {
        if (held.has(id)) continue; // already listed above, as the key it is
        const isCurrent = id === current;
        container.appendChild(
          card({
            name: id,
            meta: isCurrent ? "this client is signed in as " + id : "on the control server; switching gives it its own session",
            badges: isCurrent ? [{ text: "current", kind: "on" }] : [{ text: "server", kind: "" }],
            actions: isCurrent ? [] : [{ label: "Switch", run: () => switchAccount(id) }],
          }),
        );
      }
    }
    // The quick switcher at the top of this page, from the rows just read: one click and
    // this window is that account.
    renderAccountSwitcher(local, current);
    if (note) {
      if (onServer.length) {
        note.textContent = "The control server lists " + onServer.length + " account(s), and " + local.length + " key(s) are stored on this machine.";
      } else if (local.length) {
        note.textContent = "No control server is configured here, so this list is the " + local.length + " key(s) this machine holds: a key signs this window in as that account. An account on a control server would also get its own session, and would appear here beside these.";
      } else {
        note.textContent = "No control server is configured here either, so there is nothing to sign in as until a key is stored.";
      }
    }
    await loadUpdates();
  }

  /**
   * The name an account answered with: its display name first, then the handle. Never the
   * id unless there is nothing else, because an id is not what anybody calls themselves.
   */
  function identityName(identity) {
    if (!identity || typeof identity !== "object") return "";
    return text(identity.name) || text(identity.username);
  }

  /**
   * The quick switcher: one round face per stored account, at the top of the Accounts
   * page, so changing account is one click instead of one click found below a list of
   * cards. The client has no tray on purpose (src/main.js), which makes this sheet the
   * right home for it.
   *
   * Three rules make it worth clicking rather than worrying about:
   *
   *   * **a missing picture is a letter, never a hole.** An account nothing has checked
   *     yet has no identity at all, and one whose avatar hash is empty has none either -
   *     both take the same round slot with the account's first letter in it, so the row
   *     keeps its shape and nothing is ever fetched to find that out;
   *   * **nothing here is a network round trip.** It reads the list the page already read
   *     and calls the same `useKey` the cards use, so a click signs in and re-reads the
   *     page; asking Discord who each account is belongs to `Test key`, where the person
   *     asked for it;
   *   * **the account this client is already signed in as is marked, and does nothing.**
   *     Pressing it would only reload the window onto the session it is already using.
   */
  function renderAccountSwitcher(rows, current) {
    const list = $("hp-accountList");
    // the strip lives beside the cards, in whatever column holds them: this file owns no
    // markup, so the sheet is found rather than assumed
    const host = list && list.parentElement ? list.parentElement : null;
    if (!host) return;
    const existing = $("hp-accountSwitcher");
    const accounts = (Array.isArray(rows) ? rows : []).filter((entry) => entry && text(entry.account).trim() !== "");
    if (!accounts.length) {
      // no stored accounts means no strip at all: not an empty box, and not a gap where a
      // row of faces would be
      if (existing) existing.remove();
      return;
    }
    const strip = existing || document.createElement("div");
    if (!existing) {
      strip.id = "hp-accountSwitcher";
      strip.className = "account-switcher";
      // a named group rather than a list: these are actions, and the page below already
      // has the one list of cards
      strip.setAttribute("role", "group");
      strip.setAttribute("aria-label", "switch account");
      host.insertBefore(strip, list);
    }
    strip.replaceChildren();
    for (const entry of accounts) {
      const account = text(entry.account);
      const identity = entry.identity && typeof entry.identity === "object" ? entry.identity : null;
      // the same display-name rule the cards use: the name the account answered with, then
      // the owner's own label, then the id - an id is not what anybody calls themselves,
      // but it is better than an unlabelled button
      const shown = identityName(identity) || text(entry.label) || account;
      const isCurrent = account === current;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "account-chip" + (isCurrent ? " current" : "");
      button.title = isCurrent ? shown + " is the account this client is signed in as" : "switch to " + shown;
      button.setAttribute("aria-label", button.title);
      if (isCurrent) button.setAttribute("aria-current", "true");
      const face = identity ? text(identity.avatar).trim() : "";
      if (face) {
        const img = document.createElement("img");
        img.className = "account-face";
        img.src = face;
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        button.appendChild(img);
      } else {
        const initial = document.createElement("span");
        initial.className = "account-face account-initial";
        // decorative: the button's own name already says whose account this is
        initial.setAttribute("aria-hidden", "true");
        initial.textContent = text(shown).trim().charAt(0).toUpperCase() || "?";
        button.appendChild(initial);
      }
      if (isCurrent) {
        // a mark that is not colour alone: the ring and the tick are two signals, and
        // `aria-current` is the third, for anybody not looking at the pixels
        const tick = document.createElement("span");
        tick.className = "account-tick";
        tick.setAttribute("aria-hidden", "true");
        tick.textContent = "\u2713";
        button.appendChild(tick);
      }
      button.addEventListener("click", async () => {
        if (isCurrent) return; // already here: switching would only reload the window
        await useKey(account);
        await loadAccounts();
      });
      strip.appendChild(button);
    }
  }

  /**
   * Ask Discord whether a stored key still works, from the accounts page.
   *
   * The check is the only thing that can tell a live key from a dead one, and it is what
   * teaches the store the account's name and picture - so the page is read back afterwards
   * rather than only reporting an answer in the status line.
   */
  async function testStoredKey(account) {
    const res = await guard("test the key for " + account, () => hc.tokens.test(account));
    if (!res) return;
    if (res.ok) {
      const who = identityName(res.identity);
      say("the key for " + account + " works" + (who ? " - it is " + who : ""), "good");
      await loadAccounts();
      return;
    }
    say("the key for " + account + " does not work: " + text(res.error || "Discord refused it"), "bad");
  }

  /**
   * Renaming an account is a label, not a key, so this adds one text field to the row it
   * belongs to - the same shape as replacing a key, in the card's own column so the row's
   * buttons stay where they are. An empty name is allowed and means the account's own id
   * is what the row is called.
   */
  function revealRename(row, entry) {
    const existing = row.querySelector(".token-rename");
    if (existing) {
      existing.remove();
      return;
    }
    const column = row.querySelector(".card-main") || row;
    const box = document.createElement("div");
    box.className = "token-rename";
    const input = document.createElement("input");
    input.type = "text";
    input.id = "hp-rename-" + text(entry.account);
    input.value = text(entry.label);
    input.placeholder = "a name for " + text(entry.account);
    input.setAttribute("aria-label", "the name to show for " + text(entry.account));
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save name";
    save.addEventListener("click", async () => {
      const label = text(input.value).trim();
      const res = await guard("rename " + text(entry.account), () => hc.tokens.rename(text(entry.account), label));
      if (!res || res.ok !== true) return;
      say(label ? "named " + text(entry.account) + " " + label : "removed the name from " + text(entry.account), "good");
      box.remove();
      await loadAccounts();
    });
    box.appendChild(input);
    box.appendChild(save);
    column.appendChild(box);
    input.focus();
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
    // Why it is not updating, when the reason is not a failure: another app's process (a
    // patched client runs this host inside Discord's own), an install with no copy of ours to
    // replace, or a build with no feed. "not updating in this run" on its own is the silence
    // this line exists to remove.
    if (state.note) bits.push(text(state.note));
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
    if (res.ok) {
      // the identity is an object, not a string: printing it whole said "[object Object]"
      const who = identityName(res.identity);
      say("the key for " + account + " works" + (who ? " as " + who : ""), "good");
    } else say("that key does not work: " + text(res.error || "the account refused it"), "bad");
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
   * Where these pages can be: Discord's own settings content column, measured by the
   * preload. Without that measurement there is no column for a page to be, and the
   * sheet is not opened at all - a page drawn anyway is a panel over somebody's
   * chat, which is the one thing this client must never do (and did, before the
   * preload's sidebar detection stopped accepting Discord's server rail as a
   * settings list). `data-seamless` is the preload's word for "placed".
   */
  function placeable() {
    const root = sheet();
    return Boolean(root && root.getAttribute("data-seamless") === "true");
  }

  /**
   * Open the sheet, on `view` when one is named. With nothing named the sheet
   * opens where it makes sense to start: with no key stored there is nothing to
   * sign in with, so it lands on Access keys, and otherwise on Commands.
   */
  async function open(view) {
    const root = sheet();
    if (!placeable()) {
      if (root) root.setAttribute("data-open", "false");
      say("Hypercord's pages live in Discord's settings: open Settings and pick one of the Hypercord sections", "bad");
      return false;
    }
    if (root) root.setAttribute("data-open", "true");
    let wanted = VIEWS.includes(text(view)) ? text(view) : "";
    if (!wanted) {
      const stored = hc && hc.tokens && typeof hc.tokens.list === "function" ? await guard("access keys", () => hc.tokens.list()) : null;
      wanted = Array.isArray(stored) && stored.length === 0 ? "tokens" : "commands";
    }
    // always, even when the section was the one already showing: the page is read again
    // on every visit, so a catalogue read early in the client's start - before the plugin
    // host had answered - can never be what somebody is left looking at
    setView(wanted, { tell: false });
    return wanted;
  }

  /**
   * Show a view without asking the shell to change its record of one: the settings
   * entry that opened the sheet already knows which section it stands for, so
   * telling the shell again would be a second source of truth for the same thing.
   */
  function show(view) {
    const wanted = VIEWS.includes(text(view)) ? text(view) : currentView;
    const root = sheet();
    if (root) root.setAttribute("data-open", "true");
    setView(wanted, { tell: false });
    return wanted;
  }

  window.hypercordPanes = { open, close, isOpen, show, placeable };

  /* ---- wiring, once -------------------------------------------------------- */

  function wire() {
    const root = sheet();
    if (!root || !$("hp-main")) {
      // mounted without markup: nothing can be wired, and saying so beats a
      // half-dead sheet
      say("the panes markup is not mounted in this page", "bad");
      return false;
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
    const beefForm = $("hp-beefSettings");
    if (beefForm) beefForm.addEventListener("submit", (event) => event.preventDefault());
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
    on("hp-detailBack", "click", () => closeSettings());
    on("hp-pluginSearch", "input", () => renderPlugins());
    on("hp-pluginFilter", "change", () => {
      const filter = $("hp-pluginFilter");
      pluginFilter = filter ? text(filter.value) : "all";
      renderPlugins();
    });
    on("hp-pluginRefresh", "click", () => refreshCatalogue());
    on("hp-pluginRestart", "click", () => restartClient());
    on("hp-quickSave", "click", () => saveQuickCss());
    on("hp-themeLibraryLoad", "click", () => loadThemeLibrary(true));
    const librarySearch = $("hp-themeLibrarySearch");
    if (librarySearch) {
      librarySearch.addEventListener("input", () => {
        libraryQuery = text(librarySearch.value).trim().toLowerCase();
        renderThemeLibrary();
      });
    }
    on("hp-beefRefresh", "click", () => loadBeef());
    on("hp-logsRefresh", "click", () => loadLogs());
    on("hp-updateCheck", "click", () => checkUpdates());
    on("hp-tokenForget", "click", () => forgetKeys());
    return true;
  }

  /* ---- typing in our own pages -------------------------------------------- */

  /**
   * The caret stays in our own fields.
   *
   * Discord's settings run a focus trap: focus that is not inside the tree the client
   * manages is pulled back, by calling focus() on one of its own rows and then on the
   * column itself. This sheet is deliberately *outside* that tree - attached to the
   * document element, which is what keeps a re-render from throwing it away - so every
   * click into one of our fields put the caret there and the trap took it straight back
   * out: everything was enabled, on top and clickable, and nothing could be typed into.
   * Measured rather than guessed: the field had the caret, and a moment later the
   * client's own bundle had focused a div of its own.
   *
   * So there is one rule, and it is about the interaction rather than the event: while
   * the interaction that is happening began in a field of ours, the caret belongs to that
   * field. It is armed by a press inside our sheet, and dropped by the next press
   * anywhere else and by Tab or Escape - the keys that mean "leave this field" - so
   * nothing is trapped here: keyboard navigation out of these pages works, and Discord's
   * own controls take focus exactly as they did before.
   */
  function keepFocus() {
    // The document, not the sheet, is what these rules are about, so they are installed once
    // per page: this script runs again whenever the sheet is mounted again, and a second set
    // of document listeners and a second wrap around `focus` would serve no purpose but to
    // grow with every settings screen that is opened and closed.
    if (window.__hypercordPanesFocus === true) return;
    window.__hypercordPanesFocus = true;
    const FOCUSABLE = "input, textarea, select, [contenteditable='true']";
    const inSheet = (node) => Boolean(node && node.closest && node.closest("#hypercord-panes"));
    let wanted = null; // the field of ours the interaction in progress belongs to, if any

    document.addEventListener(
      "pointerdown",
      (event) => {
        const control = event.target && event.target.closest ? event.target.closest(FOCUSABLE) : null;
        wanted = control && inSheet(control) ? control : null;
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Tab" || event.key === "Escape") {
          wanted = null;
          return;
        }
        // A keystroke while the interaction is ours belongs to our field, so it is
        // claimed before the key is delivered: a trap that took the caret back
        // between two characters would otherwise eat the second one.
        claim();
      },
      true,
    );
    const claim = () => {
      if (wanted && document.activeElement !== wanted) wanted.focus();
    };
    // the last phase of the click, after every handler the client has on the document
    window.addEventListener("click", claim, false);
    // and the pointer itself, because their handling answers to a press as well
    window.addEventListener("pointerup", claim, true);
    // and then the trap's own move, which happens after the event has been answered:
    // a focus call that would take the caret out of our sheet is answered by our field
    const real = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      if (wanted && !inSheet(this) && inSheet(document.activeElement)) {
        real.apply(wanted, args);
        return undefined;
      }
      return real.apply(this, args);
    };
  }

  /* ---- the shell's pushes -------------------------------------------------- */

  /* ---- one page, however many times the sheet is mounted -------------------- */

  /**
   * What a mount of this sheet leaves behind, and what the next one has to take away again.
   *
   * The sheet is mounted again whenever Discord's settings layer is torn down with it, and
   * that is a second run of this script in the same page. One thing must not accumulate
   * because of it: the shell's pushes, where each mount would answer every push once more
   * (a plugin change would reload the catalogue twice, and so on). So each mount keeps the
   * unsubscribes the shell handed it, under one name on the window, and drops the previous
   * mount's before it registers its own. Everything else here belongs to the markup of the
   * sheet and is wired fresh with it.
   */
  function mountSession() {
    const previous = window.__hypercordPanesSession;
    if (previous && Array.isArray(previous.offs)) {
      for (const off of previous.offs) {
        try {
          off();
        } catch {
          /* already gone: dropping a listener twice is not a failure */
        }
      }
    }
    const current = { offs: [] };
    window.__hypercordPanesSession = current;
    return current;
  }

  function boot() {
    const session = mountSession();
    keepFocus();
    const wired = wire();
    if (wired) setView(currentView, { tell: false });
    if (!hc) {
      say("the Hypercord bridge is not available in this window", "bad");
      return;
    }
    // the shell drives the sheet: it opens it on a view, reopens the current one,
    // and closes it
    session.offs.push(hc.on("panes:open", (view) => open(view)));
    session.offs.push(
      hc.on("panes:view", (view) => {
        // the echo of our own "tell the shell" call must not reload the view
        if (VIEWS.includes(text(view)) && text(view) !== currentView) setView(view, { tell: false });
      }),
    );
    session.offs.push(hc.on("panes:close", () => close()));
    // a change made elsewhere is followed by the view that shows it, and only
    // while that view is the visible one
    session.offs.push(
      hc.on("plugins:changed", () => {
        // both plugin tabs read the same catalogue, so both stay in step - and the beef
        // page follows it too, because switching that plugin off is what empties it
        if (currentView === "plugins" || currentView === "hyper") loadPlugins();
        else if (currentView === "beef") loadBeef();
      }),
    );
    session.offs.push(
      hc.on("themes:css", () => {
        if (currentView === "themes") loadThemes();
      }),
    );
    session.offs.push(
      hc.on("tokens:changed", () => {
        // the keys are what the accounts view lists too, so both follow the push
        if (currentView === "tokens") loadTokens();
        else if (currentView === "accounts") loadAccounts();
      }),
    );
  }

  boot();
})();
