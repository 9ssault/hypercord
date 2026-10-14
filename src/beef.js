// language: JavaScript, file: src/beef.js
//
// Beef, in the client, with no control server anywhere.
//
// The Beef section used to be a viewer for a control server's routes: with no server
// configured every function answered "no control server configured", which is an honest
// answer and a useless one. This module is where that ends. The same functions - the
// generator's state, its reload, its rollback, the line lab and the last beef - run here,
// on this machine, with nothing to configure.
//
// Three things are worth knowing:
//
//   * **the generator is the operator's file.** The bot loads a generator module the
//     operator supplies (`beefgen.cjs`), discovers its categories from what it exports, and
//     hot-swaps it when the file changes. The same file is loaded here, from the client's
//     own data directory, with the same rule: a replacement that will not load is rejected
//     and the last working generator stays in place, so a bad paste never disarms anything.
//     Installing keeps one backup, and rollback restores exactly that file - which is the
//     whole of what "roll back the generator" means;
//   * **with no file, the built-in banks answer.** `src/beef-lines.js` is the port of the
//     bot's own content banks, so a machine that has never seen a generator still draws
//     real lines, and the section still says which source answered (`builtin banks`);
//   * **the log is a file, not a server.** What ran is written to `beef.json` in the
//     client's data directory, newest last, capped - so "the last beef and its history" is
//     a read of a file this process owns.
//
// Nothing here runs on a timer: a replaced generator is noticed when state is asked for,
// which is a stat call, not a poll.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as banks from "./beef-lines.js";
import * as routing from "./beef-routing.js";

/** Where the operator's generator is looked for, in order, inside the data directory. */
const CANDIDATES = ["beefgen.cjs", "beefgen.js", path.join("gen", "beefgen.cjs"), path.join("gen", "beefgen.js")];
const BACKUP = "beefgen.backup.cjs";
const LOG_NAME = "beef.json";
const LOG_MAX = 200;
const MAX_SOURCE = 4 * 1024 * 1024;

// The names a generator's own dispatcher uses. They are not categories, so they are not
// offered as one; everything else the module exports is, which is what lets a replacement
// file with new categories work with no change here.
const NOT_CATEGORIES = new Set(["line", "batch", "many", "default", "categories", "__esModule"]);

// The kinds a line can be drawn for, and the generator export names that mean each one.
const ALIASES = {
  insult: ["insult", "insultline", "roast"],
  banter: ["banter", "banterline", "chat", "talk"],
  clutch: ["clutch", "clutchline", "clutches", "play"],
  afk: ["afkcheck", "afk_check", "afkline"],
  entry: ["entry", "opener", "entryline"],
  confused: ["confused"],
  welcome: ["welcome"],
  final: ["final"],
};
const PROBE = { name: "probe", count: 2, topic: "gaming" };

export function createBeef({ userData = ".", log = () => {} } = {}) {
  const home = String(userData || ".");
  const require_ = createRequire(import.meta.url);
  const logFile = path.join(home, LOG_NAME);

  let generator = null; // the loaded module, when one loaded
  let sourcePath = ""; // where it came from, empty when the banks answer
  let categories = [...banks.KINDS]; // the kinds it can draw
  let declared = []; // every category the module exports, aliases included
  let dropped = []; // declared, but refused by the probe
  let remapped = {}; // export name -> the kind it stands in for
  let loadedAt = 0;
  let generations = 0;
  let reloadMs = 0;
  let lastError = ""; // the standing advisory (dropped categories, a draw that threw)
  let lastFailure = ""; // why the last load attempt failed; cleared by a load that works
  let signature = ""; // size + mtime of the file the generator came from
  let triedSignature = ""; // the signature of the last file a load was attempted on
  let installedAt = ""; // when install() last wrote the generator

  /* ---- the file ------------------------------------------------------------ */

  function candidateFiles() {
    return CANDIDATES.map((name) => path.join(home, name));
  }

  function backupFile() {
    return path.join(home, BACKUP);
  }

  function fileSize(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  function fileSignature(file) {
    try {
      const stat = fs.statSync(file);
      return String(stat.size) + ":" + String(Math.round(stat.mtimeMs));
    } catch {
      return "";
    }
  }

  function pickFile() {
    for (const file of candidateFiles()) {
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* not there: the next candidate */
      }
    }
    return "";
  }

  /** Which kind an exported category name stands for. */
  function kindFor(name) {
    const key = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    if (banks.KINDS.includes(key)) return key;
    for (const [kind, names] of Object.entries(ALIASES)) {
      if (names.some((one) => key === one || key.startsWith(one))) return kind;
    }
    return key;
  }

  /**
   * What a generator module offers: its exported functions, minus the dispatcher. Each is
   * probed with a plain call, because a category that throws is one a person would press
   * and get nothing from - better to say it was dropped than to look broken.
   */
  function discover(mod) {
    const kinds = [];
    const refused = [];
    const names = [];
    remapped = {};
    for (const [name, value] of Object.entries(mod || {})) {
      if (typeof value !== "function" || NOT_CATEGORIES.has(name)) continue;
      names.push(name);
      const kind = kindFor(name);
      if (kind !== name && !banks.KINDS.includes(name)) remapped[name] = kind;
      let drawn;
      try {
        drawn = value({ ...PROBE, rng: () => 0.5 });
        if (drawn === undefined || drawn === null || String(drawn).trim() === "") {
          refused.push(name);
          continue;
        }
      } catch {
        refused.push(name);
        continue;
      }
      if (!kinds.includes(kind)) kinds.push(kind);
    }
    return { kinds, refused, names };
  }

  /**
   * Load the generator at `file`, or keep the working one and say why.
   *
   * This is the bot's own rule, and the reason a bad paste is survivable: a module that
   * cannot be loaded, or that exports nothing usable, leaves the previous generator in
   * place. The failure is reported, never thrown.
   */
  function load(file, { force = false, from = "reload" } = {}) {
    const wanted = String(file || "");
    const started = Date.now();
    const next = fileSignature(wanted);
    if (!force && wanted === sourcePath && next === signature) return;
    triedSignature = next;

    if (!wanted) {
      generator = null;
      sourcePath = "";
      categories = [...banks.KINDS];
      declared = [...banks.KINDS];
      dropped = [];
      remapped = {};
      loadedAt = Date.now();
      lastError = "";
      lastFailure = "";
      signature = "";
      triedSignature = "";
      return;
    }

    try {
      try {
        delete require_.cache[require_.resolve(wanted)];
      } catch {
        /* never resolved before: nothing to drop from the cache */
      }
      const mod = require_(wanted);
      const found = discover(mod);
      if (!found.kinds.length) {
        lastFailure = "the generator at " + wanted + " exports nothing the beef path can draw from";
        lastError = lastFailure;
        log("[hypercord] beef: " + lastFailure);
        if (!generator) load("");
        return;
      }
      generator = mod;
      sourcePath = wanted;
      categories = found.kinds;
      declared = found.names;
      dropped = found.refused;
      remapped = { ...remapped };
      loadedAt = Date.now();
      generations += 1;
      reloadMs = Date.now() - started;
      lastFailure = "";
      lastError = found.refused.length ? "dropped: " + found.refused.join(", ") : "";
      signature = next;
      log(
        "[hypercord] beef generator " +
          (from === "install" ? "installed" : from === "start" ? "found" : "reloaded") +
          ": " +
          path.basename(wanted) +
          " (" +
          categories.length +
          " categories" +
          (dropped.length ? ", " + dropped.length + " dropped" : "") +
          ")",
      );
    } catch (err) {
      lastFailure = "the generator at " + wanted + " could not be loaded: " + String((err && err.message) || err).slice(0, 160);
      lastError = lastFailure;
      log("[hypercord] beef: " + lastFailure);
      if (!generator) load("");
    }
  }

  /** Everything the section shows. A replaced file is noticed here, by a stat. */
  function state() {
    const onDisk = pickFile();
    const onDiskSignature = fileSignature(onDisk);
    // a replaced or edited generator is noticed here, and a file that already failed once
    // is not attempted again on every refresh
    if (onDisk && onDiskSignature !== signature && onDiskSignature !== triedSignature) load(onDisk, {});
    return {
      ready: Boolean(generator) || categories.length > 0,
      installed: Boolean(generator),
      source: sourcePath || "builtin banks",
      sourceFile: sourcePath,
      sourceLabel: sourceLabel(),
      categories: [...categories],
      declared: [...declared],
      dropped: [...dropped],
      remapped: { ...remapped },
      generations,
      reloadMs,
      lastError,
      lastFailure,
      installedAt,
      loadedAt,
      backup: fs.existsSync(backupFile()) ? { file: backupFile(), bytes: fileSize(backupFile()) } : null,
      log: readLog().length,
      at: Date.now(),
      banks: banks.KINDS.length,
    };
  }

  /**
   * Read the generator, from disk, again. The section's Reload button, answered in this
   * process. With no file anywhere, the built-in banks are what remains, and that is
   * reported as the source rather than as an error.
   */
  function reload() {
    const file = pickFile();
    if (!file) {
      load("");
      log("[hypercord] beef: no generator file, the built-in banks answer");
      return { ok: true, error: "", ...state() };
    }
    load(file, { force: true });
    return { ok: !lastFailure, error: lastFailure, ...state() };
  }

  /**
   * Install a generator: the previous file is kept as the backup, the pushed text is
   * written and loaded, and a file that will not load is rolled back on the spot - so the
   * client can never be left pointing at a generator that does not draw.
   */
  function install(text, { name = "" } = {}) {
    const source = String(text === undefined || text === null ? "" : text);
    if (!source.trim()) return { ok: false, error: "nothing to install (the push was empty)", ...state() };
    if (source.includes("\u0000")) {
      return { ok: false, error: "the file looks like UTF-16 (it contains null bytes) - save it as UTF-8 and push again", ...state() };
    }
    if (Buffer.byteLength(source) > MAX_SOURCE) return { ok: false, error: "the generator is larger than " + MAX_SOURCE + " bytes", ...state() };
    const target = path.join(home, path.basename(String(name || "beefgen.cjs")));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // One backup, of the text this install is about to replace - read from the exact
      // file being written, not from "whichever candidate is first". Getting this wrong
      // was a real bug: installing over beefgen.cjs wrote no backup at all, so a file
      // that would not load could not be rolled back and stayed on disk. A first install
      // (nothing there yet) has nothing to keep, and rollback() says that rather than
      // pretending.
      const existing = fs.existsSync(target) ? target : pickFile();
      if (existing) {
        try {
          fs.copyFileSync(existing, backupFile());
        } catch {
          /* no backup: rollback() will say so rather than pretend */
        }
      }
      fs.writeFileSync(target, source);
    } catch (err) {
      return { ok: false, error: "the generator could not be written: " + String((err && err.message) || err).slice(0, 140), ...state() };
    }
    load(target, { force: true, from: "install" });
    if (lastFailure) {
      // The new file is not a generator: put the previous one back rather than leave the
      // client with nothing to draw from. The reason is read out first, because the
      // rollback's own reload is a success and clears the failure - and a caller that
      // asked to install something must still be told why it was refused.
      const why = lastFailure;
      const restored = rollback();
      return { ok: false, error: why, restored: restored.ok === true, ...state() };
    }
    installedAt = new Date().toISOString();
    return { ok: true, error: "", ...state() };
  }

  /** Put back the copy the last accepted install replaced. */
  function rollback() {
    const file = backupFile();
    if (!fs.existsSync(file)) {
      return { ok: false, error: "there is no backup to roll back to (nothing has been installed in this data directory)", ...state() };
    }
    const target = path.join(home, path.basename(pickFile() || CANDIDATES[0]));
    try {
      fs.copyFileSync(file, target);
      fs.rmSync(file, { force: true });
    } catch (err) {
      return { ok: false, error: "the backup could not be restored: " + String((err && err.message) || err).slice(0, 140), ...state() };
    }
    load(target, { force: true });
    return { ok: !lastFailure, error: lastFailure, ...state() };
  }

  /* ---- drawing lines ------------------------------------------------------- */

  /**
   * One line for a kind: the operator's generator when it has one, the built-in banks
   * otherwise. A generator category that throws falls back to the banks rather than
   * leaving a hole in the beef, and says so in the log - a partly working replacement
   * beats an empty message.
   */
  function lineFor(kind, opts = {}) {
    const wanted = String(kind || "").toLowerCase();
    // "opener" is a kind, not an alias of "entry": draw from the banks for it, so a
    // generator that overrides one does not silently take over the other
    if (generator && categories.includes(wanted)) {
      for (const [name, value] of Object.entries(generator)) {
        if (typeof value !== "function" || NOT_CATEGORIES.has(name)) continue;
        if (kindFor(name) !== wanted) continue;
        try {
          const out = value({ ...PROBE, ...opts });
          if (out !== undefined && out !== null && String(out).trim()) return String(out).trim();
        } catch (err) {
          lastError = "the generator's " + name + " threw: " + String((err && err.message) || err).slice(0, 120);
          log("[hypercord] beef: " + lastError);
        }
      }
    }
    if (generator && !banks.KINDS.includes(wanted)) return "";
    try {
      const drawn = banks.line(wanted, opts);
      return String(drawn === undefined || drawn === null ? "" : drawn).trim();
    } catch (err) {
      lastError = "the built-in banks could not draw " + wanted + ": " + String((err && err.message) || err).slice(0, 120);
      log("[hypercord] beef: " + lastError);
      return "";
    }
  }

  function sourceLabel() {
    return sourcePath ? path.basename(sourcePath) : "builtin banks";
  }

  /**
   * A beef against a user, built here: how the line routes (the bot's own routing), how
   * hot it reads, and the lines themselves - an opener, the burst, the follow-ups.
   * Deterministic when `roll` is passed, which is what makes it testable.
   */
  function start(target, { count = 3, roll = Math.random, text = "", selfId = "", now = Date.now(), history = [] } = {}) {
    const name = String(target || "").trim();
    if (!name) return { ok: false, error: "name the user to beef with" };
    const said = String(text || "").trim();
    const aggro = routing.detectAggro(said, { names: [name], selfId });
    const heat = routing.heatOf(said, {
      level: aggro.level,
      strikes: aggro.aggro ? 1 : 0,
      mentioned: aggro.mentioned || /<@!?\d+>/.test(said),
    });
    const route = routing.pickBeefRoute({ aggro: aggro.aggro, armedAnswer: false });
    const wanted = Math.max(1, Math.min(12, Number(count) || 3));
    const topic = routing.smartTopic(said, Array.isArray(history) ? history : []);
    const context = said ? [said] : [];
    const lines = [];
    const opener = lineFor("opener", { name, rng: roll, context, previous: "" }) || lineFor("entry", { name, rng: roll, context });
    if (opener) lines.push(opener);
    const burst = banks.insultBurst({ count: wanted, context, rng: roll });
    for (const one of Array.isArray(burst) ? burst : [burst]) {
      const line = String(one === undefined || one === null ? "" : one).trim();
      if (line) lines.push(line.split("{name}").join(name));
    }
    // the follow-ups alternate the way the bot's own beef does: a jab, then a line that
    // pretends to be above it all
    for (let index = 0; index < Math.min(2, wanted); index += 1) {
      const kind = index % 2 === 0 ? "banter" : "clutch";
      const one = lineFor(kind, { name, rng: roll, context, previous: lines[lines.length - 1] || "" });
      if (one) lines.push(one);
    }
    const entry = {
      at: new Date(now).toISOString(),
      target: name,
      topic,
      route,
      heat,
      tier: routing.heatTier(heat),
      intent: routing.detectIntent(said),
      source: sourceLabel(),
      lines: lines.filter(Boolean),
    };
    record(entry);
    return { ok: true, ...entry };
  }

  /* ---- the line lab -------------------------------------------------------- */

  /**
   * What the detectors make of a line. Read-only, and nothing is posted anywhere: the
   * section's "read a line" is answered here, in this process. `selfId` is optional - with
   * it the ping is precise, without it a mention is taken as aimed at us (see the note in
   * the body), and the same rule decides the route.
   */
  function inspect(text, { selfId = "", roll = Math.random, now = Date.now(), history = [] } = {}) {
    const raw = String(text === undefined || text === null ? "" : text);
    if (!raw.trim()) return { ok: false, error: "nothing to read (the line was empty)" };
    const pinged = selfId ? routing.isPing(raw, selfId) : /<@!?\d+>/.test(raw);
    // Who the line is aimed at is the one thing this process cannot know on its own: the
    // lab is handed a line, not a session. With the account's own id it is precise; with
    // no id, a mention of anybody is read as aimed at us, which is the reading a person
    // pasting "<@1> you are trash" is asking for - and `directed` still reports which of
    // the two rules decided it.
    const aggro = routing.detectAggro(raw, selfId ? { selfId } : { mentioned: pinged });
    const heat = routing.heatOf(raw, { level: aggro.level, strikes: aggro.aggro ? 1 : 0, mentioned: pinged });
    const afk = routing.afkDecision(
      { tagged: aggro.mentioned, named: true, checkCount: 1, checksSeen: 1, heat, now },
      routing.DEFAULT_CONFIG,
    );
    return {
      ok: true,
      read: {
        text: raw,
        ping: pinged,
        aggro: aggro.level ? { level: aggro.level, score: aggro.score, cues: aggro.cues, classes: aggro.classes } : null,
        directed: aggro.directed,
        intensity: routing.intensityOf(raw),
        heat,
        tier: routing.heatTier(heat),
        route: routing.pickBeefRoute({ aggro: aggro.aggro, armedAnswer: false }),
        intent: routing.detectIntent(raw),
        topic: routing.smartTopic(raw, Array.isArray(history) ? history : []),
        words: routing.contentWords(raw),
        quote: routing.quoteKind(raw),
        emoji: routing.emojiReaction(raw, { roll }),
        cue: routing.reactionCue(raw, { roll }),
        afk: afk || null,
        source: sourceLabel(),
        at: now,
      },
    };
  }

  /** A sample of the writing style the banks hold, for the section's voice preview. */
  function voices(limit, roll) {
    return banks.voiceExamples(Number(limit) || 12, roll);
  }

  /* ---- the log ------------------------------------------------------------- */

  function readLog() {
    try {
      const parsed = JSON.parse(fs.readFileSync(logFile, "utf8")) || {};
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  function record(entry) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const entries = [...readLog(), entry].slice(-LOG_MAX);
      fs.writeFileSync(logFile, JSON.stringify({ version: 1, entries }, null, 1) + "\n");
      return true;
    } catch (err) {
      log("[hypercord] beef: the log could not be written (" + String((err && err.message) || err).slice(0, 120) + ")");
      return false;
    }
  }

  /** The last beef and the history the owner asked for, newest last. */
  function last({ history = 5 } = {}) {
    const entries = readLog();
    const wanted = Math.max(0, Math.min(20, Number(history) || 0));
    return {
      ok: true,
      beef: entries.length ? entries[entries.length - 1] : null,
      history: wanted > 1 ? entries.slice(-wanted, -1) : [],
      total: entries.length,
    };
  }

  // The first read is the one that finds a generator already sitting in the data directory,
  // and it reports its own failure rather than leaving an unhandled error in the main
  // process.
  try {
    const first = pickFile();
    load(first, { force: true, from: "start" });
    if (!first) log("[hypercord] beef: no generator file, the built-in banks answer");
  } catch (err) {
    lastFailure = String((err && err.message) || err);
    lastError = lastFailure;
    log("[hypercord] beef: " + lastFailure);
  }

  return {
    state,
    reload,
    install,
    rollback,
    line: lineFor,
    start,
    inspect,
    last,
    voices,
    /** the kinds the beef path draws for, and what each one draws from */
    categories: () => banks.categories(),
    /** the generator's own file, for a caller that wants to open it */
    file: () => sourcePath || path.join(home, CANDIDATES[0]),
    backup: () => backupFile(),
    logFile: () => logFile,
    kinds: () => [...banks.KINDS],
    routing,
  };
}
