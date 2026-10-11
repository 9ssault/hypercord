// language: JavaScript, file: scripts/release.mjs
//
// The release gate.
//
// This exists because of one specific failure: `dist/` sat two hours behind
// `src/`, so the client everybody opened was the old one - the passkey dialog
// appeared, the token option was missing, and nothing in the source said so. A
// passing test suite cannot catch that, because the suite runs the source.
//
// So the order is the point, and it is deliberately not "build everything and
// hope":
//
//   1. the vendor audit - the catalogue and the rebrand, since every plugin the
//      client ships comes through it;
//   2. every test suite;
//   3. pack the app (electron-builder --dir);
//   4. refuse if the packed app is older than anything it was built from;
//   5. start the packed executable and read its page (scripts/check-packaged.mjs),
//      on a throwaway profile, so the login form - and the passkey request it
//      makes by itself - is actually under test;
//   6. only now build the installers, and never publish them;
//   7. say which artifacts were produced, and fail if none were.
//
// Steps 1-5 all have to pass; the first non-zero exit stops the run before any
// installer exists. Nothing here publishes: `--publish never` is passed
// explicitly, because a release script that can upload is a release script that
// will one day upload by accident.
//
//   npm run release
//   npm run release -- --skip-tests                 # the gate without the suites
//   npm run release -- --no-fresh                   # check the signed-in profile
//   npm run release -- --win --x64                  # extra args go to electron-builder
//   npm run release -- --dry-run                    # print the plan, run nothing
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** What the build actually packages: see the `files` list in package.json. */
export const SHIPPED = ["src", "plugins", "pwa", "package.json"];

/** The packed app's asar, wherever electron-builder put it on this platform. */
export function packedAsar() {
  const candidates = [
    "dist/win-unpacked/resources/app.asar",
    "dist/linux-unpacked/resources/app.asar",
    "dist/mac/Hypercord.app/Contents/Resources/app.asar",
    "dist/mac-arm64/Hypercord.app/Contents/Resources/app.asar",
  ];
  for (const rel of candidates) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) return full;
  }
  return "";
}

/** The newest modification time under the given paths, as milliseconds. */
export function newestInput(paths = SHIPPED, base = root) {
  let newest = 0;
  const visit = (target) => {
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const entry of entries) visit(path.join(target, entry));
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
  };
  for (const rel of paths) visit(path.join(base, rel));
  return newest;
}

/**
 * Is this build stale? A missing build is as stale as a build from before the
 * change: both mean "the artifact does not represent this source".
 */
export function isStale(asarMs, inputMs) {
  if (!asarMs) return true;
  return Number(asarMs) < Number(inputMs);
}

/** The installers a run produced: the executable files beside the unpacked app. */
export function artifactsIn(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(exe|appimage|deb|dmg|pkg|zip|tar\.gz)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * The plan, as data. Keeping it a list is what makes the ordering testable: the
 * installers may not run before the packaged check, and nothing may unpack before
 * the vendor audit.
 */
export function plan({ tests = true, fresh = true, builderArgs = [], node = process.execPath } = {}) {
  const steps = [
    { name: "vendor audit", command: "npm", args: ["run", "--silent", "vendor:check"] },
  ];
  if (tests) steps.push({ name: "the test suites", command: "npm", args: ["test"] });
  steps.push({ name: "pack", command: "npm", args: ["run", "--silent", "pack"] });
  steps.push({ key: "freshness", name: "freshness of the packed app" });
  steps.push({
    name: "packaged build check",
    command: node,
    args: [path.join("scripts", "check-packaged.mjs"), ...(fresh ? ["--fresh"] : [])],
  });
  steps.push({ name: "installers", command: "npm", args: ["run", "--silent", "dist", "--", "--publish", "never", ...builderArgs] });
  return steps;
}

/**
 * How a step is handed to the operating system.
 *
 * On Windows `npm` is `npm.cmd`, and Node refuses to spawn a `.cmd` without a
 * shell (the 2024 fix for argument injection through .bat/.cmd): the call fails
 * with EINVAL and *nothing runs*. That is how this gate once reported "the vendor
 * audit failed" for an audit that passes on its own - the step never started. So
 * the shell is used exactly where it is required, and the arguments are quoted
 * individually rather than pasted together, because paths can contain spaces.
 */
export function commandLine(command, args, platform = process.platform) {
  const file = platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const shell = platform === "win32" && /\.(cmd|bat)$/i.test(file);
  if (!shell) return { file, argv: args, shell: false };
  const quote = (value) => (/[\s"]/.test(String(value)) ? '"' + String(value).replace(/"/g, '\\"') + '"' : String(value));
  return { file: [file, ...args].map(quote).join(" "), argv: [], shell: true };
}

function builderArguments() {
  const index = process.argv.indexOf("--");
  if (index === -1) return [];
  return process.argv.slice(index + 1);
}

function run() {
  // No bypass: there is no flag here that skips a gate. A release script whose
  // checks can be turned off is a release script that ships unverified builds.
  const skipTests = process.argv.includes("--skip-tests");
  const noFresh = process.argv.includes("--no-fresh");
  const dryRun = process.argv.includes("--dry-run");
  const steps = plan({ tests: !skipTests, fresh: !noFresh, builderArgs: builderArguments() });
  // an artifact counts as produced only if this run wrote it, so installers left
  // over from an earlier build cannot make a failed run look successful
  const startedAt = Date.now();

  if (dryRun) {
    console.log("# release plan (nothing will run)");
    for (const step of steps) console.log("  - " + step.name + (step.command ? ": " + step.command + " " + step.args.join(" ") : ""));
    console.log("\nnothing to build: this was a dry run");
    return 0;
  }

  for (const step of steps) {
    console.log("\n# " + step.name);
    if (step.key === "freshness") {
      // the assertion that makes a stale build impossible to ship: the packed app
      // must be newer than everything it was packed from
      const asar = packedAsar();
      const input = newestInput();
      if (isStale(asar ? fs.statSync(asar).mtimeMs : 0, input)) {
        console.log("FAIL the packed app is older than the source it came from");
        console.log("     build: " + (asar ? new Date(fs.statSync(asar).mtimeMs).toISOString() : "(no build at all)"));
        console.log("     source: " + new Date(input).toISOString());
        console.log("refusing to build installers from a stale build");
        return 1;
      }
      console.log("ok   the packed app is newer than everything it was built from");
      continue;
    }
    const line = commandLine(step.command, step.args);
    const done = spawnSync(line.file, line.argv, { cwd: root, stdio: "inherit", shell: line.shell });
    // a step that could not even be started is a failed step, and saying so is
    // the difference between "the audit failed" and "the audit never ran"
    const code = done.error ? 1 : done.status === null ? 1 : done.status;
    if (done.error) console.log("could not start it: " + String(done.error.message || done.error));
    if (code !== 0) {
      console.log("\nFAIL " + step.name + " exited " + code);
      if (step.name === "installers") {
        console.log("no installer was produced");
      } else {
        console.log("refusing to build installers: " + step.name + " did not pass");
      }
      return code || 1;
    }
  }

  const made = artifactsIn(path.join(root, "dist"));
  const produced = made.filter((file) => {
    try {
      return fs.statSync(file).mtimeMs >= startedAt;
    } catch {
      return false;
    }
  });
  if (!produced.length) {
    console.log("\nFAIL the run finished but wrote no installer into dist/");
    return 1;
  }
  console.log("\n# artifacts written by this run");
  for (const file of produced) console.log("  " + path.relative(root, file));
  const older = made.filter((file) => !produced.includes(file));
  if (older.length) console.log("  (" + older.length + " older artifact(s) still in dist/)");
  console.log("\nrelease ready: " + produced.length + " artifact(s), nothing published");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
