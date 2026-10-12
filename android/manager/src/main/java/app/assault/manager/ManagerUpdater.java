package app.assault.manager;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import com.android.apksig.ApkVerifier;
import java.io.*;
import java.util.Arrays;

final class ManagerUpdater {
    static File prepared(Context context) { return new File(context.getFilesDir(), "manager-update.apk"); }
    static synchronized String check(Context context) throws Exception {
        var release = ReleaseSource.json(ReleaseSource.MANAGER_RELEASE);
        PackageInfo current = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
        String remote = release.optString("tag_name", "").replaceFirst("^v", "");
        if (!newer(remote, current.versionName)) return "Manager is up to date.";
        var assets = release.getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) {
            var asset = assets.getJSONObject(i);
            if (!"Hypercord-Manager.apk".equals(asset.optString("name"))) continue;
            File apk = new File(context.getCacheDir(), "manager-download.apk");
            try {
            ReleaseSource.download(asset.getString("browser_download_url"), apk, message -> {});
            var verified = new ApkVerifier.Builder(apk).setMinCheckedPlatformVersion(28).build().verify();
            PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (!verified.isVerified() || info == null || info.signingInfo == null || current.signingInfo == null || !context.getPackageName().equals(info.packageName)
                || !Arrays.equals(info.signingInfo.getApkContentsSigners(), current.signingInfo.getApkContentsSigners())) throw new IOException("Manager update signature mismatch");
            if (info.getLongVersionCode() <= current.getLongVersionCode()) { apk.delete(); return "Manager is up to date."; }
            java.nio.file.Files.move(apk.toPath(), prepared(context).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return "Manager " + info.versionName + " is ready to install.";
            } finally {apk.delete();}
        }
        return "No Manager APK is published for " + remote + ".";
    }
    static boolean newer(String remote, String local) {
        if (!remote.matches("\\d+\\.\\d+\\.\\d+") || local == null || !local.matches("\\d+\\.\\d+\\.\\d+")) return false;
        String[] a=remote.split("\\."), b=local.split("\\.");
        try { for (int i=0;i<3;i++) { int difference = Integer.compare(Integer.parseInt(a[i]),Integer.parseInt(b[i])); if(difference!=0)return difference>0; } }
        catch(NumberFormatException ignored) { return false; }
        return false;
    }
}
