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

// A theme is injected into the page as CSS, so the only things worth refusing
// are the things that would let it act like anything other than CSS.
const FORBIDDEN = [
  [/<\/style/i, "</style> is not allowed in a theme: it would end the style block"],
  [/<script/i, "<script> is not allowed in a theme"],
  [/@import/i, "@import is not allowed in a theme: it fetches at render time"],
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
  return { ok: true, css };
}

/**
 * The built-in theme this client ships with: full AMOLED black.
 *
 * True black on every surface Discord paints behind content, and a hair off black
 * for the few that have to stay distinguishable - two black surfaces with nothing
 * between them is how an AMOLED theme makes a client unusable. Text colours are
 * left alone: the point is the background, and overriding text here would fight
 * every accessibility setting the person already has.
 */
export const AMOLED_ID = "amoled-black";

export const AMOLED_CSS = `/* Hypercord's built-in theme: full AMOLED black. */
:root {
  --background-primary: #000000;
  --background-secondary: #000000;
  --background-secondary-alt: #060607;
  --background-tertiary: #000000;
  --background-accent: #0a0a0c;
  --background-floating: #060607;
  --background-mobile-primary: #000000;
  --background-mobile-secondary: #060607;
  --channeltextarea-background: #0a0a0c;
  --input-background: #0a0a0c;
  --modal-background: #000000;
  --modal-footer-background: #060607;
  --deprecated-card-bg: #060607;
  --deprecated-quickswitcher-input-background: #0a0a0c;
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
    return parts.filter(Boolean).join("\n");
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
