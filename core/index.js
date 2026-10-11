import { AddonManager } from '../plugins/index.js';
import { nativeTheme } from '../themes/index.js';
import { Journal } from '../utils/store.js';
import { nativeBridge } from './bridge.js';
import { createScreens } from './screens.js';
import { ScriptManager } from './scripts.js';
import { createScriptScreen } from './script-screen.js';
import { message } from '../utils/validation.js';
import { ADDON_SOURCES, fetchPlan, groupByPlatform, sourceById, sourcesForKind, unfetchableReason } from './sources.js';
let screens, failure, api;
globalThis.__ASSAULT_ADDONS__ = {
  async initialize(vendetta, applyTheme, files) {
    api = vendetta;
    try {
      const rn = api.metro.common.ReactNative;
      if (!files?.readFile || !files?.writeFile || !files?.fileExists) throw new Error('This Discord version does not expose compatible addon storage.');
      const bridge = nativeBridge(files, rn.Linking);
      screens = {};
      let addonManager;
      try {
        const manager = new AddonManager(new Journal(bridge.io), {
          notify: text => api.ui.toasts.showToast(text), report: text => rn.Alert.alert('Addons', text),
          canActivate: () => !api.settings.safeMode?.enabled,
          applyTheme: record => { if (record && api.settings.safeMode?.enabled) throw new Error('Themes are paused in safe mode.'); return applyTheme(nativeTheme(record)); }
        });
        // The pages are built before anything is read out of storage: a damaged
        // journal is a recoverable state, and it must not take away the only way
        // back, which is importing an addon file or restoring a backup from these
        // very screens.
        Object.assign(screens, createScreens(api, manager, bridge));
        addonManager = manager;
        try { await manager.start(); }
        catch (error) {
          // Still recoverable, and said out loud rather than swallowed: the screens
          // work, and every action they have to refuse carries this reason.
          failure = message(error);
          console.error('[Hypercord addons]', failure);
          try { api.ui.toasts.showToast('Addons: ' + failure); } catch { /* the toast is not the failure */ }
        }
      } catch (error) { failure = message(error); console.error('[Hypercord addons]', failure); }
      try {
        const runner = nativeBridge(files, rn.Linking, 'script');
        const scripts = new ScriptManager(bridge.io, runner, () => !api.settings.safeMode?.enabled);
        await scripts.start();
        screens.script = createScriptScreen(api, scripts, bridge, addonManager);
        void scripts.resume();
      } catch (error) {
        const problem = message(error);
        screens.script = () => api.metro.common.React.createElement(rn.Text, { accessibilityRole: 'alert', style: { padding: 24, color: '#ffb0b8', backgroundColor: '#000000' } }, problem);
      }
    } catch (error) { failure = message(error); console.error('[Hypercord addons]', failure); }
  },
  // The source catalogue the addon pages browse, exposed beside the pages rather
  // than inside them: it is data, it has no storage behind it, and a screen that
  // cannot reach a source still has to be able to list one.
  sources: {
    all: ADDON_SOURCES,
    byId: sourceById,
    forKind: sourcesForKind,
    byPlatform: groupByPlatform,
    fetchPlan,
    unfetchableReason
  },
  page(kind) {
    // A store that could not be opened is not a library with nothing in it, and it
    // must not look like one: while `failure` stands the addon pages say why (the
    // manager's "storage is damaged…", the bridge's "Permission denied") instead of
    // drawing an empty list. The runner is deliberately not gated by it - damaged
    // addon storage never hides the code runner.
    const addon = kind === 'plugin' || kind === 'theme';
    if (screens?.[kind] && !(failure && addon)) return { default: screens[kind] };
    const common = api?.metro?.common ?? { React: globalThis.React, ReactNative: globalThis.ReactNative };
    return { default: () => common.React.createElement(common.ReactNative.Text, { accessibilityRole: 'alert', style: { padding: 24, backgroundColor: '#000000', color: '#ffb0b8', fontSize: 16 } }, failure ?? 'Addon storage is still loading. Reopen this page in a moment.') };
  }
};
