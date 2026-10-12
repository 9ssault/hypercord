// language: JavaScript, file: android/loader/src/main/assets/addons.js
//
// HYPERCORD-ADDONS-PLACEHOLDER - this is NOT the addons bundle. It is the asset the
// loader injects when the bundle has not been generated, and it exists so that case is
// visible instead of silent.
//
// `npm run build:addons` (scripts/build_addons.mjs) rewrites this file with the real
// bundle: core/, utils/, plugins/ and themes/ packed into one classic script, with
// core/index.js as the entry, which is what installs globalThis.__ASSAULT_ADDONS__.
// Until that has run, an APK built from this tree loads no addons - which is the
// failure this placeholder refuses to hide: the Addons, Themes and Code runner pages
// in Discord render the reason below instead of looking like an empty library.
//
// The shape matches the real runtime's contract exactly (initialize, page(kind),
// sources) so the patched client's calls do not fail; only the behaviour is a message.
(function () {
  "use strict";

  var REASON =
    "The bundled addons were not built into this APK. Run `npm run build:addons` before " +
    "building it - the asset android/loader/src/main/assets/addons.js is generated from " +
    "core/, utils/, plugins/ and themes/.";

  globalThis.__hypercordAddonsBundle = false;

  function alert() {
    var React = globalThis.React;
    var ReactNative = globalThis.ReactNative;
    if (!React || !ReactNative || !ReactNative.Text) return { default: function () { return null; } };
    return {
      default: function () {
        return React.createElement(
          ReactNative.Text,
          {
            accessibilityRole: "alert",
            style: { padding: 24, backgroundColor: "#000000", color: "#ffb0b8", fontSize: 16 },
          },
          REASON,
        );
      },
    };
  }

  globalThis.__ASSAULT_ADDONS__ = {
    async initialize() {
      // Recorded rather than thrown: the pages below read this and say why.
      console.error("[hypercord] addons are not bundled: " + REASON);
      return { ok: false, reason: REASON };
    },
    // The real runtime exposes the source catalogue here; a placeholder that invented
    // any of it would be a lie, so each call answers with the reason instead.
    sources: {
      all: [],
      byId() {
        return null;
      },
      forKind() {
        return [];
      },
      byPlatform() {
        return { android: [], ios: [], desktop: [] };
      },
      fetchPlan() {
        return null;
      },
      unfetchableReason() {
        return REASON;
      },
    },
    page() {
      return alert();
    },
  };
})();
