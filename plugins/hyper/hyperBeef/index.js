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
//
// The server is not the only way to answer, and on a machine where none is configured
// it is not the way at all. The client carries the same beef engine in its own process
// (src/beef.js) and the host hands it to plugins as `ctx.local.beef`: the generator it
// loads from the client's data directory, its reload, its install and rollback, the line
// lab and the last beef it recorded. So every function below has two paths - the routes
// above when a control server is configured, and this process when one is not - and the
// local engine returns the same field names the routes document, which is why both paths
// feed the same `apply` and the section cannot tell them apart. What it does *not* do is
// pretend: `start` draws lines here and posts nothing to Discord, and says so, while the
// server path goes through the command box as it always did.
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
      installed: false,
      categories: [],
      declared: [],
      dropped: [],
      remapped: {},
      generations: 0,
      reloadMs: 0,
      source: "",
      lastError: "",
      backup: null,
      banks: 0,
      log: 0,
      at: 0,
      reason: "",
    };
    let backup = null; // the rollback target, as metadata only

    /**
     * "No control server configured" is a normal state, not a failure - and it is not the
     * same state as "the api object is missing". The host always builds an api (the caller
     * may set a control URL later), so the question is whether that api has anywhere to
     * send a request: `createApi` with no base URL answers every request with "no control
     * server configured" rather than pretending, which is exactly the machine the local
     * engine exists for. Asking the api its own base is the one reading that cannot drift
     * from what a request would do.
     */
    function unconfigured() {
      if (!ctx.api || typeof ctx.api.request !== "function") return true;
      return !String(ctx.api.base || "");
    }

    /**
     * The client's own engine, when this run has one. It is read live on every call
     * rather than captured at start, the same way a setting is: the host builds it once
     * per run, and a section that cached it would keep answering after it was gone.
     */
    function local() {
      return ctx.local && ctx.local.beef && typeof ctx.local.beef.state === "function" ? ctx.local.beef : null;
    }

    /**
     * Which path answers right now: the server when one is configured, the local engine
     * when one is not, and neither when the run has neither - the one case where the
     * section says so instead of showing an empty generator that looks like a broken one.
     */
    function via() {
      if (!unconfigured()) return "control server";
      return local() ? "local engine" : "";
    }

    /**
     * What a local state means in the section's own words: a file that would not load, or
     * categories the engine dropped, are the two things worth saying out loud.
     */
    function localReason(next) {
      const failure = String((next && next.lastFailure) || "");
      if (failure) return failure;
      const dropped = next && Array.isArray(next.dropped) ? next.dropped : [];
      if (dropped.length) return "dropped: " + dropped.join(", ");
      return "";
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
      beef.installed = Boolean(json.installed);
      beef.categories = Array.isArray(json.categories) ? json.categories.map(String) : [];
      beef.declared = Array.isArray(json.declared) ? json.declared.map(String) : beef.declared;
      beef.dropped = Array.isArray(json.dropped) ? json.dropped.map(String) : [];
      beef.remapped = json.remapped && typeof json.remapped === "object" ? { ...json.remapped } : {};
      beef.generations = Number(json.generations) || 0;
      beef.reloadMs = Number(json.reloadMs) || 0;
      // the local engine names the file it drew from (`sourceLabel`) and the server names
      // a path (`source`): either way the field a person reads says where the lines come
      // from, and "builtin banks" is a real answer rather than an empty one
      beef.source = String(json.sourceLabel || json.source || "");
      beef.lastError = String(json.lastError || "");
      beef.banks = Number(json.banks) || beef.banks;
      beef.log = Number(json.log) || 0;
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
      const engine = local();
      if (unconfigured() && engine) {
        // no round trip and nothing to wait for: the engine is a few function calls in
        // this process, so the section is filled before the caller gets the promise back
        const next = engine.state();
        apply(next);
        note(localReason(next));
        return state();
      }
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
      const engine = local();
      if (unconfigured() && engine) {
        const res = engine.reload();
        apply(res);
        note(res.error || localReason(res));
        if (res.ok) ctx.log("beef generator reloaded (" + beef.categories.length + " categories, source " + beef.source + ")");
        return { ok: res.ok === true, error: String(res.error || ""), ...state() };
      }
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
      const engine = local();
      if (unconfigured() && engine) {
        // the engine keeps one backup and writes the pushed text as the generator, so the
        // push and the rollback below mean here exactly what they mean on the server - and
        // a file that will not load is rolled back by the engine before this returns
        const res = engine.install(source);
        apply(res);
        note(res.error || "");
        if (res.ok) ctx.log("beef generator installed (" + beef.categories.length + " categories, source " + beef.source + ")");
        return { ok: res.ok === true, error: String(res.error || ""), restored: res.restored, ...state() };
      }
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
      const engine = local();
      if (unconfigured() && engine) {
        const res = engine.rollback();
        apply(res);
        note(res.error || "");
        if (res.ok) ctx.log("beef generator rolled back (source " + beef.source + ")");
        return { ok: res.ok === true, error: String(res.error || ""), ...state() };
      }
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
      const engine = local();
      if (unconfigured() && engine) {
        const res = engine.inspect(line);
        if (res.ok) return { ok: true, read: res.read };
        return { ok: false, error: String(res.error || "the line could not be read") };
      }
      if (unconfigured()) return { ok: false, error: "no control server configured" };
      const res = await ask("/api/inspect?text=" + encodeURIComponent(line));
      if (res.ok && res.json) return { ok: true, read: res.json };
      return { ok: false, error: why(res) };
    }

    /**
     * The last beef, and the history behind it, trimmed to the setting: the server's
     * rolling history when there is a server, the client's own log file when there is not.
     */
    async function last() {
      const engine = local();
      if (unconfigured() && engine) {
        const wanted = Math.max(0, Math.min(20, Number(ctx.setting("history")) || 0));
        const res = engine.last({ history: wanted });
        if (!res.ok) {
          return { ok: false, error: String(res.error || "the local engine could not read its log"), beef: null, history: [], total: 0 };
        }
        return {
          ok: true,
          beef: res.beef || null,
          history: Array.isArray(res.history) ? res.history : [],
          total: Number(res.total) || 0,
        };
      }
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
     *
     * With no server configured the client's own engine builds the beef here instead:
     * the same routing and the same banks, recorded in this client's log, and nothing is
     * sent to Discord - which the reply says rather than leaving a person to find out.
     */
    async function start(user) {
      const target = String(user === undefined || user === null ? "" : user).trim();
      if (!target) return { ok: false, error: "name the user to beef with" };
      const engine = local();
      if (unconfigured() && engine) {
        // the lines are drawn here and the beef is recorded in this client's own log;
        // nothing is posted to Discord from this path, which the reply says plainly
        const res = engine.start(target, {});
        if (!res.ok) return { ok: false, error: String(res.error || "the local engine could not build a beef"), via: "local engine" };
        const drawn = Array.isArray(res.lines) ? res.lines.length : 0;
        ctx.log("beef drawn against " + target + " (" + drawn + " lines, route " + res.route + ")");
        return { ok: true, via: "local engine", beef: res, note: "the lines were drawn in this client and were not sent to Discord" };
      }
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
        declared: [...beef.declared],
        dropped: [...beef.dropped],
        remapped: { ...beef.remapped },
        backup: backup ? { ...backup } : null,
        droppedShown: ctx.setting("showDropped") !== false,
        // which path answered, in the section's own data rather than only in the reason
        // string: a page that shows an empty generator can then show why it is empty
        answers: via() || "nothing configured",
      };
    }

    /** the start action's route: the command box on the server, the engine here */
    function answeredRoute(asked) {
      return asked ? "local engine: beef.start(user)" : "command box: beef <user>";
    }

    /**
     * The section, as data. The manager renders this; nothing here builds DOM, so
     * the same description is what Discord's own settings show and what a future
     * surface reads. `actions` are the beef functions the owner asked for, and each
     * one names the route it calls so a reader can check it.
     */
    function section() {
      // the actions describe the call that will actually be made: the same function names
      // against the local engine when it is what answers, so a reader is never told a
      // route is live when a server is not
      const answers = via();
      const asked = answers === "local engine";
      const needs = asked ? "local engine" : "control server";
      const route = (server, here) => (asked ? here : server);
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
          { id: "refresh", label: "Refresh", route: route("GET /api/beef", "local engine: beef.state()") },
          { id: "reload", label: "Reload generator", route: route("POST /api/beef", "local engine: beef.reload()"), needs },
          { id: "rollback", label: "Roll back generator", route: route("POST /api/beef/source", "local engine: beef.rollback()"), needs },
          { id: "install", label: "Install a generator", route: route("POST /api/beef/source", "local engine: beef.install()"), needs, input: "source text" },
          { id: "inspect", label: "Read a line", route: route("GET /api/inspect", "local engine: beef.inspect()"), needs, input: "text" },
          { id: "last", label: "Last beef", route: route("GET /api/last-beef", "local engine: beef.last()"), needs },
          { id: "start", label: "Beef with a user", route: answeredRoute(asked), needs },
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

    return { state, section, refresh, reload, install, rollback, inspect, last, start, setSetting, via };
  },

  stop(ctx) {
    ctx.log("beef section closed");
  },
};
