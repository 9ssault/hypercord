package app.assault.loader;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Build;
import android.widget.*;
import app.assault.shared.AccountSettings;
import app.assault.shared.CommandGuide;
import app.assault.shared.RichPresence;
import org.json.JSONObject;

/** Created only when the user opens native controls; no background service or polling. */
final class Controls {
    static void show(Activity activity, String failure, String hook) {
        var prefs=activity.getSharedPreferences("assault",0);
        SettingsSheet sheet=new SettingsSheet(activity,"Hypercord","Make Discord yours. Changes to runtime settings apply after restarting the client.");
        LinearLayout general=sheet.section("APP & APPEARANCE");
        toggle(sheet,general,prefs,"addonRuntime","Plugins & features","Load the Hypercord runtime",true);
        toggle(sheet,general,prefs,"nativeThemes","Native theme colors",null,true);
        toggle(sheet,general,prefs,"amoledMode","AMOLED pure black","True black #000000 background for OLED battery savings",false);
        toggle(sheet,general,prefs,"safeMode","Safe mode","Disable mods for troubleshooting",false);
        sheet.note("Find plugins and themes in Discord Settings → Hypercord.");
        LinearLayout capture=sheet.section("MESSAGES & EXPORT");
        toggle(sheet,capture,prefs,"captureEnabled","Capture messages","Keep this session’s messages available for export",true);
        toggle(sheet,capture,prefs,"antiDelete","Keep deleted messages",null,false);
        toggle(sheet,capture,prefs,"antiEdit","Keep edit history",null,false);
        toggle(sheet,capture,prefs,"ghostPingAlert","Ghost ping detector","Badge retained deleted messages with mentions",true);
        toggle(sheet,capture,prefs,"captureAttachments","Include attachment links",null,true);
        toggle(sheet,capture,prefs,"redactAuthors","Hide authors in exports",null,false);
        choice(sheet,capture,"Message limit","maxMessages",new int[]{100,500,1000},new String[]{"100 messages","500 messages","1,000 messages"},500);
        choice(sheet,capture,"Edits per message","maxEdits",new int[]{5,20,50},new String[]{"5 edits","20 edits","50 edits"},20);
        choice(sheet,capture,"Capture memory limit","memoryKiB",new int[]{256,1024,4096},new String[]{"256 KiB","1 MiB","4 MiB"},4096);
        choice(sheet,capture,"Expire messages after","retentionMinutes",new int[]{0,15,60},new String[]{"End of session","15 minutes","1 hour"},0);
        sheet.action(capture,"Save HTML transcript","Run /hypercord → export or export-all first",()->HtmlExport.save(activity));
        sheet.action(capture,"Save JSON transcript","Run /hypercord → export-json first",()->HtmlExport.save(activity,true));
        sheet.action(capture,"Save history archive","Run /hypercord → export-history first; includes a coverage report",()->HtmlExport.saveHistory(activity,true));
        sheet.action(capture,"Save history archive (links only)","Skip attachment downloads for a smaller archive",()->HtmlExport.saveHistory(activity,false));
        sheet.note("History archives fetch known channels and supplied closed DM IDs. Unknown closed DMs may be absent. The full archive downloads accessible attachments and reports failures.");
        sheet.note("Captured messages follow your expiry and capture limits and may be removed before export. Saved files can include private messages and attachment links.");
        LinearLayout account=sheet.section("ACCOUNT & PRIVACY");
        sheet.action(account,"Account controls","Profiles, reactions and presence",()->AccountSettings.show(activity,prefs,()->Toast.makeText(activity,"Saved. Restart the client to apply.",Toast.LENGTH_LONG).show()));
        sheet.action(account,"Rich presence","Activity card, artwork, buttons, timestamps and party size",()->RichPresence.show(activity,prefs,()->Toast.makeText(activity,"Saved. Restart the client to apply.",Toast.LENGTH_LONG).show()));
        toggle(sheet,account,prefs,"silentTyping","Silent typing","Hide your typing indicator in chats and DMs",false);
        toggle(sheet,account,prefs,"maskTokens","Token protection","Block text containing recognized Discord tokens or private keys; best-effort",true);
        toggle(sheet,account,prefs,"noTrack","Block analytics requests",null,true);
        toggle(sheet,account,prefs,"blockCrashReports","Block crash-report requests",null,true);
        LinearLayout floating=sheet.section("AS BUTTON");
        sheet.toggle(floating,"Default to left side","Used when you reset the position",prefs.getBoolean("leftControl",false),(v,on)->{prefs.edit().putBoolean("leftControl",on).apply();});
        sheet.action(floating,"Reset button position","You can also drag AS anywhere inside the app",()->FloatingControl.reset(activity));
        LinearLayout support=sheet.section("SUPPORT");
        sheet.action(support,"Command guide","Search local commands and message tools",()->CommandGuide.show(activity));
        sheet.action(support,"Check for updates","Open Hypercord Manager",()->{
            try{activity.startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse("assault://updates")).setPackage("app.assault.manager"));}
            catch(RuntimeException e){new AlertDialog.Builder(sheet.context).setMessage("Install Hypercord Manager to prepare client updates.").setPositiveButton("OK",null).show();}
        });
        sheet.action(support,"Copy diagnostics","No messages or account tokens included",()->{
            try{
                String report="Hypercord "+BuildConfig.VERSION_NAME+"\nAndroid API "+Build.VERSION.SDK_INT+"\nHook: "+hook+"\n"+Appearance.status+"\n"+(failure==null?"No native injection error recorded":failure);
                activity.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Hypercord diagnostics",report));
                Toast.makeText(activity,"Diagnostics copied",Toast.LENGTH_SHORT).show();
            }catch(RuntimeException e){Toast.makeText(activity,"Clipboard unavailable",Toast.LENGTH_SHORT).show();}
        });
        if(failure!=null)sheet.note(failure);
        sheet.note("Hypercord "+BuildConfig.VERSION_NAME+" · Native controls remain available when the runtime is disabled.");
        sheet.show();
    }
    private static void toggle(SettingsSheet sheet,LinearLayout panel,SharedPreferences prefs,String key,String title,String detail,boolean fallback){
        sheet.toggle(panel,title,detail,prefs.getBoolean(key,fallback),(view,on)->prefs.edit().putBoolean(key,on).apply());
    }
    static void receiveProfile(Activity activity,Intent intent) {
        if(!activity.getClass().getName().startsWith("com.discord.") || intent==null || !intent.hasExtra(AccountSettings.EXTRA))return;
        try {
            String raw=intent.getStringExtra(AccountSettings.EXTRA);intent.removeExtra(AccountSettings.EXTRA);
            if(raw==null || raw.length()>16384)throw new IllegalArgumentException();
            JSONObject profile=AccountSettings.validate(new JSONObject(raw));
            new AlertDialog.Builder(activity).setTitle("Apply account controls?")
                .setMessage("A profile was opened for this client: "+profile.getString("accountProfile")+". Apply it to this installation? No account credentials are transferred.")
                .setNegativeButton("Cancel",null).setPositiveButton("Apply",(d,w)->{
                    try{AccountSettings.save(activity.getSharedPreferences("assault",0),profile);Toast.makeText(activity,"Profile applied. Restart the client to activate it.",Toast.LENGTH_LONG).show();}
                    catch(Exception e){Toast.makeText(activity,"Invalid profile",Toast.LENGTH_SHORT).show();}
                }).show();
        }catch(Exception invalid){Toast.makeText(activity,"Invalid account-control profile",Toast.LENGTH_SHORT).show();}
    }
    private static void choice(SettingsSheet sheet,LinearLayout panel,String label,String key,int[] values,String[] labels,int fallback) {
        var prefs=sheet.activity.getSharedPreferences("assault",0);
        TextView[] name=new TextView[1];
        Runnable refresh=()->{int selected=0;for(int i=0;i<values.length;i++)if(values[i]==prefs.getInt(key,fallback))selected=i;name[0].setText(label+" · "+labels[selected]);((android.view.View)name[0].getParent().getParent()).setContentDescription(label+", "+labels[selected]);};
        name[0]=sheet.action(panel,label,null,()->{
            int selected=0;for(int i=0;i<values.length;i++)if(values[i]==prefs.getInt(key,fallback))selected=i;
            new AlertDialog.Builder(sheet.context).setTitle(label).setSingleChoiceItems(labels,selected,(dialog,index)->{prefs.edit().putInt(key,values[index]).apply();refresh.run();dialog.dismiss();}).setNegativeButton("Cancel",null).show();
        });refresh.run();
    }
}
