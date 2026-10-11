import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('broker authenticates the local signer and decodes Termux success and failure codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assault-script-trust-'));
  try {
    mkdirSync(join(dir, 'keys'));
    execFileSync('keytool', ['-genkeypair', '-alias', 'client', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', 'CN=Synthetic Test', '-storepass', 'assault-local-key', '-keypass', 'assault-local-key', '-keystore', join(dir, 'keys/client-signing.bks')], { stdio: 'pipe' });
    const provider = readFileSync('android/manager/src/main/java/app/assault/manager/ScriptProvider.java', 'utf8');
    const method = provider.slice(provider.indexOf('    private void authorize()'), provider.indexOf('    @Override public Bundle call'));
    const truncated = provider.match(/    static boolean truncated[\s\S]*?\n    }/)[0];
    const successful = provider.match(/    static boolean successful[\s\S]*?\n    }/)[0];
    writeFileSync(join(dir, 'TrustTest.java'), `
import java.io.*;
import java.security.*;
public class TrustTest {
 static class Activity { static int RESULT_OK=-1; }
 ${successful}
 ${truncated}
 static class Binder { static int uid=1; static int getCallingUid(){return uid;} }
 static class PackageManager { static int GET_SIGNING_CERTIFICATES=1; String[] packages={"com.discord"};
  Info info=new Info(); String[] getPackagesForUid(int uid){return packages;} Info getPackageInfo(String p,int flags){return info;} }
 static class Info { SigningInfo signingInfo=new SigningInfo(); }
 static class SigningInfo { Signature[] signers; Signature[] getApkContentsSigners(){return signers;} }
 static class Signature { byte[] data; Signature(byte[] data){this.data=data;} byte[] toByteArray(){return data;} }
 static class AppInfo { int uid=1; }
 static class Context { File dir; PackageManager pm=new PackageManager(); AppInfo getApplicationInfo(){return new AppInfo();} PackageManager getPackageManager(){return pm;} File getFilesDir(){return dir;} }
 static Context context=new Context(); Context getContext(){return context;}
 ${method}
 static void rejected(TrustTest gate)throws Exception {try{gate.authorize();throw new AssertionError("accepted untrusted caller");}catch(SecurityException expected){}}
 public static void main(String[] args)throws Exception {
  if(!successful(-1,0)||successful(0,0)||successful(1,0)||successful(-1,7)||successful(-1,-1))throw new AssertionError("Termux result code handling");
  if(truncated("10",10)||truncated(null,10)||!truncated("11",10)||!truncated("bad",10)||!truncated("-1",10))throw new AssertionError("Termux string output length");
  context.dir=new File(args[0]); TrustTest gate=new TrustTest(); gate.authorize();
  Binder.uid=2;
  context.pm.packages=new String[]{"evil.app"};rejected(gate);
  context.pm.packages=new String[]{"com.discord","evil.app"};rejected(gate);
  context.pm.packages=new String[]{"com.discord"};
  KeyStore store=KeyStore.getInstance(KeyStore.getDefaultType());try(var in=new FileInputStream(new File(context.dir,"client-signing.bks"))){store.load(in,"assault-local-key".toCharArray());}
  byte[] cert=store.getCertificate("client").getEncoded();
  context.pm.info.signingInfo.signers=new Signature[]{new Signature(cert)};gate.authorize();
  context.pm.info.signingInfo.signers=new Signature[]{new Signature(new byte[]{1,2,3})};rejected(gate);
  context.pm.info.signingInfo.signers=new Signature[]{new Signature(cert),new Signature(cert)};rejected(gate);
  context.pm.info.signingInfo=null;rejected(gate);
 }
}`);
    execFileSync('javac', ['-d', dir, join(dir, 'TrustTest.java')]);
    execFileSync('java', ['-cp', dir, 'TrustTest', join(dir, 'keys')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
