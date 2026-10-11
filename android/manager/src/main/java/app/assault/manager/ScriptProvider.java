package app.assault.manager;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.json.JSONObject;

/** UID and installation-key authenticated broker. No Discord credentials cross this boundary. */
public final class ScriptProvider extends ContentProvider {
    static final String PERMISSION = "com.termux.permission.RUN_COMMAND";
    static final ConcurrentHashMap<String, CompletableFuture<Bundle>> RESULTS = new ConcurrentHashMap<>();
    private static final ReentrantLock OPERATION = new ReentrantLock();
    @Override public boolean onCreate() { return true; }

    private void authorize() throws Exception {
        Context context = getContext();
        int uid = Binder.getCallingUid();
        if (uid == context.getApplicationInfo().uid) return;
        String[] packages = context.getPackageManager().getPackagesForUid(uid);
        // Shared UIDs would allow another application to impersonate the client.
        if (packages == null || packages.length != 1 || !"com.discord".equals(packages[0])) throw new SecurityException("Unrecognized runner caller.");
        var info = context.getPackageManager().getPackageInfo("com.discord", PackageManager.GET_SIGNING_CERTIFICATES);
        var signers = info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
        if (signers == null || signers.length != 1) throw new SecurityException("Client signer unavailable.");
        KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
        try (var stream = new FileInputStream(new File(context.getFilesDir(), "client-signing.bks"))) {
            store.load(stream, "assault-local-key".toCharArray());
        }
        var certificate = store.getCertificate("client");
        if (certificate == null || !MessageDigest.isEqual(certificate.getEncoded(), signers[0].toByteArray())) throw new SecurityException("Client was not signed by this Manager.");
    }

    @Override public Bundle call(String method, String argument, Bundle extras) {
        Bundle response = new Bundle();
        boolean locked = false;
        try {
            authorize();
            if (!"execute".equals(method) || argument == null || argument.getBytes(StandardCharsets.UTF_8).length > 262144) throw new IllegalArgumentException("Invalid runner request.");
            Context context = getContext();
            if (context.checkSelfPermission(PERMISSION) != PackageManager.PERMISSION_GRANTED) throw new SecurityException("Grant Termux execution permission in Manager → Code runner setup.");
            JSONObject request = new JSONObject(argument);
            if (!java.util.List.of("check", "start", "poll", "input", "stop").contains(request.getString("operation"))) throw new IllegalArgumentException("Unknown runner operation.");
            if (java.util.List.of("start", "input").contains(request.getString("operation"))
                && !context.getSharedPreferences("manager", 0).getBoolean("scripts_enabled", false)) throw new IllegalStateException("Open Manager → Code runner setup and enable execution first.");
            locked = OPERATION.tryLock();
            if (!locked) throw new IllegalStateException("A runner request is already in progress. Retry shortly.");
            // Do not forward the client's Binder identity to Termux.
            long identity = Binder.clearCallingIdentity();
            try { response.putString("data", execute(context, argument)); }
            finally { Binder.restoreCallingIdentity(identity); }
        } catch (Exception error) {
            response.putString("error", error instanceof java.util.concurrent.TimeoutException
                ? "Termux did not reply within 25 seconds. Check Termux and refresh this run before retrying."
                : String.valueOf(error.getMessage()));
        } finally { if (locked) OPERATION.unlock(); }
        return response;
    }

    static boolean successful(int error, int exitCode) {
        return error == Activity.RESULT_OK && exitCode == 0;
    }

    static boolean truncated(String originalLength, int receivedLength) {
        if (originalLength == null) return false;
        try { long length = Long.parseLong(originalLength); return length < 0 || length > receivedLength; }
        catch (NumberFormatException error) { return true; }
    }

    private static String execute(Context context, String request) throws Exception {
        String helper;
        try (var in = context.getAssets().open("script_runner.py")) {
            helper = Base64.getEncoder().encodeToString(ReleaseSource.readBounded(in, 65536));
        }
        String bootstrap = "import base64; SOURCE=base64.b64decode('" + helper + "').decode('utf-8'); exec(compile(SOURCE, '<assault-runner>', 'exec'))";
        String id = UUID.randomUUID().toString();
        CompletableFuture<Bundle> future = new CompletableFuture<>();
        RESULTS.put(id, future);
        Intent callback = new Intent(context, ScriptResultReceiver.class).setData(Uri.parse("assault-runner-result://callback/" + id));
        int flags = PendingIntent.FLAG_ONE_SHOT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent result = PendingIntent.getBroadcast(context, 0, callback, flags);
        try {
            Intent command = new Intent("com.termux.RUN_COMMAND").setClassName("com.termux", "com.termux.app.RunCommandService")
                .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/python")
                .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", bootstrap})
                .putExtra("com.termux.RUN_COMMAND_STDIN", request)
                .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
                .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", result);
            if (context.startForegroundService(command) == null) throw new IllegalStateException("Install and open Termux, then install Python and Node.js.");
            Bundle received = future.get(25, TimeUnit.SECONDS);
            if (!successful(received.getInt("err", Activity.RESULT_CANCELED), received.getInt("exitCode", -1))) throw new IllegalStateException("Termux could not execute the helper. Open Termux, enable allow-external-apps and run pkg install python nodejs bash.");
            String output = received.getString("stdout", "");
            if (output.length() > 100000 || truncated(received.getString("stdout_original_length"), output.length())) throw new IllegalStateException("Termux response was truncated. Refresh and retry.");
            return new JSONObject(output).toString();
        } finally { RESULTS.remove(id); result.cancel(); }
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] arguments, String sort) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] arguments) { throw new UnsupportedOperationException(); }
}
