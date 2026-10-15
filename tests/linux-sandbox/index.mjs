// language: JavaScript, file: tests/linux-sandbox/index.mjs
//
// The Linux AppImage failure, driven without Linux or Electron: the shell's
// log showed a healthy main process, one "Network service crashed or was
// terminated" line, and then every load failing ERR_FAILED. That is the
// OS-level sandbox dying at birth (the AppImage's setuid helper cannot work on
// the FUSE mount, and the kernel refuses the user-namespace fallback), and the
// shell's answer is `--no-sandbox` - which is what `sandboxDecision` decides.
//
//   node tests/linux-sandbox/index.mjs
//
import { sandboxDecision } from "../../src/linux-sandbox.js";

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

const base = { platform: "linux", env: {}, argv: ["hypercord"], euid: 1000, sandboxSwitchPresent: false };

// The reported failure: a plain desktop launch of the AppImage.
{
  const d = sandboxDecision({ ...base, env: { APPIMAGE: "/home/tay/Hypercord-0.3.6-linux-x86_64.AppImage" } });
  ok("the AppImage disables the OS sandbox", d.disable === true, JSON.stringify(d));
  ok("the reason names the AppImage", d.reason.includes("AppImage"), JSON.stringify(d));
}

// Running as root: Chromium refuses the helper outright.
{
  const d = sandboxDecision({ ...base, euid: 0 });
  ok("root disables the OS sandbox", d.disable === true, JSON.stringify(d));
}

// The CI escape hatch the release pipeline already uses.
{
  const d = sandboxDecision({ ...base, env: { ELECTRON_DISABLE_SANDBOX: "1" } });
  ok("ELECTRON_DISABLE_SANDBOX=1 disables the OS sandbox", d.disable === true, JSON.stringify(d));
}

// An explicit request on the command line is honoured, not doubled.
{
  const d = sandboxDecision({ ...base, argv: ["hypercord", "--no-sandbox"], sandboxSwitchPresent: true });
  ok("an existing --no-sandbox is reported as disabled", d.disable === true, JSON.stringify(d));
}

// A normal Linux install - deb, tarball, dev checkout - keeps the sandbox.
{
  const d = sandboxDecision({ ...base });
  ok("a plain linux launch keeps the sandbox", d.disable === false, JSON.stringify(d));
}

// Other platforms are never touched by a Linux heuristic.
for (const platform of ["win32", "darwin"]) {
  const d = sandboxDecision({ ...base, platform, env: { APPIMAGE: "/x.AppImage" }, euid: 0 });
  ok(platform + " keeps the sandbox whatever the environment claims", d.disable === false, JSON.stringify(d));
}

// The opt-out works in both directions: HYPERCORD_SANDBOX=0 keeps the sandbox
// even inside the AppImage, for whoever wants to prove the kernel can do it.
{
  const d = sandboxDecision({ ...base, env: { APPIMAGE: "/home/tay/H.AppImage", HYPERCORD_SANDBOX: "0" } });
  ok("HYPERCORD_SANDBOX=0 keeps the sandbox inside the AppImage", d.disable === false, JSON.stringify(d));
}

// The decision never throws on missing facts: main.js calls it with almost
// nothing on exotic platforms. Only the shape is asserted here, never the value:
// with no facts the decision reads the real machine, and the real machine can be
// anything - the APK job sets ELECTRON_DISABLE_SANDBOX=1 for its own run, which is
// exactly how asserting `disable === false` failed there while passing everywhere
// else. A fact this test names is a fact it controls; the room it runs in is not.
{
  let threw = null;
  let d = null;
  try {
    d = sandboxDecision();
  } catch (err) {
    threw = err;
  }
  ok(
    "no facts is a decision, not a throw",
    threw === null && d && typeof d.disable === "boolean" && typeof d.reason === "string" && d.reason.length > 0,
    String((threw && threw.message) || threw || d),
  );
}

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
