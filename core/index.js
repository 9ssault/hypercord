import { AddonManager } from '../plugins/index.js';
import { nativeTheme } from '../themes/index.js';
import { Journal } from '../utils/store.js';
import { nativeBridge } from './bridge.js';
import { createScreens } from './screens.js';
import { ScriptManager } from './scripts.js';
import { createScriptScreen } from './script-screen.js';
import { message } from '../utils/validation.js';
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
        await manager.start();
        addonManager = manager;
        Object.assign(screens, createScreens(api, manager, bridge));
      } catch (error) { failure = message(error); console.error('[Assault addons]', failure); }
      try {
        const runner = nativeBridge(files, rn.Linking, 'script');
        const scripts = new ScriptManager(bridge.io, runner, () => !api.settings.safeMode?.enabled);
        await scripts.start();
        screens.script = createScriptScreen(api, scripts, bridge, addonManager);
        void scripts.resume();
      } catch (error) {
        const problem = message(error);
        screens.script = () => api.metro.common.React.createElement(rn.Text, { accessibilityRole: 'alert', style: { padding: 24, color: '#ffb0b8', backgroundColor: '#1e1f22' } }, problem);
      }
    } catch (error) { failure = message(error); console.error('[Assault addons]', failure); }
  },
  page(kind) {
    if (screens?.[kind]) return { default: screens[kind] };
    const common = api?.metro?.common ?? { React: globalThis.React, ReactNative: globalThis.ReactNative };
    return { default: () => common.React.createElement(common.ReactNative.Text, { accessibilityRole: 'alert', style: { padding: 24, backgroundColor: '#1e1f22', color: '#ffb0b8', fontSize: 16 } }, failure ?? 'Addon storage is still loading. Reopen this page in a moment.') };
  }
};
