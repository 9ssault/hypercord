// language: JavaScript, file: src/plugin-host.js
//
// The platform half of Hypercord. The whole catalogue stays available; what is
// kept out of the way is the cost of it:
//
//   * the catalogue is read from a manifest - kilobytes, no plugin code;
//   * enabling a plugin is the only moment its code is imported, and disabling
//     it drops the module again;
//   * a plugin that throws while loading or starting is marked broken and the
//     client carries on (one bad plugin must never take the window down).
//
// A plugin module is the Vencord shape, so the vendored catalogue is consumed
// through `src/adapters/vencord.js` (lands with the fork) instead of being
// rewritten:
//
//   export default {
//     name, description, authors, version,
//     defaultOn: false,                     // off unless the operator asked
//     settings: [{ key, type, default, description }],
//     start(ctx), stop(ctx),
//   };
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class PluginHost {
  constructor({ root, manifestPath, stateFile, ctx = {}, log = console.log } = {}) {
    this.root = String(root || "");
    this.manifestPath = String(manifestPath || path.join(this.root, "plugins", "manifest.json"));
    this.stateFile = String(stateFile || path.join(this.root, "plugins.state.json"));
    this.ctx = ctx || {};
    this.log = typeof log === "function" ? log : () => {};
    this.meta = new Map();
    this.modules = new Map(); // id -> module, only while enabled
    this.handles = new Map(); // id -> whatever that plugin's start() returned
    this.running = new Set();
    this.broken = new Map(); // id -> why
    this.state = { enabled: [], settings: {}, chosen: false };
    this.defaultSet = "";
    this.defaults = [];
  }

  /** the catalogue and the enabled list: metadata only, no plugin code is read */
  load() {
    this.meta.clear();
    try {
      const manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) || {};
      for (const entry of Array.isArray(manifest.plugins) ? manifest.plugins : []) {
        if (!entry || !entry.id) continue;
        this.meta.set(String(entry.id), {
          id: String(entry.id),
          name: String(entry.name || entry.id),
          description: String(entry.description || ""),
          authors: Array.isArray(entry.authors) ? entry.authors.map(String) : [],
          version: String(entry.version || ""),
          entry: String(entry.entry || entry.id + "/index.js"),
          builtin: entry.builtin !== false,
          deps: Array.isArray(entry.deps) ? entry.deps.map(String) : [],
          defaultOn: entry.defaultOn === true,
        });
      }
      this.defaultSet = String((manifest.defaults && manifest.defaults.set) || "");
      this.defaults = Array.isArray(manifest.defaults && manifest.defaults.enabled) ? manifest.defaults.enabled.map(String) : [];
    } catch {
      /* no catalogue yet: the host simply has nothing to offer */
    }

    let firstRun = true;
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) || {};
      firstRun = false;
      this.state = {
        enabled: Array.isArray(saved.enabled) ? saved.enabled.map(String) : [],
        settings: saved.settings && typeof saved.settings === "object" ? saved.settings : {},
        chosen: saved.chosen === true,
      };
    } catch {
      this.state = { enabled: [], settings: {}, chosen: false };
    }

    // The default set: a plugin nobody turned on must not be started, and a
    // plugin the manifest marks as part of the set must be. So a first run (no
    // state file, or one that never recorded a choice) starts as exactly the set
    // - the whole catalogue is present and one click away, and everything else
    // is off. An operator who turns every plugin off is respected: that writes
    // `chosen`, and the set is not brought back over their head.
    if (firstRun || (!this.state.chosen && !this.state.enabled.length)) {
      const seeded = [...this.meta.values()].filter((entry) => entry.defaultOn).map((entry) => entry.id);
      if (seeded.length) {
        this.state.enabled = seeded;
        this.save();
      }
    }
    return this;
  }

  /**
   * What the plugin manager shows: everything, with what is running marked. The
   * declared `settings` schema travels with each entry when the plugin is loaded
   * (it lives in the plugin's own module) and falls back to the manifest, so the
   * settings form can be built for a plugin that has not been started yet.
   */
  list() {
    return [...this.meta.values()].map((entry) => {
      const module = this.modules.get(entry.id);
      return {
        ...entry,
        settings: (module && Array.isArray(module.settings) ? module.settings : []) || entry.settings || [],
        enabled: this.state.enabled.includes(entry.id),
        running: this.running.has(entry.id),
        broken: this.broken.has(entry.id) ? this.broken.get(entry.id) : "",
      };
    });
  }

  settingsFor(id) {
    const saved = this.state.settings[String(id)] || {};
    return { ...saved };
  }

  /** the live surface a running plugin returned from start(), or null */
  handle(id) {
    return this.handles.get(String(id)) || null;
  }

  /** every live handle, by plugin id - named apart from the map it reads, which
   * is the collision this method had with its own field */
  allHandles() {
    return Object.fromEntries(this.handles);
  }

  setSetting(id, key, value) {
    const bucket = this.state.settings[String(id)] || (this.state.settings[String(id)] = {});
    bucket[String(key)] = value;
    this.save();
    return bucket[String(key)];
  }

  async enable(id) {
    const entry = this.meta.get(String(id));
    if (!entry) return { ok: false, error: "no such plugin: " + id };
    if (this.running.has(entry.id)) return { ok: true, already: true };
    const remembered = this.state.enabled.includes(entry.id);
    const broken = (why) => {
      this.broken.set(entry.id, why);
      this.log("[hypercord] plugin not started: " + entry.id + ": " + why);
      return { ok: false, error: why };
    };
    // `entry` in the manifest is already a path from the app root (that is how
    // vendor.mjs writes it), so joining "plugins" on as well pointed at a file
    // that never existed and nothing in the catalogue could ever load
    const file = path.join(this.root, entry.entry);
    if (!fs.existsSync(file)) return broken("the file is not here (not vendored): " + entry.entry);
    if (/\.tsx?$/i.test(entry.entry)) {
      // the vendored catalogue is TypeScript; node cannot import it, so say so
      // instead of failing with a parse error from deep inside the loader
      return broken("TypeScript source, not built: " + entry.entry);
    }
    try {
      // the one and only moment this plugin's code is touched
      const url = pathToFileURL(file);
      const mod = await import(url.href + "?v=" + Date.now());
      const plugin = (mod && mod.default) || mod;
      if (!plugin || typeof plugin.start !== "function") throw new Error("no start()");
      this.modules.set(entry.id, plugin);
      // whatever start() hands back is that plugin's live surface - the rail's
      // toggle, the manager sheet's last view - so the shell can drive a feature
      // through the plugin that owns it instead of keeping a second copy of its
      // state. Nothing is kept when start() returns nothing.
      const handle = await plugin.start(this.contextFor(entry, plugin));
      if (handle !== undefined && handle !== null) this.handles.set(entry.id, handle);
      this.running.add(entry.id);
      this.broken.delete(entry.id);
      if (!remembered) {
        // the choice is recorded only once the plugin actually came up: one that
        // cannot load must not sit in the enabled list pretending to be on, and
        // one that was already on stays on (and stays listed as broken)
        this.state.enabled.push(entry.id);
        this.save();
      }
      this.log("[hypercord] plugin on: " + entry.id);
      return { ok: true };
    } catch (err) {
      const why = String((err && err.message) || err).slice(0, 200);
      this.modules.delete(entry.id);
      this.running.delete(entry.id);
      return broken(why);
    }
  }

  async disable(id) {
    const entry = this.meta.get(String(id));
    this.state.enabled = this.state.enabled.filter((x) => x !== String(id));
    this.state.chosen = true;
    this.broken.delete(String(id));
    this.save();
    const plugin = this.modules.get(String(id));
    if (plugin && typeof plugin.stop === "function") {
      try {
        await plugin.stop(this.contextFor(entry, plugin));
      } catch (err) {
        this.log("[hypercord] plugin stop threw: " + id + ": " + String((err && err.message) || err).slice(0, 160));
      }
    }
    this.modules.delete(String(id));
    this.running.delete(String(id));
    this.handles.delete(String(id));
    return { ok: true };
  }

  /** only what the operator turned on, in dependency order */
  async startEnabled() {
    const wanted = this.state.enabled.filter((id) => this.meta.has(id));
    const done = new Set();
    let progress = true;
    while (wanted.some((id) => !done.has(id)) && progress) {
      progress = false;
      for (const id of wanted) {
        if (done.has(id)) continue;
        const entry = this.meta.get(id);
        if (!entry.deps.every((dep) => done.has(dep))) continue;
        await this.enable(id);
        done.add(id);
        progress = true;
      }
    }
    return this.status();
  }

  status() {
    return {
      catalogue: this.meta.size,
      enabled: this.state.enabled.length,
      running: [...this.running],
      broken: Object.fromEntries(this.broken),
      // what the plugin manager shows as "the set": the intended list and the
      // name of the set, whether or not those plugins are vendored yet
      defaultSet: this.defaultSet,
      defaults: [...this.defaults],
    };
  }

  contextFor(entry, plugin) {
    return {
      id: entry.id,
      api: this.ctx.api,
      ui: this.ctx.ui,
      log: (line) => this.log("[hypercord:" + entry.id + "] " + String(line)),
      // Read live, not a snapshot taken at start: a plugin that writes a setting
      // must be able to read it back in the same run. And fall back to the
      // default the plugin declares - a plugin that declares `default: "hi"`
      // must read "hi" before anybody opens the settings form, or every plugin
      // that has settings is broken on first run.
      setting: (key) => {
        const live = this.settingsFor(entry.id);
        if (key in live) return live[key];
        const declared = (plugin && Array.isArray(plugin.settings) ? plugin.settings : []) || [];
        const found = declared.find((row) => row && String(row.key) === String(key));
        return found ? found.default : undefined;
      },
      setSetting: (key, value) => this.setSetting(entry.id, key, value),
      settings: () => (plugin && plugin.settings) || entry.settings || [],
    };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1));
      return true;
    } catch {
      return false;
    }
  }
}
