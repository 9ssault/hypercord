// language: JavaScript, file: scripts/check-size.mjs
//
// A release that grows quietly is how a "lightweight" client stops being one.
//
//   node scripts/check-size.mjs                 measure what is built, fail over budget
//   node scripts/check-size.mjs --output p.json  ... and write the measurement down
//   node scripts/check-size.mjs --root .        where to look (default: this tree)
//
// The budgets are in `scripts/size-budget.json`, next to the reasons for each number, so a
// limit can be argued with instead of discovered. This script only measures: it never
// invents a size for an artifact that is not there. An artifact that was not built in this
// tree is reported as such - a `check:size` on a fresh clone must not fail for a file the
// clone was never going to have - while an artifact that *is* there and is over its budget
// fails the run, which is the difference between "not measured" and "measured and fat".
//
// Why bytes and not a percentage: the numbers here are dominated by two things nobody edits
// by accident (Electron, and the vendored runtime bundle), so the useful question is "did
// this release cross a line" rather than "did this diff add 0.4%".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function argument(name, fallback = "") {
  const at = process.argv.indexOf("--" + name);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const root = path.resolve(argument("root", ROOT));
const output = argument("output", "");

/** The budget file, read from this script's directory so `--root` cannot misplace it. */
function budgets() {
  const file = path.join(HERE, "size-budget.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.budgets) || parsed.budgets.length === 0) {
    throw new Error(`${file} has no budgets`);
  }
  for (const budget of parsed.budgets) {
    if (!budget.name || typeof budget.limitBytes !== "number" || budget.limitBytes <= 0) {
      throw new Error(`${file}: a budget needs a name and a positive limitBytes (${JSON.stringify(budget)})`);
    }
    if (!budget.match && !budget.dir) {
      throw new Error(`${file}: "${budget.name}" names neither a match pattern nor a dir`);
    }
  }
  return { budgets: parsed.budgets, searched: parsed.searched || ["release", "dist"] };
}

/**
 * Bytes under a path, following directories and ignoring symlinks.
 *
 * Recursive and functional on purpose: an accumulator shared with the recursion counts a
 * subtree once per level it is nested under (a 325 MB unpacked app measured 1.2 GB the first
 * time this was written), and a size check that over-reports by 4x fails the builds that are
 * fine.
 */
export function sizeOf(target) {
  const walk = (file) => {
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return 0;
    }
    if (stat.isSymbolicLink()) return 0;
    if (stat.isDirectory()) {
      return fs.readdirSync(file).reduce((sum, row) => sum + walk(path.join(file, row)), 0);
    }
    return stat.size;
  };
  return walk(target);
}

/** Files in the searched directories, one level deep (the packaging output is flat). */
function candidates(dir) {
  const found = [];
  const walk = (at, depth) => {
    let rows;
    try {
      rows = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const row of rows) {
      const full = path.join(at, row.name);
      if (row.isDirectory()) {
        if (depth < 2) walk(full, depth + 1);
        continue;
      }
      if (row.isFile()) found.push(full);
    }
  };
  walk(dir, 0);
  return found;
}

/**
 * One measurement per artifact, never per budget: two architectures of the same installer
 * are two files with two sizes, and adding them together would let a 99 MB setup pass a
 * 200 MB limit while the release page carries 198 MB of them. Each matched file (or each
 * named directory) is its own row, and one over-budget row fails the run.
 */
export function measure(budgetList, searched) {
  const rows = [];
  for (const budget of budgetList) {
    if (budget.dir) {
      // The directory is named relative to the tree *and* relative to each searched
      // directory, because packaging writes `dist/win-unpacked` while the budget only wants
      // to say `win-unpacked`.
      const found = [budget.dir, ...searched.map((dir) => path.join(dir, budget.dir))]
        .map((rel) => path.join(root, rel))
        .filter((full) => {
          try {
            return fs.statSync(full).isDirectory();
          } catch {
            return false;
          }
        });
      for (const dir of found) {
        rows.push({
          name: budget.name,
          file: path.relative(root, dir).split(path.sep).join("/"),
          bytes: sizeOf(dir),
          limitBytes: budget.limitBytes,
          why: budget.why || "",
        });
      }
      if (!found.length) rows.push({ name: budget.name, file: "", bytes: 0, limitBytes: budget.limitBytes, missing: true });
      continue;
    }
    const pattern = new RegExp(budget.match);
    let any = false;
    for (const dir of searched) {
      for (const file of candidates(path.join(root, dir))) {
        if (!pattern.test(path.basename(file))) continue;
        any = true;
        rows.push({
          name: budget.name,
          file: path.relative(root, file).split(path.sep).join("/"),
          bytes: sizeOf(file),
          limitBytes: budget.limitBytes,
          why: budget.why || "",
        });
      }
    }
    if (!any) rows.push({ name: budget.name, file: "", bytes: 0, limitBytes: budget.limitBytes, missing: true });
  }
  return rows;
}

const kb = (bytes) => (bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + " MB" : (bytes / 1024).toFixed(0) + " KB");

function main() {
  let config;
  try {
    config = budgets();
  } catch (error) {
    console.log("FAIL " + String((error && error.message) || error));
    return 1;
  }
  const rows = measure(config.budgets, config.searched);
  const measured = rows.filter((row) => !row.missing);
  const over = measured.filter((row) => row.bytes > row.limitBytes);

  for (const row of rows) {
    if (row.missing) {
      console.log(`  --   ${row.name}: not built in this tree, so not measured`);
      continue;
    }
    const verdict = row.bytes > row.limitBytes ? "FAIL" : "ok  ";
    const percent = Math.round((row.bytes / row.limitBytes) * 100);
    console.log(`${verdict}  ${row.name}: ${kb(row.bytes)} of ${kb(row.limitBytes)} (${percent}%)  ${row.file}`);
  }

  if (output) {
    const file = path.isAbsolute(output) ? output : path.join(root, output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          schema: 1,
          measured_at: new Date().toISOString(),
          ok: over.length === 0,
          artifacts: rows.map((row) => ({
            name: row.name,
            file: row.file || null,
            measured: !row.missing,
            bytes: row.missing ? null : row.bytes,
            limit_bytes: row.limitBytes,
            over: !row.missing && row.bytes > row.limitBytes,
            why: row.why,
          })),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`measured: ${path.relative(root, file).split(path.sep).join("/")}`);
  }

  if (measured.length === 0) {
    console.log("\nno artifact of this tree was built here, so nothing was measured");
    return 0;
  }
  if (over.length) {
    console.log(`\n${over.length} artifact(s) over budget`);
    return 1;
  }
  console.log(`\n${measured.length} artifact(s) within budget`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

export { main, budgets };
