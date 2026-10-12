// language: JavaScript, file: scripts/build_addons.mjs
//
// The generator for `android/loader/src/main/assets/addons.js` - the JavaScript half of
// the phone client, packed into the one asset the loader injects. Nothing produced it
// before this file, which is why an APK built from this tree loaded no addons at all:
// the loader had an asset to inject and the asset was not in the tree.
//
// It is a bundler, deliberately a small one, because of what the bundle is for. The
// output is evaluated inside Discord's runtime by the patched loader, which has no
// module loader, no filesystem and no `require`. So the bundle is one classic script:
// every module the entry reaches becomes a factory, a nine-line registry links them,
// and nothing that needs a host survives into the output - a static `import`, a dynamic
// `import()` or a `node:` specifier stops this script with the module and line instead
// of shipping a bundle that throws on the device.
//
// Reachability, not a directory listing: it walks relative imports from `core/index.js`.
// That is the phone client's whole module graph (`core/`, `utils/`, `plugins/index.js`
// with `plugins/sandbox.js`, `themes/index.js`) and it deliberately does not sweep in
// `plugins/hyper/**` or `plugins/examples/**` - those are the desktop plugin host's
// modules, not the phone runtime's, and bundling them would ship dead weight.
//
// Usage: node scripts/build_addons.mjs [--check] [--force]
//   --check  verify the committed asset is current, exit non-zero if it is stale
//   --force  replace a file this script did not write
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "core/index.js";
const OUT = path.join(ROOT, "android", "loader", "src", "main", "assets", "addons.js");

// The loader refuses an asset over 16 MiB (its asset rules, pinned by
// tests/loader-assets.test.mjs), so a bundle that crosses it fails here, at build
// time, rather than being rejected after an APK has been assembled.
const LIMIT = 16 * 1024 * 1024;

const PLACEHOLDER_MARK = "HYPERCORD-ADDONS-PLACEHOLDER";
const GENERATED_MARK = "HYPERCORD-ADDONS-BUNDLE";

const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

function fail(file, line, why, text) {
  throw new Error(`${rel(file)}:${line} ${why}${text ? `\n    ${text.trim()}` : ""}`);
}

/* ---- reaching the modules ------------------------------------------------ */

/** The relative specifiers one module pulls in. Anything not relative is refused. */
function specifiersOf(source, file) {
  const found = [];
  source.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("import") && !trimmed.startsWith("export")) return;
    const from = /^\s*(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/.exec(line);
    const bare = /^\s*import\s*["']([^"']+)["']/.exec(line);
    const spec = (from && from[1]) || (bare && bare[1]) || "";
    if (!spec) {
      if (/^\s*import\s*\(/.test(line)) fail(file, index + 1, "a dynamic import() has no loader on the device", line);
      return; // `export { a, b };` - no specifier, handled by the transform
    }
    if (!spec.startsWith(".")) fail(file, index + 1, `"${spec}" is not relative - the device has no module resolution`, line);
    found.push({ spec, line: index + 1 });
  });
  return found;
}

function resolveSpecifier(spec, fromFile) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  fail(fromFile, 1, `cannot resolve "${spec}"`, `tried ${rel(base)}, .js, .mjs, /index.js`);
}

/** Depth-first, dependencies first, so a factory is defined before it is required. */
function collect(entry = ENTRY) {
  const entryFile = path.join(ROOT, entry);
  if (!fs.existsSync(entryFile)) fail(entryFile, 1, "the bundle entry is missing", "");
  const order = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const { spec } of specifiersOf(source, file)) visit(resolveSpecifier(spec, file));
    order.push({ file, id: rel(file), source });
  };
  visit(entryFile);
  return order;
}

/* ---- one ESM module into one factory ------------------------------------- */

/**
 * Split a module into what runs first (the requires), the body, and the exports, and
 * append the exports at the end - never before - because `const` does not hoist and an
 * export registered early would hand the host `undefined`.
 *
 * Line-anchored on purpose: "import" and "export" appear inside strings in this tree
 * (the sandbox explains that an addon cannot import anything), and a transform that
 * matched mid-line would corrupt exactly the code that states the rule.
 */
function transform(module) {
  const exported = new Set();
  // What `export default` handed out, if anything. Two shapes reach here - a named
  // function (whose own name is the value) and any other expression, which is bound to
  // a const so a multi-line object literal still terminates correctly - so the tail
  // records the expression rather than a flag, and can never reference a binding the
  // other branch never created.
  let defaultExpr = "";
  const lines = [];

  module.source.split("\n").forEach((line) => {
    const trimmed = line.trim();
    let match;

    // --- imports ----------------------------------------------------------
    match = /^(\s*)import\s+(\w+)\s*,\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?\s*$/.exec(line);
    if (match) {
      lines.push(`${match[1]}const ${match[2]} = __require(${JSON.stringify(match[4])}).default;`);
      lines.push(`${match[1]}const {${match[3]}} = __require(${JSON.stringify(match[4])});`);
      return;
    }
    match = /^(\s*)import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?\s*$/.exec(line);
    if (match) {
      lines.push(`${match[1]}const {${match[2]}} = __require(${JSON.stringify(match[3])});`);
      return;
    }
    match = /^(\s*)import\s+\*\s+as\s+(\w+)\s+from\s*["']([^"']+)["'];?\s*$/.exec(line);
    if (match) {
      lines.push(`${match[1]}const ${match[2]} = __require(${JSON.stringify(match[3])});`);
      return;
    }
    match = /^(\s*)import\s+(\w+)\s+from\s*["']([^"']+)["'];?\s*$/.exec(line);
    if (match) {
      lines.push(`${match[1]}const ${match[2]} = __require(${JSON.stringify(match[3])}).default;`);
      return;
    }
    match = /^(\s*)import\s*["']([^"']+)["'];?\s*$/.exec(line);
    if (match) {
      lines.push(`${match[1]}__require(${JSON.stringify(match[2])});`);
      return;
    }

    // --- exports ----------------------------------------------------------
    match = /^(\s*)export\s+default\s+function\s+(\w+)\s*\(/.exec(line);
    if (match) {
      exported.add(match[2]);
      defaultExpr = match[2];
      lines.push(line.replace(/^(\s*)export\s+default\s+/, "$1"));
      return;
    }
    if (/^\s*export\s+default\s+/.test(line)) {
      defaultExpr = "__defaultExport";
      lines.push(line.replace(/^(\s*)export\s+default\s+/, "$1const __defaultExport = "));
      return;
    }
    match = /^(\s*)export\s+(?:async\s+)?function\s+(\w+)/.exec(line);
    if (match) {
      exported.add(match[2]);
      lines.push(line.replace(/^(\s*)export\s+/, "$1"));
      return;
    }
    match = /^(\s*)export\s+class\s+(\w+)/.exec(line);
    if (match) {
      exported.add(match[2]);
      lines.push(line.replace(/^(\s*)export\s+/, "$1"));
      return;
    }
    match = /^(\s*)export\s+(?:const|let|var)\s+([^=;]+)=/.exec(line);
    if (match) {
      for (const part of match[2].split(",")) {
        const name = part.trim().split(/[\s:]/)[0];
        if (name) exported.add(name);
      }
      lines.push(line.replace(/^(\s*)export\s+/, "$1"));
      return;
    }
    match = /^(\s*)export\s*\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?;?\s*$/.exec(line);
    if (match) {
      const pairs = match[2]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [local, alias] = part.split(/\s+as\s+/).map((one) => one.trim());
          return { local, name: alias || local };
        });
      if (match[3]) {
        lines.push(`${match[1]}const {${pairs.map((one) => one.local).join(", ")}} = __require(${JSON.stringify(match[3])});`);
      }
      for (const one of pairs) lines.push(`${match[1]}__export(${JSON.stringify(one.name)}, ${one.local});`);
      return;
    }
    if (/^\s*export\b/.test(line)) fail(module.file, 1, "an export form this bundler does not know", line);
    lines.push(line);
  });

  const tail = [...exported].map((name) => `__export(${JSON.stringify(name)}, ${name});`);
  if (defaultExpr) tail.push(`__default(${defaultExpr});`);
  return [
    `__modules[${JSON.stringify(module.id)}] = function (__exports, __require) {`,
    "  var __export = function (name, value) { __exports[name] = value; };",
    "  var __default = function (value) { __exports.default = value; };",
    ...lines,
    ...tail.map((line) => `  ${line}`),
    "};",
    "",
  ].join("\n");
}

/* ---- the bundle ---------------------------------------------------------- */

function bundle(modules) {
  const header = [
    "// language: JavaScript, file: android/loader/src/main/assets/addons.js",
    `// ${GENERATED_MARK} - generated by scripts/build_addons.mjs. Do not edit by hand.`,
    "//",
    `// ${modules.length} module(s) reachable from ${ENTRY}, packed as one classic script for`,
    "// the patched loader: the device has no module loader, so each module is a factory",
    "// and the registry below is the only way in. `core/index.js` is the entry, and it is",
    "// what installs globalThis.__ASSAULT_ADDONS__ - the object the patched Discord",
    "// runtime calls for its Addons, Themes and Code runner settings pages.",
    "//",
    "// Regenerate with: npm run build:addons",
  ].join("\n");
  const registry = [
    "(function () {",
    '  "use strict";',
    "  var __modules = {};",
    "  var __cache = {};",
    "  function __require(id) {",
    "    if (__cache[id]) return __cache[id];",
    '    if (!__modules[id]) throw new Error("Hypercord addons: no such module " + id);',
    "    var exports = (__cache[id] = {});",
    "    __modules[id](exports, __require);",
    "    return exports;",
    "  }",
    "",
  ].join("\n");
  const entry = [
    "",
    `  var __entry = __require(${JSON.stringify(ENTRY)});`,
    "  if (!globalThis.__ASSAULT_ADDONS__ && __entry && __entry.default) {",
    "    globalThis.__ASSAULT_ADDONS__ = __entry.default;",
    "  }",
    "  globalThis.__hypercordAddonsBundle = true;",
    "})();",
    "",
  ].join("\n");
  return [header, "", registry, modules.map(transform).join("\n"), entry].join("\n");
}

/* ---- checks that run on the text about to be written ---------------------- */

function verify(code) {
  code.split("\n").forEach((line, index) => {
    if (/^\s*(?:import|export)\s/.test(line)) fail(OUT, index + 1, "an import/export survived the transform", line);
    if (/\bimport\s*\(/.test(line)) fail(OUT, index + 1, "a dynamic import() survived the transform", line);
    if (/"node:/.test(line)) fail(OUT, index + 1, "a node: builtin survived the transform", line);
  });
  try {
    new Function(code); // parses without running: the device evaluates this as a script
  } catch (err) {
    fail(OUT, 1, "the bundle does not parse as a script: " + String((err && err.message) || err), "");
  }
  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > LIMIT) fail(OUT, 1, `the bundle is ${bytes} bytes, over the loader's 16 MiB asset cap`, "");
  return bytes;
}

function main(argv = process.argv.slice(2)) {
  const modules = collect();
  const code = bundle(modules);
  const bytes = verify(code);
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  const ours = existing.includes(GENERATED_MARK) || existing.includes(PLACEHOLDER_MARK);
  if (existing && !ours && !argv.includes("--force")) {
    fail(OUT, 1, "the file exists and was not written by this script (pass --force to replace it)", "");
  }
  if (argv.includes("--check")) {
    const current = existing.includes(GENERATED_MARK) && existing === code;
    console.log((current ? "ok   " : "FAIL ") + `${rel(OUT)} is ${current ? "" : "not "}current`);
    return current ? 0 : 1;
  }
  fs.writeFileSync(OUT, code);
  console.log(`ok   ${rel(OUT)}: ${modules.length} module(s), ${bytes} bytes`);
  for (const module of modules) console.log("     " + module.id);
  return 0;
}

// Only when run directly: the helpers above are exported for a test to use without
// this being a script with side effects on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error("FAIL " + String((err && err.message) || err));
    process.exit(1);
  }
}

export { collect, transform, bundle, verify, main, ENTRY, OUT, LIMIT, PLACEHOLDER_MARK, GENERATED_MARK };
