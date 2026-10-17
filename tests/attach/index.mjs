// language: JavaScript, file: tests/attach/index.mjs
//
// The attach decision, and what happens when Discord installs a new version.
//
// Every case here is a decision that can put a loader in front of somebody's Discord or
// refuse to - so they are checked against synthetic installs rather than reasoned about:
// which of the two clients a run is, whose directory is left alone, and which install a
// person's shortcut will actually start.
//
//   node tests/attach/index.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_FLAGS, attachPolicy, newestInstalls, updatePlan } from "../../src/attach.js";
import { inspect, patch } from "../../src/patcher.js";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-attach-"));
const loaderFile = path.join(root, "loader.cjs");
fs.writeFileSync(loaderFile, "// the loader the patched entry point requires\n");

const config = path.join(root, "config");

/** a Discord install in the Linux config layout, clean, at the version asked for */
function makeInstall(version) {
  const resources = path.join(config, "discord", "app-" + version, "resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "app.asar"), Buffer.from("discord-app-asar-" + version));
  fs.writeFileSync(path.join(path.dirname(resources), "Discord"), "not really a binary");
  return resources;
}

const list = () => newestInstalls({ platform: "linux", env: { XDG_CONFIG_HOME: config }, home: root, packageRoots: [], flatpakFiles: [] });
const found = (installs) => ({ ok: Boolean(installs.length), install: installs[0], error: installs.length ? "" : "no Discord install found", installs });

makeInstall("1.0.1");
const olderOnly = list();
ok("an install is discovered", olderOnly.length === 1 && olderOnly[0].version === "1.0.1", String(olderOnly.length));

/* ---- who this run is ---------------------------------------------------- */

const here = found(olderOnly);
ok(
  "with an install here, a packaged run attaches",
  attachPolicy({ argv: [], env: {}, packaged: true, found: here }).attach === true,
  JSON.stringify(attachPolicy({ argv: [], env: {}, packaged: true, found: here })),
);
ok(
  "…and says why, so it is never mistaken for a failure",
  attachPolicy({ argv: [], env: {}, packaged: true, found: here }).reason.includes("Discord install is here"),
);
ok(
  "a development run keeps its own window",
  attachPolicy({ argv: [], env: {}, packaged: false, found: here }).attach === false &&
    attachPolicy({ argv: [], env: {}, packaged: false, found: here }).reason.includes("development run"),
);
ok("…unless it asked for the real client", attachPolicy({ argv: ["--attach"], env: {}, packaged: false, found: here }).attach === true);
ok(
  "--no-attach wins over everything, including a packaged run with an install",
  attachPolicy({ argv: ["--no-attach", "--attach"], env: {}, packaged: true, found: here }).attach === false,
  JSON.stringify(attachPolicy({ argv: ["--no-attach", "--attach"], env: {}, packaged: true, found: here })),
);
ok(
  "and the environment can say the same thing",
  attachPolicy({ argv: [], env: { HYPERCORD_NO_ATTACH: "1" }, packaged: true, found: here }).attach === false,
);
// A harness starts a *packaged* build of this client - the electron suites, and
// `scripts/check-packaged.mjs` - and those runs must never patch and launch the Discord
// installed on the machine. That is the difference between a check and an incident.
for (const flag of ["--perf=45", "--remote-debugging-port=9333", "--user-data-dir=/tmp/x"]) {
  const decision = attachPolicy({ argv: [flag], env: {}, packaged: true, found: here });
  ok(
    "a packaged run a harness started keeps its own window (" + flag.split("=")[0] + ")",
    decision.attach === false && decision.reason.includes("harness"),
    JSON.stringify(decision),
  );
}
ok(
  "and the harness switch is reported, so the log says which one it was",
  attachPolicy({ argv: ["--remote-debugging-port=9333"], env: {}, packaged: true, found: here }).harness === "--remote-debugging-port",
  JSON.stringify(attachPolicy({ argv: ["--remote-debugging-port=9333"], env: {}, packaged: true, found: here })),
);
ok(
  "…and the switches are named in one place, rather than in the harnesses that pass them",
  HARNESS_FLAGS.every((flag) => attachPolicy({ argv: [flag], env: {}, packaged: true, found: here }).attach === false),
  JSON.stringify(HARNESS_FLAGS),
);
ok(
  "a plain packaged run is still unaffected by that rule",
  attachPolicy({ argv: ["--enable-features=Something"], env: {}, packaged: true, found: here }).attach === true,
  JSON.stringify(attachPolicy({ argv: ["--enable-features=Something"], env: {}, packaged: true, found: here })),
);

ok(
  "a machine with no install keeps the window, with the patcher's own reason",
  attachPolicy({ argv: [], env: {}, packaged: true, found: found([]) }).attach === false &&
    attachPolicy({ argv: [], env: {}, packaged: true, found: found([]) }).reason === "no Discord install found",
  JSON.stringify(attachPolicy({ argv: [], env: {}, packaged: true, found: found([]) })),
);

/* ---- whose directory it is --------------------------------------------- */

// somebody else's loader: resources/app exists and is not ours
const foreignResources = makeInstall("1.0.2");
fs.mkdirSync(path.join(foreignResources, "app"), { recursive: true });
fs.writeFileSync(path.join(foreignResources, "app", "package.json"), JSON.stringify({ name: "somebody-elses-loader" }));
const withForeign = list();
ok("the newer install is the foreign one", withForeign[0].version === "1.0.2" && inspect(withForeign[0]).state === "foreign", inspect(withForeign[0]).state);
ok(
  "an install another loader owns is refused, and not touched",
  attachPolicy({ argv: [], env: {}, packaged: true, found: found(withForeign) }).attach === false &&
    attachPolicy({ argv: [], env: {}, packaged: true, found: found(withForeign) }).reason.includes("another loader owns"),
  JSON.stringify(attachPolicy({ argv: [], env: {}, packaged: true, found: found(withForeign) })),
);
ok("and the plan refuses it too", updatePlan({ installs: withForeign, version: "0.3.10" }).action === "refuse");

// our own patch, applied to the newer install
fs.rmSync(path.join(foreignResources, "app"), { recursive: true, force: true });
const patched = patch(withForeign[0], { loader: loaderFile, version: "0.3.9", appRoot: path.join(root, "no-app-root") });
const afterPatch = list();
ok("the newest install is patched when this says so", patched.ok === true && inspect(afterPatch[0]).state === "patched", JSON.stringify(patched));
ok("an install that is already ours is something a run can attach to", attachPolicy({ argv: [], env: {}, packaged: true, found: found(afterPatch) }).attach === true);

/* ---- what to do about the install -------------------------------------- */

ok("with no install at all there is nothing to do", updatePlan({ installs: [], version: "0.3.10" }).action === "none");
ok("an install patched by this same build needs nothing", updatePlan({ installs: afterPatch, version: "0.3.9" }).action === "none", JSON.stringify(updatePlan({ installs: afterPatch, version: "0.3.9" })));
const stale = updatePlan({ installs: afterPatch, version: "0.3.10" });
ok("an install patched by an older build is refreshed, not repatched", stale.action === "refresh" && stale.freshness.state === "older", JSON.stringify(stale));
ok("…and the reason names both builds", stale.reason.includes("0.3.9") && stale.reason.includes("0.3.10"), stale.reason);
ok(
  "the newer build a run does not know about is not called stale",
  updatePlan({ installs: afterPatch, version: "0.3.8" }).action === "none",
  JSON.stringify(updatePlan({ installs: afterPatch, version: "0.3.8" })),
);

// a version that cannot be ordered is not treated as older - the warning has to be true
const oddInstall = { ...afterPatch[0], exists: (file) => fs.existsSync(file) };
fs.writeFileSync(path.join(oddInstall.resources, "app", "hypercord.json"), JSON.stringify({ tool: "hypercord", patchedByVersion: "0.4.0-beta.1" }));
const odd = updatePlan({ installs: [oddInstall], version: "0.3.10" });
ok("an unorderable record is left alone rather than called stale", odd.action === "none" && odd.freshness.state === "unorderable", JSON.stringify(odd));

// a clean newer version - what a Discord update actually leaves behind
const freshVersion = makeInstall("1.0.3");
fs.writeFileSync(path.join(path.dirname(freshVersion), "resources", "app.asar"), Buffer.from("discord-app-asar-1.0.3"));
const afterUpdate = list();
ok("a Discord update brings a new directory to the front", afterUpdate[0].version === "1.0.3", afterUpdate.map((one) => one.version).join(","));
const plan = updatePlan({ installs: afterUpdate, version: "0.3.10" });
ok(
  "and the plan is to patch that one, not the one that used to be the client",
  plan.action === "patch" && plan.install.version === "1.0.3",
  JSON.stringify({ action: plan.action, version: plan.install && plan.install.version }),
);
ok("and the reason says so in Discord's own version", plan.reason.includes("1.0.3"), plan.reason);

// the half state: the archive was moved aside and the entry directory is gone
const halfResources = makeInstall("1.0.4");
fs.renameSync(path.join(halfResources, "app.asar"), path.join(halfResources, "hypercord.app.asar"));
const halfList = list();
ok("an install whose entry went missing inspects as half", inspect(halfList[0]).state === "half", inspect(halfList[0]).state);
ok("and the plan repairs it", updatePlan({ installs: halfList, version: "0.3.10" }).action === "patch");

fs.rmSync(root, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
