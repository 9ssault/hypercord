package app.assault.shared;

import android.app.Activity;
import android.app.AlertDialog;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Locale;

/** Offline command reference shared by Manager and the injected native controls. */
public final class CommandGuide {
    private static final String[][] COMMANDS = {
        {"$help · $status · $id", "Show commands, hook availability, your user ID and the current channel ID locally."},
        {"$stop · $start", "Pause/resume own-message reactions and custom presence. Local tools still work. Logout pauses automation."},
        {"$prefix !", "Change the command prefix for this session. Use Hypercord → Account controls for a saved default."},
        {"$react on · $react off", "Opt in/out of reactions to your own new messages. Never reacts to another author's message."},
        {"$react emoji 🔥", "Choose a Unicode reaction emoji for this session."},
        {"$react interval 30", "Set 10–300 seconds between reactions. Server retry delays are also respected."},
        {"$react channels 123,456 · $react channels all", "Limit reactions to up to 20 channel IDs. Use $id in a channel to find its ID."},
        {"$activity playing My game", "Presence profile only. Also accepts listening, watching and competing; applies on the next existing gateway presence update."},
        {"$activity clear · $activity reset", "Clear keeps Discord activities unchanged; reset restores your saved activity profile."},
        {"$status_override idle", "Presence profile only: online, idle, dnd, invisible, clear or reset. Does not open another gateway connection."},
        {"$rpc status · $rpc preview · $rpc refresh", "Inspect the saved rich-presence card or refresh image resolution. Configure artwork, links, buttons, timestamps and party size in Hypercord → Rich presence."},
        {"$rpc details Some text · $rpc state Some text", "Change rich-presence details/state for this session. rpc clear disables its override; rpc reset re-enables it."},
        {"$search words", "Search retained messages in the current channel. /assault search with scope:all searches all captured channels."},
        {"$channels · $mentions · $stats", "List captured channels, current-channel mentions, or capture and hook diagnostics."},
        {"$export history [channel IDs]", "Fetch server history for all known channels plus supplied closed DM IDs. Then Hypercord → Save history archive. Inspect manifest.json for omissions; attachment bytes are not downloaded."},
        {"$export status · $export cancel", "Show history progress, or cancel and clear the cached archive. /assault export-history also works with profiles off; query accepts extra channel IDs."},
        {"$export html · $export json", "Prepare the current channel transcript, then choose Hypercord → Save HTML/JSON transcript."},
        {"$export deleted · $export all", "Export retained deleted messages in this channel, or HTML for all captured channels."},
        {"$clear · $clear all", "Clear current-channel or all retained messages. Also discards cached transcripts."},
        {"$capture off · $capture on", "Off clears session capture and cached exports; on resumes capture. Restart restores the saved setting."},
        {"$privacy", "Show session privacy settings. Toggle with typing, analytics, crashes or tokens followed by on/off."},
        {"$privacy typing on", "Suppress matching JavaScript typing requests. Does not cover every native request path."},
        {"$privacy tokens on", "Block recognized Discord tokens/private-key text in supported outgoing text messages. Best-effort; inspect messages before sending."},
        {"/hypercord", "Available even with the account profile off: export, export-all, export-deleted, export-json, search, channels, mentions, ghost-pings, capture, privacy, clear, clear-all, status, help."}
    };
    public static void show(Activity activity) {
        LinearLayout panel=new LinearLayout(activity);panel.setOrientation(LinearLayout.VERTICAL);
        int pad=Math.round(16*activity.getResources().getDisplayMetrics().density);panel.setPadding(pad,pad,pad,pad);
        TextView intro=new TextView(activity);intro.setText("Enable an account profile and restart for prefix commands. Examples use the default $. Recognized commands stay local; unknown commands are sent normally. Session changes reset on restart.");panel.addView(intro);
        EditText query=new EditText(activity);query.setSingleLine(true);query.setHint("Search commands");query.setContentDescription("Search commands");panel.addView(query);
        LinearLayout results=new LinearLayout(activity);results.setOrientation(LinearLayout.VERTICAL);
        ScrollView scroll=new ScrollView(activity);scroll.addView(results);
        panel.addView(scroll,new LinearLayout.LayoutParams(-1,Math.round(Math.min(360,activity.getResources().getDisplayMetrics().heightPixels/activity.getResources().getDisplayMetrics().density*0.45f)*activity.getResources().getDisplayMetrics().density)));
        Runnable render=()->{
            results.removeAllViews();String term=query.getText().toString().toLowerCase(Locale.ROOT);int count=0;
            for(String[] command:COMMANDS)if((command[0]+" "+command[1]).toLowerCase(Locale.ROOT).contains(term)){
                TextView row=new TextView(activity);row.setText(command[0]+"\n"+command[1]);row.setTextIsSelectable(true);row.setPadding(0,pad,0,pad);results.addView(row);count++;
            }
            if(count==0){TextView empty=new TextView(activity);empty.setText("No matching commands.");results.addView(empty);}
        };
        query.addTextChangedListener(new TextWatcher(){
            public void beforeTextChanged(CharSequence s,int start,int count,int after){}
            public void onTextChanged(CharSequence s,int start,int before,int count){render.run();}
            public void afterTextChanged(Editable value){}
        });
        render.run();new AlertDialog.Builder(activity).setTitle("Hypercord command guide").setView(panel).setPositiveButton("Done",null).show();
    }
}
