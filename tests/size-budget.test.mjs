import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sizeOf } from '../scripts/check-size.mjs';

// Why this suite exists: "lightweight" is only real if a release fails when it stops being
// lightweight. `scripts/check-size.mjs` enforces `scripts/size-budget.json`, and the two
// mistakes worth pinning are the ones that make such a check useless in opposite directions -
// measuring an artifact that is not there (a fresh clone would fail forever), and measuring a
// directory wrong (the first version summed each nested subtree once per level, reporting a
// 325 MB unpacked app as 1.2 GB and failing a build that was fine).

const SCRIPT = join('scripts', 'check-size.mjs');

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'hypercord-size-'));
  mkdirSync(join(root, 'release'), { recursive: true });
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', timeout: 30000 });
}

test('a nested directory is measured once, not once per level', () => {
  const root = tree();
  try {
    const deep = join(root, 'win-unpacked', 'resources', 'app');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, 'win-unpacked', 'outer.bin'), Buffer.alloc(1000));
    writeFileSync(join(root, 'win-unpacked', 'resources', 'middle.bin'), Buffer.alloc(2000));
    writeFileSync(join(deep, 'inner.bin'), Buffer.alloc(4000));
    assert.equal(sizeOf(join(root, 'win-unpacked')), 7000);
    // and the same answer twice: a measurement that grows when it is repeated is a counter,
    // not a size
    assert.equal(sizeOf(join(root, 'win-unpacked')), 7000);
    assert.equal(sizeOf(join(root, 'nope')), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact over its budget fails the run and is named', () => {
  const root = tree();
  try {
    // The loader budget is 400 KB; this is 600 KB of a file that claims to be one.
    writeFileSync(join(root, 'release', 'Hypercord-Loader.apk'), Buffer.alloc(600 * 1024));
    const done = run(root);
    assert.equal(done.status, 1, done.stdout + done.stderr);
    assert.match(done.stdout, /FAIL {2}loader APK/);
    assert.match(done.stdout, /1 artifact\(s\) over budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact inside its budget passes, and two architectures are two measurements', () => {
  const root = tree();
  try {
    writeFileSync(join(root, 'release', 'Hypercord-Loader.apk'), Buffer.alloc(200 * 1024));
    mkdirSync(join(root, 'dist', 'win-x64-unpacked', 'resources'), { recursive: true });
    mkdirSync(join(root, 'dist', 'win-arm64-unpacked', 'resources'), { recursive: true });
    writeFileSync(join(root, 'dist', 'win-x64-unpacked', 'resources', 'app.asar'), Buffer.alloc(1024 * 1024));
    writeFileSync(join(root, 'dist', 'win-arm64-unpacked', 'resources', 'app.asar'), Buffer.alloc(1024 * 1024));
    const done = run(root, '--output', 'size.json');
    assert.equal(done.status, 0, done.stdout + done.stderr);
    // Two asars at 1 MB each: the budget is per artifact, so neither is summed into 2 MB.
    const rows = done.stdout.split('\n').filter((line) => line.includes('packed app'));
    assert.equal(rows.length, 2, done.stdout);
    for (const row of rows) assert.match(row, /1\.0 MB of 6\.0 MB/);
    const record = JSON.parse(readFileSync(join(root, 'size.json'), 'utf8'));
    assert.equal(record.ok, true);
    const asars = record.artifacts.filter((row) => row.name === 'packed app (app.asar)');
    assert.equal(asars.length, 2);
    assert.ok(asars.every((row) => row.measured && row.bytes === 1048576 && row.over === false));
    // The APKs that were not built are recorded as unmeasured rather than as zero bytes.
    const loader = record.artifacts.find((row) => row.name === 'loader APK');
    assert.equal(loader.bytes, 200 * 1024);
    assert.equal(loader.measured, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nothing built is not a failure, and says so instead of passing silently', () => {
  const root = tree();
  try {
    const done = run(root);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /not built in this tree, so not measured/);
    assert.match(done.stdout, /nothing was measured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the budgets themselves stay coherent: a positive limit and a reason for it', () => {
  const file = JSON.parse(readFileSync(join('scripts', 'size-budget.json'), 'utf8'));
  assert.ok(Array.isArray(file.budgets) && file.budgets.length >= 4, 'every shipped artifact kind needs a budget');
  for (const budget of file.budgets) {
    assert.ok(budget.name, JSON.stringify(budget));
    assert.ok(Number.isInteger(budget.limitBytes) && budget.limitBytes > 0, budget.name);
    assert.ok(typeof budget.why === 'string' && budget.why.length > 20, budget.name + ' needs a reason');
    assert.ok(budget.match || budget.dir, budget.name + ' names neither a file nor a directory');
  }
  // The number that made the check worth writing: the loader is the lean half, and its
  // budget has to stay in the hundreds of kilobytes, not drift up to match whatever ships.
  const loader = file.budgets.find((budget) => budget.name === 'loader APK');
  assert.ok(loader.limitBytes <= 1024 * 1024, 'the loader budget should still be under a megabyte');
});
