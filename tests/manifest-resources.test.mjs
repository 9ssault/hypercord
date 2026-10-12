import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The two checks this suite exercises live in scripts/build_android.py, because that is
// where the APK job asks "can this build run at all?" before it starts Gradle. Both were
// release failures first: a manifest resource AAPT could not find, and a bundle entry two
// sources both provided - each reported from inside a Gradle log.

// `python3` is the name CI and the Android job use. A Windows machine that installed
// Python from python.org has `python` and no `python3` alias, and a check that cannot run
// there is a check nobody runs.
function interpreter() {
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'pass'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return name;
  }
  return null;
}

const python = interpreter();

test('a resource a manifest names and no resource directory provides is named before Gradle runs', (t) => {
  if (!python) return t.skip('no python interpreter on PATH');
  const program = `
import importlib.util, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_android', 'scripts/build_android.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

# The manifests in this tree have to resolve, or the APK job dies inside AAPT with
# "resource xml/data_extraction_rules (aka app.assault.loader:xml/...) not found".
for module in ('loader', 'manager'):
    gaps = m.manifest_resource_gaps(m.ANDROID_DIR / module)
    assert gaps == [], (module, gaps)

# The loader's backup rules belong to the loader, not to android/branding/res: the manager
# reads that directory too and ships its own copy, so sharing one would be a duplicate.
assert (m.ANDROID_DIR / 'loader/src/main/res/xml/data_extraction_rules.xml').is_file()
assert not (m.ANDROID_DIR / 'branding/res/xml/data_extraction_rules.xml').exists()

root = Path(tempfile.mkdtemp()) / 'android'
module = root / 'sample'
(module / 'src/main').mkdir(parents=True)
(module / 'src/main/AndroidManifest.xml').write_text(
    '<manifest><application'
    ' android:theme="@android:style/Theme.Material.NoActionBar"'
    ' android:id="@+id/thing"'
    ' android:label="@string/app_name"'
    ' android:dataExtractionRules="@xml/rules"/></manifest>', encoding='utf-8')

def gaps():
    return sorted(gap['reference'] for gap in m.manifest_resource_gaps(module))

# The platform's own resource and a declared id are not this project's to provide; the
# other two are missing until something provides them.
assert gaps() == ['string/app_name', 'xml/rules'], gaps()

# A value resource is declared in a file rather than named by one.
(module / 'src/main/res/values').mkdir(parents=True)
(module / 'src/main/res/values/strings.xml').write_text(
    '<resources><string name="app_name">x</string></resources>', encoding='utf-8')
assert gaps() == ['xml/rules'], gaps()
(module / 'src/main/res/xml').mkdir(parents=True)
(module / 'src/main/res/xml/rules.xml').write_text('<data-extraction-rules/>', encoding='utf-8')
assert gaps() == [], gaps()

# The shared sibling directory satisfies a reference as well - which is where the
# loader's @mipmap/ic_launcher comes from.
(module / 'src/main/res/values/strings.xml').unlink()
shared = root / 'branding/res/values'
shared.mkdir(parents=True)
(shared / 'strings.xml').write_text('<resources><string name="app_name">x</string></resources>', encoding='utf-8')
assert gaps() == [], gaps()
`;
  const result = spawnSync(python, ['-c', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('the loader asset tree carries nothing the Gradle task injects into the bundle itself', (t) => {
  if (!python) return t.skip('no python interpreter on PATH');
  const program = `
import importlib.util, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_android', 'scripts/build_android.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

# The task copies android/licenses/* into the bundle, so a copy in the asset tree fails
# the build with "Entry licenses/Revenge-BSD-3-Clause.txt is a duplicate but no duplicate
# handling strategy has been set" - the failure this suite exists to keep out.
assert m.loader_asset_collisions(m.ANDROID_DIR / 'loader') == []

root = Path(tempfile.mkdtemp())
module = root / 'loader'
(module / 'src/main/assets/licenses').mkdir(parents=True)
(module / 'src/main/assets/addons.js').write_text('// bundle entry\\n', encoding='utf-8')
(module / 'src/main/assets/licenses/Revenge-BSD-3-Clause.txt').write_text('notice\\n', encoding='utf-8')
assert m.loader_asset_collisions(module) == ['licenses/Revenge-BSD-3-Clause.txt']
`;
  const result = spawnSync(python, ['-c', program], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
