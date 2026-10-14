// language: JavaScript, file: tests/beef/index.mjs
//
// The client's own beef engine, exercised as plain node (it imports nothing from
// electron and talks to nothing):
//
//   node tests/beef/index.mjs
//
// What matters here is not that a line comes back but *which* source answered: with no
// generator file the built-in banks draw, with one the operator's file draws, and a file
// that cannot be loaded leaves the working generator in place instead of disarming the
// section. The last two checks are the ones a bad paste depends on.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBeef } from "../../src/beef.js";

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-beef-"));
const logs = [];
const roll = () => 0.42; // a fixed roll: every drawn line is reproducible

/* ---- 1. no generator anywhere: the built-in banks answer ----------------- */

{
  const beef = createBeef({ userData: home, log: (line) => logs.push(String(line)) });
  const state = beef.state();
  ok("a machine with no generator still has an engine", state.ready === true && state.installed === false, JSON.stringify({ ready: state.ready, installed: state.installed }));
  ok("and says which source answered", state.source === "builtin banks" && state.sourceLabel === "builtin banks", JSON.stringify(state.source));
  ok("it draws for every kind it knows", state.categories.length === state.banks && state.banks >= 9, JSON.stringify({ categories: state.categories.length, banks: state.banks }));
  ok("with no backup to roll back to", state.backup === null, JSON.stringify(state.backup));

  const line = beef.line("insult", { rng: roll });
  ok("a line for a kind is a line", typeof line === "string" && line.length > 0, JSON.stringify(line));

  const unknown = beef.line("no-such-kind", { rng: roll });
  ok("an unknown kind still gets filler rather than nothing", typeof unknown === "string" && unknown.length > 0, JSON.stringify(unknown));

  /* ---- 2. the line lab --------------------------------------------------- */

  const read = beef.inspect("<@123> you are trash, kys", { selfId: "123", roll });
  ok("a line is read, not posted", read.ok === true && read.read.text.length > 0, JSON.stringify(read && read.ok));
  ok("a ping at us is seen as aimed at us", read.read.ping === true && read.read.aggro !== null, JSON.stringify({ ping: read.read.ping, level: read.read.aggro && read.read.aggro.level }));
  ok("heat and its tier are one reading", read.read.heat >= 50 && ["heavy", "max"].includes(read.read.tier), JSON.stringify({ heat: read.read.heat, tier: read.read.tier }));
  ok("and it routes to beef", read.read.route === "beef", JSON.stringify(read.read.route));
  const harmless = beef.inspect("hey everyone, good morning", { selfId: "123", roll });
  ok("an ordinary line routes nowhere", harmless.read.route === "skip" && harmless.read.aggro === null, JSON.stringify({ route: harmless.read.route, aggro: harmless.read.aggro }));
  ok("an empty line is refused", beef.inspect("   ").ok === false);

  /* ---- 3. a beef, and the log it lands in -------------------------------- */

  const made = beef.start("someone", { count: 3, roll, text: "you are trash <@123>", selfId: "123" });
  ok("a beef is built here, not requested", made.ok === true && Array.isArray(made.lines) && made.lines.length >= 3, JSON.stringify(made.lines && made.lines.length));
  ok("with the routing the bot would use", made.route === "beef" && made.heat > 0 && made.tier !== "none", JSON.stringify({ route: made.route, heat: made.heat, tier: made.tier }));
  ok("and its lines are real lines", made.lines.every((one) => typeof one === "string" && one.length > 0), JSON.stringify(made.lines));
  const log = beef.last({ history: 5 });
  ok("the beef is in the log", log.ok === true && log.total === 1 && log.beef && log.beef.target === "someone", JSON.stringify({ total: log.total, target: log.beef && log.beef.target }));
  ok("the log says which source drew it", log.beef.source === "builtin banks", String(log.beef.source));
  const again = beef.start("someone", { count: 2, roll });
  ok("a second beef is appended, not substituted", again.ok === true && beef.last({}).total === 2, JSON.stringify(beef.last({}).total));
  ok("and the history keeps what came before", beef.last({ history: 5 }).history.length === 1, JSON.stringify(beef.last({ history: 5 }).history.length));

  /* ---- 4. an operator's generator takes over ----------------------------- */

  const good = [
    "// a generator with one category the banks do not have, and one it overrides",
    "module.exports = {",
    "  line: () => \"unused\",",
    "  insult: () => \"generator insult\",",
    "  clutch: ({ name }) => \"generator clutch for \" + name,",
    "};",
  ].join("\n");
  const installed = beef.install(good, { name: "beefgen.cjs" });
  ok("a pushed generator installs", installed.ok === true, JSON.stringify(installed.error));
  ok("and the engine says it is the source now", beef.state().installed === true && beef.state().sourceLabel === "beefgen.cjs", JSON.stringify(beef.state().sourceLabel));
  ok("its categories are the ones it exports", beef.state().categories.includes("insult") && beef.state().categories.includes("clutch"), JSON.stringify(beef.state().categories));
  ok("the dispatcher it exports is not offered as a category", !beef.state().categories.includes("line"), JSON.stringify(beef.state().categories));
  ok("the operator's line answers for its category", beef.line("insult", { rng: roll }) === "generator insult", JSON.stringify(beef.line("insult", { rng: roll })));
  ok("and a category it does not define still comes from the banks", beef.line("banter", { rng: roll }).length > 0, "empty");
  const drawn = beef.start("someone", { count: 2, roll });
  ok("a beef with a generator says so", drawn.ok === true && drawn.source === "beefgen.cjs", JSON.stringify(drawn.source));

  /* ---- 5. a replacement that cannot load is refused, and the old one stays - */

  const beforeBad = beef.state();
  const bad = beef.install("module.exports = { this is not javascript", { name: "beefgen.cjs" });
  ok("a generator that will not parse is refused", bad.ok === false && /could not be loaded/.test(bad.error), JSON.stringify(bad.error));
  ok("and the previous one was put back on disk", bad.restored === true, JSON.stringify(bad.restored));
  ok("so the working generator still answers", beef.line("insult", { rng: roll }) === "generator insult", JSON.stringify(beef.line("insult", { rng: roll })));
  ok("and nothing about the failure is hidden", beef.state().lastFailure === "" && beef.state().generations >= beforeBad.generations, JSON.stringify({ failure: beef.state().lastFailure, generations: beef.state().generations }));

  const empty = beef.install("module.exports = { line: () => \"nothing else\" };", { name: "beefgen.cjs" });
  ok("a generator that exports nothing drawable is refused too", empty.ok === false && /exports nothing/.test(empty.error), JSON.stringify(empty.error));
  ok("and a push with no text is refused before anything is written", beef.install("   ").ok === false);
  ok("as is one that is not utf-8", beef.install("x\u0000y").ok === false);

  /* ---- 6. rollback restores exactly the replaced file -------------------- */

  const second = "module.exports = { insult: () => \"the second generator\" };";
  const replaced = beef.install(second, { name: "beefgen.cjs" });
  ok("a second generator installs over the first", replaced.ok === true && beef.line("insult", { rng: roll }) === "the second generator", JSON.stringify(beef.line("insult", { rng: roll })));
  ok("and the replaced one is held as the backup", Boolean(beef.state().backup) && beef.state().backup.bytes > 0, JSON.stringify(beef.state().backup));
  const back = beef.rollback();
  ok("rollback puts the replaced one back", back.ok === true && beef.line("insult", { rng: roll }) === "generator insult", JSON.stringify(beef.line("insult", { rng: roll })));
  ok("and the backup is consumed, not left behind", beef.state().backup === null, JSON.stringify(beef.state().backup));
  ok("so a second rollback says there is nothing to roll back to", beef.rollback().ok === false, "rolled back twice");

  /* ---- 7. a file edited on disk is noticed ------------------------------- */

  const edited = "module.exports = { insult: () => \"edited on disk\" };";
  fs.writeFileSync(path.join(home, "beefgen.cjs"), edited);
  ok("editing the file is picked up by the next read", beef.state().sourceLabel === "beefgen.cjs" && beef.line("insult", { rng: roll }) === "edited on disk", JSON.stringify(beef.line("insult", { rng: roll })));
  ok("and the reload is reported", beef.reload().ok === true);

  /* ---- 8. voices and the file paths a caller can open -------------------- */

  const voices = beef.voices(5, roll);
  ok("the banks can show their own voice, sampled", Array.isArray(voices) && voices.length === 5 && voices.every((one) => typeof one === "string"), JSON.stringify(Array.isArray(voices) ? voices.length : voices));
  ok("the generator's file is a path in the data directory", beef.file().startsWith(home), String(beef.file()));
  ok("and the log is a file this process owns", beef.logFile() === path.join(home, "beef.json"), String(beef.logFile()));
  ok("nothing drew a line without a source to name", logs.every((line) => /beef/.test(line)), JSON.stringify(logs.slice(-3)));
}

/* ---- 9. deleting the generator takes the engine back to the banks -------- */

{
  fs.rmSync(path.join(home, "beefgen.cjs"), { force: true });
  const beef = createBeef({ userData: home, log: () => {} });
  ok("with the file gone the banks answer again", beef.state().installed === false && beef.state().source === "builtin banks", JSON.stringify(beef.state().source));
  ok("and the log written by the previous run is still there", beef.last({}).total >= 2, JSON.stringify(beef.last({}).total));
}

fs.rmSync(home, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
