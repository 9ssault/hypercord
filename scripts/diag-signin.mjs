// language: JavaScript, file: scripts/diag-signin.mjs
//
// What the client did when it tried to sign in with a token, read back from its own log.
//
//   node scripts/diag-signin.mjs                 this machine's client
//   node scripts/diag-signin.mjs --file other.log  a log somebody sent you
//   node scripts/diag-signin.mjs --json          the same answers as JSON
//
// Why: `signin.log` is written by the shell while a sign-in runs, and it is the only record
// of *which* placement was tried and what the client did with it. Reading it by eye means
// knowing that `used=false verdict=rejected` on every storage attempt is not the token being
// wrong - it is the client never reading the place the token was written - and that the fix
// is the client's own `loginToken`, which logs `client token login: ok:client loginToken`.
// This turns the log into that sentence.
//
// The token is never in the log and this script never needs it: the log records placements,
// verdicts and paths, and nothing else.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where this platform's client keeps its user data.
 *
 * Electron's own rule: `%APPDATA%` on Windows, `Application Support` on macOS, and
 * `$XDG_CONFIG_HOME` (or `~/.config`) on Linux, under the product name.
 */
export function defaultLogPath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const app = "Hypercord";
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), app, "signin.log");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", app, "signin.log");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), app, "signin.log");
}

const TIME = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(.*)$/;

/** One structured entry per line the shell writes, in order. */
export function parseLog(text) {
  const entries = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const stamped = TIME.exec(line);
    const at = stamped ? stamped[1] : "";
    const body = stamped ? stamped[2] : line;
    const entry = { at, line: body, kind: "other", text: body };
    const attempt = /^attempt round=(\d+) write=(.+?) used=(true|false) landed=(\S*) verdict=(\S+)$/.exec(body);
    if (/^probe\b/.test(body)) {
      // "probe:", "probe client:" and "probe note:" are all the one probe's report
      entry.kind = "probe";
    } else if (attempt) {
      entry.kind = "attempt";
      entry.round = Number(attempt[1]);
      entry.placement = attempt[2];
      entry.used = attempt[3] === "true";
      entry.landed = attempt[4];
      entry.verdict = attempt[5];
    } else if (/^client token login:/.test(body)) {
      entry.kind = "client-login";
      entry.answer = body.slice("client token login:".length).trim();
    } else if (/^client sign-in:/.test(body)) {
      entry.kind = "client-sign-in";
      entry.answer = body.slice("client sign-in:".length).trim();
    } else if (/^capture:/.test(body)) {
      entry.kind = "capture";
    } else if (/^failed\b/.test(body)) {
      entry.kind = "failed";
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The diagnosis: what was tried, which of it the client actually read, and the next thing to
 * do. Each answer names the evidence it is based on, because a diagnosis without its reason
 * is another guess.
 */
export function diagnose(entries) {
  const attempts = entries.filter((entry) => entry.kind === "attempt");
  const clientLogin = entries.filter((entry) => entry.kind === "client-login").pop() || null;
  const accepted = attempts.find((entry) => entry.verdict === "accepted");
  const rejected = attempts.filter((entry) => entry.verdict === "rejected");
  const used = attempts.filter((entry) => entry.used);
  const result = {
    status: "unknown",
    signedIn: false,
    attempts,
    clientLogin: clientLogin ? clientLogin.answer : "",
    probe: entries.find((entry) => entry.kind === "probe") || null,
    explanation: [],
    advice: [],
  };

  if (!entries.length) {
    result.status = "no-log";
    result.explanation.push("the log is empty: no sign-in has been attempted in this profile");
    result.advice.push("use the sign-in prompt beside Discord's login form, or Accounts → Access keys, and try again");
    return result;
  }

  if (accepted) {
    result.status = "signed-in";
    result.signedIn = true;
    result.explanation.push(`the client accepted the token (${accepted.placement}, round ${accepted.round}) and landed on ${accepted.landed || "an app route"}`);
    return result;
  }

  if (clientLogin) {
    result.explanation.push(`the client's own token login answered: ${clientLogin.answer}`);
    if (!/^ok/.test(clientLogin.answer)) {
      result.status = "client-login-refused";
      result.explanation.push("the client's own loginToken refused the token before any storage placement could matter");
      result.advice.push("check that this is a user token for a real account (Discord rejects bot tokens and expired ones), and that it was copied without surrounding text");
      return result;
    }
  }

  if (attempts.length) {
    result.status = "rejected";
    result.explanation.push(`${attempts.length} placement(s) were tried; the client read the token in ${used.length === 0 ? "none of them" : used.length + " of them"}`);
    if (!used.length && rejected.length) {
      result.explanation.push("every attempt landed back on the login page without the client using what was written: the token went into storage this build does not read");
      result.advice.push("0.3.18 and later sign in through the client's own loginToken; on an older build the storage placements cannot work");
    } else if (used.length) {
      result.explanation.push("the client did read the token and came back to the login page: Discord refused it");
      result.advice.push("the token is expired, reset, or not a user token - sign in in a browser and copy a fresh one");
    }
    return result;
  }

  if (entries.some((entry) => entry.kind === "failed")) {
    result.status = "failed";
    result.explanation.push("the sign-in run reported a failure without a per-placement attempt line");
    result.advice.push("attach this log and the client version: the failure line is above");
    return result;
  }

  result.status = "no-attempt";
  result.explanation.push("the log has probe lines but no attempt: a token was checked and never used");
  result.advice.push("open the sign-in prompt and press the stored-token button; the probe alone does not sign in");
  return result;
}

function print(report) {
  console.log(`status: ${report.status}${report.signedIn ? " (signed in)" : ""}`);
  for (const line of report.explanation) console.log(`  - ${line}`);
  if (report.attempts.length) {
    console.log("\n  round  placement                     used   landed        verdict");
    for (const attempt of report.attempts) {
      console.log(
        `  ${String(attempt.round).padEnd(5)}  ${attempt.placement.padEnd(28).slice(0, 28)}  ${String(attempt.used).padEnd(5)}  ${(attempt.landed || "-").padEnd(12).slice(0, 12)}  ${attempt.verdict}`,
      );
    }
  }
  if (report.advice.length) {
    console.log("\nnext:");
    for (const line of report.advice) console.log(`  - ${line}`);
  }
}

async function main() {
  const at = process.argv.indexOf("--file");
  const explicit = at > -1 ? process.argv[at + 1] : "";
  const file = explicit || defaultLogPath();
  if (!fs.existsSync(file)) {
    console.log(`no sign-in log at ${file}`);
    console.log("the client writes one the first time it tries to sign in with a token");
    return 0;
  }
  const report = diagnose(parseLog(fs.readFileSync(file, "utf8")));
  if (process.argv.includes("--json")) console.log(JSON.stringify({ file, ...report }, null, 2));
  else {
    console.log(`log: ${file}\n`);
    print(report);
  }
  return 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exit(await main());
