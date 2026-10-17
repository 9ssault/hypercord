import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { diagnose, defaultLogPath, parseLog } from "../scripts/diag-signin.mjs";

// The log this reads is the one a person pastes into a support bundle, and the question it
// answers is the one that took a live run to answer: "was the token wrong, or did the client
// never read it?". These fixtures are the two shapes a real log actually had - the rejected
// storage placements of 0.3.17 and the accepted loginToken of 0.3.18.

const REJECTED = `2026-10-17T04:55:08.344Z probe: page.local=[] page.session=[] frame.local=[token*] cookies=[] indexeddb=[]
2026-10-17T04:55:08.345Z probe client: registry=true require=true modules=102 candidates=[]
2026-10-17T04:55:08.346Z probe note: page localStorage unreadable: ReferenceError
2026-10-17T04:55:33.359Z attempt round=1 write=same-origin frame used=false landed=/login verdict=rejected
2026-10-17T04:55:58.376Z attempt round=1 write=indexeddb BetterImageEditor/library used=false landed=/app verdict=waiting
2026-10-17T04:56:06.075Z attempt round=1 write=indexeddb BetterImageEditor/library used=false landed=/login verdict=rejected
2026-10-17T04:56:48.413Z client sign-in: not attempted - the probe found no callable auth export
2026-10-17T04:56:48.414Z failed used=false writes=4`;

const ACCEPTED = `2026-10-17T05:10:32.879Z probe: page.local=[] page.session=[] frame.local=[token*] cookies=[] indexeddb=[]
2026-10-17T05:10:33.027Z client token login: ok:client loginToken
2026-10-17T05:10:35.100Z attempt round=1 write=client loginToken used=true landed=/channels/@me verdict=accepted
2026-10-17T05:10:45.415Z capture: stored this client's own session for 685909618580389989 (stored)`;

test("the placements, their verdicts and the client's own login are parsed", () => {
  const entries = parseLog(REJECTED);
  const attempts = entries.filter((entry) => entry.kind === "attempt");
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map((attempt) => [attempt.placement, attempt.used, attempt.landed, attempt.verdict]),
    [
      ["same-origin frame", false, "/login", "rejected"],
      ["indexeddb BetterImageEditor/library", false, "/app", "waiting"],
      ["indexeddb BetterImageEditor/library", false, "/login", "rejected"],
    ],
  );
  assert.equal(entries.filter((entry) => entry.kind === "probe").length, 3);
});

test("a rejected every-placement run is named as not-read, not as a bad token", () => {
  const report = diagnose(parseLog(REJECTED));
  assert.equal(report.status, "rejected");
  assert.equal(report.signedIn, false);
  assert.ok(report.explanation.some((line) => /read the token in none of them/.test(line)), report.explanation.join(" | "));
  assert.ok(report.advice.some((line) => /loginToken/.test(line)), report.advice.join(" | "));
});

test("an accepted run says where it landed", () => {
  const report = diagnose(parseLog(ACCEPTED));
  assert.equal(report.status, "signed-in");
  assert.equal(report.signedIn, true);
  assert.ok(report.explanation.some((line) => /channels\/@me/.test(line)), report.explanation.join(" | "));
});

test("a client login that refused the token says so, with the client's own words", () => {
  const report = diagnose(parseLog("2026-10-17T05:00:00.000Z client token login: err:the client's own auth module is not in this page"));
  assert.equal(report.status, "client-login-refused");
  assert.ok(/auth module/.test(report.explanation.join(" ")), report.explanation.join(" | "));
});

test("an empty log is its own answer, and a probe without an attempt is another", () => {
  assert.equal(diagnose(parseLog("")).status, "no-log");
  const probed = diagnose(parseLog("2026-10-17T05:00:00.000Z probe: page.local=[]\n2026-10-17T05:00:00.001Z probe client: registry=true"));
  assert.equal(probed.status, "no-attempt");
});

test("the default log path is the client's own user-data directory per platform", () => {
  const windows = defaultLogPath({ platform: "win32", env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, home: "C:\\Users\\x" });
  assert.equal(path.basename(windows), "signin.log");
  assert.ok(/Hypercord/.test(windows), windows);
  const mac = defaultLogPath({ platform: "darwin", env: {}, home: "/Users/x" });
  // built with `path.join`, so the separator is this host's - the segments are what matter
  assert.ok(mac.includes("Application Support") && path.basename(mac) === "signin.log" && mac.includes("Hypercord"), mac);
  const linux = defaultLogPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/home/x/.config" }, home: "/home/x" });
  assert.equal(linux, path.join("/home/x/.config", "Hypercord", "signin.log"));
});
