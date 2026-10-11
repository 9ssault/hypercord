// language: JavaScript, file: scripts/check-packaged.mjs
//
// The packaged build, checked as a packaged build.
//
// Everything else in tests/ runs the *source* through Electron. This runs the
// artifact: it starts the built executable, attaches to its renderer over the
// DevTools protocol, and reads the page it actually produced. That is the only
// check that can answer "does the exe I am about to hand over carry the rail, the
// token option, the manager sheet and the passkey policy" - a passing unit test
// cannot, because the build could be stale, and this one was: dist/ sat hours
// behind src/ while the dialog kept appearing.
//
//   node scripts/check-packaged.mjs
//   node scripts/check-packaged.mjs --exe "dist/win-unpacked/Hypercord.exe" --port 9225 --wait 90
//
// It starts one window, reads it, and kills the process tree it started. It needs
// a network for Discord's own page (the login page is what the token option and
// the passkey policy are about); it writes nothing anywhere.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** The built executable, wherever electron-builder put it. */
function findExe() {
  const named = arg("exe", "");
  if (named) {
    const full = path.isAbsolute(named) ? named : path.join(root, named);
    return fs.existsSync(full) ? full : "";
  }
  const candidates = [
    "dist/win-unpacked/Hypercord.exe",
    "dist/mac/Hypercord.app/Contents/MacOS/Hypercord",
    "dist/mac-arm64/Hypercord.app/Contents/MacOS/Hypercord",
    "dist/linux-unpacked/hypercord",
    "dist/linux-unpacked/Hypercord",
  ].map((rel) => path.join(root, rel));
  return candidates.find((file) => fs.existsSync(file)) || "";
}

let passed = 0;
let failed = 0;
function ok(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log("ok   " + name + (detail ? " | " + detail : ""));
  } else {
    failed += 1;
    console.log("FAIL " + name + (detail ? " | " + detail : ""));
  }
}

/** A check that fails without a condition to test: for a state that must hold. */
function fail(name, detail = "") {
  failed += 1;
  console.log("FAIL " + name + (detail ? " | " + detail : ""));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the running client what its page looks like. */
async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("the debugging socket refused")), { once: true });
    });
    const id = 1;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the page did not answer")), 15000);
      socket.addEventListener("message", (event) => {
        let message = null;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!message || message.id !== id) return;
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (reply.error) throw new Error(String(reply.error.message || "the page refused the question"));
    const result = reply.result && reply.result.result;
    if (reply.result && reply.result.exceptionDetails) throw new Error(String(reply.result.exceptionDetails.text || "the page threw"));
    return result ? result.value : null;
  } finally {
    socket.close();
  }
}

/** The page target: Discord's own document, not a worker or the devtools page. */
async function findPage(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list");
  if (!res.ok) throw new Error("the client's debugger answered " + res.status);
  const list = await res.json();
  return (Array.isArray(list) ? list : []).find((target) => target.type === "page" && target.webSocketDebuggerUrl) || null;
}

const exe = findExe();
if (!exe) {
  console.log("FAIL no packaged build found: run `npm run pack` first, or pass --exe");
  process.exit(1);
}
const port = Number(arg("port", "9225"));
const waitSeconds = Number(arg("wait", "90"));

// `--fresh` runs the build against an empty profile. The window then has no
// session, so Discord shows its login page - which is where the token option has
// to sit and where the page asks for a passkey by itself. That is the state worth
// checking in a build; a signed-in profile never reaches it.
const fresh = process.argv.includes("--fresh");
const profileDir = fresh ? fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-check-")) : "";

console.log("# checking " + path.relative(root, exe) + (fresh ? " (fresh profile)" : ""));

// The exe is started exactly as a user starts it, plus one switch that lets this
// script look at the page. Nothing about the app changes.
const args = ["--remote-debugging-port=" + String(port)];
if (fresh) args.push("--user-data-dir=" + profileDir);
const child = spawn(exe, args, { stdio: "ignore", detached: false });

let target = null;
try {
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline && !target) {
    await wait(700);
    try {
      target = await findPage(port);
    } catch {
      /* not listening yet */
    }
  }
  if (!target) throw new Error("no page appeared within " + waitSeconds + "s");
  ok("the packaged client starts and shows a page", true, String(target.url).slice(0, 60));

  // Discord's own scripts take a moment; the injection is what we are here for,
  // and the token option belongs beside the login form, which arrives late
  // A target appears as soon as the window exists, which is before its document
  // has an execution context - so every read is retried rather than thrown away,
  // and the last reason is what gets reported if none of them lands.
  let seen = null;
  let lastError = "";
  const settle = Date.now() + 60000;
  while (Date.now() < settle) {
    try {
      seen = await evaluate(
        target.webSocketDebuggerUrl,
        `(() => ({
        url: location.href,
        bridge: typeof window.hypercord,
        surfaces: window.hypercord ? Object.keys(window.hypercord).sort() : [],
        rail: Boolean(document.getElementById("hypercord-rail")),
        railTabs: [...document.querySelectorAll("#hypercord-rail .hc-tab")].map((n) => n.getAttribute("data-tab")),
        prompt: Boolean(document.getElementById("hypercord-token-prompt")),
        promptOpen: (document.getElementById("hypercord-token-prompt") || { getAttribute: () => null }).getAttribute("data-open"),
        promptAnchored: (document.getElementById("hypercord-token-prompt") || { getAttribute: () => null }).getAttribute("data-anchored"),
        promptHasForm: Boolean(document.querySelector('#hypercord-token-prompt [data-hc="prompt-value"]')),
        sheet: Boolean(document.getElementById("hypercord-panes")),
        sheetMounted: (document.getElementById("hypercord-panes") || { getAttribute: () => null }).getAttribute("data-mounted"),
        sheetCss: Boolean(document.getElementById("hypercord-panes-css")),
        sheetApi: typeof window.hypercordPanes,
        sheetTabs: [...document.querySelectorAll("#hypercord-panes .nav-item")].map((n) => n.getAttribute("data-view")),
        passkeys: window.__hypercordPasskeys || "(none)",
        refusals: window.__hypercordPasskeyCalls || null,
        loginForm: Boolean(document.querySelector('form[class*="auth"]')),
      }))()`,
      );
      lastError = "";
      // with a fresh profile Discord's client redirects itself to its login page a
      // moment after /app renders, so that is what this waits for before reading
      const settled = seen && seen.rail && seen.sheetMounted === "true" && seen.passkeys === "on-demand" && seen.prompt && (!fresh || seen.loginForm);
      if (settled) break;
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
    await wait(1500);
  }
  if (!seen) throw new Error("the page never answered: " + lastError);

  ok("the bridge is in the page", seen.bridge === "object", String(seen.bridge));
  ok("the rail is mounted with a tab per thing", seen.rail && seen.railTabs.length >= 5, JSON.stringify(seen.railTabs));
  ok("the passkey policy is in place before the page's scripts", seen.passkeys === "on-demand", String(seen.passkeys));
  ok("the manager sheet is mounted in Discord's own page", seen.sheet && seen.sheetMounted === "true" && seen.sheetCss, "mounted " + seen.sheetMounted);
  ok("the manager's script ran", seen.sheetApi === "object", String(seen.sheetApi));
  ok("the manager carries the tabs, access keys included", seen.sheetTabs.includes("hyper") && seen.sheetTabs.includes("tokens") && seen.sheetTabs.includes("themes"), JSON.stringify(seen.sheetTabs));
  ok("the token option is in the page", seen.prompt && seen.promptHasForm, "open " + String(seen.promptOpen));

  if (seen.promptOpen === "true" && seen.loginForm) {
    ok("and it is placeable under Discord's own login fields", seen.promptAnchored === "true", String(seen.promptAnchored));
  } else if (seen.promptOpen !== "true") {
    fail("the token option is open when no token is stored", "open " + String(seen.promptOpen));
  } else {
    console.log("note  the client is not on the login form (url " + String(seen.url).slice(0, 48) + "), so the placement is not asserted for this run");
  }

  // Discord asks for a passkey a moment *after* its form renders, so an empty
  // record on the first read means "not yet", not "never"
  let refusals = Array.isArray(seen.refusals) ? seen.refusals : [];
  if (!refusals.length && seen.loginForm) {
    const until = Date.now() + 10000;
    while (Date.now() < until && !refusals.length) {
      await wait(1500);
      try {
        const again = await evaluate(target.webSocketDebuggerUrl, "window.__hypercordPasskeyCalls || []");
        refusals = Array.isArray(again) ? again : [];
      } catch {
        /* the window is on its way out; the answer below is what matters */
      }
    }
  }
  if (refusals.length) {
    ok("a passkey request the page made by itself was refused here", refusals.some((line) => /conditional/.test(String(line))), JSON.stringify(refusals));
  } else if (seen.loginForm) {
    console.log("note  the login page was up but asked for no passkey during this run");
  } else {
    console.log("note  not on the login page, so no passkey request was expected");
  }
} catch (err) {
  failed += 1;
  console.log("FAIL " + String((err && err.message) || err));
} finally {
  // only the process tree this script started, by pid
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(child.pid, "SIGTERM");
  } catch {
    /* it may already be gone */
  }
  // and the throwaway profile. `taskkill` returns before Windows has released the
  // handles inside it, so the removal is retried rather than attempted once and
  // abandoned - a check that litters the temp directory is a check nobody keeps
  // running.
  if (profileDir) {
    const until = Date.now() + 10000;
    for (;;) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (Date.now() > until) {
          console.log("note  could not remove the throwaway profile " + profileDir + ": " + String((err && err.message) || err));
          break;
        }
        await wait(500);
      }
    }
  }
}

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
