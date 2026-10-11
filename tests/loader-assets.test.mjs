import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
test('loader publication rejects missing/empty assets, wrong entrypoints and duplicated runtime', () => {
  const python = `
import importlib.util,tempfile,zipfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('build_android','scripts/build_android.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assets={'licenses/Acorn-MIT.txt':b'notice','addons.js':b'addons','xposed_init':b'app.assault.loader.AssaultLoader','assault-runtime.js':b'runtime','assault.js':b'capture','account-controls.js':b'controls','rich-presence.js':b'presence','history-export.js':b'history','html-export.js':b'html','licenses/Revenge-BSD-3-Clause.txt':b'notice'}
with tempfile.TemporaryDirectory() as tmp:
 for case in ['valid','missing','empty','entrypoint','duplicate','oversized','missing-license']:
  values=dict(assets)
  if case=='missing-license':del values['licenses/Acorn-MIT.txt']
  if case=='missing':del values['assault-runtime.js']
  if case=='empty':values['assault.js']=b''
  if case=='entrypoint':values['xposed_init']=b'wrong.Class'
  if case=='duplicate':values['revenge.js']=b'extra runtime'
  if case=='oversized':values['assault-runtime.js']=b'x'*(16*1024*1024+1)
  apk=Path(tmp)/'loader.apk'
  with zipfile.ZipFile(apk,'w',zipfile.ZIP_DEFLATED) as z:
   for name,data in values.items():z.writestr('assets/'+name,data)
  try:m.verify_loader_assets(apk)
  except (RuntimeError,KeyError):assert case!='valid',case
  else:assert case=='valid',case
`;
  const result = spawnSync('python3', ['-c', python], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('optional addon injection failure is reported and returns to the existing loader chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assault-loader-isolation-'));
  try {
    const source = readFileSync('android/loader/src/main/java/app/assault/loader/AssaultLoader.java', 'utf8');
    const method = source.slice(source.indexOf('    private void loadOptionalAddons('), source.indexOf('    private static void hookCallback'));
    assert.match(source, /loadOptionalAddons\(assets,call.thisObject,resources.getAssets\(\),call.args\[2\]\);\s*XposedBridge.invokeOriginalMethod\(assets,call.thisObject,new Object\[\]\{resources.getAssets\(\),"assets:\/\/assault-runtime.js"/);
    writeFileSync(join(dir, 'LoaderIsolationTest.java'), `
import java.lang.reflect.Method;
public class LoaderIsolationTest {
 String failure;
 static class AssetManager {}
 static class XposedBridge {
  static boolean fail; static Throwable logged;
  static void invokeOriginalMethod(Method m,Object instance,Object[] args)throws Throwable {if(fail)throw new LinkageError("synthetic addon failure");}
  static void log(Throwable error){logged=error;}
 }
 ${method}
 public static void main(String[] args) {
  LoaderIsolationTest loader=new LoaderIsolationTest();
  loader.loadOptionalAddons(null,null,new AssetManager(),true);
  if(loader.failure!=null||XposedBridge.logged!=null)throw new AssertionError("successful optional load reported failure");
  XposedBridge.fail=true;
  loader.loadOptionalAddons(null,null,new AssetManager(),true);
  if(loader.failure==null||!(XposedBridge.logged instanceof LinkageError))throw new AssertionError("optional load failure was not reported");
 }
}`);
    execFileSync('javac', ['-d', dir, join(dir, 'LoaderIsolationTest.java')]);
    execFileSync('java', ['-cp', dir, 'LoaderIsolationTest']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
