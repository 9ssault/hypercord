// language: JavaScript, file: src/tokens.js
//
// The token store. Every token the client holds passes through this file and
// nowhere else, on four rules:
//
//   * a token is never written in clear. What goes to disk is metadata plus the
//     cipher's own output, base64'd - so the file has no readable secret in it
//     even if the cipher's output happened to be ASCII;
//   * a token is never read back except by `get()`, which is the one call the
//     code that is about to *use* a token makes. `list()` is what a UI renders,
//     and it carries a fingerprint and the last four characters, never the token;
//   * a token is never logged, and never echoed in an error, including an error
//     thrown by the cipher itself (see redact);
//   * no cipher means no persistence. Without one the store keeps the token in
//     memory for this run when asked (memoryOnly), and otherwise refuses - it
//     will not write something it cannot protect.
//
// The cipher is injected, so this module has no electron import and can be tested
// as plain node. Its contract is two functions over *strings*:
//
//   cipher.encrypt(plainText) -> opaque text      (any encoding; treated as opaque)
//   cipher.decrypt(opaqueText) -> plainText
//
// Electron's safeStorage is wrapped around that in one line each where it is
// built, so the store itself never has to know which platform it is on.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MIN_LENGTH = 20;
const MAX_LENGTH = 200;
// Discord's tokens are base64url, sometimes with an `mfa.` prefix, and nothing
// else: a token with a space, a newline or any other punctuation in it is not a
// token, it is something that would end up in a header.
const TOKEN_CHARS = /^[A-Za-z0-9._-]+$/;
const ACCOUNT_CHARS = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A short digest that identifies a token without being one. */
export function fingerprint(token) {
  return crypto.createHash("sha256").update(String(token === undefined || token === null ? "" : token)).digest("hex").slice(0, 12);
}

/**
 * The last few characters, for a human deciding *which* token they are looking
 * at. Deliberately tiny: enough to tell two apart, never enough to be one.
 */
export function mask(token) {
  const text = String(token === undefined || token === null ? "" : token);
  if (!text) return "\u2026";
  return "\u2026" + text.slice(-4);
}

/**
 * Replace anything token-shaped in a message before it can reach a log, a UI or
 * an exception. A cipher that throws `new Error("cannot encrypt " + text)` is a
 * real possibility, and that message would otherwise carry the secret.
 */
export function redact(message, ...secrets) {
  let text = String(message === undefined || message === null ? "" : message);
  for (const secret of secrets) {
    const value = String(secret === undefined || secret === null ? "" : secret);
    if (value.length < 6) continue;
    text = text.split(value).join("[redacted]");
    if (value.length > 16) text = text.split(value.slice(0, 12)).join("[redacted]");
  }
  return text;
}

/** Every reason a string is not a token, with the rule it broke. */
export function checkToken(token) {
  if (typeof token !== "string") return { ok: false, error: "a token must be text" };
  if (!token) return { ok: false, error: "a token cannot be empty" };
  if (CONTROL_CHARS.test(token)) return { ok: false, error: "a token cannot contain control characters" };
  if (/\s/.test(token)) return { ok: false, error: "a token cannot contain whitespace" };
  if (!TOKEN_CHARS.test(token)) return { ok: false, error: "a token must be base64url: letters, digits, . - _ only" };
  if (token.length < MIN_LENGTH) return { ok: false, error: "a token is shorter than " + MIN_LENGTH + " characters" };
  if (token.length > MAX_LENGTH) return { ok: false, error: "a token is longer than " + MAX_LENGTH + " characters" };
  return { ok: true };
}

function checkAccount(account) {
  if (typeof account !== "string" || !account.trim()) return { ok: false, error: "an account name is required" };
  if (!ACCOUNT_CHARS.test(account)) return { ok: false, error: "an account name must be letters, digits, . - _ (max 64)" };
  return { ok: true };
}

export function createTokens({ userData = "", cipher = null, log = console.log, now = () => Date.now() } = {}) {
  const home = String(userData || ".");
  const file = path.join(home, "tokens.json");
  const memory = new Map(); // account -> entry, only when there is nowhere safe to write

  function blank() {
    return { version: 1, tokens: {} };
  }

  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) || {};
      const tokens = saved && saved.tokens && typeof saved.tokens === "object" ? saved.tokens : {};
      return { version: 1, tokens };
    } catch {
      // first run, or a store we cannot parse: an unreadable store is empty, never
      // a crash, and never a reason to hand out somebody else's token
      return blank();
    }
  }

  /** write via a temp file and a rename, so a crash cannot leave half a store */
  function write(state) {
    const tmp = file + ".tmp";
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
      log("[hypercord] tokens: could not save the store (" + redact((err && err.message) || err) + ")");
      return false;
    }
  }

  function entry(account) {
    return memory.get(account) || read().tokens[account] || null;
  }

  function list() {
    const onDisk = read().tokens;
    const accounts = [...new Set([...Object.keys(onDisk), ...memory.keys()])].sort();
    return accounts.map((account) => {
      const inMemory = memory.get(account);
      const row = inMemory || onDisk[account];
      return {
        account,
        label: String(row.label || ""),
        present: true,
        source: inMemory ? "memory" : "disk",
        updatedAt: Number(row.updatedAt || 0),
        fingerprint: String(row.fingerprint || ""),
        last4: String(row.last4 || ""),
      };
    });
  }

  function put(account, token, { label = "", memoryOnly = false } = {}) {
    const name = checkAccount(String(account === undefined || account === null ? "" : account));
    if (!name.ok) return { ok: false, error: name.error };
    const id = String(account);
    const text = checkToken(token);
    if (!text.ok) return { ok: false, error: text.error };

    const previous = entry(id);
    const next = {
      label: String(label || "").trim() || String((previous && previous.label) || ""),
      updatedAt: now(),
      fingerprint: fingerprint(token),
      last4: String(token).slice(-4),
    };

    if (memoryOnly || !cipher) {
      if (!memoryOnly) {
        return { ok: false, error: "no cipher: the client will not store a token it cannot protect (pass memoryOnly to keep it for this run only)" };
      }
      memory.set(id, { ...next, token: String(token) });
      log("[hypercord] token held in memory for this run: " + id);
      return { ok: true, account: id, fingerprint: next.fingerprint, memoryOnly: true };
    }

    let blob = "";
    try {
      const encoded = cipher.encrypt(String(token));
      if (typeof encoded !== "string") {
        return { ok: false, error: "the cipher did not return text, so the token was not stored" };
      }
      blob = Buffer.from(encoded, "utf8").toString("base64");
    } catch (err) {
      return { ok: false, error: "the cipher refused the token (" + redact((err && err.message) || err, token).slice(0, 120) + ")" };
    }

    const state = read();
    state.tokens[id] = { ...next, blob };
    if (!write(state)) return { ok: false, error: "the store could not be written" };
    memory.delete(id);
    log("[hypercord] token stored for " + id + " (" + mask(String(token)) + ")");
    return { ok: true, account: id, fingerprint: next.fingerprint };
  }

  function get(account) {
    const id = String(account === undefined || account === null ? "" : account);
    const inMemory = memory.get(id);
    if (inMemory) return String(inMemory.token || "");
    const row = read().tokens[id];
    if (!row || !row.blob || !cipher) return "";
    try {
      return String(cipher.decrypt(Buffer.from(String(row.blob), "base64").toString("utf8")));
    } catch (err) {
      // a token that cannot be decrypted is a token we do not have: say so, and
      // never let the cipher's message (which may quote the ciphertext) escape
      log("[hypercord] tokens: could not decrypt the stored token for " + id + " (" + redact((err && err.message) || err) + ")");
      return "";
    }
  }

  function has(account) {
    return Boolean(entry(String(account === undefined || account === null ? "" : account)));
  }

  function remove(account) {
    const id = String(account === undefined || account === null ? "" : account);
    const state = read();
    const existed = Boolean(state.tokens[id]) || memory.has(id);
    if (!existed) return { ok: false, error: "no token stored for " + (ACCOUNT_CHARS.test(id) ? id : "that account") };
    memory.delete(id);
    delete state.tokens[id];
    if (!write(state)) return { ok: false, error: "the store could not be written" };
    log("[hypercord] token removed for " + id);
    return { ok: true, account: id };
  }

  function forgetAll() {
    const state = read();
    const removed = Object.keys(state.tokens).length + memory.size;
    memory.clear();
    let wrote = true;
    if (removed) wrote = write(blank());
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the file being gone is the point; a leftover temp file is not a token */
    }
    log("[hypercord] tokens: forgot " + removed + " token(s)");
    return { ok: wrote, removed };
  }

  return {
    list,
    put,
    get,
    has,
    remove,
    forgetAll,
    fingerprint,
    mask,
    size: () => list().length,
    file: () => file,
  };
}
