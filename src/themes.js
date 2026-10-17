// language: JavaScript, file: src/themes.js
//
// Themes, without a single line of theme code ever running. A theme is CSS text
// and nothing else:
//
//   * local themes are `.theme.css` files the user drops in <userData>/themes;
//   * online themes are fetched at the moment they are installed and then stored
//     as files, so rendering a theme never touches the network - there is no
//     timer and no background refresh anywhere in this file, which is what keeps
//     the idle-timer budget at zero;
//   * quick CSS is one string the user edits.
//
// Everything ends up in `css()`, a single string the client pastes into the page
// at one injection point. A theme that is not enabled is never read from disk.
//
// The client also ships one theme of its own - AMOLED black - as a string in this
// file, installed and enabled by `installDefault()`. It goes through the same gate
// and the same injection point as a user's, so the default cannot do anything a
// downloaded theme could not, and it needs no network and no file to exist.
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 512 * 1024;

/**
 * Where a browser of themes reads from.
 *
 * The library is the only public theme index with a documented JSON API (Equicord's
 * Equithemes), so it is the one this client reads. It is asked for when somebody presses
 * Load, its reply is trimmed to the fields a card shows, and the trimmed list is kept in
 * memory for a bounded time - there is no timer here, no background refresh, and nothing
 * is fetched while nobody is looking at the page.
 *
 * A theme's CSS is *not* in that reply: the documented download URL for a theme's file is
 * `/download/<id>`, and installing from here goes through exactly the same gate as
 * installing from a link somebody pasted - one fetch at the moment of install, then a
 * file on disk, and never the network again.
 */
const LIBRARY_URL = "https://api.themes.equicord.org/themes";
const LIBRARY_DOWNLOAD = "https://api.themes.equicord.org/download/";
const LIBRARY_PAGE = "https://themes.equicord.org/theme/";
const LIBRARY_TTL_MS = 10 * 60 * 1000;
const LIBRARY_HOSTS = new Set(["api.themes.equicord.org", "themes.equicord.org"]);

// A preview is a picture the library publishes, and the page it would be drawn in refuses
// most of the web: the client's own Content-Security-Policy decides what its images may be,
// and the index has at least one row whose thumbnail lives on a third party's GitHub Pages.
// So the bytes are fetched *here*, once, and handed to the page as a data URL - one request
// when somebody asks for that one preview, never one per card as a grid is drawn.
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;
const THUMBNAIL_CACHE_MAX = 12;

// A theme is injected into the page as CSS, so the only things worth refusing
// are the things that would let it act like anything other than CSS.
/**
 * Where a theme may `@import` from.
 *
 * Themes really do import: the published ones pull their own modules and their fonts in
 * with `@import url(...)`, and refusing the statement outright refused most of the theme
 * library - which is what "install Novum: @import is not allowed" was. So it is allowed
 * from an allow-list rather than never: the hosts BetterDiscord's own publishing
 * guidelines tell theme authors to use (GitHub, GitLab, Codeberg, Imgur, Discord, Google
 * Fonts) plus the CDNs those projects serve from. What stays refused is an import from
 * anywhere else, and the message names the host, because "not allowed" without a host is
 * not something a person can act on.
 */
const IMPORT_HOSTS = new Set([
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "cdn.jsdelivr.net",
  "gitlab.com",
  "codeberg.org",
  "imgur.com",
  "i.imgur.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "discord.com",
]);

const IMPORT_ALLOWED = [...IMPORT_HOSTS].slice(0, 8).join(", ");

/** The first `@import` a theme may not make, or an empty string. */
function importProblem(css) {
  for (const statement of css.matchAll(/@import\s+([^;]*);?/gi)) {
    const value = String(statement[1] || "").trim();
    const wrapped = /^url\(\s*['"]?([^'")]*?)['"]?\s*\)$/i.exec(value) || /^['"]([^'"]*)['"]$/.exec(value);
    const target = wrapped ? wrapped[1].trim() : "";
    if (!target) return "an @import with nothing to import is not allowed in a theme";
    if (!/^https:\/\//i.test(target)) return "@import must be an https url, and this one is " + target.slice(0, 60);
    let host = "";
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      return "that @import is not a url: " + target.slice(0, 60);
    }
    if (!IMPORT_HOSTS.has(host)) {
      return "@import from " + host + " is not allowed: a theme may import from " + IMPORT_ALLOWED + " and nowhere else";
    }
  }
  return "";
}

const FORBIDDEN = [
  [/<\/style/i, "</style> is not allowed in a theme: it would end the style block"],
  [/<script/i, "<script is not allowed in a theme"],
  [/javascript:/i, "javascript: URLs are not allowed in a theme"],
  [/expression\s*\(/i, "CSS expression() is not allowed in a theme"],
  [/behavior\s*:/i, "the behavior property is not allowed in a theme"],
];

/** the one gate every piece of CSS text goes through */
export function sanitizeCss(text) {
  if (typeof text !== "string") return { ok: false, error: "a theme must be CSS text" };
  if (text.length > MAX_BYTES) return { ok: false, error: "the theme is larger than " + MAX_BYTES + " bytes" };
  const css = text.trim();
  if (!css) return { ok: false, error: "the theme is empty" };
  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(css)) return { ok: false, error: why };
  }
  const badImport = importProblem(css);
  if (badImport) return { ok: false, error: badImport };
  return { ok: true, css };
}

/**
 * The built-in theme this client ships with: full AMOLED black.
 *
 * True black on every surface Discord paints, with no surface lifted a hair above
 * another: the lifted greys this used to carry are why the client read as dark grey
 * instead of black. Edges come from Discord's own 1px borders and from the
 * white-alpha hover, selected and accent fills kept at the bottom of this block -
 * removing those would leave nothing to see when a row is hovered. Text colours are
 * left alone: the point is the background, and overriding text here would fight
 * every accessibility setting the person already has.
 */
export const AMOLED_ID = "amoled-black";

export const AMOLED_CSS = `/* Hypercord's built-in theme: full AMOLED black. */
:root {
  --background-primary: #000000;
  --background-secondary: #000000;
  --background-secondary-alt: #000000;
  --background-tertiary: #000000;
  --background-accent: #000000;
  --background-floating: #000000;
  --background-mobile-primary: #000000;
  --background-mobile-secondary: #000000;
  --channeltextarea-background: #000000;
  --input-background: #000000;
  --modal-background: #000000;
  --modal-footer-background: #000000;
  --deprecated-card-bg: #000000;
  --deprecated-quickswitcher-input-background: #000000;
  --background-modifier-hover: rgba(255, 255, 255, 0.03);
  --background-modifier-active: rgba(255, 255, 255, 0.05);
  --background-modifier-selected: rgba(255, 255, 255, 0.07);
  --background-modifier-accent: rgba(255, 255, 255, 0.06);
}
html, body { background: #000000; }
[class^="app-"], [class^="bg-"], [class^="sidebar-"], [class^="chat-"], [class^="members-"], [class^="scroller-"] { background-color: #000000; }`;

/** an id that is safe as a file name on every platform */
function idFor(raw) {
  const base = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\.theme\.css$/i, "")
    .replace(/\.[a-z0-9]{1,5}$/i, "");
  const id = base
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return id || "theme";
}

export function createThemes({ root = "", userData = "", log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const home = String(userData || root || ".");
  const dir = path.join(home, "themes");
  const stateFile = path.join(home, "themes.state.json");
  let state = null;
  let fetchCalls = 0; // only the online install path may move this
  let library = null; // the library index as it was read, with when it was read
  let libraryError = "";
  const previews = new Map(); // the previews fetched, by address, bounded to a handful

  function blank() {
    return { version: 1, order: [], themes: {}, quickCss: "" };
  }

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  function read() {
    if (state) return state;
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")) || {};
      const themes = saved.themes && typeof saved.themes === "object" ? saved.themes : {};
      state = {
        version: 1,
        order: (Array.isArray(saved.order) ? saved.order : []).map(String).filter((id) => id in themes),
        themes,
        quickCss: typeof saved.quickCss === "string" ? saved.quickCss : "",
      };
    } catch {
      state = blank(); // first run, or a state file we cannot read
    }
    return state;
  }

  function write() {
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
      return true;
    } catch (err) {
      log("[hypercord] themes: could not save the state (" + String((err && err.message) || err) + ")");
      return false;
    }
  }

  /** where a theme's stored CSS lives: one file per theme, read only when enabled */
  function fileOf(id) {
    return path.join(dir, id + ".theme.css");
  }

  function record(entry, css) {
    const current = read();
    ensureDir();
    fs.writeFileSync(fileOf(entry.id), css);
    current.themes[entry.id] = { ...entry, bytes: Buffer.byteLength(css) };
    if (!current.order.includes(entry.id)) current.order.push(entry.id);
    write();
    return entry;
  }

  function uniqueId(wanted) {
    const current = read();
    let id = wanted;
    let n = 2;
    while (id in current.themes) id = wanted + "-" + n++;
    return id;
  }

  /**
   * The library index, trimmed to what a card needs. `force` is what the page's Load
   * button sends: the copy in memory is a convenience, never a lock.
   */
  async function index({ force = false } = {}) {
    if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch available to read the theme library" };
    if (!force && library && Date.now() - library.at < LIBRARY_TTL_MS) {
      return { ok: true, themes: library.themes, from: library.from, fetchedAt: library.at, cached: true };
    }
    try {
      fetchCalls += 1;
      const res = await fetchImpl(LIBRARY_URL, { headers: { accept: "application/json" } });
      if (!res || !res.ok) return { ok: false, error: "the theme library answered " + ((res && res.status) || "nothing") };
      const body = await res.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body && body.themes) ? body.themes : [];
      const themes = rows
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const id = row.id === undefined || row.id === null ? "" : String(row.id);
          const person = row.author && typeof row.author === "object" ? String(row.author.github_name || row.author.discord_name || "") : String(row.author || "");
          return {
            id,
            name: String(row.name || ""),
            author: person,
            description: String(row.description || ""),
            tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
            // what the row calls itself: the index really does carry both kinds (the two
            // published ones are "theme" and "snippet"), so the filter reads it rather than
            // guessing from a description
            kind: String(row.type || ""),
            likes: Number(row.likes) || 0,
            downloads: Number(row.downloads) || 0,
            // where the preview picture is, and where its page is - both shown only when
            // somebody asks for that one entry
            thumbnail: String(row.thumbnail_url || ""),
            updated: String(row.last_updated || row.release_date || ""),
            source: String(row.source || ""),
            download: id ? LIBRARY_DOWNLOAD + id : "",
            page: id ? LIBRARY_PAGE + id : "",
          };
        })
        .filter((row) => row && row.name && row.download);
      library = { at: Date.now(), themes, from: LIBRARY_URL };
      log("[hypercord] theme library: " + themes.length + " theme(s) read");
      return { ok: true, themes, from: LIBRARY_URL, fetchedAt: library.at, cached: false };
    } catch (err) {
      libraryError = String((err && err.message) || err).slice(0, 160);
      return { ok: false, error: libraryError };
    }
  }

  /**
   * One preview picture, fetched here and handed back as a data URL.
   *
   * Four rules, and each one is a way this could otherwise be worse than not having previews
   * at all: the address must be https, the host must be one this client already trusts for
   * theme content, the reply must say it is an image, and it must not be enormous - a
   * published thumbnail is around half a megabyte and a grid of a hundred and thirty of them
   * is not something to pull over somebody's connection. What was fetched is kept in a small
   * bounded map, so looking at the same preview twice costs nothing and looking at two
   * hundred previews does not keep two hundred pictures in memory.
   */
  async function thumbnail(url) {
    const wanted = String(url || "").trim();
    if (!wanted) return { ok: false, error: "no preview to fetch" };
    let where = null;
    try {
      where = new URL(wanted);
    } catch {
      return { ok: false, error: "that preview is not an address: " + wanted.slice(0, 80) };
    }
    if (where.protocol !== "https:") return { ok: false, error: "a preview is only fetched over https, and that one is " + where.protocol.replace(":", "") };
    if (!LIBRARY_HOSTS.has(where.host) && !IMPORT_HOSTS.has(where.host)) {
      return { ok: false, error: "this client does not fetch pictures from " + where.host + "; open the theme's page to see its preview" };
    }
    if (previews.has(wanted)) return { ok: true, cached: true, ...previews.get(wanted) };
    if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch available to read a preview" };
    try {
      fetchCalls += 1;
      const res = await fetchImpl(wanted, { headers: { accept: "image/*" } });
      if (!res || !res.ok) return { ok: false, error: "the preview answered " + ((res && res.status) || "nothing") };
      const type = String((res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "").split(";")[0].trim().toLowerCase();
      if (!THUMBNAIL_TYPES.has(type)) return { ok: false, error: "that preview is " + (type || "of an unnamed type") + ", not an image" };
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > THUMBNAIL_MAX_BYTES) {
        return { ok: false, error: "that preview is " + Math.round(buffer.length / 1024) + " kb, larger than the " + Math.round(THUMBNAIL_MAX_BYTES / 1024) + " kb this client fetches" };
      }
      const answer = { dataUrl: "data:" + type + ";base64," + buffer.toString("base64"), bytes: buffer.length, type };
      previews.set(wanted, answer);
      while (previews.size > THUMBNAIL_CACHE_MAX) previews.delete(previews.keys().next().value);
      log("[hypercord] theme library: preview fetched (" + buffer.length + " bytes)");
      return { ok: true, cached: false, ...answer };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 160) };
    }
  }

  async function install(source, name = "") {
    const raw = String(source || "").trim();
    if (!raw) return { ok: false, error: "no theme to install" };
    const online = /^https?:\/\//i.test(raw);
    let text = "";
    let origin = {};

    if (online) {
      if (typeof fetchImpl !== "function") return { ok: false, error: "no fetch available for an online theme" };
      try {
        fetchCalls += 1; // the one and only place this counter moves
        const res = await fetchImpl(raw);
        if (!res || !res.ok) return { ok: false, error: "the theme download answered " + ((res && res.status) || "nothing") };
        text = await res.text();
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err).slice(0, 160) };
      }
      origin = { source: "online", url: raw };
    } else {
      const file = path.isAbsolute(raw) ? raw : path.join(dir, raw);
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (err) {
        return { ok: false, error: "could not read that theme: " + String((err && err.message) || err).slice(0, 120) };
      }
      origin = { source: "local", file: path.basename(file) };
    }

    const clean = sanitizeCss(text);
    if (!clean.ok) return { ok: false, error: clean.error };

    const id = uniqueId(idFor(name || (online ? raw : path.basename(raw))));
    const entry = { id, name: String(name || "").trim() || id, enabled: false, ...origin };
    record(entry, clean.css);
    log("[hypercord] theme added: " + id + " (" + entry.source + ")");
    return { ok: true, id };
  }

  function list() {
    const current = read();
    return current.order
      .filter((id) => id in current.themes)
      .map((id) => ({ ...current.themes[id], missing: !fs.existsSync(fileOf(id)) }));
  }

  function setEnabled(id, on) {
    const current = read();
    const key = String(id || "");
    if (!(key in current.themes)) return { ok: false, error: "no such theme: " + key };
    current.themes[key].enabled = Boolean(on);
    write();
    return { ok: true, id: key, enabled: current.themes[key].enabled };
  }

  function remove(id) {
    const current = read();
    const key = String(id || "");
    if (!(key in current.themes)) return { ok: false, error: "no such theme: " + key };
    delete current.themes[key];
    current.order = current.order.filter((x) => x !== key);
    try {
      fs.rmSync(fileOf(key), { force: true });
    } catch {
      /* the state is what matters: a stray file is never listed again */
    }
    write();
    return { ok: true, id: key };
  }

  function setQuickCss(text) {
    const clean = sanitizeCss(String(text ?? ""));
    // an empty quick CSS is legal: it means "nothing", not "an error"
    if (!clean.ok && !String(text ?? "").trim()) {
      read().quickCss = "";
      write();
      return { ok: true, css: "" };
    }
    if (!clean.ok) return { ok: false, error: clean.error };
    read().quickCss = clean.css;
    write();
    return { ok: true, css: clean.css };
  }

  function quickCss() {
    return read().quickCss;
  }

  /**
   * The single injection point. Enabled themes in the order they were added,
   * then the quick CSS - and never a file for a theme that is switched off.
   */
  function css() {
    const current = read();
    const parts = [];
    for (const id of current.order) {
      const entry = current.themes[id];
      if (!entry || !entry.enabled) continue;
      try {
        parts.push(fs.readFileSync(fileOf(id), "utf8").trim());
      } catch {
        log("[hypercord] theme " + id + " is enabled but its file is gone; skipping it");
      }
    }
    if (current.quickCss) parts.push(current.quickCss);
    const body = parts.filter(Boolean).join("\n");
    // The imports of every theme are lifted to the top of the payload, in the order they
    // were found. CSS ignores an @import that is not before every other rule, and there is
    // one injection point here rather than one style element per theme - so without this,
    // a theme that imports its own module or its font would silently lose it, and the
    // theme would read as half applied.
    const imports = [];
    const rest = body.replace(/@import\s+[^;]*;?/gi, (statement) => {
      imports.push(statement.trim());
      return "";
    });
    return imports.length ? imports.join("\n") + "\n" + rest.replace(/^\s*\n+/, "") : rest;
  }

  /** re-read the state from disk, and forget themes whose file has been removed */
  function reload() {
    state = null;
    const current = read();
    let dropped = 0;
    for (const id of [...current.order]) {
      if (!fs.existsSync(fileOf(id))) {
        delete current.themes[id];
        current.order = current.order.filter((x) => x !== id);
        dropped += 1;
      }
    }
    if (dropped) write();
    return { ...snapshot(), dropped };
  }

  /** a snapshot safe to hand out: callers must not be able to mutate the state */
  function snapshot() {
    const current = read();
    return { version: current.version, order: [...current.order], themes: JSON.parse(JSON.stringify(current.themes)), quickCss: current.quickCss, dir };
  }

  /**
   * Put the built-in AMOLED theme in place as the default.
   *
   * Called by the shell on the first run: idempotent, offline, and it never touches
   * a theme the person installed - it writes its own CSS text and enables that. A
   * default theme the person can switch off is a default, not a policy.
   */
  function installDefault() {
    const current = read();
    const existing = current.themes[AMOLED_ID];
    if (existing && existing.builtin && existing.enabled) return { ok: true, id: AMOLED_ID, already: true };
    record({ id: AMOLED_ID, name: "AMOLED Black", enabled: true, builtin: true, source: "builtin" }, AMOLED_CSS);
    log("[hypercord] theme: the built-in AMOLED default is on");
    return { ok: true, id: AMOLED_ID, already: false };
  }

  return {
    list,
    index,
    thumbnail,
    install,
    installDefault,
    remove,
    setEnabled,
    setQuickCss,
    quickCss,
    css,
    reload,
    state: snapshot,
    // only the test uses this; it is the proof that nothing fetches in the background
    fetchCount: () => fetchCalls,
  };
}
