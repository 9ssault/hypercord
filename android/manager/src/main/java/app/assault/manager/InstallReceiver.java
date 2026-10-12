package app.assault.manager;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

public class InstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message;
        boolean confirmationOpened = false;
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmation != null) {
                try {
                    confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(confirmation);
                    confirmationOpened = true;
                    message = "Confirm installation in Android.";
                } catch (RuntimeException e) { message = "Android could not open confirmation. Retry installation from Manager."; }
            } else { message = "Android did not provide an installation prompt. Retry installation."; }
        } else if (status == PackageInstaller.STATUS_SUCCESS) {
            boolean manager = context.getPackageName().equals(intent.getStringExtra("assault.package"));
            if (manager) ManagerUpdater.prepared(context).delete();
            else {var prefs=context.getSharedPreferences("manager",0);prefs.edit().putInt("installed_loader",intent.getIntExtra("assault.loader",0)).apply();}
            message = manager ? "Manager updated." : "Hypercord installed. Ready to open.";
        }
        else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) message = "Installation canceled. You can retry.";
        else message = "Installation failed (" + status + "): " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        ClientEngine.installing.set(confirmationOpened);
        context.getSharedPreferences("manager", 0).edit().putString("message", message)
            .putBoolean("installing", confirmationOpened).apply();
    }
}
