// language: JavaScript, file: utils/validation.js
//
// The checks the Android client shares: one place that decides what a value may
// be, and one place that turns a thrown thing into a sentence a person can read.
//
// Every module of this client imports from here - the addon manager, the script
// manager, the native bridge and the journal - so this file is also the single
// description of the sizes the *native* side enforces. Those numbers are not ours
// to choose: `android/loader/.../AddonDocuments.java` refuses an archive over
// ARCHIVE_LIMIT and a script over SOURCE_LIMIT, and
// `android/manager/src/main/assets/script_runner.py` refuses arguments, input and
// a console window of its own. Keeping them here means a too-large script is
// refused with a sentence naming the limit, instead of travelling to Android and
// coming back as "Invalid runner request."
//
// Nothing here reaches for a global that a JavaScript engine inside Discord may
// not have: no TextEncoder and no Buffer, because this runs on Hermes.

/** The limits, mirroring the native side, each named for where it is enforced. */
export const LIMITS = Object.freeze({
  // AddonDocuments.ARCHIVE_LIMIT: an addon backup or a journal revision.
  archive: 4 * 1024 * 1024,
  // AddonDocuments.SOURCE_LIMIT and script_runner.py: one addon or one script.
  source: 64 * 1024,
  // AddonManager: "Remove an addon before installing more (32 maximum)".
  addons: 32,
  // ScriptManager: "Export or remove a project before adding another".
  projects: 24,
  // A project's setup command.
  setup: 8 * 1024,
  // script_runner.py: at most 32 arguments of at most 2048 characters.
  arguments: 32,
  argument: 2048,
  // script_runner.py's poll window: the console it answers with.
  console: 16 * 1024,
  // One control message. script_runner.py accepts 4096 encoded bytes including
  // the newline, so this stays under it.
  input: 4000,
  // The settings UI allows one character past this so an over-length paste is an
  // error rather than a silent truncation.
  setting: 512,
});

/**
 * The one way this client refuses something: a condition, and the reason a person
 * reading the screen can act on. Never a boolean nobody looks at.
 */
export function ensure(condition, text) {
  if (!condition) throw new Error(String(text));
  return true;
}

/**
 * Anything thrown, as a sentence. A string is already one, an Error contributes its
 * message, and anything else is described rather than stringified into "[object
 * Object]". Deliberately never a stack: these strings are shown on screen and stored.
 */
export function message(error) {
  if (error === null || error === undefined) return 'Something went wrong, and no reason was given.';
  if (typeof error === 'string') return error.slice(0, 400) || 'Something went wrong.';
  if (typeof error.message === 'string' && error.message) return error.message.slice(0, 400);
  if (typeof error.error === 'string' && error.error) return error.error.slice(0, 400);
  try {
    const text = JSON.stringify(error);
    return text && text !== '{}' ? text.slice(0, 400) : 'Something went wrong, and no reason was given.';
  } catch {
    return 'Something went wrong, and no reason was given.';
  }
}

/** The UTF-8 length of a value, counted the way Android counts it. */
export function utf8Size(value) {
  const text = String(value === undefined || value === null ? '' : value);
  let size = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (code > 0xffff) index += 1; // a surrogate pair is one character
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return size;
}

/**
 * A deep copy that cannot smuggle something enormous into storage: the value has to
 * survive JSON within the limit, or it is refused. A value JSON cannot carry at all
 * (a function, a symbol, nothing) copies to undefined rather than to a lie.
 */
export function jsonCopy(value, limit = LIMITS.archive) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    // A cycle, which JSON.stringify refuses rather than a size problem.
    throw new Error('That value cannot be saved or copied.');
  }
  if (text === undefined) return undefined;
  ensure(utf8Size(text) <= limit, 'That value is too large to save. Move the data into a project file instead.');
  return JSON.parse(text);
}

/**
 * An identifier this client will later use as an object key: an addon's id, a
 * setting's name. Restricted, because these names travel into saved archives and
 * into other people's addons, and a name that could collide with an object's own
 * members is not a name this client accepts.
 */
export function key(value) {
  ensure(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
      && !['__proto__', 'prototype', 'constructor'].includes(value),
    'An addon or setting name may use letters, digits, dot, dash and underscore (64 characters maximum).',
  );
  return value;
}

/**
 * A settings schema, checked once, and a saved settings object coerced against it.
 *
 * Called with the schema alone while inspecting an addon, and with a saved object
 * while loading one, so a stored value is always brought back into the shape the
 * schema declares: a boolean is a boolean, a number is inside its own range, and a
 * text setting is text within its length. A text setting past the limit is refused
 * rather than truncated, because those 512 characters are the person's own input.
 */
export function settingsValues(schema = {}, current = {}) {
  ensure(schema && typeof schema === 'object' && !Array.isArray(schema), 'Invalid settings schema.');
  ensure(current === undefined || current === null || (typeof current === 'object' && !Array.isArray(current)), 'Saved settings are not a set of values.');
  const saved = current ?? {};
  const values = {};
  for (const [name, field] of Object.entries(schema)) {
    key(name);
    ensure(field && typeof field === 'object' && !Array.isArray(field), 'Invalid settings field.');
    ensure(['boolean', 'string', 'number'].includes(field.type), `The setting "${name}" is not a boolean, text or number.`);
    const stored = Object.prototype.hasOwnProperty.call(saved, name) ? saved[name] : undefined;
    if (field.type === 'boolean') {
      values[name] = stored === true;
      continue;
    }
    if (field.type === 'number') {
      ensure(Number.isFinite(field.min) && Number.isFinite(field.max) && field.min <= field.max, `The setting "${name}" needs a minimum and a maximum.`);
      const number = Number(stored);
      values[name] = Number.isFinite(number) ? Math.min(field.max, Math.max(field.min, number)) : field.min;
      continue;
    }
    const text = stored === undefined || stored === null ? '' : String(stored);
    ensure(text.length <= LIMITS.setting, `The setting "${name}" is longer than ${LIMITS.setting} characters.`);
    values[name] = text;
  }
  return values;
}
