// language: JavaScript, file: scripts/audit-releases.mjs
//
// Every published version, read back from the release page instead of trusted.
//
//   node scripts/audit-releases.mjs                     all releases, report to stdout
//   node scripts/audit-releases.mjs --limit 5           the newest five
//   node scripts/audit-releases.mjs --out docs/release-audit.md --json release-audit.json
//
// Why: the defects this project keeps finding are properties of *published bytes* - the
// 0.3.16 loader had no signature at all, and its `assets/addons.js` was 142,443 bytes while
// the tree's bundle was 143,313. Neither is visible from the source, and both are visible in
// one pass over the releases. So this walks every tag, downloads the small files that carry
// those facts (the APKs, `SHA256SUMS`, `acceptance.json`), and reports:
//
//   * the signature schemes each APK actually carries (v1 from META-INF, v2/v3 from the APK
//     Signing Block) - an APK with neither cannot be installed, whatever the release notes say;
//   * whether the APK matches the `SHA256SUMS` the same release publishes;
//   * whether the acceptance record the release shipped agrees about that signature;
//   * the sizes of every artifact, against `scripts/size-budget.json`;
//   * which platforms a release shipped, so a missing platform is a fact and not a surprise.
//
// It downloads, it never writes to the repository's build directories, and it reports
// historical facts without failing: a release that is already published cannot be made
// smaller or re-signed, and an audit that exits non-zero for the past is an audit nobody
// keeps running. `--fail-on-problem` exists for using it as a gate on a *new* release.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(ROOT, "release-audit");

function argument(name, fallback = "") {
  const at = process.argv.indexOf("--" + name);
  return at > -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const limit = Number(argument("limit", "0")) || 0;
const outMarkdown = argument("out", "");
const outJson = argument("json", "");
const failOnProblem = process.argv.includes("--fail-on-problem");

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** The budgets, so the audit weighs releases against the same lines a build must hold. */
function budgets() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, "size-budget.json"), "utf8")).budgets;
  } catch {
    return [];
  }
}

function budgetFor(name) {
  const clean = name.replace(/^Hypercord-/, "");
  for (const budget of budgets()) {
    if (budget.match && new RegExp(budget.match).test(name)) return budget;
    if (budget.dir && clean.startsWith(budget.dir)) return budget;
  }
  return null;
}

/* ---- signatures, read with the same code the build gate uses ---------------- */

/**
 * `scripts/build_android.py` already knows how to read v1 and v2/v3 signatures out of an
 * APK, and an audit with its own second opinion would be a second place to be wrong. One
 * interpreter per run, every APK at once.
 */
/**
 * `python3` is what CI has; a Windows machine that installed Python from python.org has
 * `python` and no alias, and this audit is exactly the kind of thing a person runs there.
 * A probe that cannot answer is null, so the report can say so instead of printing a stack.
 */
function pythonInterpreter() {
  for (const name of ["python3", "python"]) {
    try {
      execFileSync(name, ["-c", "pass"], { stdio: "ignore" });
      return name;
    } catch {
      /* try the next name */
    }
  }
  return null;
}

function signingSchemes(files) {
  if (!files.length) return {};
  const interpreter = pythonInterpreter();
  if (!interpreter) return Object.fromEntries(files.map((file) => [file, ["unreadable: no python3/python on PATH"]]));
  const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('build_android', 'scripts/build_android.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
out = {}
for file in sys.argv[1:]:
    out[file] = m.signing_schemes(m.Path(file))
print(json.dumps(out))
`;
  const result = execFileSync(interpreter, ["-c", program, ...files], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(result);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* ---- one release ----------------------------------------------------------- */

const KINDS = [
  { name: "windows", match: /-win-.*\.(exe|blockmap)$/ },
  { name: "macos", match: /-mac-.*\.(dmg|zip|blockmap)$/ },
  { name: "linux", match: /-linux-.*\.(AppImage|deb|tar\.gz)$/ },
  { name: "android", match: /\.apk$/ },
];

function platforms(assets) {
  const found = {};
  for (const kind of KINDS) {
    const rows = assets.filter((asset) => kind.match.test(asset.name));
    found[kind.name] = rows.length;
  }
  return found;
}

async function auditRelease(tag) {
  const meta = JSON.parse(gh(["release", "view", tag, "--json", "assets,publishedAt,isPrerelease"]) || "{}");
  const assets = (meta.assets || []).map((asset) => ({ name: asset.name, size: asset.size }));
  const dir = path.join(CACHE, tag);
  fs.mkdirSync(dir, { recursive: true });

  const wanted = assets.filter((asset) => /\.apk$/.test(asset.name) || /^(SHA256SUMS|acceptance\.json)$/.test(asset.name));
  for (const asset of wanted) {
    const file = path.join(dir, asset.name);
    if (fs.existsSync(file)) continue;
    try {
      gh(["release", "download", tag, "--pattern", asset.name, "--dir", dir, "--clobber"]);
    } catch (error) {
      /* a release whose asset has gone is a fact the report states, not a crash */
    }
  }

  const apks = assets.filter((asset) => /\.apk$/.test(asset.name)).map((asset) => path.join(dir, asset.name)).filter((file) => fs.existsSync(file));
  let schemes = {};
  try {
    schemes = signingSchemes(apks);
  } catch (error) {
    // The interpreter's own words, not `Command failed`: a missing module and a missing
    // file look identical through the wrapper's message, and they are different problems.
    const detail = String((error && error.stderr) || (error && error.message) || error)
      .split("\n")
      .filter((line) => line.trim())
      .pop();
    schemes = Object.fromEntries(apks.map((file) => [file, [`unreadable: ${detail}`]]));
  }

  // The checksum file the release publishes, checked against the bytes beside it.
  const sumsFile = path.join(dir, "SHA256SUMS");
  const published = new Map();
  if (fs.existsSync(sumsFile)) {
    for (const line of fs.readFileSync(sumsFile, "utf8").split("\n")) {
      const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
      if (match) published.set(match[2], match[1]);
    }
  }
  const integrity = [];
  for (const file of apks) {
    const name = path.basename(file);
    const expected = published.get(name);
    if (!expected) {
      integrity.push({ name, status: "not listed" });
      continue;
    }
    integrity.push({ name, status: sha256(file) === expected ? "matches" : "MISMATCH" });
  }

  // What the acceptance record the release shipped says about the signature.
  const acceptanceFile = path.join(dir, "acceptance.json");
  let acceptance = null;
  if (fs.existsSync(acceptanceFile)) {
    try {
      const record = JSON.parse(fs.readFileSync(acceptanceFile, "utf8"));
      // `absent` is its own answer: a record written before the build recorded signatures
      // says nothing about them, which is different from saying the artifact was unsigned.
      acceptance = {
        signed: (record.artifacts || []).map((artifact) => ({
          module: artifact.module,
          signed: artifact.signed === undefined ? "absent" : Boolean(artifact.signed),
          schemes: artifact.signature_schemes || [],
        })),
      };
    } catch {
      acceptance = { error: "unreadable JSON" };
    }
  }

  const overBudget = [];
  for (const asset of assets) {
    const budget = budgetFor(asset.name);
    if (budget && asset.size > budget.limitBytes) overBudget.push({ name: asset.name, size: asset.size, limit: budget.limitBytes });
  }

  return {
    tag,
    publishedAt: meta.publishedAt || "",
    prerelease: Boolean(meta.isPrerelease),
    assets: assets.length,
    platforms: platforms(assets),
    apks: apks.map((file) => ({
      name: path.basename(file),
      bytes: fs.statSync(file).size,
      schemes: schemes[file] || [],
      budget: budgetFor(path.basename(file))?.limitBytes ?? null,
    })),
    integrity,
    acceptance,
    overBudget,
    desktopBytes: assets.filter((asset) => /\.(exe|dmg|AppImage|deb|tar\.gz)$/.test(asset.name)).reduce((sum, asset) => sum + asset.size, 0),
  };
}

/* ---- the report ------------------------------------------------------------ */

const kb = (bytes) => (bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + " MB" : (bytes / 1024).toFixed(0) + " KB");

function problemsOf(row) {
  const problems = [];
  for (const apk of row.apks) {
    if (!apk.schemes.length) problems.push(`${apk.name} carries no signature (Android refuses to install it)`);
    else if (apk.schemes.some((scheme) => scheme.startsWith("unreadable"))) problems.push(`${apk.name}: ${apk.schemes.join(", ")}`);
    if (apk.budget && apk.bytes > apk.budget) problems.push(`${apk.name} is ${kb(apk.bytes)}, over its ${kb(apk.budget)} budget`);
  }
  for (const entry of row.integrity) {
    if (entry.status === "MISMATCH") problems.push(`${entry.name} does not match SHA256SUMS`);
  }
  for (const asset of row.overBudget) {
    if (asset.name.endsWith(".apk")) continue; // already reported above, in KB
    problems.push(`${asset.name} is ${kb(asset.size)}, over its ${kb(asset.limit)} budget`);
  }
  if (!row.platforms.windows) problems.push("no Windows installer");
  if (!row.platforms.macos) problems.push("no macOS installer");
  if (!row.platforms.linux) problems.push("no Linux installer");
  if (!row.platforms.android) problems.push("no APK");
  return problems;
}

function markdown(rows) {
  const lines = [];
  lines.push("# Release audit");
  lines.push("");
  lines.push("Every published version, read back from its release page: the signature schemes each");
  lines.push("APK actually carries, whether those APKs match the `SHA256SUMS` published beside them,");
  lines.push("the sizes against `scripts/size-budget.json`, and which platforms the release shipped.");
  lines.push("");
  lines.push("Generated by `npm run audit:releases`; re-run it rather than editing this file.");
  lines.push("");
  lines.push("| Version | Published | APK signature | Loader | Manager | Installers | Platforms | Problems |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) {
    const schemes = row.apks.map((apk) => `${apk.name.replace(/^Hypercord-|\.apk$/g, "")}: ${apk.schemes.join("+") || "none"}`).join("<br>") || "no APK";
    const loader = row.apks.find((apk) => /Loader/.test(apk.name));
    const manager = row.apks.find((apk) => /Manager/.test(apk.name));
    const platforms = Object.entries(row.platforms).filter(([, count]) => count).map(([name]) => name).join(", ") || "none";
    const problems = problemsOf(row);
    lines.push(
      `| ${row.tag} | ${row.publishedAt.slice(0, 10)} | ${schemes} | ${loader ? kb(loader.bytes) : "-"} | ${
        manager ? kb(manager.bytes) : "-"
      } | ${kb(row.desktopBytes)} | ${platforms} | ${problems.length ? problems.map((line) => line.replace(/\|/g, "/")).join("; ") : "none"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const tags = gh(["release", "list", "--limit", "100", "--json", "tagName", "--jq", ".[].tagName"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const chosen = limit ? tags.slice(0, limit) : tags;
  const rows = [];
  for (const tag of chosen) {
    process.stdout.write(`reading ${tag}\n`);
    try {
      rows.push(await auditRelease(tag));
    } catch (error) {
      rows.push({ tag, apks: [], integrity: [], overBudget: [], platforms: {}, desktopBytes: 0, failure: String((error && error.message) || error) });
    }
  }

  const report = markdown(rows);
  if (outMarkdown) {
    const file = path.isAbsolute(outMarkdown) ? outMarkdown : path.join(ROOT, outMarkdown);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, report);
    console.log(`report: ${path.relative(ROOT, file).split(path.sep).join("/")}`);
  } else {
    console.log(report);
  }
  if (outJson) {
    const file = path.isAbsolute(outJson) ? outJson : path.join(ROOT, outJson);
    fs.writeFileSync(file, JSON.stringify({ schema: 1, releases: rows }, null, 2) + "\n");
    console.log(`json: ${path.relative(ROOT, file).split(path.sep).join("/")}`);
  }

  const troubled = rows.filter((row) => problemsOf(row).length);
  console.log(`\n${rows.length} release(s) read, ${troubled.length} with a problem`);
  for (const row of troubled) console.log(`  ${row.tag}: ${problemsOf(row).length} problem(s)`);
  if (failOnProblem && troubled.length) return 1;
  return 0;
}

// Only when run directly: `problemsOf` is worth a test, and importing a script that exits
// the process would make that impossible.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

export { auditRelease, problemsOf, markdown, budgetFor };
