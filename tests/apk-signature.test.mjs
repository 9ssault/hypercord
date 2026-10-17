import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { requirePython } from './support/toolchain.mjs';


// Why this suite exists: the 0.3.16 loader APK carried no `META-INF/*.RSA` and no `.SF`,
// so it was not merely "unsigned" - Android answered `INSTALL_PARSE_FAILED_NO_CERTIFICATES`
// and the file could not be installed at all. That reached a release because nothing looked
// at the bytes: the job printed a warning, stripped the signature material, and published.
//
// Two things are pinned here. The script now reads the signature block out of the APK, and
// the job now signs with a generated key when no keystore secret is configured, so a run
// without secrets produces an installable file instead of a warning.

const python = requirePython();

test('a signature block is read from the APK itself, and its absence is reported as none', () => {
  const program = `
import importlib.util, tempfile, zipfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_android', 'scripts/build_android.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    signed = tmp / 'signed.apk'
    with zipfile.ZipFile(signed, 'w') as archive:
        for name in ('META-INF/MANIFEST.MF', 'META-INF/CERT.SF', 'META-INF/CERT.RSA', 'classes.dex'):
            archive.writestr(name, 'x')
    assert m.signature_block(signed) == ['META-INF/CERT.RSA', 'META-INF/CERT.SF'], m.signature_block(signed)

    # Exactly the shape that shipped: the signature files removed, the manifest left behind.
    stripped = tmp / 'stripped.apk'
    with zipfile.ZipFile(stripped, 'w') as archive:
        for name in ('META-INF/MANIFEST.MF', 'META-INF/com/android/build/gradle/app-metadata.properties', 'classes.dex'):
            archive.writestr(name, 'x')
    assert m.signature_block(stripped) == [], m.signature_block(stripped)

    # A file that cannot be read is not an unsigned APK. Returning [] for both is how a
    # path bug (a POSIX path handed to the Windows interpreter) once read as "shipped
    # unsigned" - so an unreadable path raises, by name, and never answers the question.
    for missing in (tmp / 'absent.apk',):
        try:
            m.signature_block(missing)
        except m.BuildError as error:
            assert 'cannot read the APK' in str(error), str(error)
        else:
            raise AssertionError('a missing file was reported as an unsigned APK')
    (tmp / 'garbage.apk').write_bytes(b'not a zip')
    try:
        m.signing_schemes(tmp / 'garbage.apk')
    except m.BuildError as error:
        assert 'cannot read the APK' in str(error), str(error)
    else:
        raise AssertionError('a corrupt file was reported as unsigned rather than unreadable')
`;
  const result = spawnSync(python, ['-c', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('a configured build refuses an APK Gradle produced without a signature block', () => {
  const program = `
import importlib.util, tempfile, zipfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_android', 'scripts/build_android.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

with tempfile.TemporaryDirectory() as tmp:
    bare = Path(tmp) / 'loader-release.apk'
    with zipfile.ZipFile(bare, 'w') as archive:
        archive.writestr('classes.dex', 'x')

    # Signing was configured and the artifact has no scheme at all: a failed build, named.
    try:
        m.require_signature(bare, True, 'loader')
    except m.BuildError as error:
        assert 'loader' in str(error) and 'no signature' in str(error), str(error)
    else:
        raise AssertionError('an unsigned artifact was accepted from a signed build')

    # The same artifact from a build that never asked for signing is reported, not raised:
    # a debug build on a developer machine must still be able to produce one.
    assert m.require_signature(bare, False, 'loader') == []

    signed = Path(tmp) / 'signed.apk'
    with zipfile.ZipFile(signed, 'w') as archive:
        archive.writestr('META-INF/CERT.RSA', 'x')
        archive.writestr('META-INF/CERT.SF', 'x')
    assert m.require_signature(signed, True, 'loader') == ['v1']
`;
  const result = spawnSync(python, ['-c', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('a v2-only APK counts as signed even with no META-INF signature files', () => {
  // `minSdk 28` means AGP drops the v1 JAR signature: a correct release APK has an empty
  // META-INF and an APK Signing Block. A v1-only check would have rejected every good build,
  // which is why the schemes are read from the block itself here.
  const program = `
import importlib.util, struct, tempfile, zipfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_android', 'scripts/build_android.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

MAGIC = b'APK Sig Block 42'

def with_signing_block(path, pair_ids):
    """Insert an APK Signing Block carrying one pair per id, fixing the EOCD offset."""
    raw = path.read_bytes()
    eocd = raw.rfind(b'PK\\x05\\x06')
    cd_offset = int.from_bytes(raw[eocd + 16:eocd + 20], 'little')
    pairs = b''
    for pair_id in pair_ids:
        value = b'unsigned-test-value'
        pairs += struct.pack('<Q', len(value) + 4) + struct.pack('<I', pair_id) + value
    block_size = len(pairs) + 8 + 16
    block = struct.pack('<Q', block_size) + pairs + struct.pack('<Q', block_size) + MAGIC
    out = bytearray(raw[:cd_offset] + block + raw[cd_offset:])
    new_eocd = out.rfind(b'PK\\x05\\x06')
    out[new_eocd + 16:new_eocd + 20] = struct.pack('<I', cd_offset + len(block))
    path.write_bytes(bytes(out))

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    apk = tmp / 'v2.apk'
    with zipfile.ZipFile(apk, 'w') as archive:
        archive.writestr('classes.dex', 'x')
    assert m.signing_schemes(apk) == []

    with_signing_block(apk, [0x7109871A])
    assert m.signature_block(apk) == [], 'v2 leaves META-INF alone'
    assert m.signing_schemes(apk) == ['v2'], m.signing_schemes(apk)
    assert m.require_signature(apk, True, 'loader') == ['v2']

    v3 = tmp / 'v3.apk'
    with zipfile.ZipFile(v3, 'w') as archive:
        archive.writestr('classes.dex', 'x')
    with_signing_block(v3, [0x7109871A, 0xF05368C0])
    assert m.signing_schemes(v3) == ['v2', 'v3'], m.signing_schemes(v3)

    # The shape that shipped in 0.3.16: no v1 material, no signing block.
    shipped = tmp / 'shipped.apk'
    with zipfile.ZipFile(shipped, 'w') as archive:
        archive.writestr('META-INF/com/android/build/gradle/app-metadata.properties', 'x')
        archive.writestr('classes.dex', 'x')
    assert m.signing_schemes(shipped) == [], m.signing_schemes(shipped)
    try:
        m.require_signature(shipped, True, 'loader')
    except m.BuildError as error:
        assert 'INSTALL_PARSE_FAILED_NO_CERTIFICATES' in str(error), str(error)
    else:
        raise AssertionError('the 0.3.16 shape was accepted as signed')
`;
  const result = spawnSync(python, ['-c', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('the release job refuses a stale generated asset before Gradle runs', () => {
  const workflow = readFileSync('.github/workflows/android-release.yml', 'utf8');
  // 0.3.16's loader carried `assets/addons.js` from an older tree (142,443 bytes where the
  // committed bundle was 143,313), and nothing compared the two. Both generators are now
  // checked in the job, before the APK that embeds their output is assembled.
  assert.match(workflow, /npm run build:addons:check/);
  assert.match(workflow, /npm run build:runtime:check/);
  const checked = workflow.indexOf('npm run build:addons:check');
  const built = workflow.indexOf('scripts/build_android.py --all-variants');
  assert.ok(checked > 0 && built > checked, 'the asset check has to run before the build');
});

test('the release job signs when no keystore secret exists, and never ships unsigned', () => {
  const workflow = readFileSync('.github/workflows/android-release.yml', 'utf8');
  // The branch that used to warn and ship is gone: no run may say "UNSIGNED" and hand out
  // an installable-looking APK.
  assert.doesNotMatch(workflow, /signing: UNSIGNED/);
  // The fallback is a real key generated in the job, with the alias the build injects.
  assert.match(workflow, /keytool -genkeypair -keystore "\$HYPERCORD_KEYSTORE_PATH"/);
  assert.match(workflow, /-alias hypercord/);
  // And the password reaches the build through the variable scripts/build_android.py reads.
  assert.match(workflow, /export HYPERCORD_SIGNING_PASSWORD=/);
  assert.match(workflow, /export HYPERCORD_KEYSTORE_PATH="\$RUNNER_TEMP\/generated\.p12"/);
});
