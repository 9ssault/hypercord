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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { artifactsIn, commandLine, isStale, newestInput, plan } from "../../scripts/release.mjs";

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

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
