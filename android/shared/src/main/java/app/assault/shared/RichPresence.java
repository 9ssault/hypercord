package app.assault.shared;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.SharedPreferences;
import android.text.InputFilter;
import android.widget.*;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONObject;

/** Local rich-presence editor. Contains display settings only, never credentials. */
public final class RichPresence {
    private static final String[] TEXT_KEYS={"applicationId","name","details","state","detailsUrl","stateUrl","streamUrl","largeImage","largeText","largeUrl","smallImage","smallText","smallUrl","button1Label","button1Url","button2Label","button2Url","startTime","endTime"};
    private static final String[] MODES={"none","elapsed","today","custom"};
    private static final int[] TYPES={0,1,2,3,5};
    public static JSONObject read(SharedPreferences prefs) {
        try{return validate(new JSONObject(prefs.getString("richPresence","{}")));}
        catch(Exception invalid){return new JSONObject();}
    }
    private static int limit(String key){return key.equals("applicationId")?20:key.endsWith("Label")?32:key.endsWith("Time")?16:(key.endsWith("Url")||key.endsWith("Image"))?512:128;}
    private static boolean https(String value){
        try{URI uri=new URI(value);return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost()!=null && uri.getUserInfo()==null && !value.matches(".*[\\s<>\"'].*");}
        catch(Exception error){return false;}
    }
    public static JSONObject validate(JSONObject raw)throws Exception {
        JSONObject checked=new JSONObject().put("enabled",raw.optBoolean("enabled",false));
        for(String key:TEXT_KEYS){String value=raw.optString(key,"").trim();if(value.length()>limit(key))throw new IllegalArgumentException(key+" is too long");checked.put(key,value);}
        int type=raw.optInt("type",0);if(type!=0 && type!=1 && type!=2 && type!=3 && type!=5)throw new IllegalArgumentException("Choose a supported activity type");checked.put("type",type);
        String mode=raw.optString("timestampMode","none");if(!java.util.Arrays.asList(MODES).contains(mode))throw new IllegalArgumentException("Unknown timestamp mode");checked.put("timestampMode",mode);
        String appId=checked.getString("applicationId");if(!appId.isEmpty() && !appId.matches("[0-9]{1,20}"))throw new IllegalArgumentException("Application ID must be numeric");
        if(checked.getBoolean("enabled") && checked.getString("name").isEmpty())throw new IllegalArgumentException("Enter an activity name");
        for(String key:TEXT_KEYS)if(key.endsWith("Url") && !checked.getString(key).isEmpty() && !https(checked.getString(key)))throw new IllegalArgumentException(key+" needs a complete HTTPS URL without credentials");
        String stream=checked.getString("streamUrl");
        if(checked.getBoolean("enabled") && type==1 && !stream.matches("(?i)https://(www\\.)?(twitch\\.tv|youtube\\.com)/.+"))throw new IllegalArgumentException("Streaming needs a Twitch or YouTube HTTPS URL");
        for(String size:new String[]{"large","small"}){
            String image=checked.getString(size+"Image");
            if(!image.isEmpty() && !image.matches("[A-Za-z0-9_.-]{1,128}") && !https(image))throw new IllegalArgumentException("Use an image asset ID, key or HTTPS URL");
            if(!image.isEmpty() && !image.matches("[0-9]{1,20}") && appId.isEmpty())throw new IllegalArgumentException("An application ID is required to resolve image keys or URLs");
        }
        for(int i=1;i<=2;i++)if(checked.getString("button"+i+"Label").isEmpty()!=checked.getString("button"+i+"Url").isEmpty())throw new IllegalArgumentException("Each button needs both a label and HTTPS URL");
        long start=timestamp(checked.getString("startTime")),end=timestamp(checked.getString("endTime"));
        if(mode.equals("custom") && start>0 && end>0 && end<=start)throw new IllegalArgumentException("End time must be after start time");
        int current=raw.optInt("partySize",0),max=raw.optInt("partyMax",0);
        if(current<0 || max<0 || max>9999 || current>max || ((current==0)!=(max==0)))throw new IllegalArgumentException("Party needs 1 ≤ size ≤ maximum ≤ 9999, or both zero");
        return checked.put("partySize",current).put("partyMax",max);
    }
    private static long timestamp(String value){
        if(value.isEmpty())return 0;
        try{long parsed=Long.parseLong(value);if(parsed>0 && parsed<=8640000000000000L)return parsed;}catch(NumberFormatException ignored){}
        throw new IllegalArgumentException("Timestamps must be positive Unix milliseconds");
    }
    public static void show(Activity activity,SharedPreferences prefs,Runnable saved){
        JSONObject initial=read(prefs);Map<String,EditText> fields=new LinkedHashMap<>();
        LinearLayout panel=new LinearLayout(activity);panel.setOrientation(LinearLayout.VERTICAL);
        int pad=Math.round(16*activity.getResources().getDisplayMetrics().density);panel.setPadding(pad,pad,pad,pad);
        note(activity,panel,"Build your activity card. This uses the existing client connection. Enable activity sharing in Discord. Images, links and buttons depend on Discord support; inspect your profile from another account. Saving an enabled card selects the presence profile. Restart the client to apply.");
        Switch enabled=new Switch(activity);enabled.setText("Enable rich presence");enabled.setChecked(initial.optBoolean("enabled",false));panel.addView(enabled);
        Spinner type=spinner(activity,panel,"Activity type",new String[]{"Playing","Streaming","Listening","Watching","Competing"},java.util.Arrays.binarySearch(TYPES,initial.optInt("type",0)));
        String[][] labels={{"applicationId","Discord application ID"},{"name","Activity name"},{"details","Details"},{"state","State"},{"detailsUrl","Details link (HTTPS)"},{"stateUrl","State link (HTTPS)"},{"streamUrl","Streaming URL (Twitch / YouTube)"},{"largeImage","Large image asset ID, key or HTTPS URL"},{"largeText","Large image hover text"},{"largeUrl","Large image click URL"},{"smallImage","Small image asset ID, key or HTTPS URL"},{"smallText","Small image hover text"},{"smallUrl","Small image click URL"},{"button1Label","Button 1 label"},{"button1Url","Button 1 URL"},{"button2Label","Button 2 label"},{"button2Url","Button 2 URL"}};
        for(String[] row:labels)fields.put(row[0],input(activity,panel,row[1],initial.optString(row[0],""),limit(row[0])));
        Spinner time=spinner(activity,panel,"Timestamp mode",new String[]{"No timestamp","Elapsed since client start","Elapsed since local midnight","Custom Unix milliseconds"},java.util.Arrays.asList(MODES).indexOf(initial.optString("timestampMode","none")));
        fields.put("startTime",input(activity,panel,"Custom start (Unix milliseconds)",initial.optString("startTime",""),16));
        fields.put("endTime",input(activity,panel,"Custom end (Unix milliseconds)",initial.optString("endTime",""),16));
        Button now=new Button(activity);now.setText("Use current time as start");panel.addView(now);now.setOnClickListener(v->{fields.get("startTime").setText(String.valueOf(System.currentTimeMillis()));time.setSelection(3);});
        EditText party=input(activity,panel,"Party size (0 disables)",String.valueOf(initial.optInt("partySize",0)),4);
        EditText maximum=input(activity,panel,"Party maximum (0 disables)",String.valueOf(initial.optInt("partyMax",0)),4);
        party.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);maximum.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        note(activity,panel,"Image keys/URLs need an application ID and a compatible client asset resolver. Numeric asset IDs can be used directly. A preview describes configured data; it does not prove remote visibility.");
        ScrollView scroll=new ScrollView(activity);scroll.addView(panel);
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle("Hypercord rich presence").setView(scroll).setNegativeButton("Cancel",null).setNeutralButton("Preview",null).setPositiveButton("Save",null).create();
        interface ReadForm{JSONObject get()throws Exception;}
        ReadForm read=()->{JSONObject raw=new JSONObject().put("enabled",enabled.isChecked()).put("type",TYPES[type.getSelectedItemPosition()]).put("timestampMode",MODES[time.getSelectedItemPosition()]).put("partySize",party.getText().toString().trim().isEmpty()?0:Integer.parseInt(party.getText().toString().trim())).put("partyMax",maximum.getText().toString().trim().isEmpty()?0:Integer.parseInt(maximum.getText().toString().trim()));for(var field:fields.entrySet())raw.put(field.getKey(),field.getValue().getText().toString());return validate(raw);};
        dialog.setOnShowListener(ignored->{
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{try{JSONObject checked=read.get();var editor=prefs.edit().putString("richPresence",checked.toString());if(checked.getBoolean("enabled"))editor.putString("accountProfile","presence");editor.apply();dialog.dismiss();if(saved!=null)saved.run();}catch(Exception error){Toast.makeText(activity,error.getMessage(),Toast.LENGTH_LONG).show();}});
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v->{try{JSONObject value=read.get();new AlertDialog.Builder(activity).setTitle(value.optString("name","Activity preview")).setView(preview(activity,value)).setPositiveButton("Done",null).setNeutralButton("Copy configuration",(d,w)->{try{activity.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Hypercord rich presence",value.toString()));Toast.makeText(activity,"Display configuration copied",Toast.LENGTH_SHORT).show();}catch(RuntimeException error){Toast.makeText(activity,"Clipboard unavailable",Toast.LENGTH_SHORT).show();}}).show();}catch(Exception error){Toast.makeText(activity,error.getMessage(),Toast.LENGTH_LONG).show();}});
        });dialog.show();
    }
    private static android.view.View preview(Activity activity,JSONObject value){
        LinearLayout card=new LinearLayout(activity);card.setOrientation(LinearLayout.VERTICAL);
        int pad=Math.round(20*activity.getResources().getDisplayMetrics().density);card.setPadding(pad,pad,pad,pad);
        String[] names={"Playing","Streaming","Listening","Watching","Competing"};int type=java.util.Arrays.binarySearch(TYPES,value.optInt("type",0));
        note(activity,card,names[Math.max(0,type)]+" · "+value.optString("name",""));
        for(String key:new String[]{"details","state"})if(!value.optString(key,"").isEmpty())note(activity,card,value.optString(key));
        for(String size:new String[]{"large","small"})if(!value.optString(size+"Image","").isEmpty())note(activity,card,size+" artwork: "+value.optString(size+"Image")+"\n"+value.optString(size+"Text",""));
        if(value.optInt("partyMax",0)>0)note(activity,card,"Party: "+value.optInt("partySize")+" / "+value.optInt("partyMax"));
        note(activity,card,"Timestamp: "+value.optString("timestampMode","none"));
        for(int i=1;i<=2;i++)if(!value.optString("button"+i+"Label","").isEmpty())note(activity,card,"["+value.optString("button"+i+"Label")+"]\n"+value.optString("button"+i+"Url"));
        note(activity,card,"Local configuration preview. Artwork is resolved in the client; remote rendering may differ.");
        ScrollView scroll=new ScrollView(activity);scroll.addView(card);return scroll;
    }
    private static void note(Activity activity,LinearLayout panel,String value){TextView label=new TextView(activity);label.setText(value);label.setPadding(0,12,0,8);panel.addView(label);}
    private static EditText input(Activity activity,LinearLayout panel,String label,String value,int max){note(activity,panel,label);EditText field=new EditText(activity);field.setSingleLine(true);field.setContentDescription(label);field.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)});field.setText(value);panel.addView(field);return field;}
    private static Spinner spinner(Activity activity,LinearLayout panel,String label,String[] labels,int selected){note(activity,panel,label);Spinner field=new Spinner(activity);field.setContentDescription(label);field.setAdapter(new ArrayAdapter<>(activity,android.R.layout.simple_spinner_dropdown_item,labels));field.setSelection(Math.max(0,selected));panel.addView(field);return field;}
}
