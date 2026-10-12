package app.assault.shared;

import android.app.*;
import android.content.SharedPreferences;
import android.text.InputFilter;
import android.widget.*;
import org.json.JSONObject;
import java.util.Arrays;

/** Built-in profiles only. Configuration never contains account credentials or executable scripts. */
public final class AccountSettings {
    public static final String EXTRA = "app.assault.ACCOUNT_SETTINGS";
    private static final String[] PROFILES = {"off", "controls", "presence"};
    private static final int[] ACTIVITY_TYPES = {0, 2, 3, 5};
    private static final String[] STATUSES = {"unchanged", "online", "idle", "dnd", "invisible"};
    public static JSONObject read(SharedPreferences prefs) {
        try {
            return validate(new JSONObject().put("accountProfile", prefs.getString("accountProfile", "off"))
                .put("commandPrefix", prefs.getString("commandPrefix", "$"))
                .put("selfReaction", prefs.getBoolean("selfReaction", false))
                .put("reactionEmoji", prefs.getString("reactionEmoji", "🔥"))
                .put("reactionIntervalSeconds", prefs.getInt("reactionIntervalSeconds", 10))
                .put("reactionChannels", prefs.getString("reactionChannels", ""))
                .put("activityType", prefs.getInt("activityType", 0))
                .put("presenceStatus", prefs.getString("presenceStatus", "unchanged"))
                .put("activityName", prefs.getString("activityName", "")).put("richPresence",RichPresence.read(prefs)));
        } catch (Exception invalid) { return new JSONObject(); }
    }
    public static JSONObject validate(JSONObject raw) throws Exception {
        String profile=raw.optString("accountProfile","off"), prefix=raw.optString("commandPrefix","$");
        String status=raw.optString("presenceStatus","unchanged"), emoji=raw.optString("reactionEmoji","🔥").trim();
        if(!Arrays.asList(PROFILES).contains(profile) || !Arrays.asList(STATUSES).contains(status)) throw new IllegalArgumentException("Unknown profile or status");
        if(!prefix.matches("[^\\s/@]{1,3}")) throw new IllegalArgumentException("Prefix needs 1–3 characters without spaces, / or @");
        if(emoji.isEmpty() || emoji.length()>32 || emoji.matches(".*[<>\\s].*")) throw new IllegalArgumentException("Enter a Unicode emoji without spaces");
        String activity=raw.optString("activityName","").trim();
        if(activity.length()>128) throw new IllegalArgumentException("Activity is limited to 128 characters");
        int interval=raw.optInt("reactionIntervalSeconds",10), activityType=raw.optInt("activityType",0);
        if(interval<10 || interval>300) throw new IllegalArgumentException("Reaction interval must be 10–300 seconds");
        if(activityType!=0 && activityType!=2 && activityType!=3 && activityType!=5) throw new IllegalArgumentException("Unknown activity type");
        String channels=raw.optString("reactionChannels","").trim();
        if(channels.equals("all"))channels="";
        if(!channels.isEmpty()) {
            String[] ids=channels.split(",",-1);
            if(ids.length>20)throw new IllegalArgumentException("Use at most 20 reaction channel IDs");
            for(int i=0;i<ids.length;i++){ids[i]=ids[i].trim();if(!ids[i].matches("[0-9]{1,20}"))throw new IllegalArgumentException("Channel IDs must be numbers separated by commas");}
            channels=String.join(",",ids);
        }
        return new JSONObject().put("accountProfile",profile).put("commandPrefix",prefix)
            .put("selfReaction",raw.optBoolean("selfReaction",false)).put("reactionEmoji",emoji)
            .put("presenceStatus",status).put("activityName",activity).put("activityType",activityType)
            .put("reactionIntervalSeconds",interval).put("reactionChannels",channels).put("richPresence",RichPresence.validate(raw.optJSONObject("richPresence")==null?new JSONObject():raw.getJSONObject("richPresence")));
    }
    public static void save(SharedPreferences prefs, JSONObject value) throws Exception {
        if(!value.has("richPresence"))value.put("richPresence",RichPresence.read(prefs));
        JSONObject checked=validate(value);
        SharedPreferences.Editor editor=prefs.edit();
        for(String key:new String[]{"accountProfile","commandPrefix","reactionEmoji","presenceStatus","activityName","reactionChannels"}) editor.putString(key,checked.getString(key));
        editor.putString("richPresence",checked.getJSONObject("richPresence").toString());
        editor.putInt("reactionIntervalSeconds",checked.getInt("reactionIntervalSeconds")).putInt("activityType",checked.getInt("activityType"));
        editor.putBoolean("selfReaction",checked.getBoolean("selfReaction")).apply();
    }
    public static void show(Activity activity, SharedPreferences prefs, Runnable saved) {
        LinearLayout panel=new LinearLayout(activity);panel.setOrientation(LinearLayout.VERTICAL);
        int pad=Math.round(16*activity.getResources().getDisplayMetrics().density);panel.setPadding(pad,pad,pad,pad);
        JSONObject current=read(prefs);
        label(activity,panel,"Built-in account controls run in your signed-in client. Changes apply after restarting the client. Start/stop and prefix commands are local; no chat message is sent.");
        Spinner profile=select(activity,panel,"Profile",new String[]{"Off","Local controls + own-message reactions","Controls + custom presence"},PROFILES,current.optString("accountProfile","off"));
        EditText prefix=input(activity,panel,"Command prefix",current.optString("commandPrefix","$"),3);
        Switch react=new Switch(activity);react.setText("React to my own new messages (at most once per 10 seconds)");react.setChecked(current.optBoolean("selfReaction",false));panel.addView(react);
        EditText emoji=input(activity,panel,"Reaction emoji",current.optString("reactionEmoji","🔥"),32);
        EditText interval=input(activity,panel,"Minimum reaction interval (10–300 seconds)",String.valueOf(current.optInt("reactionIntervalSeconds",10)),3);
        interval.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        EditText channels=input(activity,panel,"Reaction channel IDs (comma-separated; blank means all)",current.optString("reactionChannels",""),419);
        Spinner type=select(activity,panel,"Activity type",new String[]{"Playing","Listening","Watching","Competing"},new String[]{"0","2","3","5"},String.valueOf(current.optInt("activityType",0)));
        Spinner status=select(activity,panel,"Presence status",new String[]{"Use Discord status","Online","Idle","Do not disturb","Invisible"},STATUSES,current.optString("presenceStatus","unchanged"));
        EditText name=input(activity,panel,"Activity name (blank keeps Discord activities)",current.optString("activityName",""),128);
        label(activity,panel,"Presence profile applies on Discord's next gateway presence update. Logout/account switch pauses controls. /assault remains available for capture, HTML export and status. Runtime availability depends on the installed Discord version.");
        ScrollView scroll=new ScrollView(activity);scroll.addView(panel);
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle("Hypercord account controls").setView(scroll).setNegativeButton("Cancel",null).setPositiveButton("Save",null).create();
        dialog.setOnShowListener(ignored->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            try {
                save(prefs,new JSONObject().put("accountProfile",PROFILES[profile.getSelectedItemPosition()]).put("commandPrefix",prefix.getText().toString())
                    .put("selfReaction",react.isChecked()).put("reactionEmoji",emoji.getText().toString()).put("presenceStatus",STATUSES[status.getSelectedItemPosition()]).put("activityName",name.getText().toString()).put("activityType",ACTIVITY_TYPES[type.getSelectedItemPosition()])
                    .put("reactionIntervalSeconds",Integer.parseInt(interval.getText().toString())).put("reactionChannels",channels.getText().toString()));
                dialog.dismiss();if(saved!=null)saved.run();
            } catch(Exception error) {Toast.makeText(activity,error.getMessage(),Toast.LENGTH_LONG).show();}
        }));
        dialog.show();
    }
    private static void label(Activity activity,LinearLayout panel,String text){TextView view=new TextView(activity);view.setText(text);view.setPadding(0,12,0,8);panel.addView(view);}
    private static EditText input(Activity activity,LinearLayout panel,String label,String value,int max){label(activity,panel,label);EditText input=new EditText(activity);input.setSingleLine(true);input.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)});input.setText(value);panel.addView(input);return input;}
    private static Spinner select(Activity activity,LinearLayout panel,String label,String[] labels,String[] values,String current){
        label(activity,panel,label);Spinner spinner=new Spinner(activity);spinner.setAdapter(new ArrayAdapter<>(activity,android.R.layout.simple_spinner_dropdown_item,labels));
        for(int i=0;i<values.length;i++)if(values[i].equals(current))spinner.setSelection(i);panel.addView(spinner);return spinner;
    }
}
