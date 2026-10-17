// language: JavaScript, file: tests/release/index.mjs
//
// The release gate's own logic, checked without building anything.
//
// The gate exists to stop one thing: an installer built from a packed app that
// does not represent the source, or built after a check that failed. So what is
// asserted here is the *order* and the *staleness rule* - the two properties that
// make the gate mean anything - plus the artifact rules, which is what decides
// whether a run is declared a success.
//
//   node tests/release/index.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { feedProblems, missingPlatformFeeds, readFeed, requiredFeeds } from "../../scripts/check-feed.mjs";
import { artifactsIn, commandLine, isStale, missingTestFiles, namedTestFiles, newestInput, plan } from "../../scripts/release.mjs";

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}

/* ---- the order, which is the point --------------------------------------- */

const names = plan().map((step) => step.name);
const at = (step) => names.indexOf(step);

ok("the vendor audit runs before anything is packed", at("vendor audit") === 0 && at("vendor audit") < at("pack"), names.join(" -> "));
ok("the suites run before anything is packed", at("the test suites") < at("pack"), names.join(" -> "));
ok("the app is packed before it is checked", at("pack") < at("packaged build check"), names.join(" -> "));
ok("staleness is judged between packing and checking", at("pack") < at("freshness of the packed app") && at("freshness of the packed app") < at("packaged build check"), names.join(" -> "));
ok("installers are built last, after every check", at("installers") === names.length - 1, names.join(" -> "));
ok("nothing can be skipped by a flag", !names.some((name) => /skip|only|force/i.test(name)), names.join(" -> "));

const slim = plan({ tests: false }).map((step) => step.name);
ok("--skip-tests drops only the suites, never a check", !slim.includes("the test suites") && slim.includes("pack") && slim.includes("packaged build check") && slim.includes("installers"), slim.join(" -> "));

const checked = plan().find((step) => step.name === "packaged build check");
ok("the packaged check runs the checker on the real executable", /check-packaged\.mjs$/.test(checked.args[0]), JSON.stringify(checked.args));
ok("and it uses a throwaway profile by default, so the login page is under test", checked.args.includes("--fresh"), JSON.stringify(checked.args));
ok("--no-fresh is the only way to check a signed-in profile", !plan({ fresh: false }).find((step) => step.name === "packaged build check").args.includes("--fresh"));

const installers = plan({ builderArgs: ["--win", "--x64"] }).find((step) => step.name === "installers");
ok("the installers step never publishes", installers.args.includes("--publish") && installers.args.includes("never"), JSON.stringify(installers.args));
ok("and it passes the caller's builder arguments through", installers.args.join(" ").includes("--win --x64"), JSON.stringify(installers.args));

/* ---- how a step is started ---------------------------------------------- */

// The bug this covers: on Windows `npm` is a .cmd, Node refuses to spawn it
// without a shell, the step silently never runs, and the gate reports a failed
// audit for an audit that passes on its own.
const npmOnWindows = commandLine("npm", ["run", "--silent", "vendor:check"], "win32");
ok("npm is resolved to npm.cmd on Windows", npmOnWindows.file.startsWith("npm.cmd"), npmOnWindows.file);
ok("and is run through the shell, which is the only way Windows runs it", npmOnWindows.shell === true);
ok("with its arguments intact", npmOnWindows.file.includes("vendor:check"), npmOnWindows.file);
ok("nothing is shelled on other platforms", commandLine("npm", ["test"], "linux").shell === false && commandLine("npm", ["test"], "linux").argv.includes("test"));
const spaced = commandLine("npm", ["run", "--silent", "pack"], "win32");
ok("an argument with a space would be quoted, not pasted", commandLine("npm", ["run", "--config", "/a b/c.json"], "win32").file.includes('\"'), spaced.file);
const nodeStep = commandLine(process.execPath, ["scripts/check-packaged.mjs", "--fresh"], "win32");
ok("the checker is started directly, with no shell in the way", nodeStep.shell === false && nodeStep.argv.includes("--fresh"), JSON.stringify(nodeStep));

/* ---- staleness: a missing build is a stale build ------------------------- */

ok("a build older than its source is stale", isStale(1000, 2000) === true);
ok("a build newer than its source is not", isStale(2000, 1000) === false);
ok("a build with the same timestamp as its source is not stale", isStale(2000, 2000) === false);
ok("no build at all is stale", isStale(0, 1) === true && isStale(undefined, 1) === true);

/* ---- newestInput: the newest file, not the newest directory -------------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-release-test-"));
try {
  const nested = path.join(dir, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });
  const older = path.join(dir, "src", "older.txt");
  const newer = path.join(nested, "newer.txt");
  fs.writeFileSync(older, "a");
  fs.writeFileSync(newer, "b");
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(older, past, past);
  fs.utimesSync(path.join(dir, "src"), past, past); // the directory is older than its file
  const newest = newestInput(["src"], dir);
  const expected = Math.round(fs.statSync(newer).mtimeMs);
  ok("newestInput finds the newest file, however deep", Math.round(newest) === expected, "got " + Math.round(newest) + " want " + expected);
  ok("a directory's own timestamp cannot make a build look fresh", newest > Math.round(fs.statSync(path.join(dir, "src")).mtimeMs));
  ok("a path that does not exist is not a reason to throw", newestInput(["nope", "src"], dir) === newest);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---- what counts as an artifact ------------------------------------------ */

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-release-dist-"));
try {
  for (const file of ["Hypercord-Setup-0.1.0.exe", "Hypercord-portable-0.1.0.exe", "latest.yml", "builder-debug.yml", "Hypercord-0.1.0.AppImage"]) {
    fs.writeFileSync(path.join(dist, file), "x");
  }
  fs.mkdirSync(path.join(dist, "win-unpacked"));
  fs.writeFileSync(path.join(dist, "win-unpacked", "Hypercord.exe"), "x");
  const found = artifactsIn(dist).map((file) => path.basename(file));
  ok("installers are counted, whatever platform built them", found.includes("Hypercord-Setup-0.1.0.exe") && found.includes("Hypercord-portable-0.1.0.exe") && found.includes("Hypercord-0.1.0.AppImage"), JSON.stringify(found));
  ok("the unpacked tree is not an artifact", !found.includes("Hypercord.exe"), JSON.stringify(found));
  ok("metadata files are not artifacts", !found.includes("latest.yml") && !found.includes("builder-debug.yml"), JSON.stringify(found));
  ok("an empty dist produces nothing rather than throwing", artifactsIn(path.join(dist, "nope")).length === 0);
} finally {
  fs.rmSync(dist, { recursive: true, force: true });
}

/* ---- preflight: the tree the gate is about to build ---------------------- */

// The failure this covers is a real one: a test file the suite names was gone, the
// suite could not run, and the release built anyway. The gate is driven here as a
// child process, against a scratch copy of itself, because that is how it is
// actually used - and nothing in the scratch tree can touch this project's dist/.
const here = path.dirname(fileURLToPath(import.meta.url));
const projectScript = path.join(here, "..", "..", "scripts", "release.mjs");

/** A throwaway project that names one test it has and one it does not. */
function scratchProject({ missing = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-gate-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(projectScript, path.join(dir, "scripts", "release.mjs"));
  fs.mkdirSync(path.join(dir, "tests", "present"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "present", "index.mjs"), "console.log('ok');\n");
  const named = ["node tests/present/index.mjs"];
  if (missing) named.push("node tests/absent/index.mjs");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "scratch", version: "0.0.0", scripts: { "test:units": named.join(" && ") } }, null, 2),
  );
  return dir;
}

/** Run the real gate inside that scratch project. It never reaches a build. */
function gate(dir, args = ["--dry-run"]) {
  const done = spawnSync(process.execPath, [path.join("scripts", "release.mjs"), ...args], { cwd: dir, encoding: "utf8", timeout: 20000 });
  return { code: done.status === null ? -1 : done.status, out: String(done.stdout || "") + String(done.stderr || "") };
}

function git(dir, args) {
  return spawnSync("git", args, { cwd: dir, encoding: "utf8" });
}

const parsed = scratchProject({ missing: true });
try {
  ok("the suite is read out of package.json, not guessed", namedTestFiles(parsed).join(",") === "tests/present/index.mjs,tests/absent/index.mjs", JSON.stringify(namedTestFiles(parsed)));
  ok("a test the suite names and the tree does not have is reported", missingTestFiles(parsed).join(",") === "tests/absent/index.mjs", JSON.stringify(missingTestFiles(parsed)));

  const run = gate(parsed);
  ok("the gate reports its preflight", run.out.includes("# preflight"), run.out.trim().split("\n").slice(0, 2).join(" / "));
  ok("a missing test stops the run", run.code !== 0, "exit " + run.code);
  ok("and it says so as a check, not as a sentence in the middle of a build", /FAIL every test file the suite names exists/.test(run.out), run.out.trim().split("\n").slice(-2).join(" / "));
  ok("naming the file that is missing", run.out.includes("tests/absent/index.mjs"), "");
  ok("and refusing with the wording a failed pack already gets", /refusing to build installers: the suite names 1 test file\(s\) that do not exist/.test(run.out), "");
  ok("nothing was built and nothing was planned", !run.out.includes("# release plan") && !fs.existsSync(path.join(parsed, "dist")), "");
} finally {
  fs.rmSync(parsed, { recursive: true, force: true });
}

const tree = scratchProject({ missing: false });
try {
  const started = git(tree, ["init", "-q"]);
  const tracked = started.status === 0 && git(tree, ["add", "-A"]).status === 0 && git(tree, ["-c", "user.email=gate@example.test", "-c", "user.name=gate", "commit", "-q", "-m", "scratch"]).status === 0;
  if (!tracked) console.log("note  git is not available here, so the dirty-tree cases cannot be driven");

  const clean = gate(tree);
  ok("a clean tree with every named test present passes preflight", clean.code === 0 && /ok   every test file the suite names exists/.test(clean.out), "exit " + clean.code + " " + clean.out.trim().split("\n").slice(-1)[0]);
  if (tracked) {
    ok("and the run goes on to its plan rather than refusing", clean.out.includes("# release plan") && !clean.out.includes("refusing to build installers"), "");
    ok("and it says why the working copy is acceptable", /ok   the working copy is the committed state \| no tracked file is modified/.test(clean.out), "");

    fs.appendFileSync(path.join(tree, "tests", "present", "index.mjs"), "// an edit nobody committed\n");
    const dirty = gate(tree);
    ok("an uncommitted edit stops the run", dirty.code !== 0, "exit " + dirty.code);
    ok("and is reported as such", /FAIL the working copy is the committed state/.test(dirty.out), dirty.out.trim().split("\n").slice(-2).join(" / "));
    ok("naming the file that was edited", dirty.out.includes("tests/present/index.mjs"), "");
    ok("refusing, with the same wording a failed pack gets", /refusing to build installers: the working copy has uncommitted changes/.test(dirty.out), "");

    const allowed = gate(tree, ["--dry-run", "--allow-dirty"]);
    ok("--allow-dirty is the documented way past it", allowed.code === 0 && /allowed by --allow-dirty/.test(allowed.out), "exit " + allowed.code);
  }
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}

// A source tarball with no history is not a reason to refuse: the gate is run from
// checkouts that are not repositories at all.
const loose = scratchProject({ missing: false });
try {
  const run = gate(loose);
  ok("a tree that is not a git repository does not fail the dirty check", run.code === 0 && /ok   the working copy is the committed state/.test(run.out), "exit " + run.code);
  ok("and it says how it knows, rather than pretending to have checked", /not a git repository, so there is nothing to compare/.test(run.out), "");
} finally {
  fs.rmSync(loose, { recursive: true, force: true });
}

/* ---- the feeds a release publishes --------------------------------------- */

// What a client reads after the release is public, checked as the pair it is: the channel file
// and the artifact it names. The failures below are the ones that fail *silently* on an installed
// client, which is why they are asserted here rather than left to a job log.

const config = {
  win: { target: [{ target: "nsis", arch: ["x64", "arm64"] }, { target: "portable", arch: ["x64"] }] },
  mac: { target: [{ target: "zip", arch: ["x64", "arm64"] }] },
  linux: { target: [{ target: "AppImage", arch: ["x64", "arm64"] }, { target: "deb", arch: ["x64"] }] },
};
ok(
  "the app's own build config decides which feeds a release needs",
  requiredFeeds(config).join(",") === "latest.yml,latest-mac.yml,latest-linux.yml,latest-linux-arm64.yml",
  requiredFeeds(config).join(","),
);
const armOnly = { linux: { target: [{ target: "AppImage", arch: ["arm64"] }] } };
ok("an arm64-only Linux target needs only the arm64 feed", requiredFeeds(armOnly).join(",") === "latest-linux-arm64.yml", requiredFeeds(armOnly).join(","));
ok(
  "Windows and macOS need one feed each, whatever architectures they build",
  requiredFeeds({ win: { target: [{ target: "nsis", arch: ["x64", "arm64"] }] }, mac: { target: [{ target: "dmg", arch: ["arm64"] }] } }).join(",") === "latest.yml,latest-mac.yml",
);
ok("a config that ships no platform needs no feed", requiredFeeds({}).length === 0, JSON.stringify(requiredFeeds({})));

const wrote = readFeed("version: 0.3.5\nfiles:\n  - url: Hypercord-0.3.5-win-x64-setup.exe\n    sha512: abc\n    size: 12\npath: Hypercord-0.3.5-win-x64-setup.exe\n");
ok(
  "a feed is read as the version, the files and the path a client follows",
  wrote.version === "0.3.5" && wrote.urls.join(",") === "Hypercord-0.3.5-win-x64-setup.exe" && wrote.path === "Hypercord-0.3.5-win-x64-setup.exe",
  JSON.stringify(wrote),
);

const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-feed-"));
try {
  const write = (name, text) => fs.writeFileSync(path.join(feedDir, name), text);
  const installer = "Hypercord-0.3.5-win-x64-setup.exe";
  fs.writeFileSync(path.join(feedDir, installer), "x");
  write("latest.yml", "version: 0.3.5\nfiles:\n  - url: " + installer + "\n    sha512: abc\npath: " + installer + "\n");
  ok("a feed whose artifact is right there has no problem at all", feedProblems(feedDir, { expectedVersion: "0.3.5" }).length === 0, JSON.stringify(feedProblems(feedDir, { expectedVersion: "0.3.5" })));
  const drifted = feedProblems(feedDir, { expectedVersion: "0.4.0" });
  ok("and a feed whose version drifted from the app is a problem", drifted.some((line) => /says version 0.3.5 while the app is 0.4.0/.test(line)), JSON.stringify(drifted));

  fs.rmSync(path.join(feedDir, installer));
  const missing = feedProblems(feedDir, { expectedVersion: "0.3.5" });
  ok("a feed naming an artifact that is not in the release is a problem, in words", missing.length === 1 && missing[0].includes(installer) && /not in this release/.test(missing[0]), JSON.stringify(missing));

  fs.writeFileSync(path.join(feedDir, installer), "x");
  // the historical arm64 bug, exactly: the AppImage *was* built and shipped, and the feed every
  // arm64 install asks for by name was not. The artifact is what makes the absence a problem.
  const armAppImage = "Hypercord-0.3.5-linux-arm64.AppImage";
  fs.writeFileSync(path.join(feedDir, armAppImage), "x");
  const arm = feedProblems(feedDir, { expectedVersion: "0.3.5", require: ["latest-linux-arm64.yml"] });
  ok("a feed the app ships, for a platform that built, and the release does not carry is reported by name", arm.length === 1 && /latest-linux-arm64[.]yml is missing/.test(arm[0]), JSON.stringify(arm));
  ok("and it is not a gap: the platform built, so this is the silent-update failure", missingPlatformFeeds(feedDir, ["latest-linux-arm64.yml"]).length === 0, JSON.stringify(missingPlatformFeeds(feedDir, ["latest-linux-arm64.yml"])));
  fs.rmSync(path.join(feedDir, armAppImage));

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-feed-empty-"));
  try {
    const none = feedProblems(empty, {});
    ok("a directory with no feed and no artifact says so instead of passing", none.length === 1 && /no update feed/.test(none[0]), JSON.stringify(none));
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(feedDir, { recursive: true, force: true });
}

// A platform that built nothing. Its feed is absent for a reason the run already reports through
// that platform's own failed job, and refusing here is how a release page once carried nothing at
// all - not even the artifacts that had built cleanly - while the run's own summary said so.
const needs = ["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml"];
const partial = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-feed-partial-"));
try {
  const linuxInstaller = "Hypercord-0.3.5-linux-x86_64.AppImage";
  const linuxArm = "Hypercord-0.3.5-linux-arm64.AppImage";
  fs.writeFileSync(path.join(partial, linuxInstaller), "x");
  fs.writeFileSync(path.join(partial, linuxArm), "x");
  fs.writeFileSync(path.join(partial, "latest-linux.yml"), "version: 0.3.5\nfiles:\n  - url: " + linuxInstaller + "\n    sha512: abc\npath: " + linuxInstaller + "\n");
  // the linux build's other half, so the only feeds missing here are the two platforms that built
  // nothing - the arm64 feed is required the moment any linux artifact is present
  fs.writeFileSync(path.join(partial, "latest-linux-arm64.yml"), "version: 0.3.5\nfiles:\n  - url: " + linuxArm + "\n    sha512: abc\npath: " + linuxArm + "\n");
  ok(
    "a platform that built nothing does not stop the release that did build",
    feedProblems(partial, { expectedVersion: "0.3.5", require: needs }).length === 0,
    JSON.stringify(feedProblems(partial, { expectedVersion: "0.3.5", require: needs })),
  );
  ok(
    "and its missing feed is named as a gap, not as a problem",
    missingPlatformFeeds(partial, needs).join(",") === "latest.yml,latest-mac.yml",
    JSON.stringify(missingPlatformFeeds(partial, needs)),
  );
  // the moment that platform's installer is here, its own missing feed is the failure again
  fs.writeFileSync(path.join(partial, "Hypercord-0.3.5-win-x64-setup.exe"), "x");
  const strict = feedProblems(partial, { expectedVersion: "0.3.5", require: needs });
  ok("once a platform's installer is here, its missing feed is a problem again", strict.some((line) => /^latest[.]yml is missing/.test(line)), JSON.stringify(strict));
  ok("while the platform that still built nothing stays a gap", missingPlatformFeeds(partial, needs).join(",") === "latest-mac.yml", JSON.stringify(missingPlatformFeeds(partial, needs)));
} finally {
  fs.rmSync(partial, { recursive: true, force: true });
}

const apkOnly = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-feed-apk-"));
try {
  fs.writeFileSync(path.join(apkOnly, "Hypercord-Manager.apk"), "x");
  fs.writeFileSync(path.join(apkOnly, "Hypercord-Loader.apk"), "x");
  ok(
    "an APK-only release publishes what built instead of refusing: the release page carrying no APK is the failure this prevents",
    feedProblems(apkOnly, { expectedVersion: "0.3.5", require: needs }).length === 0,
    JSON.stringify(feedProblems(apkOnly, { expectedVersion: "0.3.5", require: needs })),
  );
  ok("with every desktop feed it never built named as a gap", missingPlatformFeeds(apkOnly, needs).join(",") === needs.join(","), JSON.stringify(missingPlatformFeeds(apkOnly, needs)));
} finally {
  fs.rmSync(apkOnly, { recursive: true, force: true });
}

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
