import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptManager, scriptValues } from '../core/scripts.js';
const script = { name: 'Example', runtime: 'javascript', source: "console.log('hello')", args: [], restart: false };
async function fixture(request = async () => ({ state: 'running' })) {
  const files = new Map();
  const io = { read: async name => files.get(name) ?? null, write: async (name, value) => files.set(name, value) };
  const bridge = { request };
  const manager = new ScriptManager(io, bridge);
  await manager.start();
  return { manager, files, io, bridge };
}
test('scripts persist across reconstruction and export saved sources, settings and run state', async () => {
  const { manager, files, io, bridge } = await fixture(async (_op, { request }) => request.operation === 'poll' ? { state: 'exited', exitCode: 0, console: 'hello\n' } : { state: 'running' });
  const id = await manager.save(script); await manager.run(id); await manager.poll(id);
  const restored = new ScriptManager(io, bridge); await restored.start();
  assert.deepEqual(restored.snapshot(), manager.snapshot());
  assert(files.has('assault-scripts-0.json')); assert(!files.has('assault-addons-0.json'));
  const backup = JSON.parse(await restored.export());
  assert.equal(backup.projects[0].source, script.source); assert.equal(backup.projects[0].run.console, 'hello\n');
  const other = await fixture(); await other.manager.restore(JSON.stringify(backup));
  assert.equal(other.manager.snapshot().projects[0].restart, false); assert.equal(other.manager.snapshot().projects[0].run, null);
  await assert.rejects(other.manager.restore(JSON.stringify(backup)), /empty project/);
});
test('duplicate launches serialize before dispatch and durable ID exists before execution', async () => {
  let launches = 0, unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const { manager, files } = await fixture(async (_op, { request }) => { launches++; assert(files.size > 0); assert.equal(manager.snapshot().projects[0].run.id, request.run); await gate; return { state: 'running' }; });
  const id = await manager.save(script);
  const first = manager.run(id), second = manager.run(id);
  unblock(); await first; await assert.rejects(second, /existing run/); assert.equal(launches, 1);
});
test('timeouts preserve an unknown run until reconciliation and save failures never execute', async () => {
  let fail = true, calls = 0;
  const { manager, io } = await fixture(async () => { calls++; if (fail) throw Error('No callback'); return { state: 'missing' }; });
  const id = await manager.save(script);
  await assert.rejects(manager.run(id), /No callback/);
  assert.equal(manager.find(id).run.state, 'unknown');
  await assert.rejects(manager.run(id), /existing run/); assert.equal(calls, 1);
  fail = false; await manager.poll(id); assert.equal(manager.find(id).run.state, 'missing');
  io.write = async () => { throw Error('Disk full'); };
  await assert.rejects(manager.run(id), /Disk full/); assert.equal(calls, 2);
});
test('validation, safe mode, removal and opt-in restarts preserve disabled scripts', async () => {
  for (const value of [{ ...script, args: '[1]' }, { ...script, source: '€'.repeat(30000) }, { ...script, runtime: 'eval' }, { ...script, name: '' }]) assert.throws(() => scriptValues(value));
  let starts = 0;
  const { manager } = await fixture(async (_op, { request }) => { if (request.operation === 'start') starts++; return { state: 'running' }; });
  const id = await manager.save(script);
  await manager.resume(); assert.equal(starts, 0);
  await manager.save({ ...script, restart: true }, id);
  manager.canRun = () => false; await manager.resume(); assert.equal(starts, 0);
  await assert.rejects(manager.run(id), /safe mode/);
  manager.canRun = () => true; await manager.resume(); assert.equal(starts, 1);
  await manager.resume(); assert.equal(starts, 1);
  await assert.rejects(manager.remove(id), /Stop and refresh/);
});
test('setup runs only explicitly and uses the selected project working directory', async () => {
  const requests = [];
  const { manager } = await fixture(async (_op, { request }) => { requests.push(request); return { state: 'exited', exitCode: 0 }; });
  const id = await manager.save({ ...script, setup: 'npm install example' });
  await manager.run(id, true);
  assert.equal(requests[0].project, id); assert.equal(requests[0].runtime, 'shell'); assert.equal(requests[0].source, 'npm install example');
  assert.equal(manager.find(id).run.phase, 'setup');
  await manager.run(id);
  assert.equal(requests[1].runtime, 'javascript'); assert.equal(requests[1].source, script.source);
});
test('runtime checks queue behind an existing launch instead of racing the runner mailbox', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const operations = [];
  const { manager } = await fixture(async (_operation, { request }) => {
    operations.push(request.operation);
    if (request.operation === 'start') { entered(); await gate; return { state: 'running' }; }
    return { python: 'test', node: true, bash: true };
  });
  const id = await manager.save(script), launch = manager.run(id); await started;
  const check = manager.check(); assert.deepEqual(operations, ['start']);
  release(); await launch; assert.equal((await check).node, true); assert.deepEqual(operations, ['start', 'check']);
});
test('script journal falls back from structurally invalid recent projects without overwriting either slot', async () => {
  const { manager, files, io, bridge } = await fixture();
  const id = await manager.save(script); await manager.save({ ...script, name: 'new revision' }, id);
  const newest = `assault-scripts-${manager.store.slot}.json`;
  const invalid = JSON.parse(files.get(newest)); invalid.data.projects[0].runtime = 'unsupported'; files.set(newest, JSON.stringify(invalid));
  const before = new Map(files), restarted = new ScriptManager(io, bridge); await restarted.start();
  assert.equal(restarted.find(id).name, 'Example'); assert.deepEqual(files, before);
});
