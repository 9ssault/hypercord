// language: Java, file: android/shared/src/main/java/app/assault/shared/RichPresence.java
//
// The custom presence, as data the client can apply and as a screen the manager can show.
//
// The keys live here and nowhere else, because the thing that consumes them is the
// loader's `rich-presence.js` asset: it reads these names out of the config the loader
// injects. A rename on one side would be invisible - the dialog would still save and the
// presence would simply never appear - so both halves point at these constants.
//
// What this can honestly promise: it can set one activity and a status on the client's
// next existing gateway presence update. It does not open a second connection, does not
// change identify credentials and does not spoof another platform. Whether the activity
// renders at all depends on the installed Discord build, which is why the preview says so
// rather than implying it will show.
package app.assault.shared;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONException;
import org.json.JSONObject;

public final class RichPresence {
    public static final String DETAILS = "presenceDetails", STATE = "presenceState";
    public static final String APPLICATION = "presenceApplicationId", TYPE = "presenceType";
    public static final String LARGE_IMAGE = "presenceLargeImage", SMALL_IMAGE = "presenceSmallImage";
    public static final String LARGE_TEXT = "presenceLargeText", SMALL_TEXT = "presenceSmallText";
    public static final String BUTTON1_LABEL = "presenceButton1Label", BUTTON1_URL = "presenceButton1Url";
    public static final String BUTTON2_LABEL = "presenceButton2Label", BUTTON2_URL = "presenceButton2Url";
    public static final String STARTED_AT = "presenceStartedAt";
    public static final String PARTY_SIZE = "presencePartySize", PARTY_MAX = "presencePartyMax";
    public static final String STATUS = "presenceStatus";

    /** Activity types, in the order Discord's own activity object numbers them. */
    public static final String[] TYPES = {"Playing", "Listening", "Watching", "Competing"};
    /** Presence statuses; invisible is a real choice here, not an absence of one. */
    public static final String[] STATUSES = {"online", "idle", "dnd", "invisible"};

    private RichPresence() {
        // static only
    }

    /** The presence half of a profile, added to the object {@link AccountSettings#read} builds. */
    public static void read(SharedPreferences preferences, JSONObject profile) throws JSONException {
        for (String key : new String[]{DETAILS, STATE, APPLICATION, LARGE_IMAGE, SMALL_IMAGE, LARGE_TEXT, SMALL_TEXT,
            BUTTON1_LABEL, BUTTON1_URL, BUTTON2_LABEL, BUTTON2_URL}) {
            profile.put(key, preferences.getString(key, ""));
        }
        profile.put(TYPE, preferences.getString(TYPE, TYPES[0]))
               .put(STATUS, preferences.getString(STATUS, STATUSES[0]))
               .put(STARTED_AT, preferences.getLong(STARTED_AT, 0L))
               .put(PARTY_SIZE, preferences.getInt(PARTY_SIZE, 0))
               .put(PARTY_MAX, preferences.getInt(PARTY_MAX, 0));
    }

    /**
     * The builder. Values are checked before they are saved rather than after they fail:
     * an application id that is not numeric, half a button, a party larger than its
     * maximum, an unknown type or status, and a link that is not a link are all refused
     * with the reason in the preview - because a presence Discord ignored cannot be
     * reported back by the client.
     */
    public static void show(Activity activity, SharedPreferences preferences, Runnable onSaved) {
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(32, 16, 32, 16);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(form);

        EditText details = field(activity, form, "Details (line 1)", preferences.getString(DETAILS, ""), false);
        EditText state = field(activity, form, "State (line 2)", preferences.getString(STATE, ""), false);
        EditText application = field(activity, form, "Application id (digits; blank clears the activity)", preferences.getString(APPLICATION, ""), true);
        EditText type = field(activity, form, "Type: Playing, Listening, Watching, Competing", preferences.getString(TYPE, TYPES[0]), false);
        EditText largeImage = field(activity, form, "Large image key or link", preferences.getString(LARGE_IMAGE, ""), false);
        EditText smallImage = field(activity, form, "Small image key or link", preferences.getString(SMALL_IMAGE, ""), false);
        EditText largeText = field(activity, form, "Large image text", preferences.getString(LARGE_TEXT, ""), false);
        EditText smallText = field(activity, form, "Small image text", preferences.getString(SMALL_TEXT, ""), false);
        EditText button1Label = field(activity, form, "Button 1 label", preferences.getString(BUTTON1_LABEL, ""), false);
        EditText button1Url = field(activity, form, "Button 1 link", preferences.getString(BUTTON1_URL, ""), false);
        EditText button2Label = field(activity, form, "Button 2 label", preferences.getString(BUTTON2_LABEL, ""), false);
        EditText button2Url = field(activity, form, "Button 2 link", preferences.getString(BUTTON2_URL, ""), false);
        EditText startedAt = field(activity, form, "Started at (epoch millis; blank clears)", count(preferences.getLong(STARTED_AT, 0L)), true);
        EditText partySize = field(activity, form, "Party size", count(preferences.getInt(PARTY_SIZE, 0)), true);
        EditText partyMax = field(activity, form, "Party maximum", count(preferences.getInt(PARTY_MAX, 0)), true);
        EditText status = field(activity, form, "Status: online, idle, dnd, invisible", preferences.getString(STATUS, STATUSES[0]), false);

        TextView preview = new TextView(activity);
        preview.setPadding(0, 16, 0, 0);
        form.addView(preview);
        Runnable update = () -> preview.setText(summary(value(details), value(state), value(application),
            canonical(value(type), TYPES), value(button1Label), value(button1Url), value(button2Label), value(button2Url),
            canonical(value(status), STATUSES)));
        for (EditText each : new EditText[]{details, state, application, type, button1Label, button1Url, button2Label, button2Url, status}) {
            each.addTextChangedListener(new Rewrite(update));
        }
        update.run();

        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("Rich presence builder")
            .setView(scroll)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save", null)
            .create();
        dialog.setOnShowListener(shown -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(clicked -> {
            String detailsValue = value(details), stateValue = value(state), applicationValue = value(application);
            String typeValue = canonical(value(type), TYPES), statusValue = canonical(value(status), STATUSES);
            String firstLabel = value(button1Label), firstUrl = value(button1Url);
            String secondLabel = value(button2Label), secondUrl = value(button2Url);
            Long startedValue = number(value(startedAt)), sizeValue = number(value(partySize)), maxValue = number(value(partyMax));
            String problem =
                applicationValue != null && !applicationValue.matches("\\d{5,25}") ? "An application id is digits only (5 to 25 of them), or blank to clear the activity." :
                typeValue == null ? "Type must be Playing, Listening, Watching or Competing." :
                statusValue == null ? "Status must be online, idle, dnd or invisible." :
                startedValue == null ? "Started at must be epoch milliseconds, or blank." :
                sizeValue == null || maxValue == null ? "Party size and maximum must be whole numbers, or blank." :
                maxValue < sizeValue ? "The party maximum cannot be smaller than the party size." :
                (firstLabel.isEmpty() != firstUrl.isEmpty()) ? "Button 1 needs both a label and a link, or neither." :
                (secondLabel.isEmpty() != secondUrl.isEmpty()) ? "Button 2 needs both a label and a link, or neither." :
                !isLink(firstUrl) || !isLink(secondUrl) ? "A button link must start with http:// or https://." : null;
            if (problem != null) {
                preview.setText(problem);
                return;
            }
            preferences.edit()
                .putString(DETAILS, detailsValue).putString(STATE, stateValue)
                .putString(APPLICATION, applicationValue).putString(TYPE, typeValue)
                .putString(LARGE_IMAGE, value(largeImage)).putString(SMALL_IMAGE, value(smallImage))
                .putString(LARGE_TEXT, value(largeText)).putString(SMALL_TEXT, value(smallText))
                .putString(BUTTON1_LABEL, firstLabel).putString(BUTTON1_URL, firstUrl)
                .putString(BUTTON2_LABEL, secondLabel).putString(BUTTON2_URL, secondUrl)
                .putString(STATUS, statusValue)
                .putLong(STARTED_AT, startedValue).putInt(PARTY_SIZE, sizeValue.intValue()).putInt(PARTY_MAX, maxValue.intValue())
                .apply();
            dialog.dismiss();
            if (onSaved != null) onSaved.run();
        }));
        dialog.show();
    }

    /**
     * What the profile will look like, and the one thing a person cannot see from the form:
     * an activity with no application id has nothing to attach itself to, so no other
     * device will show it.
     */
    private static String summary(String details, String state, String application, String type,
            String firstLabel, String firstUrl, String secondLabel, String secondUrl, String status) {
        // `type` is null while a half-typed or unknown type sits in the field, and the
        // preview must still render: the save path is where that becomes a refusal.
        String line = (type == null ? "Activity" : type) + (details.isEmpty() ? "" : ": " + details) + (state.isEmpty() ? "" : " - " + state);
        String buttons = (firstLabel.isEmpty() ? "" : "  [" + firstLabel + "]") + (secondLabel.isEmpty() ? "" : "  [" + secondLabel + "]");
        String where = status == null ? "" : "  status " + status;
        return application.isEmpty()
            ? "Preview: " + line + buttons + where + "\nNo application id: the activity will not appear on other devices until one is set."
            : "Preview: " + line + buttons + where + "\nApplication " + application + "; shown on other devices after the next presence update.";
    }

    private static boolean isLink(String value) {
        return value.isEmpty() || value.startsWith("http://") || value.startsWith("https://");
    }

    /** The stored spelling of a value in a fixed list, or null when it is not in it. */
    private static String canonical(String value, String[] allowed) {
        for (String each : allowed) if (each.equalsIgnoreCase(value)) return each;
        return null;
    }

    private static String value(EditText field) {
        return field.getText().toString().trim();
    }

    private static Long number(String value) {
        if (value.isEmpty()) return 0L;
        try {
            long parsed = Long.parseLong(value);
            return parsed < 0 ? null : parsed;
        } catch (NumberFormatException notANumber) {
            return null;
        }
    }

    private static String count(long value) {
        return value > 0 ? Long.toString(value) : "";
    }

    private static EditText field(Activity activity, LinearLayout form, String label, String value, boolean numeric) {
        TextView caption = new TextView(activity);
        caption.setText(label);
        form.addView(caption);
        EditText input = new EditText(activity);
        input.setText(value);
        // Numeric fields say so in the keyboard, but the value is still validated on save:
        // a hardware keyboard can enter anything.
        if (numeric) input.setInputType(InputType.TYPE_CLASS_NUMBER);
        form.addView(input);
        return input;
    }

    /** Re-renders the preview as fields change; nothing else is written while typing. */
    private static final class Rewrite implements TextWatcher {
        private final Runnable update;

        Rewrite(Runnable update) {
            this.update = update;
        }

        @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) { }
        @Override public void onTextChanged(CharSequence text, int start, int before, int count) { }

        @Override public void afterTextChanged(Editable text) {
            update.run();
        }
    }
}
