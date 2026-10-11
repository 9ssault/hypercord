package app.assault.loader;

import android.content.Context;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import de.robv.android.xposed.XposedBridge;

/** Separate mailbox/worker so script status never occupies an addon document session. */
final class ScriptDocuments {
    private static boolean running;
    static void cleanup(Context context) {
        File[] files = context.getCacheDir().listFiles((directory, name) -> name.equals("assault-script-request.json") || name.startsWith("assault-script-result-") || name.startsWith(".pending-assault-script-result-"));
        if (files != null) for (File file : files) if (file.isFile()) file.delete();
    }
    static synchronized void begin(Context context, String id) throws Exception {
        if (running) throw new IOException("A runner request is already in progress. Refresh shortly.");
        File mailbox = new File(context.getCacheDir(), "assault-script-request.json");
        JSONObject request;
        try (var in = new FileInputStream(mailbox)) { request = new JSONObject(AddonTransfer.decode(AddonTransfer.read(in, 1024 * 1024))); }
        if (!id.equals(request.optString("id"))) throw new IOException("Expired script request.");
        if (!"runner".equals(request.optString("operation"))) throw new IOException("Unknown script request.");
        mailbox.delete();
        File output = new File(context.getCacheDir(), "assault-script-result-" + id + ".json");
        var resolver = context.getContentResolver();
        running = true;
        Thread worker = new Thread(() -> {
            try {
                JSONObject result;
                try { result = AddonDocuments.runner(request, resolver); }
                catch (Exception error) {
                    String message = String.valueOf(error.getMessage());
                    result = new JSONObject().put("error", message.substring(0, Math.min(240, message.length())));
                }
                AddonFiles.publish(output, result.toString().getBytes(StandardCharsets.UTF_8));
            } catch (Exception error) { XposedBridge.log("Assault script result could not be saved: " + error.getClass().getSimpleName()); }
            finally { synchronized (ScriptDocuments.class) { running = false; } }
        }, "Assault script bridge");
        try { worker.start(); }
        catch (RuntimeException error) { running = false; throw error; }
    }
}
