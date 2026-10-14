// language: JavaScript, file: tests/tokens/index.mjs
//
// The token store, exercised as plain node (it imports nothing from electron):
//
//   node tests/tokens/index.mjs
//
// The load-bearing checks are the negative ones: the token must not appear in the
// file on disk, must not appear in `list()`, must not appear in a log line, and
// must not appear in an error message - including an error raised by the cipher,
// which is the one place a secret usually escapes from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkToken, createTokens, fingerprint, mask, redact } from "../../src/tokens.js";

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

/* ---- fixtures ------------------------------------------------------------ */

// three real-shaped tokens: base64url, `mfa.` prefix, distinct tails so a mask
// can never be confused between them
const TOKEN_A = "mfa.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.abcd";
const TOKEN_B = "mfa.ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210.efgh";
const TOKEN_C = "mfa.NEWNEWNEWNEWNEWNEWNEWNEWNEW1234567.wxyz";
const WEIRD = "ZZZZZZZZ!!!!ZZZZZZZZZZZZZZZZ"; // right length, wrong alphabet

// an in-memory stand-in for safeStorage: reversible, and nothing like the token
const PREFIX = "enc:";
const cipher = {
  encrypt: (text) => PREFIX + Buffer.from(String(text), "utf8").toString("base64"),
  decrypt: (blob) => Buffer.from(String(blob).slice(PREFIX.length), "base64").toString("utf8"),
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), "hypercord-tokens-"));
const storeFile = path.join(home, "tokens.json");
const logs = [];
const store = createTokens({ userData: home, cipher, log: (l) => logs.push(String(l)) });
const onDisk = () => {
  try {
    return fs.readFileSync(storeFile, "utf8");
  } catch {
    return "";
  }
};

/* ---- 1. an empty store --------------------------------------------------- */

ok("a fresh store is empty", store.list().length === 0 && store.size() === 0, JSON.stringify(store.list()));
ok("and it has written nothing yet", onDisk() === "");
ok("an account nobody stored has no token", store.get("nobody") === "");
ok("and has() agrees", store.has("nobody") === false);

/* ---- 2. no cipher: memory only, or refuse -------------------------------- */

const bare = createTokens({ userData: home, cipher: null, log: (l) => logs.push(String(l)) });
const refused = bare.put("selftest", TOKEN_A);
ok("without a cipher a token is refused", refused.ok === false && /cipher/.test(refused.error), JSON.stringify(refused));
ok("and the refusal wrote nothing at all", onDisk() === "");
const memoryOnly = bare.put("selftest", TOKEN_A, { memoryOnly: true });
ok("with memoryOnly the token is kept for this run", memoryOnly.ok === true && memoryOnly.memoryOnly === true, JSON.stringify(memoryOnly));
ok("it reads back exactly", bare.get("selftest") === TOKEN_A);
ok("it is listed", bare.list().length === 1 && bare.list()[0].account === "selftest", JSON.stringify(bare.list()));
ok("nothing reached the disk even so", onDisk() === "");

/* ---- 3. with a cipher: metadata on disk, never the token ----------------- */

const stored = store.put("selftest", TOKEN_A, { label: "main" });
ok("a token is stored", stored.ok === true && stored.fingerprint === fingerprint(TOKEN_A), JSON.stringify(stored));
ok("the store knows it", store.has("selftest") && store.size() === 1);
ok("it reads back exactly", store.get("selftest") === TOKEN_A);

const listed = store.list();
ok("the list carries a label and a tail", listed[0].label === "main" && listed[0].last4 === "abcd", JSON.stringify(listed));
ok("the list carries a fingerprint, not a token", listed[0].fingerprint === fingerprint(TOKEN_A) && listed[0].fingerprint.length === 12);
ok("the list never contains the token", !JSON.stringify(listed).includes(TOKEN_A));
ok("nor a long prefix of it", !JSON.stringify(listed).includes(TOKEN_A.slice(0, 12)));
ok("the list records which store the token is in", listed[0].source === "disk", listed[0].source);

const file = onDisk();
ok("the file exists and is not secretly plaintext", file.length > 0 && !file.includes(TOKEN_A));
ok("no long prefix of the token is in the file either", !file.includes(TOKEN_A.slice(0, 12)));
ok("not even the ct part of it", !file.includes("AbCdEfGhIjKlMnOp"));
ok("what is in the file is the cipher's output, base64'd", /"blob": "[A-Za-z0-9+/=]+"/.test(file));

/* ---- 4. rotation keeps the identity, changes the secret ------------------ */

const rotated = store.put("selftest", TOKEN_C);
ok("rotating keeps the label", rotated.ok === true && store.list()[0].label === "main", JSON.stringify(store.list()));
ok("rotating changes the fingerprint", rotated.fingerprint !== stored.fingerprint, rotated.fingerprint + " vs " + stored.fingerprint);
ok("and the new token is the one that reads back", store.get("selftest") === TOKEN_C);
// the file records the fingerprint of the token that is actually stored, so the
// metadata and the secret can never drift apart after a rotation
const fileAfterRotation = onDisk();
ok(
  "the file records the new fingerprint and not the old one",
  fileAfterRotation.includes(rotated.fingerprint) && !fileAfterRotation.includes(stored.fingerprint),
  rotated.fingerprint + " present=" + fileAfterRotation.includes(rotated.fingerprint) + " oldPresent=" + fileAfterRotation.includes(stored.fingerprint),
);
const relabelled = store.put("selftest", TOKEN_C, { label: "renamed" });
ok("a new label is taken when one is given", relabelled.ok === true && store.list()[0].label === "renamed", JSON.stringify(store.list()));

/* ---- 5. every malformed token is refused, with the rule named ----------- */

const bad = [
  [undefined, /must be text/],
  [42, /must be text/],
  ["", /cannot be empty/],
  ["abc", /shorter than/],
  ["a".repeat(201), /longer than/],
  ["aaaa bbbb cccc dddd eeee", /whitespace/],
  ["aaaa\nbbbb cccc dddd eeee", /control characters|whitespace/],
  [WEIRD, /base64url/],
];
for (const [value, why] of bad) {
  const res = store.put("selftest", value);
  ok("refused: " + JSON.stringify(String(value).slice(0, 18)) + " (" + why.source + ")", res.ok === false && why.test(res.error), JSON.stringify(res));
}
const echoed = store.put("selftest", WEIRD);
ok("a refusal never echoes the value it refused", !String(echoed.error).includes(WEIRD), String(echoed.error));
ok("and checkToken() is the same rule the store uses", checkToken(TOKEN_A).ok === true && checkToken(WEIRD).ok === false);
ok("a bad account name is refused too", store.put("bad name!", TOKEN_A).ok === false);
ok("the token that was already stored survived all of that", store.get("selftest") === TOKEN_C);

/* ---- 6. logs and errors are redacted ------------------------------------- */

let leaky = null;
const leakyCipher = {
  encrypt: (text) => {
    // a cipher that puts the secret in its own error: the store has to redact it
    throw new Error("cannot encrypt " + text);
  },
  decrypt: (blob) => String(blob),
};
const leakyStore = createTokens({ userData: home, cipher: leakyCipher, log: (l) => logs.push(String(l)) });
const leakyResult = leakyStore.put("selftest", TOKEN_A);
leaky = String(leakyResult.error);
ok("a cipher failure is reported", leakyResult.ok === false && /cipher refused/.test(leaky), leaky);
ok("and the token is redacted out of that message", !leaky.includes(TOKEN_A) && !leaky.includes(TOKEN_A.slice(0, 12)), leaky);
ok("redact() is the thing doing it", redact("boom " + TOKEN_A, TOKEN_A).indexOf(TOKEN_A) === -1);

let nonText = null;
const bufferCipher = { encrypt: () => Buffer.from("hello"), decrypt: (b) => String(b) };
const bufferStore = createTokens({ userData: home, cipher: bufferCipher, log: (l) => logs.push(String(l)) });
nonText = bufferStore.put("selftest", TOKEN_A);
ok("a cipher returning bytes rather than text is refused, not stored", nonText.ok === false && /did not return text/.test(nonText.error), JSON.stringify(nonText));

const allLogs = logs.join("\n");
ok("no log line ever contains a token", !allLogs.includes(TOKEN_A) && !allLogs.includes(TOKEN_C), allLogs.slice(0, 200));
ok("no log line contains the refused value either", !allLogs.includes(WEIRD));

/* ---- 7. mask() and fingerprint() ---------------------------------------- */

ok("mask() of nothing is just the ellipsis", mask() === "\u2026");
ok("mask() shows the tail and stays short", mask(TOKEN_A) === "\u2026abcd" && mask(TOKEN_A).length <= 6, mask(TOKEN_A));
ok("mask() never contains the token", !mask(TOKEN_A).includes(TOKEN_A) && !mask(TOKEN_A).includes("AbCd"));
ok("fingerprints of different tokens differ", fingerprint(TOKEN_A) !== fingerprint(TOKEN_B));
ok("the same token fingerprints the same in a new process view", fingerprint(TOKEN_A) === fingerprint("" + TOKEN_A));
ok("the store exposes the same helpers", store.mask(TOKEN_B) === mask(TOKEN_B) && store.fingerprint(TOKEN_B) === fingerprint(TOKEN_B));

/* ---- 8. a fresh instance over the same directory ------------------------- */

const second = createTokens({ userData: home, cipher, log: () => {} });
ok("a fresh store sees the stored token", second.list().length === 1 && second.list()[0].label === "renamed", JSON.stringify(second.list()));
ok("and can read it back", second.get("selftest") === TOKEN_C);

/* ---- 9. a store that cannot be decrypted degrades ------------------------ */

const brokenCipher = { encrypt: cipher.encrypt, decrypt: () => { throw new Error("no key here"); } };
const broken = createTokens({ userData: home, cipher: brokenCipher, log: (l) => logs.push(String(l)) });
ok("the metadata is still listed when decryption fails", broken.list().length === 1);
ok("get() returns nothing rather than throwing", broken.get("selftest") === "");
ok("and the failure is logged without the ciphertext", !logs.join("\n").includes("blob"));

/* ---- 10. removal, forgetting, and a corrupt store ----------------------- */

store.put("second", TOKEN_B, { label: "alt" });
ok("a second account is stored", store.size() === 2 && onDisk().includes("second"));
const removed = store.remove("second");
ok("removing works", removed.ok === true && store.size() === 1 && store.get("second") === "", JSON.stringify(removed));
ok("removing something that is not there says so", store.remove("second").ok === false);

store.put("second", TOKEN_B);
ok("two tokens live in the file", onDisk().includes("second"));
const forgotten = store.forgetAll();
ok("forgetAll reports what it forgot", forgotten.ok === true && forgotten.removed === 2, JSON.stringify(forgotten));
ok("and the file is gone", onDisk() === "" && !fs.existsSync(storeFile));
ok("the store is empty afterwards", store.size() === 0 && store.get("selftest") === "");

fs.writeFileSync(storeFile, "{ this is not json");
ok("a corrupt store reads as empty instead of throwing", store.list().length === 0 && store.get("selftest") === "");
ok("and it can be written again", store.put("selftest", TOKEN_A).ok === true && store.get("selftest") === TOKEN_A);

/* ---- 12. the identity and the label a page shows ------------------------ */

// The Accounts page shows a name and an avatar next to every stored key, so the store has
// to carry both - and the two rules that matter are that the identity is public data (it
// never goes through the cipher, unlike the token it belongs to) and that a re-store or a
// rename cannot quietly lose it.
const IDENTITY = {
  id: "123456789012345678",
  username: "lycia",
  name: "Lycia",
  avatar: "https://cdn.discordapp.com/avatars/123456789012345678/abc.png?size=64",
};
store.put("selftest", TOKEN_A, { label: "main", identity: IDENTITY });
const withIdentity = (store.list() || [])[0] || {};
ok("a stored key carries the identity it was stored with", JSON.stringify(withIdentity.identity) === JSON.stringify(IDENTITY), JSON.stringify(withIdentity.identity));
ok("the identity is written to the file, and the key still is not", onDisk().includes("cdn.discordapp.com") && !onDisk().includes("AbCdEfGhIjKlMnOpQrStUvWxYz"), "");

store.put("selftest", TOKEN_A, {});
ok("re-storing the same key keeps what was known about the account", ((store.list() || [])[0] || {}).identity.id === IDENTITY.id, JSON.stringify(((store.list() || [])[0] || {}).identity));
const relabelledAgain = store.put("selftest", TOKEN_A, { label: "backup" });
ok("and a label can be given with it", relabelledAgain.ok === true && ((store.list() || [])[0] || {}).label === "backup", JSON.stringify(relabelledAgain));

const renamed = store.rename("selftest", "the alt");
ok("renaming changes the label and nothing else", renamed.ok === true && renamed.label === "the alt" && ((store.list() || [])[0] || {}).label === "the alt", JSON.stringify(renamed));
ok("and the key behind it is untouched", store.get("selftest") === TOKEN_A);
const clearedLabel = store.rename("selftest", "   ");
ok("an empty rename clears the label rather than storing whitespace", clearedLabel.ok === true && clearedLabel.label === "" && ((store.list() || [])[0] || {}).label === "", JSON.stringify(clearedLabel));
ok("renaming an account that is not stored is a refusal", store.rename("nobody", "x").ok === false, JSON.stringify(store.rename("nobody", "x")));

const learned = store.setIdentity("selftest", { id: "5", username: "someone" });
ok("an identity can be learned later, which is what testing a key does", learned.ok === true, JSON.stringify(learned));
const afterLearn = ((store.list() || [])[0] || {}).identity || {};
ok("and it is normalized to the four fields", afterLearn.id === "5" && afterLearn.username === "someone" && afterLearn.name === "" && afterLearn.avatar === "", JSON.stringify(afterLearn));
ok("the name and avatar it already had are replaced only when one is given", store.setIdentity("selftest", IDENTITY).ok === true && ((store.list() || [])[0] || {}).identity.avatar === IDENTITY.avatar, "");
ok("an identity for an account that is not stored is refused", store.setIdentity("nobody", IDENTITY).ok === false, JSON.stringify(store.setIdentity("nobody", IDENTITY)));
ok("and an identity that is not plain data is refused", store.setIdentity("selftest", "not an object").ok === false, JSON.stringify(store.setIdentity("selftest", "not an object")));
ok("the store is back to the one key these checks are about", store.size() === 1 && store.get("selftest") === TOKEN_A, JSON.stringify({ size: store.size() }));

/* ---- 11. the temp file is not left behind ------------------------------- */

ok("no .tmp file is left next to the store", !fs.existsSync(storeFile + ".tmp"));

fs.rmSync(home, { recursive: true, force: true });

console.log("\npassed " + passed + "  failed " + failed);
process.exit(failed === 0 ? 0 : 1);
