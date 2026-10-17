// language: JavaScript, file: tests/asar/index.mjs
//
// The install question that locked the file it was asking about.
//
//   npm run test:asar          # electron tests/asar
//
// Why this suite exists: a shipped client found Discord, decided it was clean, and then failed
// to patch it with `EBUSY: resource busy or locked, rename '...resources\app.asar' ->
// '...resources\hypercord.app.asar'` - on every run, on a machine where the install was intact
// and the feed was fine. The patch had not been refused by Discord, or by another loader, or by
// a permission: it had been refused by the *question*.
//
// Electron's `fs` is not the filesystem. A path containing `.asar` is answered by opening the
// archive, and the handle it keeps is opened without delete sharing, so one `existsSync` on
// `resources/app.asar` - the first thing discovery does - makes that file unrenameable for the
// rest of the process. Renaming it is the patch. The client was holding its own door shut.
//
// It cannot be caught by a plain-Node suite: in Node `fs` *is* the disk, and the lock does not
// exist. It cannot be caught by the unit suites either, because they inject their own `exists`
// and never touch an archive. So this suite runs under Electron, reproduces the behaviour it was
// written for, and then asserts that src/patcher.js is immune to it - through discovery,
// inspection, a real patch and a real unpatch on a fake install.
//
// The reproduction is reported rather than required: if a future Electron stops locking archives
// it answers, that is good news, and this suite says so instead of failing for it. What is
// *required* is the half that belongs to us: after the patch's own questions, the archive is still
// the client's to rename.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name + (detail ? " | " + detail : ""));
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}
const say = (line) => console.log("note  " + line);

// a hang must report itself rather than sit there being a hang
const watchdog = setTimeout(() => {
  console.log("FAIL the suite hung: " + passed + " passed before it stopped");
  app.exit(2);
}, 120000);
watchdog.unref?.();

/**
 * The filesystem underneath the asar-aware one, for the rename attempts.
 *
 * A rename through Electron's `fs` would ask the asar layer first and answer in its terms; what
 * this suite is about is the operating system's share mode, so the rename goes through the plain
 * module. It is the same module the patch itself uses (see `disk` in src/patcher.js).
 */
const native = (await import("original-fs")).default || fs;

/**
 * A Discord install layout: <base>/Discord/app-<version>/resources/app.asar.
 *
 * The archive is built by `@electron/asar` - the same library electron-builder packs with - and
 * not written as junk bytes on purpose: Electron parses an `.asar` it is asked about, and a file
 * that only looks like one makes the layer below throw `Invalid package` instead of answering
 * the question this suite is trying to ask.
 */
async function fakeInstall(base, version = "1.0.9262") {
  const resources = path.join(base, "Discord", "app-" + version, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const source = path.join(base, "asar-source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "discord", version, main: "index.js" }) + "\n");
  fs.writeFileSync(path.join(source, "index.js"), "// Discord's own entry point, in a fake archive\n");
  const { createPackage } = await import("@electron/asar");
  const asar = path.join(resources, "app.asar");
  await createPackage(source, asar);
  return { base, resources, asar, original: path.join(resources, "hypercord.app.asar") };
}

/** Rename the archive aside and back, reporting what happened rather than throwing. */
function renameRoundTrip(install) {
  try {
    native.renameSync(install.asar, install.original);
  } catch (err) {
    return { ok: false, code: String((err && err.code) || ""), error: String((err && err.message) || err) };
  }
  try {
    native.renameSync(install.original, install.asar);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: String((err && err.code) || ""), error: "renamed aside but not back: " + String((err && err.message) || err) };
  }
}

const scratch = path.join(os.tmpdir(), "hypercord-asar-test");

try {
  /* ---- what Electron's fs does to an archive it is asked about -------------- */

  const reproduction = await fakeInstall(path.join(scratch, "repro"));
  ok("the fake install has an archive where discovery looks", fs.existsSync(reproduction.asar));

  // exactly the call that used to run first: `exists` on the archive itself
  fs.existsSync(reproduction.asar);
  const afterQuestion = renameRoundTrip(reproduction);
  if (afterQuestion.ok) {
    say("this Electron no longer locks an archive because fs was asked whether it exists; the");
    say("escape hatch below is still what the patch uses, and it costs nothing where it is not needed");
  } else {
    say("reproduced: one fs.existsSync on app.asar is enough to make it unrenameable here (" + afterQuestion.code + ")");
  }
  ok(
    "the lock, when it happens, is on the file this patch has to rename",
    afterQuestion.ok || afterQuestion.code === "EBUSY" || afterQuestion.code === "EPERM",
    afterQuestion.ok ? "not locked on this Electron" : afterQuestion.code,
  );

  /* ---- the patcher's own questions, on a fresh fake install ----------------- */

  const { findDiscord, inspect, patch, unpatch } = await import("file://" + path.join(root, "src", "patcher.js").split(path.sep).join("/"));

  const target = await fakeInstall(path.join(scratch, "patched"));
  const before = native.readFileSync(target.asar);
  const found = findDiscord({ platform: "win32", env: { LOCALAPPDATA: target.base }, home: target.base });
  ok("discovery finds the fake install", found.ok === true && found.install.resources === target.resources, found.ok ? found.install.resources : found.error);
  if (!found.ok) throw new Error("nothing to inspect: " + found.error);

  const state = inspect(found.install);
  ok("it reads as clean, before anything of ours is there", state.state === "clean", JSON.stringify(state));

  // The regression, stated as the user meets it: after the question, the answer is still actionable.
  const afterInspect = renameRoundTrip(target);
  ok(
    "after discovery and inspection the archive can still be renamed - the patch is possible",
    afterInspect.ok === true,
    afterInspect.ok ? "" : afterInspect.code + " " + String(afterInspect.error || "").slice(0, 80),
  );

  const loader = path.join(scratch, "loader.cjs");
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, "module.exports = {};\n");

  const patched = patch(found.install, { loader, version: "0.0.1", appRoot: scratch, assets: { css: "body{}" } });
  ok("the patch goes through on a real directory", patched.ok === true, JSON.stringify(patched).slice(0, 200));
  ok("the archive was moved aside, never rewritten", inspect(found.install).state === "patched" && native.existsSync(target.original) && !native.existsSync(target.asar));
  ok("the entry point that starts the loader is written", native.existsSync(path.join(target.resources, "app", "index.js")));
  const manifest = JSON.parse(fs.readFileSync(path.join(target.resources, "app", "hypercord.json"), "utf8"));
  ok("and the record names the build that patched it", manifest.tool === "hypercord" && manifest.patchedByVersion === "0.0.1", manifest.patchedByVersion);

  const unpatched = unpatch(found.install);
  ok("unpatching restores the original archive byte for byte", unpatched.ok === true && native.existsSync(target.asar) && !native.existsSync(target.original));
  const bytes = native.readFileSync(target.asar);
  ok("and the bytes are the ones it started with", bytes.equals(before), bytes.length + " bytes, identical: " + bytes.equals(before));

  /* ---- the other direction: a loader that lives *inside* an archive ------- */

  // A packaged client is its own asar, so the loader it patches Discord with is not a file on
  // the disk at all - it is an entry inside `resources/app.asar`. Asking `original-fs` about
  // that path answers "no", because that module has no asar support, and a client that used it
  // for everything refused to patch with "the loader is not here" while the loader was there.
  // The two questions are told apart by the path, and this is the regression for the second one.
  const ownSource = path.join(scratch, "own-src");
  fs.mkdirSync(path.join(ownSource, "src"), { recursive: true });
  fs.writeFileSync(path.join(ownSource, "src", "loader.cjs"), "module.exports = {};\n");
  const ownAsar = path.join(scratch, "own-app.asar");
  const { createPackage } = await import("@electron/asar");
  await createPackage(ownSource, ownAsar);

  const packagedPatch = patch(found.install, {
    loader: path.join(ownAsar, "src", "loader.cjs"),
    version: "0.0.2",
    appRoot: ownAsar,
    assets: { css: "body{}" },
  });
  ok(
    "a packaged client, whose loader is inside its own archive, patches an install too",
    packagedPatch.ok === true,
    String(packagedPatch.error || "").slice(0, 120) || "ok",
  );
  const insideManifest = inspect(found.install);
  ok(
    "and the record keeps the loader path it was actually given",
    insideManifest.state === "patched" && String(insideManifest.manifest.loader).endsWith(path.join("src", "loader.cjs")),
    insideManifest.state === "patched" ? insideManifest.manifest.loader : insideManifest.state,
  );
  ok("and that install unpaches like any other", unpatch(found.install).ok === true);
} catch (err) {
  failed += 1;
  console.log("FAIL the suite did not finish: " + String((err && err.message) || err));
} finally {
  clearTimeout(watchdog);
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* a profile still held open by a renderer is not this suite's business */
  }
}

console.log("\npassed " + passed + "  failed " + failed);
app.exit(failed === 0 ? 0 : 1);
