// language: JavaScript, file: src/plugin-host.js
//
// The platform half of Hypercord. The whole catalogue stays available; what is
// kept out of the way is the cost of it:
//
//   * the catalogue is read from a manifest - kilobytes, no plugin code;
//   * enabling a plugin is the only moment its code is imported, and disabling
//     it drops the module again;
//   * a plugin that throws while loading or starting is marked broken and the
//     client carries on (one bad plugin must never take the window down);
//   * nothing a plugin starts outlives the plugin or the client. A plugin's own
//     stop() hook is called on disable and on stopAll(), and the host owns the two
//     things a plugin would otherwise leave behind: the cleanup functions it
//     registers (`ctx.onCleanup`) and the timers it asks for (`ctx.interval`,
//     `ctx.timeout`). Asking the host for a timer is what makes "closing the
//     client kills every background activity of ours" true for plugin code too,
//     so the helpers are the documented way to wait for something.
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
    // `off` is the record of what the operator actually turned off, one id at a time. The
    // older single `chosen` flag could only say "somebody has touched this", so a plugin
    // that joined the default set *after* a machine wrote its state was enabled nowhere
    // and started never - a plugin the manager lists and nothing can open. `chosen` is
    // kept for the file's shape, not for the decision.
    //
    // `runtime` is the switch for the plugins the *built runtime* runs (the vendored
    // catalogue). It is here, in this file, because this file is the only store on this
    // machine that can keep it: the runtime keeps its settings through the page's storage,
    // and Discord's own page removes `localStorage` and `sessionStorage` (measured:
    // undefined on discord.com/app, present on example.com) - so a switch written only
    // there is forgotten by the next start. The loader reads this list and hands it to the
    // runtime as the settings it starts from, which is what makes the choice survive.
    this.state = { enabled: [], settings: {}, chosen: false, off: [], runtime: [] };
    this.defaultSet = "";
    this.defaults = [];
    this.cleanups = new Map(); // id -> [fn], called on disable and on stopAll
    this.timers = new Map(); // id -> Set<Timeout>, the timers the host owns for it
    this.stopped = false; // set by stopAll: a stopped host starts nothing again
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
          // the categories the catalogue carries, copied through so the browser can
          // offer them: the host knows nothing about what they mean, and does not need to
          tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
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
        // a profile written before this field existed has no per-plugin record, and
        // guessing one from the enabled list would freeze every one of those choices: an
        // empty list means the set is applied, and anything the operator turns off from
        // now on is remembered by id
        off: Array.isArray(saved.off) ? saved.off.map(String) : [],
        // and the built runtime's switches, which are the operator's choices the same way
        runtime: Array.isArray(saved.runtime) ? saved.runtime.map(String) : [],
      };
    } catch {
      this.state = { enabled: [], settings: {}, chosen: false, off: [], runtime: [] };
    }

    // An enabled list is a promise that something will start, so an id the
    // catalogue no longer describes is dropped here: a retired plugin left in it
    // makes the manager count a plugin that nothing can start - which is exactly
    // what the retired rail did to the count after it was removed.
    let changed = false;
    const live = this.state.enabled.filter((id) => this.meta.has(id));
    if (live.length !== this.state.enabled.length) {
      this.state.enabled = live;
      changed = true;
    }
    // the same for the built runtime's switches: a plugin the catalogue no longer describes
    // must not stay in a list the runtime is handed at the next start
    const runtimeLive = this.state.runtime.filter((id) => this.meta.has(id));
    if (runtimeLive.length !== this.state.runtime.length) {
      this.state.runtime = runtimeLive;
      changed = true;
    }

    // The default set, which is two rules rather than one, and the second rule is
    // applied on every load rather than only on a first run: a plugin the manifest marks
    // as part of the set is started, including one added to the set *after* this machine
    // wrote a state file - the case this used to miss, where a new member of the set was
    // enabled nowhere and started never. A plugin the operator turned off is the only
    // exception, and that is a per-plugin record (`off`), not a global "somebody has
    // touched this" flag.
    const seeded = [...this.meta.values()].filter((entry) => entry.defaultOn && !this.state.off.includes(entry.id)).map((entry) => entry.id);
    const missing = seeded.filter((id) => !this.state.enabled.includes(id));
    if (missing.length) {
      this.state.enabled = [...this.state.enabled, ...missing];
      changed = true;
    }
    if (changed) this.save();
    return this;
  }

  /**
   * What the plugin manager shows: everything, with what is running marked. The
   * declared `settings` schema travels with each entry when the plugin is loaded
   * (it lives in the plugin's own module) and falls back to the manifest, so the
   * settings form can be built for a plugin that has not been started yet.
   */
  /**
   * Whether this host is the side that runs a catalogue entry.
   *
   * Whoever runs a plugin owns whether it is on, and each plugin has exactly one owner. The
   * vendored catalogue is TypeScript source this process cannot load - the built runtime in
   * the page runs those - so for those entries this host has no state and nothing to write.
   */
  owns(entry) {
    return !/\.tsx?$/i.test(String((entry && entry.entry) || ""));
  }

  list() {
    return [...this.meta.values()].map((entry) => {
      const module = this.modules.get(entry.id);
      const mine = this.owns(entry);
      return {
        ...entry,
        settings: (module && Array.isArray(module.settings) ? module.settings : []) || entry.settings || [],
        // `owner` is the answer to "whose switch is this", once, instead of every reader
        // guessing it from the entry's file name
        owner: mine ? "host" : "runtime",
        // And the state is reported by the side that has it. For a plugin this host runs,
        // that is what it started. For a vendored one, this file holds the *choice* - the
        // record the runtime is handed at the next start - and nothing here claims the
        // plugin is running, because a plugin running is something only the runtime knows.
        ...(mine
          ? { enabled: this.state.enabled.includes(entry.id), running: this.running.has(entry.id) }
          : { enabled: this.state.runtime.includes(entry.id), running: false }),
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
    if (this.stopped) return { ok: false, error: "the plugin host has been stopped" };
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
    if (!this.owns(entry)) {
      // The built runtime runs this one, and the settings it starts from are handed to it
      // at every start - so the one thing this host can do for it is remember the choice
      // (see `runtime` above) for the loader to hand over. It is not a start: nothing here
      // can load a TypeScript body, and reporting one is the lie the card used to tell.
      return this.chooseRuntime(entry.id, true);
    }
    try {
      // the one and only moment this plugin's code is touched
      const url = pathToFileURL(file);
      const mod = await import(url.href + "?v=" + Date.now());
      const plugin = (mod && mod.default) || mod;
      if (!plugin || typeof plugin.start !== "function") throw new Error("no start()");
      this.modules.set(entry.id, plugin);
      // whatever start() hands back is that plugin's live surface - which view the
      // settings pages are on, say - so the shell can drive a feature through the
      // plugin that owns it instead of keeping a second copy of its state. Nothing
      // is kept when start() returns nothing.
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
      // starting it is also the operator saying they want it: a plugin in the set that
      // had been turned off and is now on again must not be dropped by the next seeding
      this.state.off = this.state.off.filter((x) => x !== entry.id);
      this.log("[hypercord] plugin on: " + entry.id);
      return { ok: true };
    } catch (err) {
      const why = String((err && err.message) || err).slice(0, 200);
      this.modules.delete(entry.id);
      this.running.delete(entry.id);
      return broken(why);
    }
  }

  /**
   * Remember whether the built runtime should run a plugin, and say what that is.
   *
   * The file is the record and the loader hands it to the runtime at the next start, which
   * is the only way a switch here survives: the runtime's own settings are kept in the
   * page's storage, and Discord's page has none (measured: `localStorage` and
   * `sessionStorage` are both undefined on discord.com/app). Nothing in the answer says
   * `running`: a choice is not a running plugin, and only the runtime can say that.
   */
  chooseRuntime(id, on) {
    const key = String(id);
    const held = this.state.runtime.includes(key);
    if (on === held) return { ok: true, runtime: true, already: true, enabled: on };
    this.state.runtime = on ? [...this.state.runtime, key] : this.state.runtime.filter((x) => x !== key);
    this.save();
    this.log("[hypercord] recorded for the built runtime: " + key + " " + (on ? "on" : "off"));
    return { ok: true, runtime: true, enabled: on };
  }

  async disable(id) {
    const entry = this.meta.get(String(id));
    const id0 = String(id);
    // a plugin the built runtime runs is switched by remembering the choice, the same way
    if (entry && !this.owns(entry)) return this.chooseRuntime(id0, false);
    this.state.enabled = this.state.enabled.filter((x) => x !== id0);
    this.state.chosen = true;
    // the record that matters: this plugin is off because the operator said so, and the
    // default set will leave it alone from here on
    if (!this.state.off.includes(id0)) this.state.off.push(id0);
    this.broken.delete(String(id));
    this.save();
    // The host's own timers for this plugin stop first: a plugin going down must not
    // be re-entered by an interval of its own while its stop() hook is still running.
    this.stopTimers(String(id));
    const plugin = this.modules.get(String(id));
    if (plugin && typeof plugin.stop === "function") {
      try {
        await plugin.stop(this.contextFor(entry, plugin));
      } catch (err) {
        this.log("[hypercord] plugin stop threw: " + id + ": " + String((err && err.message) || err).slice(0, 160));
      }
    }
    // then what it registered to run when it went away
    this.runCleanups(String(id));
    this.modules.delete(String(id));
    this.running.delete(String(id));
    this.handles.delete(String(id));
    return { ok: true };
  }

  /* ---- what a plugin leaves behind ----------------------------------------- */

  /**
   * The timers this host owns for a plugin, cleared on disable and on stopAll.
   *
   * A plugin that reaches for a global `setInterval` cannot be stopped from here, which
   * is exactly why the context offers one: `ctx.interval` is the documented way to wait
   * for something, and a plugin that uses it cannot outlive its own plugin.
   */
  timersFor(id) {
    const key = String(id);
    if (!this.timers.has(key)) this.timers.set(key, new Set());
    return this.timers.get(key);
  }

  /** Clear and forget every timer held for a plugin. Returns how many were cleared. */
  stopTimers(id) {
    const key = String(id);
    const held = this.timers.get(key);
    if (!held) return 0;
    const count = held.size;
    for (const timer of held) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    held.clear();
    this.timers.delete(key);
    return count;
  }

  /** Run and forget the cleanups a plugin registered, newest first. */
  runCleanups(id) {
    const key = String(id);
    const held = this.cleanups.get(key) || [];
    this.cleanups.delete(key);
    let failed = 0;
    for (const fn of held.reverse()) {
      try {
        fn();
      } catch (err) {
        failed += 1;
        this.log("[hypercord] plugin cleanup threw: " + key + ": " + String((err && err.message) || err).slice(0, 160));
      }
    }
    return { ran: held.length, failed };
  }

  /**
   * Take every running plugin down, in one place, before the process goes away.
   *
   * This is the half of "closing the client kills our background activity" that lives in
   * the platform: a plugin's own stop() hook runs, the timers the host held for it are
   * cleared, its cleanups run, and the module reference is dropped so the code it loaded
   * can be collected. Failures are collected rather than thrown: one plugin that refuses
   * to stop must not leave the others running.
   */
  async stopAll() {
    this.stopped = true;
    const stopped = [];
    const failed = [];
    const ids = [...new Set([...this.modules.keys(), ...this.running])];
    for (const id of ids) {
      const plugin = this.modules.get(id);
      const entry = this.meta.get(id) || { id };
      this.stopTimers(id);
      if (plugin && typeof plugin.stop === "function") {
        try {
          await plugin.stop(this.contextFor(entry, plugin));
        } catch (err) {
          failed.push(id);
          this.log("[hypercord] plugin stop threw: " + id + ": " + String((err && err.message) || err).slice(0, 160));
        }
      }
      this.runCleanups(id);
      stopped.push(id);
    }
    // anything enabled but never started still has a registry, and a closure in it is a
    // closure that would otherwise be kept alive by a host that is going away
    for (const id of [...this.cleanups.keys()]) this.runCleanups(id);
    for (const id of [...this.timers.keys()]) this.stopTimers(id);
    this.modules.clear();
    this.running.clear();
    this.handles.clear();
    this.broken.clear();
    return { stopped, failed };
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
      // the built runtime's switches, as recorded here and handed to it at the next start
      runtime: [...this.state.runtime],
      // what the plugin manager shows as "the set": the intended list and the
      // name of the set, whether or not those plugins are vendored yet
      defaultSet: this.defaultSet,
      defaults: [...this.defaults],
    };
  }

  contextFor(entry, plugin) {
    const id = String(entry.id);
    return {
      id: entry.id,
      api: this.ctx.api,
      ui: this.ctx.ui,
      // the client's own services, when the caller supplied them: what a plugin needs
      // when there is no control server to talk to (src/beef.js is the one so far)
      local: this.ctx.local,
      /**
       * Register a teardown for this plugin: called when it is disabled and when the
       * host stops. Returns the function that takes it back off the list.
       */
      onCleanup: (fn) => {
        if (typeof fn !== "function") return () => false;
        if (!this.cleanups.has(id)) this.cleanups.set(id, []);
        const held = this.cleanups.get(id);
        held.push(fn);
        return () => {
          const list = this.cleanups.get(id) || [];
          const at = list.indexOf(fn);
          if (at === -1) return false;
          list.splice(at, 1);
          return true;
        };
      },
      /**
       * A repeating timer this host owns, so it cannot outlive the plugin. The callback
       * is guarded (a throw is logged, never raised into the timer loop) and the timer is
       * unref'd - a plugin waiting for something is never the reason the client stays in
       * memory. `clearInterval` on what it returns stops it; the host clears it too, on
       * disable and on stopAll, so returning it is a convenience rather than a duty.
       */
      interval: (fn, ms) => {
        if (typeof fn !== "function") return null;
        const held = this.timersFor(id);
        const timer = setInterval(() => {
          try {
            fn();
          } catch (err) {
            this.log("[hypercord] " + id + " interval threw: " + String((err && err.message) || err).slice(0, 160));
          }
        }, Math.max(50, Number(ms) || 1000));
        timer.unref?.();
        held.add(timer);
        return timer;
      },
      /** The one-shot twin of `ctx.interval`, owned and unref'd the same way. */
      timeout: (fn, ms) => {
        if (typeof fn !== "function") return null;
        const held = this.timersFor(id);
        const timer = setTimeout(() => {
          held.delete(timer);
          try {
            fn();
          } catch (err) {
            this.log("[hypercord] " + id + " timeout threw: " + String((err && err.message) || err).slice(0, 160));
          }
        }, Math.max(0, Number(ms) || 0));
        timer.unref?.();
        held.add(timer);
        return timer;
      },
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
