import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AddonManager, validateAddon } from '../plugins/index.js';
import { Journal } from '../utils/store.js';
import { compile } from '../plugins/sandbox.js';
import { nativeTheme } from '../themes/index.js';

const plugin = (id = 'counter', extra = '') => `export default { id: '${id}', kind: 'plugin', name: 'Counter', version: '1.0.0', settings: { greeting: { type: 'string', label: 'Greeting', default: 'Hello' }, visible: { type: 'boolean', label: 'Visible', default: true } }, onStart(api) { const count = api.getState('starts', 0); api.setState('starts', count + 1); if (api.getSetting('visible')) api.notify(api.getSetting('greeting')); }, ${extra} };`;
const theme = (id = 'night') => `export default { id: '${id}', kind: 'theme', name: 'Night', version: '1.0.0', colors: { BACKGROUND_PRIMARY: '#111111', TEXT_NORMAL: '#eeeeee' } };`;
function fixture() {
  const files = new Map(), notices = [], applied = [];
  const io = { async read(name) { return files.get(name) ?? null; }, async write(name, value) { files.set(name, value); } };
  const host = { notify: value => notices.push(value), applyTheme: async value => applied.push(value) };
  return { files, notices, applied, io, host, manager: new AddonManager(new Journal(io), host) };
}
test('txt JavaScript and multiple plugins survive restart with complete inactive state exports', async () => {
  const f = fixture(), m = f.manager; await m.start();
  await Promise.all([m.install(plugin(), 'example.txt'), m.install(plugin('second'), 'second.js')]);
  await m.configure('counter', { greeting: 'Saved greeting', visible: true });
  await m.enable('counter', true); await m.enable('second', true); await m.enable('second', false);
  const before = JSON.parse(await m.export());
  assert.equal(before.entries[1].state.starts, 1); assert.equal(before.entries[1].enabled, false);
  assert.equal(before.entries[0].settings.greeting, 'Saved greeting'); assert.ok(before.entries.every(e => e.source && e.filename && e.origin && e.installedAt));
  const restarted = new AddonManager(new Journal(f.io), f.host); await restarted.start();
  const after = JSON.parse(await restarted.export());
  assert.equal(after.entries[0].state.starts, 2); assert.equal(after.entries[1].state.starts, 1);
  const restore = fixture(); await restore.manager.start(); await restore.manager.restore(await restarted.export());
  assert.ok(restore.manager.data.entries.every(e => !e.enabled));
  assert.equal(restore.manager.data.entries[0].state.starts, 2);
  assert.equal(restore.notices.length, 0);
});
test('sandbox rejects escapes, loops, imports, functions, regex and malformed input before activation', () => {
  const attacks = [
    `require('fs')`, `globalThis.fetch('https://example.com')`, `api.constructor.constructor('return this')()`,
    `api['notify']('x')`, `api.notify.call(null, 'x')`, `while(true) {}`, `for(;;) {}`, `throw 'bad'`,
    `const x = api;`, `const x = () => 1;`, `api.setState('__proto__', {});`, `const x = /a+/;`,
    `api.notify(typeof globalThis)`, `api.setState('x', new Date())`, `api.setState('x', { get x() { return 1; } })`
  ];
  for (const attack of attacks) {
    const source = `export default { id: 'test', kind: 'plugin', name: 'Test', version: '1.0.0', onStart(api) { ${attack} } };`;
    if (attack.includes("'__proto__'")) {
      const c = compile(source); assert.throws(() => c.invoke('onStart', (name, args) => { if (args[0] === '__proto__') throw Error('denied'); }));
    } else assert.throws(() => validateAddon(source, 'attack.txt'), attack);
  }
  for (const source of ['', 'export default {', `const fs = require('fs');`, `export default { constructor: 'x' };`, `export default { id:'a', id:'b' };`]) assert.throws(() => validateAddon(source, 'input.txt'));
  assert.throws(() => validateAddon(plugin(), 'plugin.json'));
});
test('faulting hooks roll back state and notifications, disable only the failed plugin', async () => {
  const f = fixture(), m = f.manager; await m.start();
  await m.install(plugin('good'), 'good.js'); await m.enable('good', true);
  await m.install(plugin('bad', `onSettingsChanged(api) { api.setState('partial', true); api.notify('discard'); api.setState('nan', 0 / 0); }`), 'bad.js');
  await m.enable('bad', true); const count = f.notices.length;
  await m.configure('bad', { greeting: 'x', visible: true });
  const bad = m.data.entries[1]; assert.equal(bad.enabled, false); assert.match(bad.error, /finite/); assert.equal(bad.state.partial, undefined);
  assert.equal(f.notices.length, count); assert.equal(m.data.entries[0].enabled, true);
});
test('failed durable writes do not activate, notify, or lose committed state', async () => {
  const f = fixture(); await f.manager.start(); await f.manager.install(plugin(), 'p.js');
  const before = await f.manager.export();
  f.io.write = async () => { throw Error('disk full'); };
  await assert.rejects(f.manager.enable('counter', true), /disk full/);
  assert.equal(await f.manager.export(), before); assert.equal(f.notices.length, 0);
});
test('journal recovers previous slot after truncated write and rejects corrupt-only storage', async () => {
  const f = fixture(), journal = new Journal(f.io);
  await journal.save({ value: 1 }); await journal.save({ value: 2 });
  f.files.set('assault-addons-1.json', '{"format":');
  assert.deepEqual(await new Journal(f.io).load(), { value: 1 });
  f.files.set('assault-addons-0.json', '');
  await assert.rejects(new Journal(f.io).load(), /damaged/);
});
test('journal catches silently truncated writes before acknowledgement', async () => {
  const f = fixture(); f.io.write = async (name, text) => f.files.set(name, text.slice(0, 10));
  await assert.rejects(new Journal(f.io).save({ data: 'complete' }), /verification failed/);
});
test('theme switching restores selection and rolls back on write failure', async () => {
  const f = fixture(), m = f.manager; await m.start(); await m.install(theme(), 't.txt'); await m.install(theme('other'), 'o.js');
  await m.selectTheme('night'); assert.equal(m.data.selectedTheme, 'night');
  assert.deepEqual(nativeTheme(m.data.entries[0]).semanticColors.TEXT_NORMAL, ['#eeeeee', '#eeeeee', '#eeeeee']);
  await assert.rejects(m.remove('night'), /Switch/);
  const restarted = new AddonManager(new Journal(f.io), f.host); await restarted.start(); assert.equal(f.applied.at(-1).manifest.id, 'night');
  f.io.write = async () => { throw Error('full'); };
  await assert.rejects(m.selectTheme('other'), /full/); assert.equal(m.data.selectedTheme, 'night'); assert.equal(f.applied.at(-1).manifest.id, 'night');
  assert.throws(() => validateAddon(theme().replace('#111111', 'url(secret)'), 't.js'));
  assert.throws(() => validateAddon(theme().replace('colors:', 'onStart(api) {}, colors:'), 't.js'));
});
test('invalid backups and duplicate installation preserve state', async () => {
  const f = fixture(); await f.manager.start(); await f.manager.install(plugin(), 'p.js');
  await assert.rejects(f.manager.install(plugin(), 'p.js'), /already/);
  const backup = await f.manager.export();
  await assert.rejects(f.manager.restore(backup), /empty library/);
  assert.equal(await f.manager.export(), backup);
  const data = JSON.parse(backup); data.entries[0].source = 'process.exit()';
  assert.throws(() => f.manager.restore(JSON.stringify(data)), /Export one/);
});
test('production patch disables both external evaluators and routes native settings', async () => {
  const patch = await readFile('scripts/patch_runtime.py', 'utf8');
  assert.match(patch, /Legacy plugins require porting/); assert.match(patch, /External plugins must use/);
  assert.match(patch, /assaultAddonPage\("plugin"\)/); assert.match(patch, /assaultAddonPage\("theme"\)/);
});
test('safe mode preserves activation preferences but never runs lifecycle hooks', async () => {
  const f = fixture(); await f.manager.start(); await f.manager.install(plugin('safe', `onStop(api) { api.notify('stopped'); }`), 'safe.js'); await f.manager.enable('safe', true);
  f.host.canActivate = () => false;
  const manager = new AddonManager(new Journal(f.io), f.host); const before = f.notices.length;
  await manager.start(); assert.equal(manager.data.entries[0].state.starts, 1);
  await assert.rejects(manager.enable('safe', true), /safe mode/);
  await manager.enable('safe', false); assert.equal(f.notices.length, before);
});
test('source limit measures UTF8 bytes and rejects oversized non-ASCII input', () => {
  assert.equal(validateAddon(plugin() + '/*' + 'x'.repeat(40000) + '*/', 'large.txt').manifest.id, 'counter');
  assert.throws(() => validateAddon(plugin() + '/*' + '€'.repeat(22000) + '*/', 'large.txt'), /too large/);
});
test('aliased data cannot expand exponentially during serialization', async () => {
  const f = fixture(); await f.manager.start();
  let body = `const v0 = ['12345678'];`;
  for (let i = 1; i < 23; i++) body += `const v${i} = [v${i - 1}, v${i - 1}];`;
  body += `api.setState('bomb', v22);`;
  await f.manager.install(`export default { id:'bomb', kind:'plugin', name:'Bomb', version:'1.0.0', onStart(api) { ${body} } };`, 'bomb.js');
  await f.manager.enable('bomb', true);
  assert.equal(f.manager.data.entries[0].enabled, false);
  assert.match(f.manager.data.entries[0].error, /limit|deeply|values/);
  assert.deepEqual(f.manager.data.entries[0].state, {});
});
test('addon journals ignore newer envelopes whose payload fails schema validation', async () => {
  const f = fixture(); await f.manager.start(); await f.manager.install(plugin(), 'counter.js');
  await f.manager.configure('counter', { greeting: 'newer', visible: true });
  const newest = `assault-addons-${f.manager.store.slot}.json`;
  const broken = JSON.parse(f.files.get(newest)); broken.data.entries[0].source = 'not an addon'; f.files.set(newest, JSON.stringify(broken));
  const manager = new AddonManager(new Journal(f.io), f.host); await manager.start();
  assert.equal(manager.data.entries[0].settings.greeting, 'Hello');
  assert.equal(JSON.parse(f.files.get(newest)).data.entries[0].source, 'not an addon', 'recovery does not delete the invalid slot');
});
test('one activation write failure preserves the library and does not prevent other plugins starting', async () => {
  const f = fixture(); await f.manager.start();
  await f.manager.install(plugin(), 'counter.js'); await f.manager.install(plugin('other'), 'other.js');
  await f.manager.enable('counter', true); await f.manager.enable('other', true);
  const write = f.io.write; let attempts = 0;
  f.io.write = async (...args) => { if (++attempts === 1) throw Error('Disk unavailable'); return write(...args); };
  const manager = new AddonManager(new Journal(f.io), f.host); await manager.start();
  assert(manager.ready); assert.equal(manager.data.entries.length, 2);
  assert.match(manager.startupErrors.counter, /Disk unavailable/);
  assert.equal(manager.data.entries[0].state.starts, 1);
  assert.equal(manager.data.entries[1].state.starts, 2);
  assert.equal(JSON.parse(await manager.export()).entries[0].enabled, true, 'saved activation preference remains intact');
  await manager.enable('counter', true);
  assert.equal(manager.startupErrors.counter, undefined); assert.equal(manager.data.entries[0].state.starts, 2);
});
