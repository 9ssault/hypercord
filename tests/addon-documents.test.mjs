import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const android = sdk && join(sdk, 'platforms/android-36/android.jar');
const xposed = resolve('android/deps/xposed-api.jar');
test('an expired native request leaves the current mailbox intact for its rightful request', {
  skip: !android || !existsSync(android) || !existsSync(xposed) ? 'Requires prepared Android SDK36 and Xposed build dependency' : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'assault-documents-'));
  // Substitute Android host APIs only; execute the production begin method and real disk I/O.
  const fixtures = {
    'android/app/Activity.java': `package android.app;
public class Activity {
 public static final int RESULT_OK=-1; public static java.io.File cache; public static int opened;
 public java.io.File getCacheDir(){return cache;} public boolean isFinishing(){return false;}
 public void runOnUiThread(Runnable task){task.run();} public void finishActivity(int code){}
 public void startActivityForResult(android.content.Intent intent,int code){opened++;}
 public android.content.Context getApplicationContext(){return new android.content.Context();}
}`,
    'android/content/Context.java': `package android.content; public class Context { public android.content.ContentResolver getContentResolver(){return null;} public java.io.File getCacheDir(){return android.app.Activity.cache;} }`,
    'android/content/Intent.java': `package android.content;
public class Intent {
 public static final String ACTION_CREATE_DOCUMENT="create",ACTION_OPEN_DOCUMENT="open",CATEGORY_OPENABLE="openable",EXTRA_TITLE="title";
 public Intent(String action){} public Intent addCategory(String category){return this;}
 public Intent setType(String type){return this;} public Intent putExtra(String key,String value){return this;}
 public android.net.Uri getData(){return null;}
}`,
    'org/json/JSONObject.java': `package org.json;
public class JSONObject {
 private final java.util.Map<String,String> fields=new java.util.HashMap<>();
 public JSONObject(){}
 public JSONObject(String text){
  java.util.regex.Matcher matcher=java.util.regex.Pattern.compile("\\\"([^\\\"]+)\\\":\\\"([^\\\"]*)\\\"").matcher(text);
  while(matcher.find())fields.put(matcher.group(1),matcher.group(2));
 }
 public String optString(String key){return fields.getOrDefault(key,"");}
 public String getString(String key){if(!fields.containsKey(key))throw new IllegalArgumentException(key);return fields.get(key);}
 public boolean has(String key){return fields.containsKey(key);}
 public Object remove(String key){return fields.remove(key);}
 public JSONObject getJSONObject(String key){return new JSONObject(getString(key));}
 public JSONObject put(String key,Object value){fields.put(key,String.valueOf(value));return this;}
 public String toString(){return fields.toString();}
}`,
    'app/assault/loader/DocumentsTest.java': `package app.assault.loader;
public class DocumentsTest {
 public static void main(String[] args)throws Exception {
  android.app.Activity.cache=new java.io.File(args[0]);
  var mailbox=new java.io.File(args[0],"assault-addon-request.json");
  byte[] request="{\\\"id\\\":\\\"1234567890123-2\\\",\\\"operation\\\":\\\"import\\\"}".replace("\\\\\\\"","\\\"").getBytes(java.nio.charset.StandardCharsets.UTF_8);
  java.nio.file.Files.write(mailbox.toPath(),request);
  var begin=AddonDocuments.class.getDeclaredMethod("begin",android.app.Activity.class,String.class);begin.setAccessible(true);
  try{begin.invoke(null,new android.app.Activity(),"1234567890123-1");throw new AssertionError("stale request accepted");}
  catch(java.lang.reflect.InvocationTargetException expected){if(!expected.getCause().getMessage().equals("Expired addon request."))throw expected;}
  if(!java.util.Arrays.equals(request,java.nio.file.Files.readAllBytes(mailbox.toPath())))throw new AssertionError("current request lost");
  if(android.app.Activity.opened!=0)throw new AssertionError("stale request opened picker");
  begin.invoke(null,new android.app.Activity(),"1234567890123-2");
  if(mailbox.exists()||android.app.Activity.opened!=1)throw new AssertionError("valid request not consumed exactly once");
  var active=AddonDocuments.class.getDeclaredField("active");active.setAccessible(true);Object picker=active.get(null);
  var scriptMailbox=new java.io.File(args[0],"assault-script-request.json");
  byte[] scriptRequest=new String(request,java.nio.charset.StandardCharsets.UTF_8).replace("import","runner").getBytes(java.nio.charset.StandardCharsets.UTF_8);
  java.nio.file.Files.write(scriptMailbox.toPath(),scriptRequest);
  try{ScriptDocuments.begin(new android.content.Context(),"1234567890123-1");throw new AssertionError("stale script request accepted");}catch(java.io.IOException expected){}
  if(!java.util.Arrays.equals(scriptRequest,java.nio.file.Files.readAllBytes(scriptMailbox.toPath())))throw new AssertionError("script mailbox lost");
  ScriptDocuments.begin(new android.content.Context(),"1234567890123-2");
  var running=ScriptDocuments.class.getDeclaredField("running");running.setAccessible(true);
  for(int i=0;i<400;i++){synchronized(ScriptDocuments.class){if(!running.getBoolean(null))break;}Thread.sleep(5);}
  if(active.get(null)!=picker||!new java.io.File(args[0],"assault-script-result-1234567890123-2.json").isFile())throw new AssertionError("script request disturbed document picker");
  active.set(null,null);
  var sequence=AddonDocuments.class.getDeclaredField("sequence");sequence.setAccessible(true);sequence.setInt(null,0x1fff);
  byte[] runner=new String(request,java.nio.charset.StandardCharsets.UTF_8).replace("import","runner").getBytes(java.nio.charset.StandardCharsets.UTF_8);
  java.nio.file.Files.write(mailbox.toPath(),runner);
  begin.invoke(null,new android.app.Activity(),"1234567890123-2");
  if(sequence.getInt(null)!=0x1fff)throw new AssertionError("poll consumed a picker code");
  long deadline=System.nanoTime()+2_000_000_000L;
  while(active.get(null)!=null && System.nanoTime()<deadline)Thread.sleep(5);
  if(active.get(null)!=null)throw new AssertionError("worker did not finish");
 }
}`,
  };
  try {
    const sources = Object.entries(fixtures).map(([name, code]) => {
      const path = join(dir, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, code); return path;
    });
    const production = ['AddonDocuments', 'AddonTransfer', 'AddonFiles', 'ScriptDocuments', 'DocumentTask'].map(name => resolve(`android/loader/src/main/java/app/assault/loader/${name}.java`));
    const classpath = [dir, android, xposed].join(delimiter);
    execFileSync('javac', ['-cp', classpath, '-d', dir, ...sources, ...production]);
    execFileSync('java', ['-cp', classpath, 'app.assault.loader.DocumentsTest', dir]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
