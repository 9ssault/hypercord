// language: JavaScript, file: themes/index.js
//
// Themes, as the two things this client needs to do with them: check one, and turn
// it into what the pinned runtime's semantic-colour updater takes.
//
// A theme is data, not code: `plugins/index.js` refuses one that declares any
// lifecycle method before it ever gets here, and this file refuses anything that is
// not one of the ten documented colour tokens with a six-digit hex value. That is
// deliberately narrow, because these values are handed to Discord's own theming
// layer: a token this client does not know is a silent no-op, and a value that is
// not a colour (a `url(...)`, a `var(...)`, a gradient) would be trusted by a
// surface we do not own. There are no remote assets and no expressions: a theme
// cannot fetch anything, and cannot compute anything.
//
// The ten tokens are the surfaces the client's own screens read (core/screens.js,
// core/script-screen.js) plus the Discord surfaces they sit on. `nativeTheme`
// answers the shape the runtime applies: for each token, a triple - normal, dark
// and high-contrast - which is why one hex value becomes three identical entries.
import { ensure } from '../utils/validation.js';

/** The colour tokens a theme may set, and what each one is for. */
export const THEME_TOKENS = Object.freeze({
  BACKGROUND_PRIMARY: 'The app background: the surface behind everything.',
  BACKGROUND_SECONDARY: 'Raised surfaces: cards, sheets and the settings rows on them.',
  BACKGROUND_TERTIARY: 'Recessed surfaces: inputs, dividers and code blocks.',
  BACKGROUND_ACCENT: 'The fill behind a selected or hovered row.',
  TEXT_NORMAL: 'Body text on the primary background.',
  TEXT_MUTED: 'Secondary text: labels, hints and metadata.',
  TEXT_LINK: 'Links and other interactive text.',
  HEADER_PRIMARY: 'Titles and headings.',
  BRAND_500: 'The accent: primary buttons, switches and the active tab.',
  STATUS_DANGER: 'Errors and destructive actions.',
});

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The palette the client's own screens start from: full AMOLED black.
 *
 * It is the same palette as the desktop client's built-in theme (AMOLED_CSS in
 * src/themes.js) and as themes/examples/amoled.txt, kept here so the Android side
 * has one source of truth for it instead of four hard-coded defaults drifting
 * apart. True black for the surfaces behind content, a hair above black where two
 * surfaces meet and would otherwise have no edge between them; the text tokens
 * stay light, because the background is the theme.
 */
export const DEFAULT_THEME_COLORS = Object.freeze({
  BACKGROUND_PRIMARY: '#000000',
  BACKGROUND_SECONDARY: '#060607',
  BACKGROUND_TERTIARY: '#000000',
  BACKGROUND_ACCENT: '#0a0a0c',
  TEXT_NORMAL: '#f2f3f5',
  TEXT_MUTED: '#a3a6aa',
  TEXT_LINK: '#7aa2ff',
  HEADER_PRIMARY: '#ffffff',
  BRAND_500: '#5865f2',
  STATUS_DANGER: '#f2555a',
});

/**
 * The default theme, in the shape `nativeTheme` answers - what a caller hands to
 * the runtime's semantic-colour updater when no addon theme is selected, instead
 * of leaving Discord's own dark (not black) surfaces in place.
 */
export function defaultTheme() {
  return nativeTheme({ manifest: { colors: DEFAULT_THEME_COLORS } });
}

/**
 * One theme's colours, checked. Throws a sentence naming the token that is wrong,
 * because a theme that half-applies is worse than one that is refused: a person has
 * to be able to see which line of their theme file to change.
 */
export function validateTheme(colors) {
  ensure(colors && typeof colors === 'object' && !Array.isArray(colors), 'A theme needs a colors object of colour tokens.');
  const names = Object.keys(colors);
  ensure(names.length > 0, 'A theme needs at least one colour: ' + Object.keys(THEME_TOKENS).join(', ') + '.');
  for (const name of names) {
    ensure(Object.prototype.hasOwnProperty.call(THEME_TOKENS, name), '"' + name + '" is not a theme colour. The ten this client supports are ' + Object.keys(THEME_TOKENS).join(', ') + '.');
    const value = colors[name];
    ensure(typeof value === 'string' && HEX.test(value), 'The theme colour "' + name + '" must be a six-digit hex value like #5865f2, not ' + JSON.stringify(value) + '.');
  }
  return colors;
}

/**
 * A stored addon record, as the runtime's semantic colour input.
 *
 * `null` for "no theme selected" - the runtime's own defaults then stay in place,
 * which is what a person expects when they turn a theme off. A record with no valid
 * colours throws rather than applying half of itself; the manager turns that into
 * the card's error and keeps the previous theme.
 */
export function nativeTheme(record) {
  if (record === null || record === undefined) return null;
  const colors = record.manifest && record.manifest.colors !== undefined ? record.manifest.colors : record.colors;
  const checked = validateTheme(colors);
  const semanticColors = {};
  for (const name of Object.keys(checked)) semanticColors[name] = [checked[name], checked[name], checked[name]];
  return { semanticColors };
}
