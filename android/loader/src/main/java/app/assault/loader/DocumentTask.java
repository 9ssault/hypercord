package app.assault.loader;

import android.os.CancellationSignal;
import java.io.Closeable;
import java.io.IOException;
import java.util.Timer;
import java.util.TimerTask;

/** Owns a document operation's deadline and rejects completion after cancellation. */
final class DocumentTask implements AutoCloseable {
    final CancellationSignal signal = new CancellationSignal();
    private final Timer timer = new Timer("Assault document deadline", true);
    private final Thread worker = Thread.currentThread();
    private boolean settled;
    private Closeable resource;

    DocumentTask(Runnable timedOut, long millis) {
        timer.schedule(new TimerTask() {
            @Override public void run() {
                Closeable pending;
                synchronized (DocumentTask.this) {
                    if (settled) return;
                    settled = true;
                    pending = resource;
                    resource = null;
                }
                // Release the client session before provider cancellation, which may block.
                try { timedOut.run(); }
                finally {
                    worker.interrupt();
                    try { signal.cancel(); }
                    finally { closeQuietly(pending); timer.cancel(); }
                }
            }
        }, millis);
    }

    <T extends Closeable> T track(T value) throws IOException {
        synchronized (this) {
            if (!settled) { resource = value; return value; }
        }
        closeQuietly(value);
        throw new IOException("Document operation expired. Please retry.");
    }

    synchronized void complete(Runnable publish) {
        if (settled) return;
        settled = true;
        timer.cancel();
        publish.run();
    }

    @Override public synchronized void close() {
        settled = true;
        resource = null;
        timer.cancel();
    }

    private static void closeQuietly(Closeable value) {
        if (value != null) try { value.close(); } catch (Exception ignored) { }
    }
}
