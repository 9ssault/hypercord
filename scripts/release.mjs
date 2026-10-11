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
//   0. preflight - is the tree a coherent one at all? Every test the suite names
//      exists, and the working copy is the committed state this build will be said
//      to represent. A half-written tree produced a half-built release once: a test
//      file was gone, the suite could not run, and the run built anyway;
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
//   npm run release -- --allow-dirty                # build a tree with uncommitted
//                                                   # edits, for testing on purpose
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

/* ---- preflight: is the tree a coherent one at all? ----------------------- */

/**
 * The test files the suite names, read from the `test:units` script in
 * package.json. That script *is* the definition of the suite, so a file it names
 * and the tree does not have is a suite that cannot run - which means a release
 * that tested less than it says it did.
 */
export function namedTestFiles(dir = root) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const script = String((pkg && pkg.scripts && pkg.scripts["test:units"]) || "");
  return [...new Set(script.match(/tests\/[\w./-]+\.mjs/g) || [])];
}

/** The named tests that are not there - all of them, not just the first. */
export function missingTestFiles(dir = root) {
  return namedTestFiles(dir).filter((rel) => !fs.existsSync(path.join(dir, rel)));
}

/**
 * The tracked files git reports as changed.
 *
 * Untracked files are left out on purpose: `dist/` is build output, it is ignored,
 * and a gate that refuses because of its own output is a gate nobody keeps running.
 * Not being a repository at all is not a failure either - the gate has to be usable
 * from a source tarball with no history in it.
 */
export function dirtyFiles(dir = root) {
  const done = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: dir, encoding: "utf8" });
  if (done.error || done.status !== 0) return { ok: false, files: [], reason: String((done.error && done.error.message) || "git did not answer") };
  const files = String(done.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, ""));
  return { ok: true, files, reason: "" };
}

/**
 * The checks that run before anything is built.
 *
 * Two facts decide whether this run may exist at all: every test the suite names
 * is present, and the working copy is the committed state the artifact will be
 * said to represent. `allowDirty` is the one documented way past the second, for a
 * tree being tested on purpose; the first cannot be bypassed - a named test that
 * does not exist is always a reason to refuse.
 */
export function preflight({ dir = root, allowDirty = false } = {}) {
  const lines = [];
  const refusals = [];

  const named = namedTestFiles(dir);
  const missing = missingTestFiles(dir);
  if (missing.length) {
    lines.push({ ok: false, text: "every test file the suite names exists", detail: "missing: " + missing.join(", ") });
    refusals.push("the suite names " + missing.length + " test file(s) that do not exist: " + missing.join(", "));
  } else {
    lines.push({ ok: true, text: "every test file the suite names exists", detail: named.length + " file(s)" });
  }

  const git = dirtyFiles(dir);
  if (!git.ok) {
    lines.push({ ok: true, text: "the working copy is the committed state", detail: "not a git repository, so there is nothing to compare" });
  } else if (!git.files.length) {
    lines.push({ ok: true, text: "the working copy is the committed state", detail: "no tracked file is modified" });
  } else {
    const shown = git.files.slice(0, 5).join(", ") + (git.files.length > 5 ? " (+" + (git.files.length - 5) + " more)" : "");
    lines.push({ ok: allowDirty, text: "the working copy is the committed state", detail: "modified: " + shown + (allowDirty ? " (allowed by --allow-dirty)" : "") });
    if (!allowDirty) refusals.push("the working copy has uncommitted changes: " + shown);
  }

  return { ok: refusals.length === 0, lines, refusals };
}

function builderArguments() {
  const index = process.argv.indexOf("--");
  if (index === -1) return [];
  return process.argv.slice(index + 1);
}

function run() {
  // The flags narrow the run; none of them waves a check away. --skip-tests drops
  // the suites (for iterating on the build steps themselves), --allow-dirty accepts
  // a working copy with uncommitted edits, and everything the artifact is judged by
  // - preflight's test inventory, freshness, the packaged check, the installers -
  // runs either way.
  const skipTests = process.argv.includes("--skip-tests");
  const noFresh = process.argv.includes("--no-fresh");
  const dryRun = process.argv.includes("--dry-run");
  const steps = plan({ tests: !skipTests, fresh: !noFresh, builderArgs: builderArguments() });
  // an artifact counts as produced only if this run wrote it, so installers left
  // over from an earlier build cannot make a failed run look successful
  const startedAt = Date.now();

  // Nothing is built until the tree is coherent: a test the suite names but the
  // tree does not have, or edits nobody committed, is how a half-built release
  // happened before. This runs before the dry run too, because "would this build?"
  // is the same question.
  const allowDirty = process.argv.includes("--allow-dirty");
  console.log("\n# preflight");
  const ready = preflight({ allowDirty });
  for (const line of ready.lines) console.log((line.ok ? "ok   " : "FAIL ") + line.text + (line.detail ? " | " + line.detail : ""));
  if (!ready.ok) {
    console.log("\nrefusing to build installers: " + ready.refusals.join("; "));
    return 1;
  }

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
