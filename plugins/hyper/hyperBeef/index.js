// language: JavaScript, file: plugins/hyper/hyperBeef/index.js
//
// Beef, back in the client as its own section. What the owner calls "the beef
// functions" is the generator the account's beef path draws its filler from, the
// reload and the rollback that replace it, the line lab that says what the bot
// would do with a message, and the last beef that actually ran. Every one of those
// is an existing route on the Hypercord control server - nothing here is invented:
//
//   GET  /api/beef            the live generator: ready, categories, dropped,
//                             remapped, generations, reloadMs, source, backup
//   POST /api/beef            { action: "reload" } - take the file on disk again
//   POST /api/beef/source     { text } replaces the generator, { action:
//                             "rollback" } restores the copy the last accepted push
//                             left behind. POST only: a GET is answered 405, so the
//                             source can be pushed and rolled back from here but
//                             never read back (that gap is deliberate on the
//                             server and is reported, not worked around).
//   GET  /api/last-beef       the last beef and the rolling history
//   GET  /api/inspect?text=…  what the detectors make of a line, read-only
//   POST /api/beef/start      what the client's api.beef() helper targets; the
//                             server has no such route today, so starting a beef
//                             goes through the command box instead - see start().
//
// No timer of any kind: the generator is read when the section is opened and when
// a caller asks, so an idle client is not talking to anything.
export default {
  name: "hyperBeef",
  description: "Beef: the generator, its reload and rollback, the line lab and the last beef",
  authors: ["Hypercord"],
  version: "1.0.0",
  defaultOn: true,
  settings: [
    { key: "announce", type: "boolean", default: false, description: "write the generator state to the log when it changes" },
    { key: "showDropped", type: "boolean", default: true, description: "show the categories the generator dropped and what they were remapped to" },
    { key: "history", type: "number", default: 5, min: 0, max: 20, description: "how many past beefs the section lists" },
  ],

  start(ctx) {
    // Nothing is cached across servers: `source` is a path the server owns, and
    // every field below is the server's own vocabulary, copied through unchanged so
    // the section can never display a number the server did not report.
    const beef = {
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
      reason: "",
    };
    let backup = null; // the rollback target, as metadata only

    /** "no control server configured" is a normal state, not a failure. */
    function unconfigured() {
      return !ctx.api || typeof ctx.api.request !== "function";
    }

    function note(reason) {
      const next = String(reason || "");
      const changed = beef.reason !== next;
      beef.reason = next;
      if (changed && ctx.setting("announce")) ctx.log("beef: " + (next || "generator reported"));
    }

    function apply(json) {
      if (!json || typeof json !== "object") return state();
      beef.ready = Boolean(json.ready);
      beef.categories = Array.isArray(json.categories) ? json.categories.map(String) : [];
      beef.dropped = Array.isArray(json.dropped) ? json.dropped.map(String) : [];
      beef.remapped = json.remapped && typeof json.remapped === "object" ? { ...json.remapped } : {};
      beef.generations = Number(json.generations) || 0;
      beef.reloadMs = Number(json.reloadMs) || 0;
      beef.source = String(json.source || "");
      beef.lastError = String(json.lastError || "");
      backup = json.backup && typeof json.backup === "object" ? { ...json.backup } : backup;
      beef.backup = backup;
      beef.at = Date.now();
      return state();
    }

    /**
     * The failure text a person reads: what the server said, and - when there is no
     * server at all - that there is no server, instead of an empty generator that
     * looks like a broken one.
     */
    function why(res) {
      if (unconfigured()) return "no control server configured (beef runs on the control server's account bot)";
      if (!res) return "the control server did not answer";
      if (res.status === 404) return "the control server has no " + res.path + " route yet";
      if (res.status === 405) return "the control server accepts POST on " + res.path + ", not GET";
      return String(res.error || ("control answered " + res.status));
    }

    async function ask(path, opts) {
      const res = await ctx.api.request(path, opts);
      res.path = path;
      return res;
    }

    /** Read the generator. The only call the section makes on its own. */
    async function refresh() {
      if (unconfigured()) {
        note("no control server configured (beef runs on the control server's account bot)");
        return state();
      }
      const res = await ask("/api/beef");
      if (res.ok && res.json) {
        apply(res.json);
        note(res.json.ready ? "" : String(res.json.lastError || "the generator is not ready"));
      } else {
        note(why(res));
      }
      return state();
    }

    /** Take the generator on disk again, exactly like the dashboard's Reload. */
    async function reload() {
      if (unconfigured()) return { ok: false, error: "no control server configured" };
      const res = await ask("/api/beef", { method: "POST", body: { action: "reload" } });
      if (res.ok && res.json) {
        apply(res.json);
        note("");
        ctx.log("beef generator reloaded (" + beef.categories.length + " categories)");
        return { ok: true, ...state() };
      }
      const error = why(res);
      note(error);
      return { ok: false, error };
    }

    /**
     * Install a new generator. An empty push is refused here with the same words the
     * server uses, so a person does not wait for a round trip to hear it, and the
     * NUL check is the server's own "this is UTF-16" case.
     */
    async function install(text, { maxBytes = 0 } = {}) {
      const source = String(text === undefined || text === null ? "" : text);
      if (!source.trim()) return { ok: false, error: "nothing to install (the upload was empty)" };
      if (source.includes("\u0000")) return { ok: false, error: "the file looks like UTF-16 (it contains null bytes) - save it as UTF-8 and push again" };
      if (unconfigured()) return { ok: false, error: "no control server configured" };
      const res = await ask("/api/beef/source", { method: "POST", body: { text: source, maxBytes: Number(maxBytes) || 0 }, timeout: 20000 });
      if (res.ok && res.json) {
        apply(res.json);
        note("");
        ctx.log("beef generator installed (" + beef.categories.length + " categories)");
        return { ok: true, ...state() };
      }
      const error = String((res.json && res.json.error) || why(res));
      note(error);
      return { ok: false, error, restored: res.json ? res.json.restored : undefined };
    }

    /** Put the copy the last accepted push replaced back. The server validates it. */
    async function rollback() {
      if (unconfigured()) return { ok: false, error: "no control server configured" };
      const res = await ask("/api/beef/source", { method: "POST", body: { action: "rollback" }, timeout: 20000 });
      if (res.ok && res.json) {
        apply(res.json);
        note("");
        ctx.log("beef generator rolled back");
        return { ok: true, ...state() };
      }
      const error = String((res.json && res.json.error) || why(res));
      note(error);
      return { ok: false, error };
    }

    /** What the detectors make of a line. Read-only: nothing is posted to Discord. */
    async function inspect(text) {
      const line = String(text === undefined || text === null ? "" : text);
      if (!line.trim()) return { ok: false, error: "nothing to read (the line was empty)" };
      if (unconfigured()) return { ok: false, error: "no control server configured" };
      const res = await ask("/api/inspect?text=" + encodeURIComponent(line));
      if (res.ok && res.json) return { ok: true, read: res.json };
      return { ok: false, error: why(res) };
    }

    /** The last beef, and the history the server keeps, trimmed to the setting. */
    async function last() {
      if (unconfigured()) return { ok: false, error: "no control server configured", beef: null, history: [] };
      const res = await ask("/api/last-beef");
      if (!res.ok || !res.json) return { ok: false, error: why(res), beef: null, history: [] };
      const wanted = Math.max(0, Math.min(20, Number(ctx.setting("history")) || 0));
      const all = res.json.history && Array.isArray(res.json.history.entries) ? res.json.history.entries : [];
      return { ok: true, beef: res.json.beef || null, history: all.slice(-wanted), total: all.length };
    }

    /**
     * Start a beef against a user.
     *
     * The client's api helper points at POST /api/beef/start, and the control server
     * has no such route: it answers 404. So this goes through the command box, which
     * is the path that exists - `$b @user` is the same command a person types - and
     * the reply says which one was used rather than pretending the helper worked.
     */
    async function start(user) {
      const target = String(user === undefined || user === null ? "" : user).trim();
      if (!target) return { ok: false, error: "name the user to beef with" };
      if (unconfigured() || typeof ctx.api.run !== "function") return { ok: false, error: "no control server configured" };
      const res = await ctx.api.run("beef", [target]);
      if (res.ok) return { ok: true, via: "command box (beef)", json: res.json || null };
      const error = res.status === 404 ? "the control server has no /api/run route yet" : String(res.error || ("control answered " + res.status));
      return { ok: false, error, via: "command box (beef)", note: "/api/beef/start, which the client helper targets, does not exist on the server" };
    }

    function state() {
      return {
        ...beef,
        categories: [...beef.categories],
        dropped: [...beef.dropped],
        remapped: { ...beef.remapped },
        backup: backup ? { ...backup } : null,
        droppedShown: ctx.setting("showDropped") !== false,
      };
    }

    /**
     * The section, as data. The manager renders this; nothing here builds DOM, so
     * the same description is what Discord's own settings show and what a future
     * surface reads. `actions` are the beef functions the owner asked for, and each
     * one names the route it calls so a reader can check it.
     */
    function section() {
      return {
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
          { id: "rollback", label: "Roll back generator", route: "POST /api/beef/source", needs: "control server" },
          { id: "install", label: "Install a generator", route: "POST /api/beef/source", needs: "control server", input: "source text" },
          { id: "inspect", label: "Read a line", route: "GET /api/inspect", needs: "control server", input: "text" },
          { id: "last", label: "Last beef", route: "GET /api/last-beef", needs: "control server" },
          { id: "start", label: "Beef with a user", route: "command box: beef <user>", needs: "control server" },
        ],
        state: state(),
      };
    }

    function setSetting(key, value) {
      const known = ["announce", "showDropped", "history"];
      if (!known.includes(String(key))) return { ok: false, error: "beef has no " + String(key) + " setting" };
      ctx.setSetting(String(key), value);
      return { ok: true, section: section() };
    }

    // fire and forget, but never unhandled: a rejected promise in the main process
    // is a crash path, so the first read reports its own failure
    refresh().catch((err) => note(String((err && err.message) || err)));

    return { state, section, refresh, reload, install, rollback, inspect, last, start, setSetting };
  },

  stop(ctx) {
    ctx.log("beef section closed");
  },
};
