import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {    problemsOf, budgetFor } from '../scripts/audit-releases.mjs';

// Why this suite exists: `scripts/audit-releases.mjs` reads every published release back and
// decided - correctly - that all seven releases that shipped an APK (0.3.5 and 0.3.6, then
// 0.3.12 through 0.3.16) shipped one Android refuses to install. That judgement is the whole value of the audit, so the rules
// behind it are pinned here: what counts as unsigned, what counts as over budget, and what
// is merely a historical fact about a release that predates a platform.

const row = (overrides = {}) => ({
  tag: 'v0.0.0',
  publishedAt: '',
  prerelease: false,
  assets: 0,
  platforms: { windows: 3, macos: 2, linux: 2, android: 2 },
  apks: [],
  integrity: [],
  acceptance: null,
  overBudget: [],
  desktopBytes: 0,
  ...overrides,
});

test('an APK with no signature scheme is the install-time failure, named as such', () => {
  const    problems =    problemsOf(
    row({
      apks: [{ name: 'Hypercord-Loader.apk', bytes: 276432, schemes: [], budget: 409600 }],
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Hypercord-Loader\.apk carries no signature/);
  // The wording has to name the consequence: "unsigned" reads like a label, not like a file
  // nobody can install.
  assert.match(problems[0], /Android refuses to install it/);
});

test('a v2-only APK is signed, however empty its META-INF is', () => {
  const    problems =    problemsOf(
    row({
      apks: [
        { name: 'Hypercord-Loader.apk', bytes: 276432, schemes: ['v2'], budget: 409600 },
        { name: 'Hypercord-Manager.apk', bytes: 6611445, schemes: ['v1', 'v2'], budget: 8388608 },
      ],
    }),
  );
  assert.deepEqual(problems, []);
});

test('an APK over its budget is a    problem, and a mismatched checksum is a bigger one', () => {
  const    problems =    problemsOf(
    row({
      apks: [{ name: 'Hypercord-Loader.apk', bytes: 500 * 1024, schemes: ['v2'], budget: 409600 }],
      integrity: [{ name: 'Hypercord-Loader.apk', status: 'MISMATCH' }],
    }),
  );
  assert.equal(problems.length, 2,    problems.join(' | '));
  assert.ok(problems.some((line) => /over its 400 KB budget/.test(line)));
  assert.ok(problems.some((line) => /does not match SHA256SUMS/.test(line)));
});

test('a release that predates a platform is reported once, not as a broken artifact', () => {
  const    problems =    problemsOf(row({ platforms: { windows: 2, macos: 0, linux: 0, android: 0 } }));
  assert.deepEqual(problems, ['no macOS installer', 'no Linux installer', 'no APK']);
});

test('sizes are judged by the same budget file a build is', () => {
  // The loader is the artifact whose budget matters most: under a megabyte, ever.
  assert.equal(budgetFor('Hypercord-Loader.apk')?.limitBytes, 409600);
  assert.equal(budgetFor('Hypercord-Manager.apk')?.limitBytes, 8388608);
  assert.equal(budgetFor('Hypercord-0.3.16-win-x64-setup.exe')?.limitBytes, 209715200);
  // Not every asset has a budget: a log file is not an artifact whose size means anything.
  assert.equal(budgetFor('gradle-build.log'), null);
  assert.equal(budgetFor('SHA256SUMS'), null);
});

test('the committed audit covers every release that shipped an APK, and every one of them installs', () => {
  const report = JSON.parse(readFileSync('release-audit.json', 'utf8'));
  const withApks = report.releases.filter((release) => release.apks.length > 0);
  // Seven tags ever carried an APK; the rest are desktop-only releases, and an audit that
  // silently skipped one of them would be the reason this assertion exists. Every one of the
  // seven shipped without a signature block once; each has since been republished signed, so
  // an empty scheme list here is a regression back to an uninstallable file.
  assert.ok(withApks.length >= 7, 'the audit should have read every release with an APK');
  for (const release of withApks) {
    for (const apk of release.apks) {
      assert.ok(apk.schemes.length > 0, `${release.tag} ${apk.name} carries no signature block`);
      assert.ok(
        apk.schemes.some((scheme) => scheme === 'v1' || scheme === 'v2' || scheme === 'v3'),
        `${release.tag} ${apk.name} carries no signature Android accepts: ${apk.schemes.join(',')}`,
      );
    }
  }
  // And it agrees with the checksums those releases publish about their own bytes, so the
  // signed APK read here is the release's APK and not a download that went wrong.
  for (const release of withApks) {
    for (const entry of release.integrity) assert.equal(entry.status, 'matches', `${release.tag} ${entry.name}`);
  }
});
