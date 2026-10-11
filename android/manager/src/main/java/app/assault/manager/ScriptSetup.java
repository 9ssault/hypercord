package app.assault.manager;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.widget.Switch;

final class ScriptSetup {
    static void show(Activity activity) {
        var preferences = activity.getSharedPreferences("manager", 0);
        Switch enabled = new Switch(activity);
        enabled.setText("Enable trusted script execution");
        enabled.setPadding(24, 16, 24, 16);
        enabled.setChecked(preferences.getBoolean("scripts_enabled", false));
        boolean[] restoring = {false};
        enabled.setOnCheckedChangeListener((button, value) -> {
            if (restoring[0]) return;
            if (!preferences.edit().putBoolean("scripts_enabled", value).commit()) {
                restoring[0] = true;
                button.setChecked(!value);
                restoring[0] = false;
                new AlertDialog.Builder(activity).setMessage("Could not save runner preference.").setPositiveButton("OK", null).show();
            }
        });
        new AlertDialog.Builder(activity).setTitle("Code runner setup")
            .setMessage("Install and open Termux from its official distribution. In Termux run:\n\npkg install python nodejs bash\nmkdir -p ~/.termux\nprintf '\\nallow-external-apps=true\\n' >> ~/.termux/termux.properties\ntermux-reload-settings\n\nScripts run with Termux permissions and can access its files and network. Only run code you trust. Discord credentials are not passed to scripts. Turning execution off prevents new starts; stop any active script from the client runner.\n\nThen grant permission below. In Discord, open Assault settings → Code runner.")
            .setView(enabled).setNegativeButton("Close", null).setPositiveButton("Grant permission", (dialog, which) -> {
                if (activity.checkSelfPermission(ScriptProvider.PERMISSION) == PackageManager.PERMISSION_GRANTED) return;
                try {
                    activity.getPackageManager().getPermissionInfo(ScriptProvider.PERMISSION, 0);
                    if (preferences.getBoolean("termux_permission_requested", false) && !activity.shouldShowRequestPermissionRationale(ScriptProvider.PERMISSION)) {
                        activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.getPackageName())));
                    } else {
                        preferences.edit().putBoolean("termux_permission_requested", true).apply();
                        activity.requestPermissions(new String[]{ScriptProvider.PERMISSION}, 7301);
                    }
                } catch (PackageManager.NameNotFoundException error) {
                    new AlertDialog.Builder(activity).setMessage("Install and open Termux first, then retry Grant permission.").setPositiveButton("OK", null).show();
                } catch (RuntimeException error) {
                    new AlertDialog.Builder(activity).setMessage("Open Android Settings → Apps → Assault Manager → Permissions and allow Termux execution.").setPositiveButton("OK", null).show();
                }
            }).show();
    }
}
