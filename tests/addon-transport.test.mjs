import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
test('native HTTPS transport rejects redirects, wrong checksums, malformed UTF8, missing/oversized/truncated bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assault-addon-transport-'));
  try {
    const source = join(dir, 'AddonTransferTest.java');
    writeFileSync(source, `package app.assault.loader;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import javax.net.ssl.HttpsURLConnection;
public class AddonTransferTest {
 static int status=200; static long length=3; static byte[] payload="abc".getBytes(StandardCharsets.UTF_8);
 static volatile boolean disconnected; static boolean stalled, stalledResponse, stalledBody; static Connection current;
 static class Connection extends HttpsURLConnection {
  ByteArrayOutputStream uploaded=new ByteArrayOutputStream();
  Connection(URL url){super(url);current=this;disconnected=false;}
  public int getResponseCode()throws IOException{if(stalledResponse)awaitDisconnect();if(getInstanceFollowRedirects())throw new AssertionError("redirect enabled");return status;}
  public long getContentLengthLong(){return length;}
  public InputStream getInputStream(){return stalledBody?new InputStream(){public int read()throws IOException{awaitDisconnect();return -1;}}:new ByteArrayInputStream(payload);}
  void awaitDisconnect()throws IOException{while(!disconnected){try{Thread.sleep(2);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException(e);}}throw new IOException("socket closed");}
  public OutputStream getOutputStream(){return stalled?new OutputStream(){public void write(int value)throws IOException{while(!disconnected){try{Thread.sleep(2);}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IOException(e);}}throw new IOException("socket closed");}}:uploaded;}
  public void disconnect(){disconnected=true;} public boolean usingProxy(){return false;} public void connect(){}
  public String getCipherSuite(){return "test";} public Certificate[] getLocalCertificates(){return null;} public Certificate[] getServerCertificates(){return null;}
 }
 interface Operation { void run() throws Exception; }
 static void rejected(Operation op)throws Exception {try{op.run();throw new AssertionError("accepted invalid input");}catch(IOException expected){}}
 static byte[] fetch(String url,String hash)throws Exception{return AddonTransfer.transfer("download",url,"",hash,new byte[0]);}
 public static void main(String[] args)throws Exception {
  URL.setURLStreamHandlerFactory(p->p.equals("https")?new URLStreamHandler(){protected URLConnection openConnection(URL u){return new Connection(u);}}:null);
  String good="https://addons.example/plugin.txt", hash="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  if(!AddonTransfer.decode(fetch(good,hash)).equals("abc")||!disconnected)throw new AssertionError();
  for(String url:new String[]{"http://example.com/a", "file:///tmp/a", "https://user@example.com/a", "https://example.com/a#part"})rejected(()->fetch(url,hash));
  rejected(()->fetch(good,""));rejected(()->fetch(good,"0".repeat(64)));
  for(int code:new int[]{301,302,401,403,429,500}){status=code;rejected(()->fetch(good,hash));if(!disconnected)throw new AssertionError();}
  status=200;length=4;rejected(()->fetch(good,hash));
  length=100000;rejected(()->fetch(good,hash));
  length=-1;payload=new byte[65537];rejected(()->fetch(good,hash));
  payload=new byte[0];rejected(()->fetch(good,hash));
  rejected(()->AddonTransfer.decode(new byte[]{(byte)0xc3,0x28}));
  rejected(()->AddonTransfer.read(null,100));
  byte[] backup="{\\"version\\":1}".getBytes(StandardCharsets.UTF_8);
  AddonTransfer.transfer("uploadBackup",good,"synthetic","",backup);
  if(!java.util.Arrays.equals(current.uploaded.toByteArray(),backup)||!current.getRequestMethod().equals("PUT")||!"Bearer synthetic".equals(current.getRequestProperty("Authorization")))throw new AssertionError();
  rejected(()->AddonTransfer.transfer("uploadBackup",good,"bad\\r\\nheader","",backup));
  rejected(()->AddonTransfer.transfer("uploadBackup",good,"","",new byte[0]));
  java.util.concurrent.atomic.AtomicInteger timeouts=new java.util.concurrent.atomic.AtomicInteger();
  stalled=true;
  rejected(()->AddonTransfer.transfer("uploadBackup",good,"","",backup,()->timeouts.incrementAndGet(),30));
  if(timeouts.get()!=1||!disconnected)throw new AssertionError("stalled upload was not cancelled");
  stalled=false;stalledResponse=true;
  rejected(()->AddonTransfer.transfer("uploadBackup",good,"","",backup,()->timeouts.incrementAndGet(),30));
  if(timeouts.get()!=2)throw new AssertionError("response deadline missing");
  stalledResponse=false;stalledBody=true;length=-1;
  rejected(()->AddonTransfer.transfer("downloadBackup",good,"","",new byte[0],()->timeouts.incrementAndGet(),30));
  if(timeouts.get()!=3)throw new AssertionError("response body deadline missing");
  stalledBody=false;
  AddonTransfer.transfer("uploadBackup",good,"","",backup,()->timeouts.incrementAndGet(),30);
  Thread.sleep(60);
  if(timeouts.get()!=3)throw new AssertionError("successful upload deadline was not cancelled");
 }
}`);
    execFileSync('javac', ['-d', dir, resolve('android/loader/src/main/java/app/assault/loader/AddonTransfer.java'), source]);
    execFileSync('java', ['-cp', dir, 'app.assault.loader.AddonTransferTest']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
