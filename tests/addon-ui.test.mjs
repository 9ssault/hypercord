import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { createScreens } from '../core/screens.js';
import { nativeBridge } from '../core/bridge.js';
import { AddonManager } from '../plugins/index.js';
import { Journal } from '../utils/store.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const source = `export default { id:'sample', kind:'plugin', name:'Sample', version:'1.0.0', settings:{ label:{type:'string',label:'Label',default:'initial'} }, onStart(api){api.setState('started',true);} };`;
const RN = Object.fromEntries(['Text', 'View', 'Pressable', 'TextInput', 'Switch', 'ScrollView', 'ActivityIndicator', 'KeyboardAvoidingView'].map(name => [name, name]));
RN.Alert = { alert() {} };
test('React Native manager opens individual settings, persists edits, toggles, and displays picker errors', async () => {
  const files = new Map(), manager = new AddonManager(new Journal({ read: async n => files.get(n) ?? null, write: async (n, t) => files.set(n, t) }), { applyTheme() {}, notify() {} });
  await manager.start(); await manager.install(source, 'sample.txt');
  const screens = createScreens({ metro: { common: { React, ReactNative: RN } } }, manager, { request: async () => { throw Error('Permission denied'); } });
  let view; await act(async () => { view = create(React.createElement(screens.plugin)); });
  const button = label => view.root.findAllByType('Pressable').find(n => n.props.accessibilityLabel === label);
  await act(async () => button('Plugin settings').props.onPress());
  assert.equal(view.root.findByType('TextInput').props.value, 'initial');
  await act(async () => view.root.findByType('TextInput').props.onChangeText('saved edit'));
  await act(async () => button('Save settings').props.onPress());
  assert.equal(manager.data.entries[0].settings.label, 'saved edit');
  assert.equal(view.root.findByType('TextInput').props.value, 'saved edit');
  await act(async () => button('Back to plugins').props.onPress());
  await act(async () => view.root.findByType('Switch').props.onValueChange(true));
  assert.equal(manager.data.entries[0].enabled, true);
  await act(async () => button('Import JavaScript file').props.onPress());
  assert.equal(view.root.findByProps({ accessibilityRole: 'alert' }).props.children, 'Permission denied');
  await act(async () => view.unmount()); assert.equal(manager.listeners.size, 0);
});
test('native bridge cleans temporary request credentials on success and bridge failure', async () => {
  const data = new Map();
  const files = { getConstants: () => ({ DocumentsDirPath: '/docs', CacheDirPath: '/cache' }), fileExists: async p => data.has(p), readFile: async p => data.get(p), writeFile: async (dir, n, text) => data.set(`/${dir}/${n}`, text), removeFile: async (dir, n) => data.delete(`/${dir}/${n}`) };
  const bridge = nativeBridge(files, { openURL: async uri => { const id = uri.split('/').at(-1); data.set(`/cache/assault-addon-result-${id}.json`, JSON.stringify({ saved: true })); } });
  assert.equal((await bridge.request('uploadBackup', { token: 'synthetic' })).saved, true);
  assert.equal(data.size, 0);
  const failed = nativeBridge(files, { openURL: async () => { throw Error('No bridge'); } });
  await assert.rejects(failed.request('uploadBackup', { token: 'synthetic' }), /No bridge/); assert.equal(data.size, 0);
});
test('addon bootstrap renders a readable fallback before initialization and on storage failure', async () => {
  globalThis.React = React; globalThis.ReactNative = RN;
  await import('../core/index.js');
  const runtime = globalThis.__ASSAULT_ADDONS__;
  assert.match(runtime.page('plugin').default().props.children, /still loading/);
  const report = console.error; console.error = () => {};
  try {
    await runtime.initialize({ metro: { common: { React, ReactNative: RN } } }, () => {}, { readFile() {}, writeFile() {}, fileExists: async () => { throw Error('Permission denied'); }, getConstants: () => ({ DocumentsDirPath: '/private' }) });
    assert.match(runtime.page('plugin').default().props.children, /Permission denied/);
  } finally { console.error = report; delete globalThis.React; delete globalThis.ReactNative; delete globalThis.__ASSAULT_ADDONS__; }
});
test('bridge rejects oversized UTF8 payloads before starting a native operation', async () => {
  let writes = 0, opens = 0;
  const bridge = nativeBridge({ getConstants: () => ({}), writeFile: async () => writes++, removeFile: async () => {} }, { openURL: async () => opens++ });
  await assert.rejects(bridge.request('uploadBackup', { data: '€'.repeat(3000000) }), /too large/);
  assert.equal(writes, 0); assert.equal(opens, 0);
});
test('a request stays exclusive until asynchronous cleanup finishes', async () => {
  let releaseCleanup, cleanupStarted;
  const cleanupGate = new Promise(resolve => { releaseCleanup = resolve; });
  const enteredCleanup = new Promise(resolve => { cleanupStarted = resolve; });
  const data = new Map();
  let blockCleanup = true, opens = 0;
  const files = {
    getConstants: () => ({ CacheDirPath: '/cache' }),
    fileExists: async p => data.has(p), readFile: async p => data.get(p),
    writeFile: async (dir, name, text) => data.set(`/${dir}/${name}`, text),
    removeFile: async (dir, name) => {
      if (blockCleanup) { cleanupStarted(); await cleanupGate; }
      data.delete(`/${dir}/${name}`);
    }
  };
  const bridge = nativeBridge(files, { openURL: async uri => {
    opens++; data.set(`/cache/assault-addon-result-${uri.split('/').at(-1)}.json`, '{"saved":true}');
  } });
  const first = bridge.request('export');
  await enteredCleanup;
  await assert.rejects(bridge.request('import'), /Finish the current file operation/);
  assert.equal(opens, 1);
  blockCleanup = false; releaseCleanup(); await first;
  assert.equal((await bridge.request('export')).saved, true);
  assert.equal(opens, 2); assert.equal(data.size, 0);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function screenFixture({ plugin = source, request = async () => ({}), navigation } = {}) {
  const files = new Map(), alerts = [], handlers = new Set();
  const io = { read: async n => files.get(n) ?? null, write: async (n, value) => files.set(n, value) };
  const host = { applyTheme() {}, notify() {} };
  const manager = new AddonManager(new Journal(io), host);
  await manager.start();
  if (plugin) await manager.install(plugin, 'sample.txt');
  const native = { ...RN, Platform: { OS: 'android' }, Alert: { alert: (...args) => alerts.push(args) }, BackHandler: {
    addEventListener: (_event, fn) => { handlers.add(fn); return { remove: () => handlers.delete(fn) }; },
  } };
  const screens = createScreens({ metro: { common: { React, ReactNative: native } } }, manager, { request });
  let view;
  await act(async () => { view = create(React.createElement(screens.plugin, { navigation })); });
  return {
    manager, io, host, alerts, handlers, view,
    button: label => view.root.findAllByType('Pressable').find(n => n.props.accessibilityLabel === label),
    input: label => view.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === label),
    text: () => view.root.findAllByType('Text').map(n => n.props.children).filter(v => typeof v === 'string').join('\n'),
    close: async () => { await act(async () => view.unmount()); },
  };
}

test('immediate duplicate taps start one import; failure clears progress and retry works', async () => {
  const wait = deferred(); let calls = 0;
  const f = await screenFixture({ plugin: null, request: () => { calls++; return wait.promise; } });
  const press = f.button('Import JavaScript file').props.onPress;
  let first;
  await act(async () => { first = press(); press(); });
  assert.equal(calls, 1);
  assert.match(f.text(), /Importing addon/);
  assert.equal(f.button('Import JavaScript file').props.disabled, true);
  await act(async () => { wait.reject(Error('File missing')); await first; });
  assert.match(f.text(), /File missing/);
  assert.doesNotMatch(f.text(), /Importing addon/);
  assert.equal(f.button('Import JavaScript file').props.disabled, false);
  await act(async () => f.button('Import JavaScript file').props.onPress());
  assert.equal(calls, 2);
  await f.close();
});

test('numeric and string field errors retain drafts and corrected settings survive restart', async () => {
  const plugin = source.replace("label:{type:'string',label:'Label',default:'initial'}", "label:{type:'string',label:'Label',default:'initial'}, count:{type:'number',label:'Count',default:2,min:1,max:5}");
  const f = await screenFixture({ plugin });
  await act(async () => f.button('Plugin settings').props.onPress());
  await act(async () => { f.input('Count').props.onChangeText(''); f.input('Label').props.onChangeText('x'.repeat(513)); });
  await act(async () => f.button('Save settings').props.onPress());
  assert.match(f.text(), /Enter a number from 1 to 5/);
  assert.match(f.text(), /no more than 512/);
  assert.equal(f.input('Count').props.value, '');
  assert.equal(f.manager.snapshot().entries[0].settings.label, 'initial');
  await act(async () => { f.input('Count').props.onChangeText('4'); f.input('Label').props.onChangeText('corrected'); });
  await act(async () => f.button('Save settings').props.onPress());
  assert.match(f.text(), /Settings saved/);
  assert.doesNotMatch(f.text(), /Unsaved changes/);
  const restored = new AddonManager(new Journal(f.io), f.host);
  await restored.start();
  assert.equal(restored.snapshot().entries[0].settings.count, 4);
  assert.equal(restored.snapshot().entries[0].settings.label, 'corrected');
  await f.close();
});

test('slow and failed saves lock editing synchronously, retain drafts, and permit retry', async () => {
  const f = await screenFixture();
  await act(async () => f.button('Plugin settings').props.onPress());
  await act(async () => f.input('Label').props.onChangeText('draft'));
  const wait = deferred(), configure = f.manager.configure.bind(f.manager); let calls = 0;
  f.manager.configure = () => { calls++; return wait.promise; };
  const press = f.button('Save settings').props.onPress, edit = f.input('Label').props.onChangeText;
  let saving;
  await act(async () => { saving = press(); press(); edit('racing edit'); });
  assert.equal(calls, 1);
  assert.equal(f.input('Label').props.value, 'draft');
  assert.equal(f.input('Label').props.editable, false);
  assert.match(f.text(), /Saving plugin settings/);
  await act(async () => { wait.reject(Error('Disk full')); await saving; });
  assert.equal(f.input('Label').props.editable, true);
  assert.equal(f.input('Label').props.value, 'draft');
  assert.match(f.text(), /Disk full/);
  f.manager.configure = configure;
  await act(async () => f.button('Save settings').props.onPress());
  assert.equal(f.manager.snapshot().entries[0].settings.label, 'draft');
  await f.close();
});

test('saved settings and failed hook are reported together without false success notice', async () => {
  const plugin = source.replace('onStart(api)', "onSettingsChanged(api){api.getSetting('missing');}, onStart(api)");
  const f = await screenFixture({ plugin });
  await act(async () => f.manager.enable('sample', true));
  await act(async () => f.button('Plugin settings').props.onPress());
  await act(async () => f.input('Label').props.onChangeText('persisted'));
  await act(async () => f.button('Save settings').props.onPress());
  assert.equal(f.manager.snapshot().entries[0].enabled, false);
  assert.equal(f.manager.snapshot().entries[0].settings.label, 'persisted');
  assert.match(f.text(), /Settings saved\. Plugin is disabled: Unknown setting/);
  assert.doesNotMatch(f.text(), /Unsaved changes/);
  assert.equal(f.view.root.findAllByType('Text').filter(n => n.props.children === 'Settings saved.').length, 0);
  await f.close();
});

test('unsaved settings require confirmation for button, hardware and navigation back', async () => {
  let listener; const dispatched = [];
  const navigation = { addListener: (_name, fn) => { listener = fn; return () => { listener = null; }; }, dispatch: action => dispatched.push(action) };
  const f = await screenFixture({ navigation });
  await act(async () => f.button('Plugin settings').props.onPress());
  await act(async () => f.input('Label').props.onChangeText('unsaved'));
  await act(async () => f.button('Back to plugins').props.onPress());
  assert.equal(f.alerts.length, 1);
  assert.equal(f.input('Label').props.value, 'unsaved');
  await act(async () => [...f.handlers][0]());
  assert.equal(f.alerts.length, 2);
  let prevented = false;
  await act(async () => listener({ preventDefault: () => { prevented = true; }, data: { action: 'BACK' } }));
  assert.equal(prevented, true);
  await act(async () => f.alerts.at(-1)[2][1].onPress());
  assert.deepEqual(dispatched, ['BACK']);
  await act(async () => f.button('Back to plugins').props.onPress());
  await act(async () => f.alerts.at(-1)[2][1].onPress());
  assert.ok(f.button('Plugin settings'));
  assert.equal(f.handlers.size, 0);
  await f.close();
});

test('unmount during import lets durable installation finish without retained listeners', async () => {
  const wait = deferred();
  const f = await screenFixture({ plugin: null, request: () => wait.promise });
  let importing;
  await act(async () => { importing = f.button('Import JavaScript file').props.onPress(); });
  await f.close();
  await act(async () => { wait.resolve({ data: source, filename: 'sample.txt' }); await importing; });
  assert.equal(f.manager.snapshot().entries.length, 1);
  assert.equal(f.manager.listeners.size, 0);
});

test('failed remote download preserves form data and all actions recover', async () => {
  const f = await screenFixture({ request: async () => { throw Error('Network disconnected'); } });
  await act(async () => f.button('Install from HTTPS URL').props.onPress());
  await act(async () => { f.input('Direct HTTPS URL').props.onChangeText('https://example.test/plugin.js'); f.input('Publisher SHA-256 checksum').props.onChangeText('a'.repeat(64)); });
  await act(async () => f.button('Download and validate').props.onPress());
  assert.match(f.text(), /Network disconnected/);
  assert.equal(f.input('Direct HTTPS URL').props.value, 'https://example.test/plugin.js');
  assert.equal(f.input('Publisher SHA-256 checksum').props.value, 'a'.repeat(64));
  assert.ok(f.view.root.findAllByType('Pressable').every(n => !n.props.disabled));
  assert.equal(f.view.root.findByType('KeyboardAvoidingView').props.behavior, 'height');
  await f.close();
});

test('a lost native callback times out, cleans its mailbox and permits retry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1700000000000 });
  const data = new Map(); let respond = false;
  const bridge = nativeBridge({
    getConstants: () => ({ CacheDirPath: '/cache' }),
    fileExists: async path => data.has(path), readFile: async path => data.get(path),
    writeFile: async (dir, name, value) => data.set(`/${dir}/${name}`, value),
    removeFile: async (dir, name) => data.delete(`/${dir}/${name}`),
  }, { openURL: async uri => {
    if (respond) data.set(`/cache/assault-addon-result-${uri.split('/').at(-1)}.json`, '{"saved":true}');
  } });
  const pending = bridge.request('import');
  const failure = assert.rejects(pending, /within 2 minutes/);
  await new Promise(setImmediate);
  t.mock.timers.tick(120000);
  await failure;
  assert.equal(data.size, 0);
  respond = true;
  assert.equal((await bridge.request('export')).saved, true);
  assert.equal(data.size, 0);
});
test('runner and addon channels keep independent mailboxes, locks and cleanup', async () => {
  const data = new Map();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const files = {
    getConstants: () => ({ CacheDirPath: '/cache' }), fileExists: async path => data.has(path), readFile: async path => data.get(path),
    writeFile: async (directory, name, value) => data.set(`/${directory}/${name}`, value), removeFile: async (directory, name) => data.delete(`/${directory}/${name}`),
  };
  const linking = { async openURL(url) {
    const runner = url.startsWith('assault-scripts:'), id = url.split('/').at(-1);
    if (runner) { entered(); await gate; }
    data.set(`/cache/assault-${runner ? 'script' : 'addon'}-result-${id}.json`, JSON.stringify(runner ? { state: 'running' } : { filename: 'plugin.txt' }));
  } };
  const runner = nativeBridge(files, linking, 'script'), addons = nativeBridge(files, linking);
  const executing = runner.request('runner'); await started;
  assert.equal((await addons.request('import')).filename, 'plugin.txt');
  assert(data.has('/cache/assault-script-request.json'));
  release(); assert.equal((await executing).state, 'running'); assert.equal(data.size, 0);
  await assert.rejects(runner.request('import'), /only accepts runner/);
});
test('plugin startup write failures render saved settings and offer an explicit activation retry', async () => {
  const f = await screenFixture();
  await act(async () => f.manager.enable('sample', true));
  const write = f.io.write; f.io.write = async () => { throw Error('Disk unavailable'); };
  await act(async () => f.manager.start());
  assert.match(f.text(), /Needs attention/); assert.match(f.text(), /Saved configuration is preserved/);
  assert(f.button('Plugin settings')); assert(f.button('Retry plugin activation'));
  f.io.write = write; await act(async () => f.button('Retry plugin activation').props.onPress());
  assert.equal(f.button('Retry plugin activation'), undefined); assert.doesNotMatch(f.text(), /Could not start/);
  await f.close();
});

test('bridge overwrites and verifies temporary data if deletion is absent or fails', async () => {
  for (const mode of ['absent', 'throws', 'no-op']) {
    const data = new Map();
    const files = {
      getConstants: () => ({ CacheDirPath: '/cache' }),
      fileExists: async path => data.has(path), readFile: async path => data.get(path),
      writeFile: async (dir, name, value) => data.set(`/${dir}/${name}`, value),
    };
    if (mode === 'throws') files.removeFile = async () => { throw Error('Unavailable'); };
    if (mode === 'no-op') files.removeFile = async () => {};
    const bridge = nativeBridge(files, { openURL: async uri => {
      data.set(`/cache/assault-addon-result-${uri.split('/').at(-1)}.json`, '{"saved":true}');
    } });
    assert.equal((await bridge.request('uploadBackup', { token: 'synthetic-secret' })).saved, true);
    assert.ok([...data.values()].every(value => value === '{}'));
    const failed = nativeBridge(files, { openURL: async () => { throw Error('No bridge'); } });
    await assert.rejects(failed.request('uploadBackup', { token: 'synthetic-secret' }), /No bridge/);
    assert.ok([...data.values()].every(value => value === '{}'));
  }
});

test('failed cleanup is reported and releases the bridge for deliberate retry', async () => {
  const data = new Map(); let failCleanup = true;
  const files = {
    getConstants: () => ({ CacheDirPath: '/cache' }),
    fileExists: async path => data.has(path), readFile: async path => data.get(path),
    writeFile: async (dir, name, value) => { if (failCleanup && value === '{}') throw Error('Storage full'); data.set(`/${dir}/${name}`, value); },
  };
  const bridge = nativeBridge(files, { openURL: async uri => { data.set(`/cache/assault-addon-result-${uri.split('/').at(-1)}.json`, '{"saved":true}'); } });
  await assert.rejects(bridge.request('uploadBackup', { token: 'synthetic-secret' }), /Temporary request cleanup failed/);
  failCleanup = false;
  assert.equal((await bridge.request('uploadBackup')).saved, true);
  assert.ok(![...data.values()].some(value => value.includes('synthetic-secret')));
});
