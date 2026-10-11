import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('document deadlines cancel providers, release sessions and reject late completion and resources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assault-document-deadline-'));
  try {
    mkdirSync(join(dir, 'android/os'), { recursive: true });
    const signal = join(dir, 'android/os/CancellationSignal.java');
    writeFileSync(signal, 'package android.os; public class CancellationSignal { public volatile boolean cancelled; public void cancel(){cancelled=true;} }');
    const source = join(dir, 'DocumentDeadlineTest.java');
    writeFileSync(source, `package app.assault.loader;
import java.io.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
public class DocumentDeadlineTest {
 static class Resource implements Closeable { volatile boolean closed; public void close(){closed=true;} }
 public static void main(String[] args)throws Exception {
  AtomicInteger timeouts=new AtomicInteger(),results=new AtomicInteger();
  try(DocumentTask task=new DocumentTask(()->timeouts.incrementAndGet(),50)) {task.complete(()->results.incrementAndGet());}
  Thread.sleep(100);
  if(timeouts.get()!=0||results.get()!=1)throw new AssertionError("successful work retained deadline");
  CountDownLatch released=new CountDownLatch(1),providerReturns=new CountDownLatch(1);
  AtomicReference<DocumentTask> running=new AtomicReference<>();AtomicReference<Throwable> error=new AtomicReference<>();
  Resource open=new Resource(),late=new Resource();
  Thread worker=new Thread(()->{
   try(DocumentTask task=new DocumentTask(()->{timeouts.incrementAndGet();released.countDown();},50)) {
    running.set(task);task.track(open);
    // Model a provider that ignores interruption until its remote request finishes.
    for(;;){try{providerReturns.await();break;}catch(InterruptedException ignored){}}
    task.complete(()->results.incrementAndGet());
    try{task.track(late);throw new AssertionError("late resource accepted");}catch(IOException expected){}
   }catch(Throwable e){error.set(e);}
  });
  worker.start();
  if(!released.await(2,TimeUnit.SECONDS))throw new AssertionError("session not released");
  long until=System.nanoTime()+2_000_000_000L;
  while((!running.get().signal.cancelled||!open.closed)&&System.nanoTime()<until)Thread.sleep(2);
  if(!running.get().signal.cancelled||!open.closed)throw new AssertionError("provider/stream not cancelled");
  // A new operation is usable while the old provider is still stuck.
  try(DocumentTask retry=new DocumentTask(()->timeouts.incrementAndGet(),50)){retry.complete(()->results.incrementAndGet());}
  providerReturns.countDown();worker.join(2000);
  if(worker.isAlive()||error.get()!=null||!late.closed||results.get()!=2||timeouts.get()!=1)throw new AssertionError("late completion changed state",error.get());
 }
}`);
    execFileSync('javac', ['-d', dir, signal, resolve('android/loader/src/main/java/app/assault/loader/DocumentTask.java'), source]);
    execFileSync('java', ['-cp', dir, 'app.assault.loader.DocumentDeadlineTest'], { timeout: 10000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
