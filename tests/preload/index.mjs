// language: JavaScript, file: tests/preload/index.mjs
//
// The injection path, in a real window: `src/preload.cjs` is loaded exactly as
// the client loads it (sandboxed, contextIsolated) into a page that stands in for
// Discord's, and the checks look at the document - one style element carrying the
// themes and the rail CSS, the rail mounted with a tab per thing, the token
// option placed under the login form, and the manager sheet mounted inside the
// page rather than in a window of its own.
//
// Two details of that stand-in page are deliberate:
//
//   * it is served over http with `Content-Security-Policy: script-src 'none'`.
//     Discord sends a strict script-src, and the manager sheet is our script, not
//     theirs: if the sheet only worked on a permissive page it would not work in
//     the client. A page that forbids every script is the honest test;
//   * it carries a login form with generated-looking class names, so the token
//     option has something to be placed against - the same way Discord's form is
//     found by measurement rather than by living inside their tree.
//
// Every channel the preload asks for is stubbed here, so this runs with no
// control server, no Discord and no network.
//
//   npx electron tests/preload
import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "..", "src");
const read = (file) => fs.readFileSync(path.join(src, file), "utf8");

// the real policy, out of the real source: the preload asks for it synchronously,
// and the shell answers with this
const require_ = createRequire(import.meta.url);
const passkeys = require_(path.join(src, "passkeys.cjs"));
ipcMain.on("passkeys:policy", (event) => {
  event.returnValue = passkeys.POLICY;
});

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

// A test harness owns its own lifetime. Electron quits by default the moment its
// last window closes, and a suite that opens a second window after destroying the
// first would otherwise be creating that window while the app is already shutting
// down - every load then fails with ERR_FAILED and nothing about the page is
// actually being tested.
app.on("window-all-closed", () => {});

const watchdog = setTimeout(() => {
  console.log("FAIL the suite hung: " + passed + " passed before it stopped");
  app.exit(2);
}, 60000);
watchdog.unref?.();

// The stand-in for Discord's login page: a login card with the same shape the
// preload looks for, and nothing else that could be mistaken for our own markup.
const PAGE = `<!doctype html><html><head><title>discord stands here</title></head><body>
<div id="app">
  <div class="authBox-1a2b">
    <h1>Welcome back!</h1>
    <form class="authForm-9f8e">
      <label for="email">Email or phone</label>
      <input id="email" type="text" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" />
      <button type="submit">Log in</button>
    </form>
  </div>
</div>
</body></html>`;

// The other page that matters: Discord's settings layer, whose sidebar is a tab
// strip with real tabs in it. Hypercord puts one entry of its own in there.
const SETTINGS_PAGE = `<!doctype html><html><head><title>settings</title></head><body>
<div class="layers-1a2b"><div class="sidebar-3c4d" role="tablist" style="width:220px;height:320px;display:flex;flex-direction:column">
  <button type="button" role="tab">My Account</button>
  <button type="button" role="tab">Profiles</button>
  <button type="button" role="tab">Privacy &amp; Safety</button>
  <button type="button" role="tab">Notifications</button>
</div></div>
</body></html>`;

// every channel the preload and the manager sheet ask for, answered the way the
// shell answers - and recorded, because a call that never happens is the failure
// this suite exists to catch
const opened = [];
const calls = { plugins: 0, tokens: 0, uses: [], forgets: 0, closes: 0, themeRows: 0 };
let tokenRows = [];

// What the shell's pageCss() hands over: the enabled themes, then the rail's own
// stylesheet (which is where the prompt and the rail get their looks from). The
// harness sending anything less would be testing a client that does not exist.
const THEME_CSS = ".theme-is-here { color: red; }";
const SHELL_CSS = THEME_CSS + "\n" + read("rail.css");

ipcMain.handle("rail:ready", () => ({ ok: true, account: "selftest" }));
ipcMain.handle("rail:assets", () => ({
  css: SHELL_CSS,
  html: read("rail.html"),
  promptHtml: read("prompt.html"),
  panesHtml: read("panes.html"),
  panesCss: read("panes.css"),
  panesJs: read("panes.js"),
  side: "right",
}));
ipcMain.handle("rail:toggle", (_event, open) => open);
ipcMain.handle("panes:open", (_event, view) => {
  opened.push(String(view));
  // the shell opens the sheet by pushing the view back at the page, which is the
  // path the rail's Manager button and the settings entry both take
  for (const target of BrowserWindow.getAllWindows()) {
    if (!target.isDestroyed()) target.webContents.send("push", "panes:open", String(view || "commands"));
  }
  return { ok: true };
});
ipcMain.handle("panes:close", () => {
  calls.closes += 1;
  // the shell pushes the close back, which is the whole reason Close goes through
  // it rather than hiding the sheet behind the shell's back
  const target = BrowserWindow.getAllWindows()[0];
  if (target && !target.isDestroyed()) target.webContents.send("push", "panes:close", true);
  return { ok: true };
});
ipcMain.handle("plugins:list", () => {
  calls.plugins += 1;
  // `source` is what splits our own plugins from the vendored catalogue: the
  // manifest marks ours "hypercord" and everything vendored "upstream"
  return [
    { id: "hyperRail", name: "hyperRail", description: "the rail", source: "hypercord", running: true, enabled: true, broken: "" },
    { id: "hyperBridge", name: "hyperBridge", description: "the bridge", source: "hypercord", running: true, enabled: true, broken: "" },
    { id: "spellCheck", name: "SpellCheck", description: "spellcheck", source: "upstream", running: false, enabled: false, broken: "TypeScript source, not built" },
    { id: "updater", name: "Updater", description: "updates", source: "hypercord", running: false, enabled: false, broken: "" },
  ];
});
ipcMain.handle("plugins:settings", () => ({}));
ipcMain.handle("plugins:setSetting", () => ({ ok: true }));
ipcMain.handle("plugins:enable", () => ({ ok: true }));
ipcMain.handle("plugins:disable", () => ({ ok: true }));
ipcMain.handle("plugins:status", () => null);
ipcMain.handle("api:request", (_event, endpoint) => ({ ok: true, status: 200, json: { route: String(endpoint) }, text: "log line for " + String(endpoint) }));
ipcMain.handle("themes:list", () => {
  calls.themeRows += 1;
  return [
    { id: "midnight", name: "Midnight", source: "local", enabled: true },
    { id: "soft", name: "Soft", source: "online", enabled: false },
  ];
});
ipcMain.handle("themes:css", () => ".theme-is-here { color: red; }");
ipcMain.handle("themes:quickCss", () => ".quick { opacity: .5; }");
ipcMain.handle("themes:enable", () => ({ ok: true }));
ipcMain.handle("themes:remove", () => ({ ok: true }));
ipcMain.handle("themes:quick", () => ({ ok: true }));
ipcMain.handle("themes:install", () => ({ ok: true, id: "whatever" }));
ipcMain.handle("account:current", () => ({ account: "selftest", accounts: ["selftest", "second"] }));
ipcMain.handle("account:switch", () => ({ ok: true }));
ipcMain.handle("update:state", () => ({ mode: "dev", supported: false, error: "" }));
ipcMain.handle("update:check", () => ({ ok: false, error: "dev" }));
ipcMain.handle("notify", () => ({ ok: true }));
ipcMain.handle("perf:metrics", () => []);
ipcMain.handle("tokens:list", () => {
  calls.tokens += 1;
  return tokenRows;
});
ipcMain.handle("tokens:store", () => ({ ok: true, file: "tokens.json", encrypted: true, count: tokenRows.length }));
ipcMain.handle("tokens:use", (_event, account) => {
  calls.uses.push(String(account));
  return { ok: true, account: String(account) };
});
ipcMain.handle("tokens:test", () => ({ ok: true, identity: { username: "selftest" } }));
ipcMain.handle("tokens:remove", () => ({ ok: true }));
ipcMain.handle("tokens:forgetAll", () => {
  calls.forgets += 1;
  return { ok: true, removed: tokenRows.length };
});
ipcMain.handle("tokens:add", () => ({ ok: true, account: "1", label: "added" }));
ipcMain.handle("tokens:put", () => ({ ok: true, account: "1" }));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run an expression in the page's own world and hand back its value. */
const page = (win, expression) => win.webContents.executeJavaScript(expression);

async function run() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // Discord's own policy is strict; a page that forbids every script is the
      // honest place to prove that the sheet still mounts
      "content-security-policy": "script-src 'none'; object-src 'none'",
    });
    res.end(String(req.url || "").startsWith("/settings") ? SETTINGS_PAGE : PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port + "/";

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(src, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const consoleErrors = [];
  const consoleAll = [];
  win.webContents.on("console-message", (_e, level, message) => {
    consoleAll.push(level + ": " + String(message));
    if (level >= 3) consoleErrors.push(String(message));
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => consoleErrors.push("did-fail-load " + code + " " + desc + " " + url));

  await win.loadURL(origin);
  // the preload boots on DOMContentLoaded and asks main for the assets after
  await wait(600);
  // the shell answers rail:ready by pushing the rail state, so the stand-in does
  // the same thing here; the assertions below then read the page, not the stub
  win.webContents.send("push", "rail:visible", true);
  win.webContents.send("push", "themes:css", SHELL_CSS);
  await wait(200);

  /* ---- the bridge, the rail, the theme --------------------------------- */

  const seen = await page(
    win,
    `(() => {
    const style = document.getElementById("hypercord-theme");
    const rail = document.getElementById("hypercord-rail");
    const names = [...document.querySelectorAll("#hypercord-rail .hc-name")].map((n) => n.textContent);
    const tags = [...document.querySelectorAll("#hypercord-rail .hc-tag")].map((n) => ({ text: n.textContent, state: n.getAttribute("data-state") }));
    return {
      bridge: typeof window.hypercord,
      surfaces: window.hypercord ? Object.keys(window.hypercord).sort() : [],
      styleText: style ? style.textContent : null,
      styleCount: document.querySelectorAll("style").length,
      railSide: rail ? rail.getAttribute("data-side") : null,
      railOpen: rail ? rail.getAttribute("data-open") : null,
      hasClose: Boolean(document.querySelector('#hypercord-rail [data-hc="close"]')),
      hasPanes: Boolean(document.querySelector('#hypercord-rail [data-hc="panes"]')),
      names,
      tags,
      appIntact: document.getElementById("app").textContent.includes("Welcome back!"),
      inputsIntact: Boolean(document.getElementById("email")) && Boolean(document.getElementById("password")),
      panesPresent: Boolean(document.getElementById("hypercord-panes")),
      panesOpen: (document.getElementById("hypercord-panes") || { getAttribute: () => null }).getAttribute("data-open"),
    };
  })()`,
  );

  ok("the bridge is exposed to the page", seen.bridge === "object", seen.bridge);
  for (const surface of ["api", "rail", "panes", "plugins", "themes", "tokens", "account", "update", "notify", "on"]) {
    ok("the bridge carries " + surface, seen.surfaces.includes(surface), seen.surfaces.join(","));
  }
  ok("the rail markup was mounted with its own tabs", seen.hasClose && seen.hasPanes);
  ok("the rail is on the side main asked for", seen.railSide === "right", String(seen.railSide));
  ok("a pushed rail:visible opens the rail", seen.railOpen === "true", String(seen.railOpen));
  // the rail shows one panel at a time, so its plugin list is what its own
  // Plugins tab shows - which is also how a user reaches it
  await page(win, `document.querySelector('#hypercord-rail .hc-tab[data-tab="plugins"]').click(); true`);
  await wait(250);
  const pluginsPanel = await page(
    win,
    `(() => ({
    names: [...document.querySelectorAll('#hypercord-rail .hc-name')].map((n) => n.textContent),
    tags: [...document.querySelectorAll('#hypercord-rail .hc-tag')].map((n) => ({ text: n.textContent, state: n.getAttribute("data-state") })),
    summary: (document.querySelector('#hypercord-rail [data-hc="plugin-summary"]') || {}).textContent || "",
  }))()`,
  );
  ok("the rail's Plugins tab lists the running and the broken", pluginsPanel.names.includes("hyperRail") && pluginsPanel.names.includes("SpellCheck") && !pluginsPanel.names.includes("Updater"), JSON.stringify(pluginsPanel.names));
  ok("running plugins are tagged on and the failure is tagged broken", pluginsPanel.tags.filter((t) => t.state === "on").length >= 2 && pluginsPanel.tags.filter((t) => t.state === "broken").length === 1, JSON.stringify(pluginsPanel.tags));
  ok("the rail says how many are running of how many", /running of/.test(pluginsPanel.summary), JSON.stringify(pluginsPanel.summary));
  ok(
    "the themes and the rail's own css arrive as one element",
    seen.styleText === SHELL_CSS && seen.styleText.includes("#hypercord-rail") && seen.styleText.includes("#hypercord-token-prompt") && seen.styleCount === 2,
    "our style elements " + seen.styleCount + ", chars " + (seen.styleText || "").length,
  );
  ok("the manager sheet is mounted, and closed until it is asked for", seen.panesPresent && seen.panesOpen === "false", "present " + seen.panesPresent + " open " + seen.panesOpen);
  ok("discord's own markup is untouched", seen.appIntact && seen.inputsIntact);

  // the rail's buttons are wired in the isolated world, so a click has to reach
  // main: this is the difference between markup and a working rail
  await page(win, `document.querySelector('#hypercord-rail .hc-actions [data-hc="themes"]').click(); true`);
  await wait(150);
  await page(win, `document.querySelector('#hypercord-rail .hc-actions [data-hc="panes"]').click(); true`);
  await wait(150);
  ok("the rail's Themes and Manager buttons reach the shell", opened.includes("themes") && opened.includes("plugins"), JSON.stringify(opened));

  await page(win, `document.querySelector('#hypercord-rail [data-hc="close"]').click(); true`);
  await wait(150);
  ok("Hide closes the rail", (await page(win, `document.getElementById("hypercord-rail").getAttribute("data-open")`)) === "false");

  win.webContents.send("push", "themes:css", ".pushed { color: blue; }");
  await wait(150);
  ok("a pushed theme replaces the injected css", (await page(win, `document.getElementById("hypercord-theme").textContent`)) === ".pushed { color: blue; }");
  // back to the real sheet, because everything below reads the rail's own styles
  win.webContents.send("push", "themes:css", SHELL_CSS);
  await wait(150);

  /* ---- the passkey policy, before anything else ------------------------- */

  // The Windows "choose a passkey" dialog is raised by the request a login page
  // makes by itself, and it is raised in the browser process - so the only place
  // to stop it is in the page, before Discord's own scripts. These checks assert
  // the policy: the uninvited request is refused, and the deliberate ones are not.
  const passkeys = await page(
    win,
    `(async () => {
    const out = { marker: window.__hypercordPasskeys || "(none)", credentials: typeof navigator.credentials };
    out.publicKeyCredential = typeof PublicKeyCredential;
    out.getIsOurs = Boolean(navigator.credentials && navigator.credentials.get && navigator.credentials.get.__hypercord);
    if (window.PublicKeyCredential && typeof PublicKeyCredential.isConditionalMediationAvailable === "function") {
      out.conditional = await PublicKeyCredential.isConditionalMediationAvailable();
    } else {
      out.conditional = "absent";
    }
    const attempt = async (options) => {
      try {
        await navigator.credentials.get(options);
        return "resolved";
      } catch (err) {
        return String((err && err.name) || "") + ": " + String((err && err.message) || err).slice(0, 60);
      }
    };
    out.conditionalGet = await attempt({ publicKey: {}, mediation: "conditional" });
    out.uninvitedGet = await attempt({ publicKey: {} });
    out.otherGet = await attempt({ password: true });
    // what it refused, kept so a "the dialog popped up again" can be answered from
    // the page: kinds and reasons only, never the challenge or the credential
    out.record = Array.isArray(window.__hypercordPasskeyCalls) ? [...window.__hypercordPasskeyCalls] : null;
    return out;
  })()`,
  );

  ok("the passkey policy was applied to the page", passkeys.marker === "on-demand", passkeys.marker);
  ok("the page cannot be asked for a conditional passkey", passkeys.conditional === false || passkeys.conditional === "absent", String(passkeys.conditional));
  ok("the conditional request a login page makes by itself is refused", /NotAllowedError: Hypercord/.test(passkeys.conditionalGet), passkeys.conditionalGet);
  ok("a passkey request with no click behind it is refused", /NotAllowedError: Hypercord/.test(passkeys.uninvitedGet), passkeys.uninvitedGet);
  ok("other uses of navigator.credentials are left alone", !/Hypercord/.test(passkeys.otherGet), passkeys.otherGet);
  ok("it keeps a bounded record of what it refused", Array.isArray(passkeys.record) && passkeys.record.length === 2 && passkeys.record.some((line) => /conditional/.test(line)) && passkeys.record.every((line) => !/[A-Za-z0-9_-]{20,}/.test(line)), JSON.stringify(passkeys.record));

  /* ---- the token option, beside the login form -------------------------- */

  const prompt = await page(
    win,
    `(() => {
    const box = document.getElementById("hypercord-token-prompt");
    const form = document.querySelector("form[class*=auth]");
    const boxRect = box ? box.getBoundingClientRect() : null;
    const formRect = form ? form.getBoundingClientRect() : null;
    return {
      mounted: Boolean(box),
      open: box ? box.getAttribute("data-open") : null,
      anchored: box ? box.getAttribute("data-anchored") : null,
      formHidden: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-form"]') || {}).hidden,
      storedHidden: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-stored"]') || {}).hidden,
      valueIsPassword: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-value"]') || {}).type === "password",
      clearsForm: boxRect && formRect ? Math.round(boxRect.top - formRect.bottom) : null,
      overlapsForm: boxRect && formRect ? boxRect.bottom > formRect.bottom && boxRect.top < formRect.bottom : null,
      inlineTop: box ? box.style.top : null,
      rectTop: boxRect ? Math.round(boxRect.top) : null,
      formBottom: formRect ? Math.round(formRect.bottom) : null,
      formTop: formRect ? Math.round(formRect.top) : null,
      position: box ? getComputedStyle(box).position : null,
    };
  })()`,
  );

  ok("the token option is in the page", prompt.mounted && prompt.open === "true", JSON.stringify(prompt));
  ok("with no token stored it offers the paste form, not the stored one", prompt.formHidden === false && prompt.storedHidden === true, JSON.stringify({ form: prompt.formHidden, stored: prompt.storedHidden }));
  ok("the token field is a password field", prompt.valueIsPassword === true);
  ok(
    "it is placed just under the login form, not over it",
    prompt.anchored === "true" && prompt.clearsForm !== null && prompt.clearsForm >= 0 && prompt.clearsForm <= 40,
    "gap " + prompt.clearsForm + "px, anchored " + prompt.anchored + ", inline top " + prompt.inlineTop + ", rect top " + prompt.rectTop + ", form " + prompt.formTop + ".." + prompt.formBottom + ", " + prompt.position,
  );
  ok("it does not cover the email and password fields", prompt.overlapsForm === false, String(prompt.overlapsForm));

  // a token appears in the store: the option turns into one button, and using it
  // is a real call to the shell
  tokenRows = [{ account: "412", label: "selftest", present: true, updatedAt: 1, fingerprint: "ab12", last4: "9c3d" }];
  win.webContents.send("push", "tokens:changed", tokenRows);
  await wait(250);
  const stored = await page(
    win,
    `(() => {
    const box = document.getElementById("hypercord-token-prompt");
    const form = document.querySelector('#hypercord-token-prompt [data-hc="prompt-form"]');
    const block = document.querySelector('#hypercord-token-prompt [data-hc="prompt-stored"]');
    return {
      open: box.getAttribute("data-open"),
      formHidden: form.hidden,
      storedHidden: block.hidden,
      who: (document.querySelector('#hypercord-token-prompt [data-hc="prompt-who"]') || {}).textContent || "",
      leaksToken: box.textContent.includes("9c3d9c3d"),
    };
  })()`,
  );
  ok("a stored token turns the option into one sign-in button", stored.open === "true" && stored.formHidden === true && stored.storedHidden === false, JSON.stringify(stored));
  ok("it names the account and masks the token", stored.who.includes("selftest") && stored.who.includes("9c3d") && !stored.leaksToken, stored.who);

  await page(win, `document.querySelector('#hypercord-token-prompt [data-hc="prompt-use"]').click(); true`);
  await wait(250);
  const used = await page(win, `(document.querySelector('#hypercord-token-prompt [data-hc="prompt-stored-hint"]') || {}).textContent || ""`);
  ok("signing in with the stored token asks the shell for it", calls.uses.join(",") === "412", JSON.stringify(calls.uses));
  ok("and says so beside the login form", /signed in as selftest/.test(used), JSON.stringify(used));

  // and it can be put away for good: Discord's own login stays exactly as it was
  await page(win, `document.querySelector('#hypercord-token-prompt [data-hc="prompt-close"]').click(); true`);
  await wait(150);
  win.webContents.send("push", "tokens:changed", []);
  await wait(200);
  ok("Hide puts the token option away and it stays away", (await page(win, `document.getElementById("hypercord-token-prompt").getAttribute("data-open")`)) === "false");

  /* ---- the manager, built into the page --------------------------------- */

  const sheet = await page(
    win,
    `(() => {
    const host = document.getElementById("hypercord-panes");
    const style = document.getElementById("hypercord-panes-css");
    return {
      host: Boolean(host),
      mounted: host ? host.getAttribute("data-mounted") : null,
      open: host ? host.getAttribute("data-open") : null,
      css: style ? style.textContent.length : 0,
      // every selector in the sheet's stylesheet is scoped to it: comments off,
      // then each rule's selector must carry the prefix, so nothing of ours can
      // restyle Discord and nothing of Discord's can reach inside
      cssScoped: style
        ? style.textContent
            .split("/*")
            .map((part, index) => (index === 0 ? part : part.slice(part.indexOf("*/") + 2)))
            .join("")
            .split("}")
            .map((chunk) => chunk.split("{")[0])
            .filter((selector) => selector.trim())
            .every((selector) => selector.split(",").every((one) => one.includes("#hypercord-panes")))
        : false,
      api: typeof window.hypercordPanes,
      views: [...document.querySelectorAll("#hypercord-panes .nav-item")].map((b) => b.getAttribute("data-view")),
      sections: document.querySelectorAll("#hypercord-panes section.view").length,
      hpIds: ["hp-status", "hp-main", "hp-close", "hp-pluginList", "hp-themeList", "hp-tokenList"].every((id) => Boolean(document.getElementById(id))),
      inDiscord: Boolean(document.getElementById("app")),
    };
  })()`,
  );

  ok("the manager sheet is mounted inside discord's own page", sheet.host && sheet.mounted === "true" && sheet.inDiscord, JSON.stringify(sheet));
  ok("the rail's Manager button opened it, in this page", sheet.open === "true", String(sheet.open));
  ok("its stylesheet travels with it, scoped to the sheet", sheet.css > 500 && sheet.cssScoped, "chars " + sheet.css + " scoped " + sheet.cssScoped);
  ok("its script ran in the page's own world, under a page that forbids scripts", sheet.api === "object", String(sheet.api));
  ok(
    "it offers a tab per thing, access keys and our own plugins included",
    sheet.sections === 7 && ["commands", "plugins", "hyper", "themes", "logs", "accounts", "tokens"].every((v) => sheet.views.includes(v)),
    JSON.stringify(sheet.views),
  );
  ok("it uses hp- ids, so discord cannot collide with it", sheet.hpIds === true);

  // the shell opens a view by pushing, which is the path the rail's Manager
  // button and the shortcut both take
  win.webContents.send("push", "panes:open", "themes");
  await wait(400);
  const openedSheet = await page(
    win,
    `(() => {
    const host = document.getElementById("hypercord-panes");
    const visible = [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden")).map((n) => n.getAttribute("data-view"));
    return {
      open: host.getAttribute("data-open"),
      visible,
      active: (document.querySelector("#hypercord-panes .nav-item.active") || {}).textContent || "none",
      themeRows: document.querySelectorAll("#hypercord-panes #hp-themeList *").length,
      status: (document.getElementById("hp-status") || {}).textContent || "",
    };
  })()`,
  );
  ok("a pushed panes:open opens the sheet on that view", openedSheet.open === "true" && openedSheet.visible.length === 1 && openedSheet.visible[0] === "themes", JSON.stringify(openedSheet));
  ok("the themes view rendered the installed themes", openedSheet.themeRows > 0, "nodes " + openedSheet.themeRows + " status " + JSON.stringify(openedSheet.status));
  // the acceptance criterion, stated plainly: opening the manager must not create a
  // second window for it to live in
  ok("opening the manager created no second window", BrowserWindow.getAllWindows().length === 1, "windows " + BrowserWindow.getAllWindows().length);
  ok("opening a view logged no error", !/^\s*(error|failed)/i.test(openedSheet.status), JSON.stringify(openedSheet.status));

  // every view has to render when it is opened, with no polling involved
  const visited = [];
  for (const view of ["commands", "plugins", "hyper", "themes", "logs", "accounts", "tokens"]) {
    await page(win, `document.querySelector('#hypercord-panes .nav-item[data-view="${view}"]').click(); true`);
    await wait(250);
    const shown = await page(
      win,
      `(() => {
      const visible = [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden"));
      return {
        shown: visible.map((n) => n.getAttribute("data-view")),
        active: document.querySelectorAll("#hypercord-panes .nav-item.active").length,
        status: (document.getElementById("hp-status") || {}).textContent || "",
        pluginRows: document.querySelectorAll("#hypercord-panes #hp-pluginList *").length,
        tokenRows: document.querySelectorAll("#hypercord-panes #hp-tokenList *").length,
      };
    })()`,
    );
    visited.push(view + ":" + JSON.stringify(shown.shown));
    ok("the " + view + " view shows exactly itself, marked active", shown.shown.length === 1 && shown.shown[0] === view && shown.active === 1, JSON.stringify(shown));
    ok("the " + view + " view logged no error", !/^\s*(error|failed)/i.test(shown.status), JSON.stringify(shown.status));
    if (view === "plugins") ok("the plugins view listed the catalogue", shown.pluginRows > 0, "nodes " + shown.pluginRows);
    if (view === "tokens") ok("the access keys view listed the stored token", shown.tokenRows > 0, "nodes " + shown.tokenRows);
  }
  ok("every view was visited", visited.length === 7, visited.join(" "));

  // the whole catalogue and our own plugins are two tabs over one catalogue, not
  // two catalogues: Hyper must hold ours and only ours
  // reading each list after its own load, because a view renders from a bridge
  // call: reading in the same script tick would read the previous view
  await page(win, `document.querySelector('#hypercord-panes .nav-item[data-view="hyper"]').click(); true`);
  await wait(300);
  const oursText = await page(
    win,
    `(() => ({
    ours: [...document.querySelectorAll("#hypercord-panes #hp-hyperList *")].map((n) => n.textContent).join(" " ),
    hyperSummary: (document.getElementById("hp-hyperSummary") || {}).textContent || "",
  }))()`,
  );
  await page(win, `document.querySelector('#hypercord-panes .nav-item[data-view="plugins"]').click(); true`);
  await wait(300);
  const allText = await page(
    win,
    `(() => ({
    all: [...document.querySelectorAll("#hypercord-panes #hp-pluginList *")].map((n) => n.textContent).join(" " ),
    summary: (document.getElementById("hp-pluginSummary") || {}).textContent || "",
  }))()`,
  );
  const split = { ours: oursText.ours, hyperSummary: oursText.hyperSummary, all: allText.all, catalogueSummary: allText.summary };
  ok("the Hyper tab lists our own plugins", /hyperRail/.test(split.ours) && /hyperBridge/.test(split.ours), split.ours.slice(0, 120));
  ok("and not the vendored ones", !/SpellCheck/.test(split.ours) && /SpellCheck/.test(split.all), "hyper: " + /SpellCheck/.test(split.ours) + ", catalogue: " + /SpellCheck/.test(split.all));
  ok("the Hyper tab says how many of the catalogue are ours", /2|3|our/i.test(split.hyperSummary), JSON.stringify(split.hyperSummary));
  ok("the whole catalogue tab still holds everything", /of 4|4 /.test(split.catalogueSummary), JSON.stringify(split.catalogueSummary));

  // Close goes through the shell, and the sheet hides: there is no window to
  // close any more, the sheet is part of the page
  await page(win, `document.getElementById("hp-close").click(); true`);
  await wait(300);
  const closed = await page(win, `document.getElementById("hypercord-panes").getAttribute("data-open")`);
  ok("the sheet's Close hides it and tells the shell", closed === "false" && calls.closes >= 1, "open " + closed + " closes " + calls.closes);

  ok("nothing the page or the sheet did logged an error", consoleErrors.length === 0, (consoleErrors.join(" | ") + " || all: " + consoleAll.slice(0, 4).join(" | ")).slice(0, 300));

  /* ---- the way in from Discord's own settings --------------------------- */

  // Discord's settings layer is a sidebar of tabs, and that is where people look
  // for settings: Hypercord adds one entry of its own, next to theirs
  const settingsWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(src, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const settingsErrors = [];
  settingsWindow.webContents.on("console-message", (_e, level, message) => {
    if (level >= 3) settingsErrors.push(String(message));
  });
  await settingsWindow.loadURL(origin + "settings");
  await wait(700);
  const entry = await page(
    settingsWindow,
    `(() => {
    const button = document.getElementById("hypercord-settings-entry");
    const list = document.querySelector('[role="tablist"]');
    return {
      present: Boolean(button),
      label: button ? button.textContent : "",
      last: list && list.lastElementChild ? list.lastElementChild.textContent : "",
      insideSidebar: Boolean(button && list && list.contains(button)),
      discordsOwn: list ? [...list.querySelectorAll('[role="tab"]')].filter((n) => n.id !== "hypercord-settings-entry").length : 0,
      sheet: Boolean(document.getElementById("hypercord-panes")),
    };
  })()`,
  );
  ok("Hypercord appears in Discord's own settings sidebar", entry.present && entry.insideSidebar && entry.label === "Hypercord", JSON.stringify(entry));
  ok("Discord's own settings entries are left alone", entry.discordsOwn === 4, "theirs " + entry.discordsOwn + ", last " + JSON.stringify(entry.last));
  ok("the manager sheet is there to be opened from settings", entry.sheet === true);

  await page(settingsWindow, `document.getElementById("hypercord-settings-entry").click(); true`);
  await wait(250);
  const fromSettings = await page(settingsWindow, `(() => {
    const host = document.getElementById("hypercord-panes");
    const visible = [...document.querySelectorAll("#hypercord-panes section.view")].filter((n) => !n.classList.contains("hidden")).map((n) => n.getAttribute("data-view"));
    return { open: host ? host.getAttribute("data-open") : null, visible };
  })()`);
  ok("clicking it opens the manager inside Discord", fromSettings.open === "true" && fromSettings.visible.length === 1, JSON.stringify(fromSettings));
  ok("and it opens on a view of its own", ["plugins", "hyper", "themes", "tokens", "commands", "logs", "accounts"].includes(fromSettings.visible[0]), JSON.stringify(fromSettings.visible));
  ok("the settings page logged no error", settingsErrors.length === 0, settingsErrors.join(" | ").slice(0, 200));
  settingsWindow.destroy();
  await wait(200);
  ok("and closing it leaves the client with its one window", BrowserWindow.getAllWindows().length === 1, "windows " + BrowserWindow.getAllWindows().length);

  win.destroy();
  server.close();
  clearTimeout(watchdog);
  console.log("\npassed " + passed + "  failed " + failed);
  app.exit(failed === 0 ? 0 : 1);
}

// A rejected renderer script must report as a failed check with the whole run
// finished, not as an unhandled rejection that leaves the suite hanging.
app.whenReady().then(() =>
  run().catch((err) => {
    console.log("FAIL the suite threw: " + String((err && err.message) || err));
    console.log("\npassed " + passed + "  failed " + (failed + 1));
    app.exit(1);
  }),
);
