package app.assault.loader;

import android.app.Activity;
import android.content.Intent;
import android.content.Context;
import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.provider.DocumentsContract;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.XposedHelpers;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONObject;

/** Host-only document and HTTPS transport. The addon interpreter has no bridge references. */
final class AddonDocuments {
    private static final int ARCHIVE_LIMIT = 4 * 1024 * 1024;
    private static final int SOURCE_LIMIT = 64 * 1024;
    private static WeakReference<Activity> foreground = new WeakReference<>(null);
    private static Session active;
    private static int sequence;
    private static final class Session {
        final File cacheDirectory;
        final String id;
        final JSONObject request;
        final int code;
        boolean writing;
        Session(Activity activity, String id, JSONObject request, int code) {
            this.cacheDirectory = activity.getCacheDir(); this.id = id; this.request = request; this.code = code;
        }
    }
    static void cleanup(Context context) {
        ScriptDocuments.cleanup(context);
        File[] files = context.getCacheDir().listFiles((dir, name) -> name.equals("assault-addon-request.json") || name.startsWith("assault-addon-result-") || name.startsWith(".pending-assault-addon-result-"));
        if (files != null) for (File file : files) if (file.isFile()) file.delete();
    }
    static void resumed(Activity activity) { foreground = new WeakReference<>(activity); }
    static void install(ClassLoader loader) {
        try {
            Class<?> promise = loader.loadClass("com.facebook.react.bridge.Promise");
            XposedHelpers.findAndHookMethod("com.facebook.react.modules.intent.IntentModule", loader, "openURL", String.class, promise, new XC_MethodHook() {
                @Override protected void beforeHookedMethod(MethodHookParam call) {
                    String url = (String) call.args[0];
                    if (url == null || (!url.startsWith("assault-addons://") && !url.startsWith("assault-scripts://"))) return;
                    call.setResult(null);
                      try {
                            Uri uri = Uri.parse(url);
                            String id = uri.getLastPathSegment();
                            if (!"request".equals(uri.getHost()) || id == null || !id.matches("[0-9]{10,16}-[0-9]{1,6}")) throw new IOException("Invalid addon request.");
                            Activity activity = foreground.get();
                            if (activity == null || activity.isFinishing()) throw new IOException("Reopen Discord and retry.");
                            if ("assault-scripts".equals(uri.getScheme())) ScriptDocuments.begin(activity.getApplicationContext(), id);
                            else begin(activity, id);
                            XposedHelpers.callMethod(call.args[1], "resolve", true);
                        } catch (Exception error) {
                            XposedHelpers.callMethod(call.args[1], "reject", "ASSAULT_ADDONS", "Addon file operation unavailable: " + error.getMessage());
                        }
                    }
                });
            } catch (Throwable error) { XposedBridge.log("Assault addon document bridge unavailable: " + error.getClass().getSimpleName()); }
        }
        private static synchronized void begin(Activity activity, String id) throws Exception {
            if (active != null && active.writing) throw new IOException("Finish the existing file operation first.");
            File requestFile = new File(activity.getCacheDir(), "assault-addon-request.json");
            JSONObject request;
            try (InputStream in = new FileInputStream(requestFile)) { request = new JSONObject(AddonTransfer.decode(read(in, ARCHIVE_LIMIT * 2))); }
            if (!id.equals(request.optString("id"))) throw new IOException("Expired addon request.");
            requestFile.delete();
            String operation = request.getString("operation");
            if (!Arrays.asList("import", "importScript", "runner", "restore", "export", "download", "uploadBackup", "downloadBackup").contains(operation)) throw new IOException("Unknown addon operation.");
            if (operation.equals("export")) {
                byte[] bytes = request.getString("data").getBytes(StandardCharsets.UTF_8);
                if (bytes.length == 0 || bytes.length > ARCHIVE_LIMIT) throw new IOException("Invalid backup size.");
                new JSONObject(AddonTransfer.decode(bytes));
            }
            if (active != null) {
                // A picker can lose its callback after a React reload. A new valid
                // request supersedes it; unique request codes reject any late result.
                int previousCode = active.code;
                finish(active, null, "File selection replaced by a new request.");
                activity.runOnUiThread(() -> {
                    try { activity.finishActivity(previousCode); } catch (RuntimeException ignored) { }
                });
            }
            boolean picker = Arrays.asList("import", "importScript", "restore", "export").contains(operation);
            if (picker && sequence >= 0x1fff) throw new IOException("Restart Discord before another document operation.");
            Session session = new Session(activity, id, request, picker ? 0x2000 + ++sequence : 0);
            active = session;
            if (picker) {
                activity.runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(operation.equals("export") ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT)
                            .addCategory(Intent.CATEGORY_OPENABLE).setType(operation.equals("export") ? "application/json" : "*/*");
                        if (operation.equals("export")) intent.putExtra(Intent.EXTRA_TITLE, "Assault-addons.json");
                        activity.startActivityForResult(intent, session.code);
                    } catch (RuntimeException error) { finish(session, null, "Document picker unavailable. Please retry."); }
                });
            } else {
                session.writing = true;
                ContentResolver resolver = activity.getApplicationContext().getContentResolver();
                new Thread(() -> {
                    try { finish(session, transfer(session, resolver), null); }
                    catch (Exception error) { finish(session, null, error.getMessage()); }
                }, "Assault addon transfer").start();
            }
        }
        static synchronized void result(Activity activity, int request, int result, Intent intent) {
            Session session = active;
            if (session == null || session.code != request || session.writing) return;
            if (result != Activity.RESULT_OK || intent == null || intent.getData() == null) { finish(session, null, "File selection cancelled."); return; }
            session.writing = true;
            Uri uri = intent.getData();
            ContentResolver resolver = activity.getApplicationContext().getContentResolver();
            new Thread(() -> {
                try (DocumentTask task = new DocumentTask(() -> finish(session, null, "File operation timed out. Check the storage provider and retry."), 60000)) {
                  try {
                    JSONObject response = new JSONObject();
                    String operation = session.request.getString("operation");
                    if (operation.equals("export")) {
                        byte[] bytes = session.request.getString("data").getBytes(StandardCharsets.UTF_8);
                        if (bytes.length == 0 || bytes.length > ARCHIVE_LIMIT) throw new IOException("Invalid backup size.");
                        new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                        try {
                            try (android.content.res.AssetFileDescriptor file = task.track(resolver.openAssetFileDescriptor(uri, "wt", task.signal));
                                 OutputStream out = task.track(file == null ? null : file.createOutputStream())) {
                                if (out == null) throw new IOException("Destination cannot be opened.");
                                out.write(bytes); out.flush();
                            }
                            try (android.content.res.AssetFileDescriptor file = task.track(resolver.openAssetFileDescriptor(uri, "r", task.signal));
                                 InputStream in = task.track(file == null ? null : file.createInputStream())) {
                                if (!Arrays.equals(bytes, read(in, ARCHIVE_LIMIT))) throw new IOException("Saved backup could not be verified.");
                            }
                        } catch (Exception error) {
                            try { DocumentsContract.deleteDocument(resolver, uri); } catch (Exception ignored) { }
                            throw error;
                        }
                        response.put("saved", true).put("bytes", bytes.length);
                    } else {
                        String name = "";
                        try (Cursor cursor = task.track(resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null, task.signal))) {
                            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                        }
                        if (operation.equals("import") && (name == null || !name.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(js|txt)$"))) throw new IOException("Choose a .js or .txt JavaScript file.");
                        if (operation.equals("importScript") && (name == null || !name.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(js|cjs|mjs|py|sh|txt)$"))) throw new IOException("Choose a .js, .cjs, .mjs, .py, .sh or .txt script.");
                        try (android.content.res.AssetFileDescriptor file = task.track(resolver.openAssetFileDescriptor(uri, "r", task.signal));
                             InputStream in = task.track(file == null ? null : file.createInputStream())) {
                            response.put("data", AddonTransfer.decode(read(in, (operation.equals("import") || operation.equals("importScript")) ? SOURCE_LIMIT : ARCHIVE_LIMIT)));
                        }
                        response.put("filename", name);
                    }
                    task.complete(() -> finish(session, response, null));
                } catch (Exception error) { task.complete(() -> finish(session, null, "File operation failed: " + error.getMessage())); }
            }
        }, "Assault addon document").start();
    }
    private static JSONObject transfer(Session session, ContentResolver resolver) throws Exception {
        JSONObject request = session.request;
        String operation = request.getString("operation");
        if (operation.equals("runner")) {
            return runner(request, resolver);
        }
        byte[] data = AddonTransfer.transfer(operation, request.getString("url"), request.optString("token"),
            request.optString("sha256"), request.optString("data").getBytes(StandardCharsets.UTF_8),
            () -> finish(session, null, "Transfer timed out. Check your connection and retry."));
        if (operation.equals("uploadBackup")) return new JSONObject().put("saved", true);
        return new JSONObject().put("data", AddonTransfer.decode(data)).put("filename", "remote.js");
    }
    static JSONObject runner(JSONObject request, ContentResolver resolver) throws Exception {
        JSONObject payload = request.getJSONObject("request");
        // Base64 avoids 6x JSON escaping and UTF-16 Binder expansion for script source.
        if (payload.has("source")) {
            byte[] source = payload.getString("source").getBytes(StandardCharsets.UTF_8);
            if (source.length > SOURCE_LIMIT) throw new IOException("Script exceeds 64 KiB.");
            payload.remove("source");
            payload.put("sourceBase64", java.util.Base64.getEncoder().encodeToString(source));
        }
        android.os.Bundle result = resolver.call(Uri.parse("content://app.assault.manager.scripts"), "execute", payload.toString(), null);
        if (result == null) throw new IOException("Install the matching Manager and prepare the client again to enable the runner.");
        if (result.containsKey("error")) throw new IOException(result.getString("error"));
        return new JSONObject(result.getString("data", "{}"));
    }
    private static byte[] read(InputStream in, int limit) throws IOException { return AddonTransfer.read(in, limit); }
    private static synchronized void finish(Session session, JSONObject result, String error) {
        if (active != session) return;
        try {
            JSONObject response = result == null ? new JSONObject() : result;
            if (error != null) response.put("error", error.length() > 240 ? error.substring(0, 240) : error);
            AddonFiles.publish(new File(session.cacheDirectory, "assault-addon-result-" + session.id + ".json"),
                response.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception failure) { XposedBridge.log("Assault addon result could not be saved: " + failure.getClass().getSimpleName()); }
        finally { active = null; }
    }
}
