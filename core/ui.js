// Presentation helpers for the addon and runner screens.
//
// Both functions run during render, so neither may throw and neither may keep
// state: a screen that cannot compute a colour or a draft has to draw something and
// say what is wrong with it, never abort the render. They are deliberately free of
// imports - `utils/validation.js` is for host code that wants to refuse an
// operation, and a screen that throws while validating an input field is a blank
// page, which is not a validation.
//
// The palette is data: a theme supplies six-digit hex colours and a device may be in
// light or dark mode, so text is not drawn in whatever the theme says when the
// theme's own colour would be unreadable on the surface it sits on. `readableColor`
// is the single place that decides that.

/** Parse `#rgb` / `#rrggbb` into [r, g, b], or null when it is not a plain hex. */
function rgb(color) {
  const text = String(color ?? '').trim();
  const short = /^#([0-9a-f]{3})$/i.exec(text);
  const long = /^#([0-9a-f]{6})$/i.exec(text);
  if (!short && !long) return null;
  const hex = (short ? short[1].split('').map(part => part + part).join('') : long[1]);
  return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]) {
  const channel = value => {
    const part = value / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21. */
function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const BLACK = [0, 0, 0], WHITE = [255, 255, 255];
const hex = ([r, g, b]) => '#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('');

/**
 * A colour that can be read on `background`.
 *
 * With one argument: black or white, whichever contrasts more with the background -
 * for labels drawn on an accent fill whose colour the theme chose.
 * With two: the colour as given, unless it is too close to the background to read
 * (below 3:1), in which case the same black-or-white answer. Themes keep their
 * colours on surfaces they work on and stay legible on surfaces they do not.
 *
 * Anything unparseable is returned unchanged rather than guessed at, so a colour
 * this does not understand is exactly as visible as the platform makes it.
 */
export function readableColor(background, color) {
  const surface = rgb(background);
  if (!surface) return color === undefined ? '#ffffff' : String(color ?? '');
  const pick = () => (contrast(surface, WHITE) >= contrast(surface, BLACK) ? hex(WHITE) : hex(BLACK));
  if (color === undefined || color === null || color === '') return pick();
  const wanted = rgb(color);
  if (!wanted) return String(color);
  return contrast(surface, wanted) >= 3 ? hex(wanted) : pick();
}

/**
 * What a settings form's Save button would submit, and what is wrong with it.
 *
 * `{ values, errors }`: `values` is the coerced draft per declared field (booleans
 * as booleans, numbers as numbers, everything else as a string), `errors` is keyed
 * by field name with a sentence for the person reading it - the screen draws both
 * and refuses to save while `errors` is not empty. Fields absent from `values` fall
 * back to the field's declared default, so a form opened before anything was saved
 * still shows what the plugin declared.
 *
 * The strings cap at 512 characters. The input allows one character more than that
 * on purpose, so a paste that is too long produces this explicit error instead of
 * being silently cut to fit.
 */
export function settingsDraft(schema = {}, values = {}) {
  const drafted = {}, errors = {};
  const fields = schema && typeof schema === 'object' ? schema : {};
  const given = values && typeof values === 'object' ? values : {};
  for (const [name, field] of Object.entries(fields)) {
    const declared = field && typeof field === 'object' ? field : {};
    const raw = Object.prototype.hasOwnProperty.call(given, name) ? given[name] : declared.default;
    if (declared.type === 'boolean') { drafted[name] = raw === true; continue; }
    if (declared.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) errors[name] = 'Enter a number.';
      else if (Number.isFinite(declared.min) && Number.isFinite(declared.max) && (value < declared.min || value > declared.max)) errors[name] = `Enter a number from ${declared.min} to ${declared.max}.`;
      else if (Number.isFinite(declared.min) && value < declared.min) errors[name] = `Enter ${declared.min} or more.`;
      else if (Number.isFinite(declared.max) && value > declared.max) errors[name] = `Enter ${declared.max} or less.`;
      drafted[name] = Number.isFinite(value) ? value : (Number.isFinite(Number(declared.default)) ? Number(declared.default) : 0);
      continue;
    }
    const text = raw === undefined || raw === null ? '' : String(raw);
    if (text.length > 512) errors[name] = 'Use no more than 512 characters.';
    drafted[name] = text;
  }
  return { values: drafted, errors };
}
