// language: JavaScript, file: tests/support/toolchain.mjs
//
// Where the checks find the tools they are written against.
//
// The Android half of this repository is Java, and its checks compile and run Java: `javac`,
// `java`, and - for the signing check - `keytool`. The Android scripts are Python. CI has both
// on PATH, because the job installs a JDK and a Python first. A workstation usually does not
// have them *there*: Python from python.org installs `python` and no `python3` alias, and a JDK
// that came with an IDE lives inside it rather than on PATH. Naming the tool bare meant those
// checks died with `spawnSync javac ENOENT`, which is a fact about the machine and says nothing
// about the code - and a check that cannot run where people work is a check nobody runs. That
// is the same reasoning tests/manifest-resources.test.mjs already applies to `python3`.
//
// So every tool is looked for in the places it actually installs to, and each lookup ends in a
// refusal that names what is missing rather than in an empty string: a check here must never
// pass by not running, and must never fail with a message that hides the real reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Whether a bare name is runnable at all, which is the only thing PATH can tell us. */
function onPath(name) {
  const probe = spawnSync(name, ["-version"], { encoding: "utf8" });
  // `javac -version` writes to stdout, `java -version` to stderr, and both exit 0; a missing
  // name leaves `error` set (ENOENT) and, on Windows, occasionally a 9009 from a stub
  if (probe.error || probe.status !== 0) return false;
  return true;
}

/** Every JDK root worth looking inside, most explicit first. */
function javaRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.JAVA_HOME) roots.push(process.env.JAVA_HOME);
  if (process.env.JDK_HOME) roots.push(process.env.JDK_HOME);
  if (process.platform === "win32") {
    const programFiles = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["ProgramW6432"]].filter(Boolean);
    const local = process.env["LOCALAPPDATA"];
    for (const base of programFiles) {
      roots.push(
        ...[
          ["Java"],
          ["Eclipse Adoptium"],
          ["Microsoft"],
          ["Amazon Corretto"],
          ["Zulu"],
          ["BellSoft"],
          ["Android", "Android Studio", "jbr"],
          ["JetBrains"],
        ].map((parts) => path.join(base, ...parts)),
      );
    }
    if (local) {
      roots.push(path.join(local, "Programs", "Android Studio", "jbr"));
      roots.push(path.join(local, "Programs", "Eclipse Adoptium"));
    }
  } else {
    roots.push("/usr/lib/jvm", "/opt/java", "/opt/jdk", "/Library/Java/JavaVirtualMachines");
    const apple = spawnSync("/usr/libexec/java_home", [], { encoding: "utf8" });
    if (!apple.error && apple.status === 0) roots.push(String(apple.stdout || "").trim());
  }
  // the toolchain homes the Java-adjacent tooling keeps: an IDE's downloaded JDKs, Gradle's
  // provisioned ones, sdkman's, scoop's
  roots.push(path.join(home, ".jdks"), path.join(home, ".gradle", "jdks"), path.join(home, ".sdkman", "candidates", "java"));
  return roots.filter(Boolean);
}

/**
 * A tool inside a JDK root, at one of the three shapes a JDK is installed in.
 *
 * A root is either the JDK itself (`$JAVA_HOME/bin/javac`), a folder of versions beside each
 * other (`C:\Program Files\Java\jdk-21\bin\javac`, `~/.jdks/temurin-21/...`), an IDE's bundled
 * runtime one level deeper (`<root>/<version>/jbr/bin/javac`, which is how Android Studio's
 * ships), or a macOS bundle (`.../Contents/Home/bin/javac`).
 */
function findInJavaRoots(name) {
  const exe = process.platform === "win32" ? name + ".exe" : name;
  const binOf = (dir) => path.join(dir, "bin", exe);
  for (const root of javaRoots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const candidates = [root];
    for (const row of entries) {
      if (!row.isDirectory()) continue;
      candidates.push(path.join(root, row.name));
      candidates.push(path.join(root, row.name, "jbr"));
      candidates.push(path.join(root, row.name, "Contents", "Home"));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(binOf(candidate))) return binOf(candidate);
    }
  }
  return null;
}

/**
 * One tool, as a path a check can run, or `null` when this machine has none.
 *
 * A bare name is returned when PATH already answers it: that keeps the common case exactly as
 * it was (and keeps the check readable), while an absolute path is returned when the tool was
 * found in a JDK that is not on PATH, which is the case this exists for.
 */
export function findTool(name) {
  if (onPath(name)) return name;
  if (name === "javac" || name === "java" || name === "keytool") return findInJavaRoots(name);
  return null;
}

/** The three Java tools the Android checks need, each a path or `null`. */
export function javaToolchain() {
  return { javac: findTool("javac"), java: findTool("java"), keytool: findTool("keytool") };
}

/** The Python the Android scripts are run with: `python3` where CI is, `python` where Windows is. */
export function pythonInterpreter() {
  for (const name of ["python3", "python"]) {
    const probe = spawnSync(name, ["-c", "pass"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return name;
  }
  return null;
}

/**
 * The toolchain, or a refusal that says what is missing.
 *
 * Deliberately a throw rather than a skip: these checks exist because the Android code they
 * cover has been wrong before, and a check that quietly does not run is how it goes wrong
 * again. The message names the tools and where a JDK can come from, so the failure is the
 * machine's, said out loud, and not confused with the code's.
 */
export function requireJava(...wanted) {
  const tools = javaToolchain();
  const missing = wanted.filter((name) => !tools[name]);
  if (missing.length) {
    throw new Error(
      "no Java toolchain on this machine: " +
        missing.join(", ") +
        " not found. Install a JDK (the Android half builds with Java 21) or point JAVA_HOME at one - this check compiles and runs the Java it covers, so it cannot be skipped.",
    );
  }
  return tools;
}

/** The Python interpreter, or the same kind of refusal. */
export function requirePython() {
  const python = pythonInterpreter();
  if (!python) {
    throw new Error("no Python on this machine: neither python3 nor python ran. Install Python 3.9+ - this check runs the Android script it covers, so it cannot be skipped.");
  }
  return python;
}
