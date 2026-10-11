import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { ScriptManager } from '../core/scripts.js';
import { createScriptScreen } from '../core/script-screen.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
async function fixture(request = async () => ({ state: 'running' }), addons) {
  const files = new Map(), alerts = [], listeners = new Map();
  const bridge = { request };
  const manager = new ScriptManager({ read: async name => files.get(name) ?? null, write: async (name, text) => files.set(name, text) }, bridge);
  await manager.start();
  const N = Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator'].map(key => [key, key]));
  N.Alert = { alert: (...args) => alerts.push(args) };
  const navigation = { addListener(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); }, dispatch() {} };
  const Screen = createScriptScreen({ metro: { common: { React, ReactNative: N } } }, manager, bridge, addons);
  let view; await act(async () => { view = create(React.createElement(Screen, { navigation })); });
  const button = label => view.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label);
  const input = label => view.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label);
  const edit = async (label, value) => act(async () => input(label).props.onChangeText(value));
  const press = async label => act(async () => button(label).props.onPress());
  return { view, manager, alerts, listeners, button, input, edit, press };
}
test('runner validates drafts, preserves failed imports and confirms unsaved navigation', async () => {
  const f = await fixture(async () => { throw Error('Picker cancelled'); });
  await f.edit('Project name', 'Local'); await f.edit('Script source', 'print("hi")'); await f.edit('Arguments (JSON array)', '[1]');
  await f.press('Save project');
  assert.match(f.view.root.findByProps({ accessibilityRole: 'alert' }).props.children, /Arguments/);
  assert.equal(f.input('Script source').props.value, 'print("hi")'); assert.equal(f.manager.snapshot().projects.length, 0);
  await f.press('Python'); assert.equal(f.alerts.length, 1);
  await act(async () => f.alerts[0][2][0].onPress?.());
  assert.equal(f.input('Project name').props.value, 'Local');
  let prevented = false;
  f.listeners.get('beforeRemove')({ preventDefault() { prevented = true; }, data: { action: {} } });
  assert(prevented);
  await f.edit('Arguments (JSON array)', '[]'); await f.press('Save project');
  await f.press('Import script file');
  assert.equal(f.input('Script source').props.value, 'print("hi")');
  assert.match(f.view.root.findByProps({ accessibilityRole: 'alert' }).props.children, /Picker cancelled/);
  await act(async () => f.view.unmount()); assert.equal(f.manager.listeners.size, 0);
});
test('rapid run taps dispatch once, lock editing and finish durable launch after unmount', async () => {
  let started, release, calls = 0;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(async () => { calls++; started(); await gate; return { state: 'running' }; });
  await f.edit('Project name', 'Example'); await f.edit('Script source', 'console.log(1)');
  let launch;
  await act(async () => { launch = f.button('Save and run').props.onPress(); f.button('Save and run').props.onPress(); await entered; });
  assert.equal(calls, 1); assert.equal(f.input('Script source').props.editable, false);
  await act(async () => f.view.unmount());
  await act(async () => { release(); await launch; });
  assert.equal(f.manager.snapshot().projects[0].run.state, 'running');
});
test('txt imports stay editable JavaScript projects without executing them', async () => {
  let calls = 0;
  const f = await fixture(async op => { calls++; assert.equal(op, 'importScript'); return { filename: 'script.txt', data: 'console.log("imported")' }; });
  await f.press('Import script file');
  assert.equal(f.input('Project name').props.value, 'script');
  assert.equal(f.input('Script source').props.value, 'console.log("imported")');
  assert.equal(f.button('JavaScript').props.accessibilityState.selected, true);
  assert.equal(f.manager.snapshot().projects.length, 0); assert.equal(calls, 1);
  await f.press('Save project'); assert.equal(f.manager.snapshot().projects.length, 1);
  await act(async () => f.view.unmount());
});
test('damaged addon storage does not prevent the independent runner screen from loading', async () => {
  const N = Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator'].map(key => [key, key]));
  N.Alert = { alert() {} };
  await import('../core/index.js');
  const runtime = globalThis.__ASSAULT_ADDONS__, previous = console.error;
  console.error = () => {};
  let view;
  try {
    await runtime.initialize({ metro: { common: { React, ReactNative: N } }, settings: {} }, () => {}, {
      getConstants: () => ({ DocumentsDirPath: '/docs' }), fileExists: async name => name.includes('assault-addons'),
      readFile: async () => 'broken json', writeFile: async () => {},
    });
    assert.match(runtime.page('plugin').default().props.children, /storage is damaged/);
    await act(async () => { view = create(React.createElement(runtime.page('script').default)); });
    assert(view.root.findAllByType('Text').some(node => node.props.children === 'Code runner'));
  } finally { console.error = previous; if (view) await act(async () => view.unmount()); delete globalThis.__ASSAULT_ADDONS__; }
});
test('runner follows theme changes with readable text on bright backgrounds and buttons', async () => {
  let snapshot = { entries: [], selectedTheme: null };
  const listeners = new Set();
  const addons = { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, snapshot: () => snapshot };
  const f = await fixture(undefined, addons);
  await act(async () => {
    snapshot = { selectedTheme: 'bright', entries: [{ manifest: { id: 'bright', colors: { BACKGROUND_PRIMARY: '#ffffff', BACKGROUND_SECONDARY: '#ffffff', BRAND_500: '#ffffff', TEXT_NORMAL: '#ffffff' } } }] };
    for (const listener of listeners) listener();
  });
  assert.equal(f.view.root.findByType('KeyboardAvoidingView').props.style.backgroundColor, '#ffffff');
  assert.equal(f.input('Script source').props.style.color, '#000000');
  assert.equal(f.button('Check runtimes').findByType('Text').props.style.color, '#000000');
  await act(async () => {
    snapshot = { ...snapshot, entries: [{ manifest: { ...snapshot.entries[0].manifest, colors: { ...snapshot.entries[0].manifest.colors, BRAND_500: '#000000' } } }] };
    for (const listener of listeners) listener();
  });
  assert.equal(f.button('Check runtimes').props.style({ pressed: true }).borderColor, '#ffffff');
  assert.equal(f.button('JavaScript').props.style({ pressed: true }).borderColor, '#ffffff');
  await act(async () => f.view.unmount()); assert.equal(listeners.size, 0);
});
