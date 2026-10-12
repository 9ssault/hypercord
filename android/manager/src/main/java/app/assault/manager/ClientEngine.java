package app.assault.manager;

import android.content.Context;
import android.os.Build;
import com.android.apksig.ApkVerifier;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.lsposed.patch.*;
import org.lsposed.patch.util.Logger;

final class ClientEngine {
    static final String CLIENT = "com.discord";
    static final String DISCORD_SIGNER = "3c39d23cf9367849a5c699395647fe0e5bfea5a1f1f40d8c717ddc70f8bfa113";
    static final AtomicBoolean busy = new AtomicBoolean();
    private static final AtomicBoolean canceled = new AtomicBoolean();
    static final AtomicBoolean installing = new AtomicBoolean();
    static volatile String progress = "Ready";
    static synchronized boolean beginInstall() {
        return !busy.get() && installing.compareAndSet(false, true);
    }
    static synchronized boolean beginPrepare() {
        if (installing.get() || !busy.compareAndSet(false, true)) return false;
        canceled.set(false); return true;
    }
    static void cancel() { if (busy.get()) canceled.set(true); }
    private static void checkCanceled() {
        if (canceled.get() || Thread.currentThread().isInterrupted()) throw new java.util.concurrent.CancellationException("Preparation canceled; previous prepared client kept");
    }
    static boolean needsUpdate(Context context,long latest) {
        var prefs=context.getSharedPreferences("manager",0);
        return latest>installed(context) || prefs.getInt("installed_loader",0)<BuildConfig.VERSION_CODE;
    }
    static void clearDownloads(Context context) throws IOException {
        if(!beginPrepare())throw new IOException("Wait for the active operation");
        try {
            File releases=new File(context.getFilesDir(),"releases");
            File keep=new File(context.getFilesDir(),context.getSharedPreferences("manager",0).getString("prepared_dir","releases/none"));
            File[] versions=releases.listFiles();
            if(versions!=null)for(File version:versions){
                File[] children=version.listFiles();
                if(children!=null)for(File child:children)if(!child.equals(keep))removeTree(child);
                File[] remaining=version.listFiles();if(remaining!=null && remaining.length==0)version.delete();
            }
            synchronized(ManagerUpdater.class){for(String name:new String[]{"manager-download.apk","manager-download.apk.part"})new File(context.getCacheDir(),name).delete();}
        } finally { busy.set(false);context.getSharedPreferences("manager",0).edit().putLong("stateRevision",System.nanoTime()).apply(); }
    }
    static long installed(Context context) {
        try { return context.getPackageManager().getPackageInfo(CLIENT, 0).getLongVersionCode(); }
        catch (Exception ignored) { return 0; }
    }
    static List<File> prepared(Context context) {
        long version = context.getSharedPreferences("manager", 0).getLong("prepared", 0);
        String directory = context.getSharedPreferences("manager", 0).getString("prepared_dir", "releases/" + version + "/patched");
        File dir = new File(context.getFilesDir(), directory);
        File[] files = dir.listFiles((d, name) -> name.endsWith(".apk"));
        if (files == null || files.length != 4 || !new File(dir, "checksums.json").isFile()) return List.of();
        Arrays.sort(files, Comparator.comparing(File::getName));
        return Arrays.asList(files);
    }
    static void verifyPrepared(Context context, List<File> files) throws Exception {
        if (files.size() != 4) throw new IOException("Prepare the complete client first");
        File manifest = new File(files.get(0).getParentFile(), "checksums.json");
        org.json.JSONObject hashes;
        try (InputStream in = new FileInputStream(manifest)) {
            hashes = new org.json.JSONObject(new String(ReleaseSource.readBounded(in, 8192), java.nio.charset.StandardCharsets.UTF_8));
        }
        if (hashes.length() != files.size()) throw new IOException("Prepared client manifest is incomplete. Prepare again.");
        for (File file : files) {
            if (!sha256(file).equals(hashes.optString(file.getName(), "")))
                throw new IOException("Prepared client integrity check failed. Prepare again.");
        }
    }
    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[65536]; int count;
            while ((count = in.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return String.format(Locale.ROOT, "%064x", new java.math.BigInteger(1, digest.digest()));
    }
    private static void verifyLoader(Context context, File module) throws Exception {
        var result = new ApkVerifier.Builder(module).setMinCheckedPlatformVersion(28).build().verify();
        var info = context.getPackageManager().getPackageArchiveInfo(module.getPath(), 0);
        if (!result.isVerified() || info == null || !"app.assault.loader".equals(info.packageName)
            || info.getLongVersionCode() != BuildConfig.VERSION_CODE)
            throw new IOException("Embedded loader does not match this Manager. Reinstall Manager from a verified release.");
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(module)) {
            for (String name : List.of("xposed_init", "assault-runtime.js", "assault.js", "account-controls.js", "rich-presence.js", "history-export.js", "html-export.js")) {
                var entry = zip.getEntry("assets/" + name);
                if (entry == null || entry.getSize() <= 0) throw new IOException("Embedded loader is missing " + name);
            }
        }
    }
    static void prepare(Context context, long version, ReleaseSource.Progress listener) throws Exception {
        if (!beginPrepare()) throw new IOException("Another update is already running");
        prepareReserved(context, version, listener);
    }
    static void prepareReserved(Context context, long version, ReleaseSource.Progress listener) throws Exception {
        File patched = null;
        File module = null;
        boolean published = false;
        try {
            ReleaseSource.Progress report = message -> { checkCanceled(); progress = message; listener.report(message); };
            File dir = new File(context.getFilesDir(), "releases/" + version);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create update directory");
            String abi = Build.SUPPORTED_ABIS[0].replace("-v", "_v");
            if(!List.of("arm64_v8a","armeabi_v7a","x86","x86_64").contains(abi))throw new IOException("Unsupported device ABI: "+abi);
            List<File> originals = new ArrayList<>();
            for (String split : List.of("base", "config." + abi, "config.en", "config.xxhdpi")) {
                File apk = new File(dir, split.equals("base") ? "base.apk" : "split_" + split + ".apk");
                report.report("Fetching " + split);
                if (!apk.isFile()) ReleaseSource.download(ReleaseSource.MIRROR + "/tracker/download/" + version + "/" + split, apk, report);
                try { verifyOriginal(context, apk, version); } catch(Exception invalid) { apk.delete(); throw invalid; }
                originals.add(apk);
            }
            module = new File(dir, "assault-loader.apk");
            try (InputStream in = context.getAssets().open("loader.apk"); OutputStream out = new FileOutputStream(module)) { ReleaseSource.copy(in, out); }
            report.report("Verifying embedded Hypercord loader " + BuildConfig.VERSION_NAME);
            verifyLoader(context, module);
            report.report("Merging embedded loader into native Discord");
            Logger logger = new Logger() {
                public void d(String message) { android.util.Log.d("HypercordPatcher", message); }
                public void i(String message) { report.report(message); }
                public void e(String message) { report.report(message); }
            };
            long required=32L*1024*1024;for(File original:originals)required+=original.length();
            if(dir.getUsableSpace()<required)throw new IOException("Not enough storage to patch. Free at least "+(required/1048576)+" MiB, then retry.");
            checkCanceled();
            patched = java.nio.file.Files.createTempDirectory(dir.toPath(), "patched-").toFile();
            PatchSpec spec = PatchSpec.builder().apks(originals).outputDir(patched)
                .module(module).sigBypassLevel(0).forceOverwrite(true).keystore(Signing.key(context))
                .manifestOverrides(ManifestOverrides.builder().label("Hypercord").build()).build();
            List<String> iconPaths=Branding.paths(context,originals.get(0));
            byte[] icon=Branding.icon(context);
            List<File> outputs = NativePatcher.patch(logger,spec,iconPaths,icon);
            checkCanceled();
            if (outputs.size() != 4) throw new IOException("Incomplete patched split set");
            for (File apk : outputs) {
                if (!new ApkVerifier.Builder(apk).setMinCheckedPlatformVersion(28).build().verify().isVerified()) throw new IOException("Patched APK failed signature verification");
            }
            try (java.util.zip.ZipFile base = new java.util.zip.ZipFile(outputs.get(0))) {
                if (base.getEntry("assets/lspatch/modules/app.assault.loader.apk") == null) throw new IOException("Patched client is missing Hypercord's module");
            }
            org.json.JSONObject hashes = new org.json.JSONObject();
            for (File apk : outputs) hashes.put(apk.getName(), sha256(apk));
            try (FileOutputStream out = new FileOutputStream(new File(patched, "checksums.json"))) {
                out.write(hashes.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            checkCanceled();
            if (!context.getSharedPreferences("manager", 0).edit().putLong("prepared", version).putInt("prepared_loader",BuildConfig.VERSION_CODE).putString("prepared_dir", "releases/" + version + "/" + patched.getName()).putString("message", "Update prepared. Tap Install to confirm in Android.").commit()) throw new IOException("Could not save prepared update state");
            published = true;
            // Keep only the prepared APKs; the patcher preserves the original inside each output.
            // Cleanup happens only after publishing the verified set. A interrupted rebuild
            // keeps the previous set usable until this point.
            for (File original : originals) original.delete();
            module.delete();
            File releases = new File(context.getFilesDir(), "releases");
            File[] versions = releases.listFiles();
            if (versions != null) for (File old : versions) {
                if (!old.equals(dir)) removeTree(old);
                else { File[] children = old.listFiles(); if (children != null) for (File child : children) if (!child.equals(patched)) removeTree(child); }
            }
            progress = "Ready to install";
            listener.report(progress);
        } finally {
            if (!published && patched != null) removeTree(patched);
            if (!published && module != null) module.delete();
            busy.set(false);
            context.getSharedPreferences("manager",0).edit().putLong("stateRevision",System.nanoTime()).apply();
        }
    }
    private static void removeTree(File file) {
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children != null) for (File child : children) removeTree(child); }
        file.delete();
    }
    static void verifyOriginal(Context context, File apk, long version) throws Exception {
        ApkVerifier.Result result = new ApkVerifier.Builder(apk).setMinCheckedPlatformVersion(28).build().verify();
        if (!result.isVerified() || result.getSignerCertificates().size() != 1) throw new IOException("Invalid Discord APK signature");
        String hash = String.format(Locale.ROOT, "%064x", new java.math.BigInteger(1, MessageDigest.getInstance("SHA-256").digest(result.getSignerCertificates().get(0).getEncoded())));
        if (!DISCORD_SIGNER.equals(hash)) throw new IOException("Unrecognized Discord signer");
        final String[] pkg = {null};
        final long[] code = {-1};
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(apk); InputStream in = zip.getInputStream(zip.getEntry("AndroidManifest.xml"))) {
            byte[] xml = ReleaseSource.readBounded(in, 4 * 1024 * 1024);
            new pxb.android.axml.AxmlReader(xml).accept(new pxb.android.axml.AxmlVisitor() {
                @Override public pxb.android.axml.NodeVisitor child(String ns, String name) {
                    if (!"manifest".equals(name)) return null;
                    return new pxb.android.axml.NodeVisitor() {
                        @Override public void attr(String ns, String name, int id, int type, Object value) {
                            if ("package".equals(name)) pkg[0] = String.valueOf(value);
                            if ("versionCode".equals(name) && value instanceof Number) code[0] = ((Number)value).longValue();
                        }
                    };
                }
            });
        }
        if (!CLIENT.equals(pkg[0]) || code[0] != version) throw new IOException("Discord package/version mismatch");
    }
}
