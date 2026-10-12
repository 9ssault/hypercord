// language: Java, file: android/shared/src/main/java/app/assault/shared/CommandGuide.java
//
// The command guide, as a searchable list in the app rather than a web page.
//
// It documents the *families* of local commands this build ships and says what each one
// does. It deliberately does not print invented syntax: the authoritative list is the one
// the client's own controls publish (AS -> Account controls), which is generated from the
// handlers that actually exist, and a guide that guessed an argument name would be worse
// than no guide. What is here is what the product documentation states, with the same
// exclusions: no token fleets, no multi-account voice, no targeted messaging, no fabricated
// quest progress and no group renaming, because none of those are in the client.
package app.assault.shared;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;

public final class CommandGuide {
    /** The families, each with what it does and whether a profile has to be on for it. */
    private static final String[][] COMMANDS = {
        {"/assault", "The local entry point. With no argument it lists the families below."},
        {"search", "Search the channels this account can already read. Nothing is fetched that the client does not already have."},
        {"capture", "Keep messages as they arrive for the bound retention window (maxMessages, retentionMinutes)."},
        {"export", "Write a capture out as JSON, or as a self-contained page you can open offline."},
        {"privacy", "The redaction filters: authors, tokens and the reporting of edits and deletions."},
        {"reactions", "React with your own account to the message you replied to. One reaction per command."},
        {"presence", "Apply or clear the activity built in the manager's presence builder."},
        {"commands", "The commands the client is currently answering, with their arguments, from the client itself."}
    };

    private CommandGuide() {
        // static only
    }

    /** The guide, filtered as you type. */
    public static void show(Activity activity) {
        LinearLayout page = new LinearLayout(activity);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(32, 24, 32, 8);

        EditText filter = new EditText(activity);
        filter.setHint("Filter commands");
        page.addView(filter);

        ListView list = new ListView(activity);
        page.addView(list);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_1, entries(""));
        list.setAdapter(adapter);
        filter.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) { }

            @Override public void afterTextChanged(Editable text) {
                adapter.clear();
                adapter.addAll(entries(text.toString().trim().toLowerCase(java.util.Locale.ROOT)));
            }
        });

        new AlertDialog.Builder(activity)
            .setTitle("Local command guide")
            .setMessage("These are the local commands this build answers, and what each one does. The exact arguments are "
                + "published by the client itself under AS -> Account controls -> commands, which cannot drift from the "
                + "handlers that exist. Nothing here reaches a server, and remote or bulk account features are not part of it.")
            .setView(page)
            .setPositiveButton("Close", null)
            .show();
    }

    /** One line per matching family; an empty filter matches everything. */
    private static java.util.List<String> entries(String needle) {
        java.util.List<String> lines = new java.util.ArrayList<>();
        for (String[] command : COMMANDS) {
            String line = command[0] + " - " + command[1];
            if (needle.isEmpty() || line.toLowerCase(java.util.Locale.ROOT).contains(needle)) lines.add(line);
        }
        if (lines.isEmpty()) lines.add("Nothing matches that filter.");
        return lines;
    }
}
