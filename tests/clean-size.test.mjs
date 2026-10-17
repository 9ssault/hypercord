import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clean } from "../scripts/clean.mjs";

// Why this suite exists: `npm run clean` reported "freed 0.0 MB across 0 path(s), 1 left
// alone" while a __pycache__ sat in scripts/. The candidate was found and then skipped,
// because every removal had to be inside dist/ or vendor/equicord/dist - and bytecode never
// is. The fix is a second allowed kind of path, and the risk in a cleaner is the opposite
// mistake: deleting something it does not own. So both halves are pinned here, on a
// temporary tree rather than on the checkout.

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-clean-"));
  const write = (rel, bytes = 8) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    return file;
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  write("dist/Hypercord-0.9.9-win-setup.exe", 100);
  write("dist/Hypercord-1.0.0-win-setup.exe", 100);
  fs.writeFileSync(path.join(root, "dist", "latest.yml"), "version: 1.0.0\n");
  write("dist/builder-debug.yml");
  write("vendor/equicord/dist/bundle.js.map", 64);
  write("vendor/equicord/dist/bundle.js", 64);
  write("scripts/__pycache__/build_android.cpython-313.pyc", 32);
  write("android/__pycache__/x.pyc", 32);
  write("src/host.js", 32);
  write("scripts/normal.mjs", 32);
  return root;
}

test("a dry run names what it would free and deletes nothing", () => {
  const root = fixture();
  const lines = [];
  const result = clean({ root, dryRun: true, log: (line) => lines.push(String(line)) });
  assert.ok(result.removed.length >= 4, JSON.stringify(result.removed.map((row) => row.file)));
  assert.ok(fs.existsSync(path.join(root, "scripts", "__pycache__")), "a dry run deleted bytecode");
  assert.ok(fs.existsSync(path.join(root, "dist", "Hypercord-0.9.9-win-setup.exe")), "a dry run deleted a stale artifact");
  assert.ok(lines.some((line) => /would free/.test(line)), lines.join("\n"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("bytecode, stale builds and source maps go; the current build and the sources stay", () => {
  const root = fixture();
  const result = clean({ root, log: () => {} });
  const removed = result.removed.map((row) => row.file);

  // the bug this pins: bytecode outside a build directory used to be skipped
  assert.ok(removed.includes("scripts/__pycache__"), removed.join(","));
  assert.ok(removed.includes("android/__pycache__"), removed.join(","));
  assert.equal(fs.existsSync(path.join(root, "scripts", "__pycache__")), false);

  // a build of another version is reclaimed, this one's is not
  assert.ok(removed.includes("dist/Hypercord-0.9.9-win-setup.exe"), removed.join(","));
  assert.equal(fs.existsSync(path.join(root, "dist", "Hypercord-1.0.0-win-setup.exe")), true);
  assert.equal(fs.existsSync(path.join(root, "dist", "latest.yml")), true);
  assert.equal(fs.existsSync(path.join(root, "dist", "builder-debug.yml")), true);

  // source maps are stripped by packaging, their bundle is not
  assert.ok(removed.includes("vendor/equicord/dist/bundle.js.map"), removed.join(","));
  assert.equal(fs.existsSync(path.join(root, "vendor", "equicord", "dist", "bundle.js")), true);

  // and nothing that is source is ever a candidate
  assert.equal(fs.existsSync(path.join(root, "src", "host.js")), true);
  assert.equal(fs.existsSync(path.join(root, "scripts", "normal.mjs")), true);
  assert.ok(!removed.some((file) => file.startsWith("src/")), removed.join(","));

  fs.rmSync(root, { recursive: true, force: true });
});
