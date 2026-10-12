// language: Java, file: android/shared/src/main/java/app/assault/shared/AccountSettings.java
//
// The account profile, described once for both apps.
//
// Two halves read this and they are not in the same process: the manager builds the JSON
// and puts it in an Intent extra, and the loader reads its own copy out of the client's
// preferences when Discord starts. The keys are spelled here, in one file, because the
// failure mode of two spellings is silent - a profile that saves correctly and is then
// ignored, with nothing in either app to say why.
//
// `read` takes a SharedPreferences rather than naming one: the manager passes its own
// ("manager") and the loader passes the client's ("assault"), and both hold the same
// keys. Nothing here reads a token, and nothing here writes: the manager's screen writes
// the chosen profile, the client's own controls write the details.
package app.assault.shared;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

public final class AccountSettings {
    /** The Intent extra the manager puts the profile JSON in and the client reads it out of. */
    public static final String EXTRA = "app.assault.shared.profile";

    /** The three profiles, as they are stored and as the picker lists them. */
    public static final String OFF = "off", LOCAL = "local", PRESENCE = "presence";

    /** The key the chosen profile is stored under, and the one `read` always sets. */
    public static final String MODE = "mode";

    /**
     * Every switch a profile carries, in the order the client's own controls list them.
     * The loader writes exactly this list from the client's preferences, so a key added
     * here without a preference of the same name would be read as its default.
     */
    public static final String[] FLAGS = {
        "antiDelete", "antiEdit", "noTrack", "captureEnabled", "captureAttachments",
        "redactAuthors", "blockCrashReports", "silentTyping", "maskTokens", "ghostPingAlert"
    };

    /**
     * The six that are on in a profile that has never been configured. They are the
     * privacy-preserving half (nothing kept off the wire, nothing reported, tokens and
     * authors masked): a first run should be private before it is convenient, and every
     * one of these is still a switch the person can turn off.
     */
    private static final String[] ON_AT_START = {
        "noTrack", "captureEnabled", "captureAttachments", "blockCrashReports", "maskTokens", "ghostPingAlert"
    };

    private AccountSettings() {
        // static only
    }

    /** The stored profile, or {@link #OFF} for a value this build does not recognise. */
    public static String mode(SharedPreferences preferences) {
        String stored = preferences.getString(MODE, OFF);
        return LOCAL.equals(stored) || PRESENCE.equals(stored) ? stored : OFF;
    }

    /** Does this switch start on? Used only for a key that has never been written. */
    public static boolean onAtStart(String key) {
        for (String each : ON_AT_START) if (each.equals(key)) return true;
        return false;
    }

    /**
     * The whole profile as JSON: what the manager hands the client through
     * {@link #EXTRA}, and what the loader merges into `globalThis.__ASSAULT_CONFIG__`.
     * The presence half is added by {@link RichPresence#read} so the two files stay the
     * only place these keys are written.
     */
    public static JSONObject read(SharedPreferences preferences) {
        JSONObject profile = new JSONObject();
        try {
            profile.put(MODE, mode(preferences));
            for (String key : FLAGS) profile.put(key, preferences.getBoolean(key, onAtStart(key)));
            // The bounded numbers: how much is kept, and for how long. 0 minutes means
            // "until the client is closed", which is what a first run does.
            profile.put("maxMessages", preferences.getInt("maxMessages", 500))
                   .put("maxEdits", preferences.getInt("maxEdits", 20))
                   .put("memoryKiB", preferences.getInt("memoryKiB", 4096))
                   .put("retentionMinutes", preferences.getInt("retentionMinutes", 0));
            RichPresence.read(preferences, profile);
        } catch (JSONException impossible) {
            // put() only rejects a null or non-finite value and every value above is a
            // primitive or a string from this file, so this cannot fire. If it ever did,
            // the caller still gets the keys that made it rather than an exception on a
            // path that must not fail at startup.
        }
        return profile;
    }

    /**
     * The manager's picker. It chooses which profile the client runs and nothing else,
     * because the details belong to the client's own controls screen; the profile starts
     * {@link #OFF}, so applying one is always a deliberate act.
     */
    public static void show(Activity activity, SharedPreferences preferences, Runnable onSaved) {
        final String[] profiles = {OFF, LOCAL, PRESENCE};
        final String[] labels = {
            "Off - the client runs exactly as installed",
            "Local controls - commands, own-message reactions, captures",
            "Controls + custom presence"
        };
        String current = mode(preferences);
        int selected = OFF.equals(current) ? 0 : PRESENCE.equals(current) ? 2 : 1;
        new AlertDialog.Builder(activity)
            .setTitle("Account profile")
            .setMessage("What the client adds to the account already signed in. No account token is used, and the details "
                + "(captures, filters, presence fields) are edited inside the client under AS -> Account controls.")
            .setSingleChoiceItems(labels, selected, (list, which) -> {
                preferences.edit().putString(MODE, profiles[which]).apply();
                list.dismiss();
                if (onSaved != null) onSaved.run();
            })
            .setNegativeButton("Close", null)
            .show();
    }
}
