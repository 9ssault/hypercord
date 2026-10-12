package app.assault.loader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * The hand-off that makes a result visible: a finished addon or script request becomes a
 * file in the client's cache, and the injected page reads it from there.
 *
 * This class exists because the loader did not compile without it - `AddonDocuments.finish`
 * and `ScriptDocuments`'s worker both call `publish(File, byte[])`, and nothing defined it.
 *
 * Publication is a rename, not a write. The page watches for `assault-addon-result-<id>.json`
 * and `assault-script-result-<id>.json`; a half-written file under the final name would be a
 * truncated JSON answer read as a complete one, so the bytes go to `.pending-<name>` first,
 * are flushed and synced, and only then take the final name. That is also why
 * `ScriptDocuments.cleanup` deletes `.pending-` files: they are the only ones a killed
 * process can leave behind.
 *
 * Two shapes of rename are handled because both happen on Android: replacing an existing
 * file, and a filesystem that refuses to replace one. In the second case the old file is
 * removed and the rename retried once; if it still fails, the pending file is removed rather
 * than left to be mistaken for a result, and the caller is told.
 */
final class AddonFiles {
    private AddonFiles() {}

    static void publish(File target, byte[] data) throws IOException {
        if (target == null) throw new IOException("No destination for the result file.");
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
            throw new IOException("Could not create " + parent.getName() + " for the result file.");
        }
        File pending = new File(parent == null ? new File(".") : parent, ".pending-" + target.getName());
        try (FileOutputStream out = new FileOutputStream(pending)) {
            out.write(data == null ? new byte[0] : data);
            out.flush();
            out.getFD().sync();
        }
        if (pending.renameTo(target)) return;
        // A rename that cannot replace an existing file is not a failed publication yet:
        // remove the stale result and try once more, because the new bytes are already on
        // disk and losing them would be worse than the extra call.
        if (target.isFile() && target.delete() && pending.renameTo(target)) return;
        pending.delete();
        throw new IOException("Could not publish " + target.getName() + ".");
    }
}
