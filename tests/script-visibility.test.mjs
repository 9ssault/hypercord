import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
test('client manifest query rewrite preserves existing package visibility and app attributes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assault-script-visibility-'));
  try {
    const source = readFileSync('android/manager/src/main/java/org/lsposed/patch/ApkPatcher.java', 'utf8');
    const start = source.indexOf('        pxb.android.axml.AxmlWriter writer =');
    const finish = source.indexOf('        return writer.toByteArray();', start) + '        return writer.toByteArray();'.length;
    if (start < 0 || finish < start) throw Error('Manifest query transform missing');
    writeFileSync(join(dir, 'VisibilityTest.java'), `
import pxb.android.axml.*;
public class VisibilityTest {
 static byte[] transform(byte[] input)throws Exception {
  java.io.ByteArrayOutputStream os=new java.io.ByteArrayOutputStream();os.write(input);
  ${source.slice(start, finish)}
 }
 public static void main(String[] args)throws Exception {
  AxmlWriter writer=new AxmlWriter();
  NodeVisitor manifest=writer.child(null,"manifest");manifest.attr(null,"package",-1,3,"com.discord");
  NodeVisitor queries=manifest.child(null,"queries");NodeVisitor original=queries.child(null,"package");
  original.attr("http://schemas.android.com/apk/res/android","name",0x01010003,3,"existing.provider");original.end();queries.end();
  NodeVisitor app=manifest.child(null,"application");app.attr("http://schemas.android.com/apk/res/android","label",0x01010001,3,"Assault");app.end();manifest.end();writer.end();
  java.util.Set<String> packages=new java.util.HashSet<>();boolean[] preserved={false,false};
  new AxmlReader(transform(writer.toByteArray())).accept(new AxmlVisitor(){
   @Override public NodeVisitor child(String ns,String name){
    if(!"manifest".equals(name))return null;
    return new NodeVisitor(){
     @Override public void attr(String ns,String name,int resource,int type,Object value){if("package".equals(name)&&"com.discord".equals(value))preserved[0]=true;}
     @Override public NodeVisitor child(String ns,String name){
      if("application".equals(name))return new NodeVisitor(){@Override public void attr(String ns,String name,int resource,int type,Object value){if("label".equals(name)&&"Assault".equals(value))preserved[1]=true;}};
      if(!"queries".equals(name))return null;
      return new NodeVisitor(){@Override public NodeVisitor child(String ns,String name){return new NodeVisitor(){@Override public void attr(String ns,String name,int resource,int type,Object value){if("name".equals(name))packages.add(String.valueOf(value));}};}};
     }
    };
   }
  });
  if(!packages.equals(java.util.Set.of("existing.provider","app.assault.manager"))||!preserved[0]||!preserved[1])throw new AssertionError(packages.toString());
 }
}`);
    const dependency = resolve('android/deps/lspatch.jar');
    execFileSync('javac', ['-cp', dependency, '-d', dir, join(dir, 'VisibilityTest.java')]);
    execFileSync('java', ['-cp', [dir, dependency].join(delimiter), 'VisibilityTest']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
